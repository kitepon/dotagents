import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { collectHarnessQuotas, QuotaCollectionError, QUOTA_COLLECTION_SCHEMA } from "../../lib/orchestrate/quota-collect.mjs";
import { makeQuotaExecutor as makeExecutor } from "./helpers.mjs";

const OBSERVED_AT = "2026-09-22T00:00:00.000Z";
const catalog = JSON.parse(readFileSync(new URL("../../lib/orchestrate/model-candidates.json", import.meta.url), "utf8"));
const code = (expected) => (error) => {
  assert.ok(error instanceof QuotaCollectionError, `QuotaCollectionError expected, got ${error?.constructor?.name}`);
  assert.equal(error.code, expected);
  return true;
};
const epoch = (iso) => Date.parse(iso) / 1000;
const claudeCapture = (overrides = {}) => ({
  rate_limits: {
    five_hour: { used_percentage: 30, resets_at: epoch("2026-09-22T04:00:00.000Z") },
    seven_day: { used_percentage: 12.5, resets_at: epoch("2026-09-28T00:00:00.000Z") },
  },
  host_instance_id: "host-mac-main",
  executor_scope: [makeExecutor({ adapter_id: "claude-native", handle_schema_id: "claude-native.session.v1" })],
  ...overrides,
});
const codexCapture = (overrides = {}) => ({
  event: {
    limit_id: "codex",
    primary: { used_percent: 2, window_minutes: 10080, resets_at: epoch("2026-09-26T00:00:00.000Z") },
    secondary: null,
  },
  host_instance_id: "host-mac-main",
  executor_scope: [makeExecutor()],
  ...overrides,
});
const collect = (captures = {}) => collectHarnessQuotas({ catalog, observed_at: OBSERVED_AT, captures });
const byId = (result, id) => {
  const found = result.pools.filter((pool) => pool.pool_id === id);
  assert.equal(found.length, 1);
  return found[0];
};

test("推薦catalogの1回の収集はpool単位で、CursorとGrokの残量を作らない", () => {
  const result = collect({
    "anthropic-claude": claudeCapture(),
    "openai-codex": codexCapture(),
  });
  assert.equal(result.schema_version, QUOTA_COLLECTION_SCHEMA);
  assert.equal(result.observed_at, OBSERVED_AT);
  assert.equal(result.pools.length, catalog.pools.length);
  assert.deepEqual(result.pools.map((pool) => pool.pool_id), catalog.pools.map((pool) => pool.id));
  for (const id of ["cursor-models-monthly", "cursor-other-models-monthly", "xai-grok-weekly", "openai-chatgpt"]) {
    const record = byId(result, id);
    assert.equal(record.status, "observation_unavailable");
    assert.equal(record.snapshot, null);
    assert.equal(record.failure, null);
    assert.equal(record.observed_at, OBSERVED_AT);
  }
  const cursor = catalog.pools.find((pool) => pool.id === "cursor-models-monthly");
  assert.ok(cursor.members.length > 1);
  assert.equal(result.pools.filter((pool) => pool.pool_id === "cursor-models-monthly").length, 1);
  const claude = byId(result, "anthropic-claude");
  assert.equal(claude.status, "measured");
  assert.deepEqual(claude.snapshot.windows.map((window) => window.window_id), ["5h", "7d"]);
  assert.equal(claude.snapshot.windows[0].remaining_bp, 7000);
  assert.equal(claude.snapshot.windows[1].remaining_bp, 8750);
  const codex = byId(result, "openai-codex");
  assert.equal(codex.status, "measured");
  assert.equal(codex.snapshot.windows.length, 1);
  assert.equal(codex.snapshot.provider, "openai");
});

test("取得不能のpoolへ割合を渡すと拒否し、認証失敗・タイムアウト・期限切れ・古い観測はsnapshotにしない", () => {
  assert.throws(() => collect({ "cursor-models-monthly": { used_percentage: 6 } }), code("INVALID_SCHEMA"));
  assert.throws(() => collect({ "xai-grok-weekly": { rate_limits: { weekly: { used_percentage: 19, resets_at: 1 } } } }), code("INVALID_SCHEMA"));
  const missing = byId(collect(), "anthropic-claude");
  assert.equal(missing.status, "error");
  assert.equal(missing.failure.code, "OBSERVATION_UNAVAILABLE");
  assert.equal(missing.snapshot, null);
  const auth = byId(collect({
    "anthropic-claude": { failure_kind: "credential-missing", detail: "claude auth status loggedIn=false" },
    "openai-codex": { failure_kind: "timeout", detail: "codex token_count event not observed within bound" },
  }), "anthropic-claude");
  assert.equal(auth.failure.code, "CREDENTIAL_MISSING");
  assert.equal(auth.snapshot, null);
  const timeout = byId(collect({
    "openai-codex": { failure_kind: "timeout", detail: "codex token_count event not observed within bound" },
  }), "openai-codex");
  assert.equal(timeout.status, "error");
  assert.equal(timeout.failure.code, "OBSERVATION_TIMEOUT");
  const expired = byId(collect({
    "anthropic-claude": claudeCapture({
      rate_limits: { five_hour: { used_percentage: 30, resets_at: epoch(OBSERVED_AT) } },
    }),
  }), "anthropic-claude");
  assert.equal(expired.status, "expired");
  assert.equal(expired.failure.code, "WINDOW_CONTRADICTION");
  assert.equal(expired.snapshot, null);
  const stale = byId(collect({
    "openai-codex": codexCapture({ observed_at: "2026-09-21T00:00:00.000Z" }),
  }), "openai-codex");
  assert.equal(stale.status, "stale");
  assert.equal(stale.failure.code, "STALE_OBSERVATION");
  assert.equal(stale.snapshot, null);
  assert.equal(stale.observed_at, OBSERVED_AT);
});

test("未対応のprogrammatic entryと重複poolは収集しない", () => {
  const broken = { pools: [{ id: "cursor-models-monthly", programmatic: "dashboard-scrape", members: [] }] };
  assert.throws(() => collectHarnessQuotas({ catalog: broken, observed_at: OBSERVED_AT, captures: {} }), code("INVALID_SCHEMA"));
  const duplicated = { pools: [{ id: "openai-codex", programmatic: "codex-token-count-event" }, { id: "openai-codex", programmatic: "codex-token-count-event" }] };
  assert.throws(() => collectHarnessQuotas({ catalog: duplicated, observed_at: OBSERVED_AT, captures: {} }), code("INVALID_SCHEMA"));
});
