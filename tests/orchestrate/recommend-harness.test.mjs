import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadRankTable, loadRecommendationCatalog, recommendHarness, RECOMMEND_HARNESS_SCHEMA } from "../../lib/orchestrate/recommend-harness.mjs";
import { makeQuotaExecutor as makeExecutor } from "./helpers.mjs";

const OBSERVED_AT = "2026-09-22T00:00:00.000Z";
const catalog = loadRecommendationCatalog();
const rankTable = loadRankTable();
const selectable = catalog.candidates.find((candidate) => candidate.selectable && candidate.pool_id === "anthropic-claude");
const epoch = (iso) => Date.parse(iso) / 1000;
const rankOf = (role) => rankTable.find((entry) => entry.role === role).ranks;
const claudeCapture = (usedPercentage) => ({
  "anthropic-claude": {
    rate_limits: { five_hour: { used_percentage: usedPercentage, resets_at: epoch("2026-09-22T04:00:00.000Z") } },
    host_instance_id: "host-mac-main",
    executor_scope: [makeExecutor({ adapter_id: "claude-native", handle_schema_id: "claude-native.session.v1" })],
  },
});
const codexCapture = (usedPercent) => ({
  "openai-codex": {
    event: { limit_id: "codex", primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: epoch("2026-09-27T00:00:00.000Z") }, secondary: null },
    host_instance_id: "host-mac-main",
    executor_scope: [makeExecutor()],
  },
});

function jevResponse(answers) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "jev-1.13.0",
      answers: Object.fromEntries(Object.entries(answers).map(([question, choice]) => [
        question, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
      ])),
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
}

function dependencies(answers, sink = {}) {
  return {
    loadKey: async () => "test-key",
    request: async (url, init) => {
      sink.url = url;
      sink.body = JSON.parse(init.body);
      sink.authorization = init.headers.Authorization;
      return jevResponse(answers);
    },
  };
}

test("02の順位表が判断基準になる。統括は除き、effort範囲とeffort無しを読む", () => {
  assert.equal(rankTable.some((entry) => entry.role === "統括"), false);
  assert.deepEqual(rankOf("設計")[0], { family: "claude-opus-5", efforts: ["high"] });
  assert.deepEqual(rankOf("軽作業")[0], { family: "gpt-5.6-luna", efforts: ["low", "medium"] });
  assert.deepEqual(rankOf("軽作業")[1], { family: "claude-haiku-4.5", efforts: [null] });
  assert.deepEqual(rankOf("相談")[0], { family: "chatgpt", efforts: [null] });
  assert.deepEqual(rankOf("調査")[0], { family: "grok-4.6", efforts: ["low", "medium"] });
  for (const { ranks } of rankTable) {
    for (const rank of ranks) {
      assert.equal(catalog.candidates.some((candidate) => candidate.selectable && candidate.family === rank.family), true, rank.family);
    }
  }
});

test("Jevは役割と難度だけを選び、コードが順位とCursor優先でharnessを決める。親も子も起動しない", async () => {
  const sink = {};
  const result = await recommendHarness({ task: "認証設計の見直し", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "設計", difficulty: "hard" }, sink));
  assert.equal(result.schema, RECOMMEND_HARNESS_SCHEMA);
  assert.equal(result.status, "recommended");
  assert.equal(result.parent_changed, false);
  assert.equal(result.recommendation.candidate_id, "cursor-agent/claude-opus-5/high");
  assert.equal(result.quota_comparison, "not_established");
  assert.match(result.reason, /pool cursor-other-models-monthly observation_unavailable/);
  assert.match(result.reason, /role 設計 rank 1 hard/);
  assert.equal(result.observed_at, OBSERVED_AT);
  assert.equal(result.failure, null);
  assert.deepEqual(result.excluded_pools, []);
  assert.equal(result.observations.length, catalog.pools.length);
  assert.equal(sink.body.model, "jev-latest");
  assert.deepEqual(Object.keys(sink.body.state), ["task"]);
  assert.deepEqual(Object.keys(sink.body.questions).sort(), ["difficulty", "role"]);
  assert.equal(Object.hasOwn(sink.body.questions.role.criteria, "設計"), true);
  assert.equal(Object.hasOwn(sink.body.questions.role.criteria, "統括"), false);
  assert.equal(Object.hasOwn(sink.body.questions.role.criteria, selectable.candidate_id), false);
  assert.equal(JSON.stringify(sink.body).includes("observation_unavailable"), false);
  assert.equal(JSON.stringify(result).includes("test-key"), false);
  assert.equal(JSON.stringify(result).includes("probabilities"), false);
  const source = readFileSync(new URL("../../lib/orchestrate/recommend-harness.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../../bin/recommend-harness.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(cli.includes("child_process"), false);
});

test("effort範囲は難度で決め、effort無しの順位は指定不可の候補を返す", async () => {
  const light = await recommendHarness({ task: "誤字", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "軽作業", difficulty: "light" }));
  assert.equal(light.recommendation.candidate_id, "codex-native/gpt-5.6-luna/low");
  const hard = await recommendHarness({ task: "誤字", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "軽作業", difficulty: "hard" }));
  assert.equal(hard.recommendation.candidate_id, "codex-native/gpt-5.6-luna/medium");
  const consult = await recommendHarness({ task: "相談", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "相談", difficulty: "ordinary" }));
  assert.equal(consult.recommendation.candidate_id, "gpt-connector/chatgpt/unsupported");
  assert.equal(consult.recommendation.effort, null);
});

test("尽きたpoolは外して次のharnessへ、全harnessが尽きた順位は次の順位へ回す", async () => {
  const skipped = await recommendHarness({
    task: "実装",
    observed_at: OBSERVED_AT,
    catalog,
    captures: codexCapture(100),
  }, dependencies({ role: "実装", difficulty: "ordinary" }));
  assert.equal(skipped.status, "recommended");
  assert.equal(skipped.recommendation.candidate_id, "cursor-agent/gpt-5.6-terra/high");
  assert.match(skipped.reason, /skipped pool openai-codex/);
  assert.deepEqual(skipped.excluded_pools, [{ pool_id: "openai-codex", reason: "remaining_bp_0" }]);

  const measured = await recommendHarness({
    task: "実装",
    observed_at: OBSERVED_AT,
    catalog,
    captures: codexCapture(40),
  }, dependencies({ role: "実装", difficulty: "ordinary" }));
  assert.equal(measured.recommendation.candidate_id, "codex-native/gpt-5.6-terra/high");
  assert.equal(measured.quota_comparison, "established");

  // 1位が Claude だけの pool に乗る順位表で、その pool が尽きたら 2位へ回る。
  const table = [{ role: "検証", ranks: [{ family: "claude-haiku-4.5", efforts: [null] }, { family: "gpt-5.6-luna", efforts: ["low"] }] }];
  const fallback = await recommendHarness({
    task: "検証",
    observed_at: OBSERVED_AT,
    catalog,
    rank_table: table,
    captures: claudeCapture(100),
  }, dependencies({ role: "検証", difficulty: "light" }));
  assert.equal(fallback.recommendation.candidate_id, "codex-native/gpt-5.6-luna/low");
  assert.match(fallback.reason, /rank 2/);
  assert.match(fallback.reason, /skipped rank claude-haiku-4.5×unsupported/);

  const exhausted = await recommendHarness({
    task: "検証",
    observed_at: OBSERVED_AT,
    catalog,
    rank_table: [{ role: "検証", ranks: [{ family: "claude-haiku-4.5", efforts: [null] }] }],
    captures: claudeCapture(100),
  }, dependencies({ role: "検証", difficulty: "light" }));
  assert.equal(exhausted.status, "quota_exhausted");
  assert.equal(exhausted.recommendation, null);
});

test("none、未知の役割、API失敗は推薦成功にしない", async () => {
  const none = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "none", difficulty: "light" }));
  assert.equal(none.status, "no_candidate");
  assert.equal(none.recommendation, null);
  assert.equal(none.parent_changed, false);
  const unknown = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "存在しない役割", difficulty: "light" }));
  assert.equal(unknown.status, "jev_failed");
  assert.equal(unknown.failure.code, "JEV_CHOICE_UNKNOWN");
  assert.equal(unknown.recommendation, null);
  const malformed = await recommendHarness({ task: "存在しない作業", observed_at: OBSERVED_AT, catalog }, dependencies({ role: "設計" }));
  assert.equal(malformed.status, "jev_failed");
  assert.equal(malformed.failure.code, "JEV_ANSWER_MALFORMED");
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
    captures: claudeCapture(30),
  }, { request: async () => { called = true; return jevResponse({ role: "none", difficulty: "light" }); }, loadKey: async () => "test-key" });
  assert.equal(called, false);
  assert.equal(pinned.status, "recommended");
  assert.equal(pinned.quota_comparison, "established");
  assert.equal(pinned.recommendation.candidate_id, selectable.candidate_id);
  const exhausted = await recommendHarness({
    task: "指定どおり",
    observed_at: OBSERVED_AT,
    catalog,
    explicit: { harness: selectable.harness, family: selectable.family, effort: selectable.effort },
    captures: claudeCapture(100),
  }, { request: async () => { called = true; return jevResponse({ role: "none", difficulty: "light" }); }, loadKey: async () => "test-key" });
  assert.equal(called, false);
  assert.equal(exhausted.status, "quota_exhausted");
  assert.equal(exhausted.recommendation, null);
  assert.deepEqual(exhausted.excluded_pools, [{ pool_id: "anthropic-claude", reason: "remaining_bp_0" }]);
  const missing = await recommendHarness({
    task: "指定どおり",
    observed_at: OBSERVED_AT,
    catalog,
    explicit: { harness: "missing-harness", family: selectable.family, effort: selectable.effort },
  }, { request: async () => { called = true; return jevResponse({ role: "none", difficulty: "light" }); }, loadKey: async () => "test-key" });
  assert.equal(missing.status, "explicit_unsupported");
  assert.equal(missing.recommendation, null);
  assert.equal(called, false);
});
