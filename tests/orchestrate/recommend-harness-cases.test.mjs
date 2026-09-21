import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadRecommendationCatalog, recommendHarness } from "../../lib/orchestrate/recommend-harness.mjs";
import {
  buildComparison,
  independentReview,
  loadBugHubEndpoint,
  recommendByRemaining,
} from "../../lib/orchestrate/recommendation-comparison.mjs";

const AT = "2026-09-22T00:00:00.000Z";
const catalog = loadRecommendationCatalog();
const root = new URL("../../", import.meta.url);
const METRICS = ["success", "rework", "audit_effort", "total_tokens", "duration_seconds"];

function measured(pool_id, remaining_bp) {
  return { pool_id, status: "measured", observed_at: AT, snapshot: { remaining_bp }, failure: null };
}

function spec(case_id, family, effort, extra = {}) {
  return {
    case_id,
    family,
    effort,
    required_features: extra.required_features ?? [],
    explicit: extra.explicit ?? null,
  };
}

test("枠の余裕があるCursorを推薦し、尽きた枠は代替か明示にする", () => {
  const room = [measured("cursor-other-models-monthly", 4000), measured("anthropic-claude", 9000)];
  const cursor = recommendByRemaining(catalog, spec("cursor-room", "claude-fable-5", "high"), room);
  assert.equal(cursor.status, "recommended");
  assert.equal(cursor.quota_comparison, "established");
  assert.equal(cursor.recommendation.candidate_id, "cursor-agent/claude-fable-5/high");
  assert.equal(cursor.recommendation.harness, "cursor-agent");
  assert.equal(cursor.recommendation.family, "claude-fable-5");
  assert.equal(cursor.recommendation.effort, "high");

  const grokRoom = [measured("cursor-models-monthly", 2000), measured("xai-grok-weekly", 8000)];
  const grok = recommendByRemaining(catalog, spec("grok-room", "grok-4.6", "medium"), grokRoom);
  assert.equal(grok.recommendation.candidate_id, "cursor-agent/grok-4.6/medium");

  const exhausted = [measured("cursor-other-models-monthly", 0), measured("anthropic-claude", 5000)];
  const alt = recommendByRemaining(catalog, spec("cursor-exhausted", "claude-fable-5", "high"), exhausted);
  assert.equal(alt.recommendation.candidate_id, "claude-code/claude-fable-5/high");
  assert.match(alt.reason, /skipped cursor-other-models-monthly/);

  const none = [measured("cursor-other-models-monthly", 0), measured("anthropic-claude", 0)];
  const blocked = recommendByRemaining(catalog, spec("both-exhausted", "claude-fable-5", "high"), none);
  assert.equal(blocked.status, "quota_exhausted");
  assert.equal(blocked.recommendation, null);

  const window = [
    { pool_id: "cursor-other-models-monthly", status: "expired", observed_at: AT, snapshot: null, failure: null },
    measured("anthropic-claude", 1000),
  ];
  const switched = recommendByRemaining(catalog, spec("window", "claude-fable-5", "high"), window);
  assert.equal(switched.recommendation.harness, "claude-code");
});

test("同じ枠はモデルを替えても増えず、欠測と非対応は成功にしない", () => {
  const shared = [measured("cursor-other-models-monthly", 2500)];
  const fable = recommendByRemaining(catalog, spec("shared-fable", "claude-fable-5", "high"), shared);
  const opus = recommendByRemaining(catalog, spec("shared-opus", "claude-opus-5", "high"), shared);
  assert.equal(fable.recommendation.pool_id, "cursor-other-models-monthly");
  assert.equal(opus.recommendation.pool_id, fable.recommendation.pool_id);
  assert.match(fable.reason, /remaining_bp 2500/);
  assert.match(opus.reason, /remaining_bp 2500/);

  const haiku = recommendByRemaining(catalog, spec("missing-effort", "claude-haiku-4.5", "high"), [measured("anthropic-claude", 5000)]);
  assert.equal(haiku.status, "no_candidate");
  assert.equal(haiku.recommendation, null);
  const unknown = recommendByRemaining(catalog, spec("missing-family", "not-a-family", "high"), []);
  assert.equal(unknown.status, "no_candidate");

  const none = recommendByRemaining(catalog, spec("none-invalid", "claude-fable-5", "high", {
    explicit: { harness: "claude-code", family: "claude-fable-5", effort: "none" },
  }), [measured("anthropic-claude", 5000)]);
  assert.equal(none.status, "explicit_unsupported");
  assert.equal(none.failure.code, "EFFORT_NONE_INVALID");
  const validNone = recommendByRemaining(catalog, spec("none-valid", "gpt-5.6-luna", "none", {
    explicit: { harness: "codex-native", family: "gpt-5.6-luna", effort: "none" },
  }), [measured("openai-codex", 5000)]);
  assert.equal(validNone.recommendation.candidate_id, "codex-native/gpt-5.6-luna/none");

  const dark = [
    { pool_id: "cursor-other-models-monthly", status: "observation_unavailable", observed_at: AT, snapshot: null, failure: null },
    { pool_id: "anthropic-claude", status: "error", observed_at: AT, snapshot: null, failure: { code: "AUTH", detail: "auth failed" } },
  ];
  const hidden = recommendByRemaining(catalog, spec("unobserved", "claude-fable-5", "high"), dark);
  assert.equal(hidden.status, "observation_unavailable");
  assert.equal(hidden.recommendation, null);
});

test("機能とproviderで評価し、明示指定とeffortの差を保つ", () => {
  const room = [measured("cursor-other-models-monthly", 4000), measured("anthropic-claude", 9000)];
  const browser = recommendByRemaining(catalog, spec("browser", "claude-fable-5", "high", { required_features: ["browser"] }), room);
  assert.equal(browser.recommendation.harness, "cursor-agent");
  const noBrowser = recommendByRemaining(catalog, spec("browser-spent", "claude-fable-5", "high", { required_features: ["browser"] }), [
    measured("cursor-other-models-monthly", 0),
    measured("anthropic-claude", 9000),
  ]);
  assert.equal(noBrowser.recommendation, null);

  const cursor = catalog.candidates.find((candidate) => candidate.candidate_id === "cursor-agent/claude-fable-5/high");
  const claude = catalog.candidates.find((candidate) => candidate.candidate_id === "claude-code/claude-fable-5/high");
  const grok = catalog.candidates.find((candidate) => candidate.candidate_id === "grok-build/grok-4.6/high");
  assert.equal(cursor.harness === claude.harness, false);
  assert.equal(independentReview([cursor, claude]), false);
  assert.equal(independentReview([claude, grok]), true);

  const pin = recommendByRemaining(catalog, spec("pin", "claude-fable-5", "low", {
    explicit: { harness: "claude-code", family: "claude-fable-5", effort: "high" },
  }), room);
  assert.equal(pin.recommendation.candidate_id, "claude-code/claude-fable-5/high");
  const unmet = recommendByRemaining(catalog, spec("pin-miss", "claude-fable-5", "high", {
    explicit: { harness: "missing-harness", family: "claude-fable-5", effort: "high" },
  }), room);
  assert.equal(unmet.status, "explicit_unsupported");
  assert.equal(unmet.recommendation, null);

  const local = recommendByRemaining(catalog, spec("local", "claude-fable-5", "low"), room);
  const design = recommendByRemaining(catalog, spec("design", "claude-fable-5", "high"), room);
  assert.equal(local.recommendation.effort, "low");
  assert.equal(design.recommendation.effort, "high");
});

test("比較文書は現行endpointを読み、測っていない品質は欠測のまま", async () => {
  const endpoint = loadBugHubEndpoint();
  const current = readFileSync(new URL("../../docs/factory-current-state.md", import.meta.url), "utf8");
  assert.equal(endpoint, current.split("\n").find((row) => row.startsWith("| 本番BugHub endpoint |")).match(/`([^`]+)`/)[1]);
  const picked = recommendByRemaining(catalog, spec("parent", "claude-fable-5", "high"), [
    measured("cursor-other-models-monthly", 4000),
    measured("anthropic-claude", 9000),
  ]);
  const doc = buildComparison({
    case_id: "parent-read",
    endpoint,
    records: [
      { candidate_id: picked.recommendation.candidate_id, pool_id: picked.recommendation.pool_id, observed_at: AT },
      { candidate_id: picked.recommendation.candidate_id, pool_id: picked.recommendation.pool_id, observed_at: AT },
    ],
  });
  assert.equal(doc.schema, "dotagents.recommendation-comparison.v1");
  assert.equal(doc.surface, "servermanager-bughub-webui");
  assert.equal(doc.endpoint_source, "docs/factory-current-state.md");
  assert.equal(doc.endpoint, endpoint);
  assert.deepEqual(doc.omits, ["secret", "task_body", "cookie", "token"]);
  for (const record of doc.records) {
    for (const key of METRICS) assert.equal(record.missing.includes(key), true);
    assert.equal(Object.hasOwn(record, "success"), false);
  }
  assert.throws(() => buildComparison({
    case_id: "secret",
    endpoint,
    records: [{ candidate_id: "a", pool_id: "b", observed_at: AT, task_body: "本文" }],
  }), (error) => error.code === "COMPARISON_OMITTED_FIELD");

  const jev = await recommendHarness({ task: "比較", observed_at: AT, catalog }, {
    loadKey: async () => "test-key",
    request: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(jev.status, "jev_failed");
  const failed = buildComparison({
    case_id: "jev-fail",
    endpoint,
    records: [{ candidate_id: null, pool_id: null, observed_at: AT }],
  });
  assert.equal(failed.records[0].missing.includes("success"), true);
  assert.equal(JSON.stringify(doc).includes("test-key"), false);

  const source = readFileSync(new URL("../../lib/orchestrate/recommendation-comparison.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("child_process"), false);
});

test("配布先のCLIが三点を返す", () => {
  const cli = spawnSync(process.execPath, ["bin/recommend-harness.mjs"], {
    cwd: root,
    input: JSON.stringify({
      task: "配布先",
      observed_at: AT,
      explicit: { harness: "claude-code", family: "claude-fable-5", effort: "high" },
    }),
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const body = JSON.parse(cli.stdout);
  assert.equal(body.recommendation.harness, "claude-code");
  assert.equal(body.recommendation.family, "claude-fable-5");
  assert.equal(body.recommendation.effort, "high");
  assert.equal(body.parent_changed, false);
  assert.equal(JSON.stringify(body).includes("test-key"), false);
});
