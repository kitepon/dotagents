import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RecommendationContractError, coverRankTable, draftChildSelection, expandCatalog,
  explicitSupport, extractRecommendationSource, orderMatchingCandidates, validateRecommendationResult,
} from "../../lib/orchestrate/recommendation-contract.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const markdown = readFileSync(new URL("../../docs/02_models.md", import.meta.url), "utf8");
const source = extractRecommendationSource(markdown);
const catalog = expandCatalog(source);
const code = (expected) => (error) => {
  assert.ok(error instanceof RecommendationContractError);
  assert.equal(error.code, expected);
  return true;
};

test("02の機械可読正本から候補JSONと候補表を再生成できる", () => {
  const ran = spawnSync(process.execPath, ["bin/render-model-candidates.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const generated = JSON.parse(readFileSync(new URL("../../lib/orchestrate/model-candidates.json", import.meta.url), "utf8"));
  assert.equal(generated.source_digest, catalog.source_digest);
  assert.equal(generated.candidates.length, catalog.candidates.length);
});

test("同じGrok 4.6でもCursorとGrok Buildは別候補で別poolになる", () => {
  const cursor = explicitSupport(catalog, { harness: "cursor-agent", family: "grok-4.6", effort: "high" });
  const direct = explicitSupport(catalog, { harness: "grok-build", family: "grok-4.6", effort: "high" });
  assert.equal(cursor.ok, true);
  assert.equal(direct.ok, true);
  assert.notEqual(cursor.candidate.candidate_id, direct.candidate.candidate_id);
  assert.equal(cursor.candidate.pool_id, "cursor-models-monthly");
  assert.equal(direct.candidate.pool_id, "xai-grok-weekly");
  assert.equal(cursor.candidate.effort_binding, "model-id");
  assert.equal(direct.candidate.effort_binding, "parameter");
  const ordered = orderMatchingCandidates(catalog, "grok-4.6", "high");
  assert.equal(ordered[0].harness, "cursor-agent");
  assert.equal(ordered[1].harness, "grok-build");
});

test("OpenAI familyはCursor優先を適用せずCodex nativeを先にする", () => {
  const ordered = orderMatchingCandidates(catalog, "gpt-5.6-luna", "medium");
  assert.equal(ordered[0].harness, "codex-native");
  assert.ok(ordered.some((candidate) => candidate.harness === "cursor-agent"));
  assert.equal(ordered[0].execution, "native-subagent");
  assert.equal(ordered[0].implies_aiterm, false);
});

test("noneと指定不可とsidecarのmax欠落を取り違えない", () => {
  assert.deepEqual(explicitSupport(catalog, { harness: "grok-build", family: "grok-4.6", effort: "none" }), { ok: false, code: "EFFORT_NONE_INVALID" });
  assert.equal(explicitSupport(catalog, { harness: "codex-native", family: "gpt-5.6-luna", effort: "none" }).ok, true);
  assert.deepEqual(explicitSupport(catalog, { harness: "codex-external", family: "gpt-5.6-sol", effort: "max" }), { ok: false, code: "EXPLICIT_UNSUPPORTED" });
  assert.equal(explicitSupport(catalog, { harness: "codex-native", family: "gpt-5.6-sol", effort: "ultra" }).ok, true);
  assert.deepEqual(explicitSupport(catalog, { harness: "cursor-agent", family: "gpt-5.6-sol", effort: "ultra" }), { ok: false, code: "EXPLICIT_UNSUPPORTED" });
  assert.equal(explicitSupport(catalog, { harness: "claude-code", family: "claude-haiku-4.5", effort: null }).ok, true);
  assert.deepEqual(explicitSupport(catalog, { harness: "claude-code", family: "claude-haiku-4.5", effort: "low" }), { ok: false, code: "EXPLICIT_UNSUPPORTED" });
});

test("子の推薦は親を変えず、候補選択はAitermを要求しない", () => {
  const cursor = explicitSupport(catalog, { harness: "cursor-agent", family: "claude-opus-5", effort: "high" }).candidate;
  const direct = explicitSupport(catalog, { harness: "claude-code", family: "claude-opus-5", effort: "high" }).candidate;
  const result = validateRecommendationResult(draftChildSelection(cursor));
  assert.equal(result.parent_changed, false);
  assert.equal(result.quota_comparison, "not_established");
  assert.notEqual(cursor.pool_id, direct.pool_id);
  assert.ok(catalog.candidates.every((candidate) => candidate.implies_aiterm === false));
  assert.equal(source.parent_mutable, false);
  assert.equal(source.selector_thresholds, "not-inherited");
});

test("複数窓と共有poolを保ち、未対応familyは候補にしない", () => {
  const claude = catalog.pools.find((pool) => pool.id === "anthropic-claude");
  assert.deepEqual(claude.window_ids, ["five_hour", "seven_day"]);
  const cursorModels = catalog.candidates.filter((candidate) => candidate.pool_id === "cursor-models-monthly").map((candidate) => candidate.family);
  assert.ok(cursorModels.includes("grok-4.6"));
  assert.ok(cursorModels.includes("grok-4.5"));
  assert.equal(cursorModels.includes("composer-2.5"), false);
  assert.equal(orderMatchingCandidates(catalog, "grok-4.5", "high").length, 0);
});

test("順位表のmodel×effortは候補で表現でき、生成物の外に順位を複製しない", () => {
  assert.equal(coverRankTable(markdown, catalog), true);
  assert.throws(() => coverRankTable(markdown.replace("Grok 4.6×high（実測14/14）", "Grok 4.6×ultra（実測14/14）"), catalog), code("RANK_UNCOVERED"));
  assert.throws(() => coverRankTable(markdown.replace("| 反証 |", "| 反証 | Mystery×high |"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "BogusModelで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "Sol/BogusModelで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "Sol/bogusmodelで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "Sol/Grokで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "Sol/AIで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  assert.throws(() => coverRankTable(markdown.replace("Sol/Terraで独立確認", "Sol/Webで独立確認"), catalog), code("RANK_LABEL_UNKNOWN"));
  const moduleSource = readFileSync(new URL("../../lib/orchestrate/recommendation-contract.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(moduleSource, /from\s+["'][^"']*rate-selector/u);
  assert.equal(moduleSource.includes("DEFAULT_SELECTOR_POLICY"), false);
  assert.equal(source.cli.command, "recommend-harness");
  assert.equal(source.comparison.endpoint_source, "docs/factory-current-state.md");
  const current = readFileSync(new URL("../../docs/factory-current-state.md", import.meta.url), "utf8");
  assert.match(current, /本番BugHub endpoint/);
});
