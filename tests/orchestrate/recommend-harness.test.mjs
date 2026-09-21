import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadRecommendationCatalog, recommendHarness, RECOMMEND_HARNESS_SCHEMA } from "../../lib/orchestrate/recommend-harness.mjs";
import { makeQuotaExecutor as makeExecutor } from "./helpers.mjs";

const OBSERVED_AT = "2026-09-22T00:00:00.000Z";
const catalog = loadRecommendationCatalog();
const selectable = catalog.candidates.find((candidate) => candidate.selectable && candidate.pool_id === "anthropic-claude");
const epoch = (iso) => Date.parse(iso) / 1000;

function jevResponse(choice) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "jev-1.13.0",
      answers: { candidate: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
}

function dependencies(choice, sink = {}) {
  return {
    loadKey: async () => "test-key",
    request: async (url, init) => {
      sink.url = url;
      sink.body = JSON.parse(init.body);
      sink.authorization = init.headers.Authorization;
      return jevResponse(choice);
    },
  };
}

test("Jevが選んだ実在候補だけを返し、親も子も起動しない", async () => {
  const sink = {};
  const result = await recommendHarness({ task: "短い文の誤字を直す", observed_at: OBSERVED_AT, catalog }, dependencies(selectable.candidate_id, sink));
  assert.equal(result.schema, RECOMMEND_HARNESS_SCHEMA);
  assert.equal(result.status, "recommended");
  assert.equal(result.parent_changed, false);
  assert.equal(result.recommendation.candidate_id, selectable.candidate_id);
  assert.equal(result.recommendation.harness, selectable.harness);
  assert.equal(result.recommendation.effort, selectable.effort);
  assert.equal(result.recommendation.pool_id, "anthropic-claude");
  assert.equal(result.quota_comparison, "not_established");
  assert.match(result.reason, /pool anthropic-claude error/);
  assert.equal(result.observed_at, OBSERVED_AT);
  assert.equal(result.failure, null);
  assert.equal(sink.body.model, "jev-latest");
  assert.equal(sink.body.questions.candidate.type, "choice");
  assert.equal(Object.hasOwn(sink.body.questions.candidate.criteria, selectable.candidate_id), true);
  assert.equal(JSON.stringify(sink.body.state).includes("順位表"), false);
  assert.equal(JSON.stringify(result).includes("test-key"), false);
  assert.equal(JSON.stringify(result).includes("probabilities"), false);
  const source = readFileSync(new URL("../../lib/orchestrate/recommend-harness.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../../bin/recommend-harness.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(cli.includes("child_process"), false);
});

test("none、未知ID、API失敗は推薦成功にしない", async () => {
  const none = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, dependencies("none"));
  assert.equal(none.status, "no_candidate");
  assert.equal(none.recommendation, null);
  assert.equal(none.parent_changed, false);
  const unknown = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, dependencies("not-a-candidate"));
  assert.equal(unknown.status, "jev_failed");
  assert.equal(unknown.failure.code, "JEV_CHOICE_UNKNOWN");
  assert.equal(unknown.recommendation, null);
  const failed = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, {
    loadKey: async () => "test-key",
    request: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(failed.status, "jev_failed");
  assert.equal(failed.failure.code, "JEV_HTTP_401");
  assert.equal(failed.recommendation, null);
});

test("明示指定は契約どおり尊重し、measured の pool だけ比較成立にする", async () => {
  let called = false;
  const pinned = await recommendHarness({
    task: "指定どおり",
    observed_at: OBSERVED_AT,
    catalog,
    explicit: { harness: selectable.harness, family: selectable.family, effort: selectable.effort },
    captures: {
      "anthropic-claude": {
        rate_limits: { five_hour: { used_percentage: 30, resets_at: epoch("2026-09-22T04:00:00.000Z") } },
        host_instance_id: "host-mac-main",
        executor_scope: [makeExecutor({ adapter_id: "claude-native", handle_schema_id: "claude-native.session.v1" })],
      },
    },
  }, { request: async () => { called = true; return jevResponse("none"); }, loadKey: async () => "test-key" });
  assert.equal(called, false);
  assert.equal(pinned.status, "recommended");
  assert.equal(pinned.quota_comparison, "established");
  assert.equal(pinned.recommendation.candidate_id, selectable.candidate_id);
  const missing = await recommendHarness({
    task: "指定どおり",
    observed_at: OBSERVED_AT,
    catalog,
    explicit: { harness: "missing-harness", family: selectable.family, effort: selectable.effort },
  }, { request: async () => { called = true; return jevResponse("none"); }, loadKey: async () => "test-key" });
  assert.equal(missing.status, "explicit_unsupported");
  assert.equal(missing.recommendation, null);
  assert.equal(called, false);
});
