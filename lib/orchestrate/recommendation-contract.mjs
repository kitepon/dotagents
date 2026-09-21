// 推薦契約 (dotagents.recommendation-source.v1)。
// 役割順位の文言は docs/02_models.md の順位表だけが持つ。ここはハーネス・effort・pool・実行面を展開する。
// rate-selector の閾値は継承しない。候補選択は親の model×effort を変えない。
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";

export const RECOMMENDATION_SOURCE_SCHEMA = "dotagents.recommendation-source.v1";
export const MODEL_CANDIDATES_SCHEMA = "dotagents.model-candidates.v1";
export const REQUEST_SCHEMA = "dotagents.recommendation-request.v1";
export const RESULT_SCHEMA = "dotagents.recommendation-result.v1";
export const COMPARISON_SCHEMA = "dotagents.recommendation-comparison.v1";

export const SOURCE_MARK_START = "<!-- recommendation-source: start -->";
export const SOURCE_MARK_END = "<!-- recommendation-source: end -->";
export const TABLE_MARK_START = "<!-- recommendation-table: start -->";
export const TABLE_MARK_END = "<!-- recommendation-table: end -->";

const EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
const BINDINGS = Object.freeze(["parameter", "model-id", "unsupported"]);
const EXECUTIONS = Object.freeze(["native-subagent", "direct-harness", "sidecar", "consultation"]);
const RESULT_STATUSES = Object.freeze(["recommended", "insufficient_input", "no_eligible_candidate", "external_failure"]);
const FAMILY_LABELS = Object.freeze({
  "Grok 4.6": "grok-4.6",
  Sol: "gpt-5.6-sol",
  "Opus 5": "claude-opus-5",
  "Sonnet 5": "claude-sonnet-5",
  Terra: "gpt-5.6-terra",
  Luna: "gpt-5.6-luna",
  Haiku: "claude-haiku-4.5",
  "Fable 5": "claude-fable-5",
  ChatGPT: "chatgpt",
});

export class RecommendationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecommendationContractError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new RecommendationContractError(code, message); };

const object = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an object`);
};
const exact = (value, keys, name) => {
  object(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const boundedString = (value, name, maximum = 128) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("INVALID_SCHEMA", `${name} is not a bounded string`);
};
const identifier = (value, name) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(value)) fail("INVALID_SCHEMA", `${name} is not an identifier`);
};
const stringList = (value, name, allowed) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail("INVALID_SCHEMA", `${name} has invalid length`);
  for (const entry of value) {
    boundedString(entry, name, 64);
    if (allowed && !allowed.includes(entry)) fail("INVALID_SCHEMA", `${name} contains an unknown value`);
  }
  if (new Set(value).size !== value.length) fail("INVALID_SCHEMA", `${name} contains duplicates`);
};

function sliceMarked(markdown, start, end, name) {
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);
  if (from < 0 || to < 0 || to <= from) fail("SOURCE_MARK_MISSING", `${name} markers are missing`);
  return { from, to, body: markdown.slice(from + start.length, to).trim() };
}

export function extractRecommendationSource(markdown) {
  if (typeof markdown !== "string") fail("INVALID_SCHEMA", "markdown must be a string");
  const marked = sliceMarked(markdown, SOURCE_MARK_START, SOURCE_MARK_END, "recommendation-source");
  const fenced = marked.body.match(/^```json\n([\s\S]*?)\n```$/);
  if (!fenced) fail("SOURCE_MARK_MISSING", "recommendation-source must be one json fence");
  let source;
  try { source = JSON.parse(fenced[1]); } catch { fail("INVALID_SCHEMA", "recommendation-source json is invalid"); }
  return validateRecommendationSource(source);
}

export function validateRecommendationSource(source) {
  exact(source, [
    "cli", "comparison", "cursor_first_families", "default_harness_order", "families",
    "parent_mutable", "pools", "quota_comparison", "schema", "selector_thresholds",
  ], "recommendation-source");
  if (source.schema !== RECOMMENDATION_SOURCE_SCHEMA) fail("INVALID_SCHEMA", "recommendation source schema is unsupported");
  exact(source.cli, ["command", "entry"], "cli");
  boundedString(source.cli.command, "cli.command", 64);
  boundedString(source.cli.entry, "cli.entry", 128);
  exact(source.comparison, ["artifact_schema", "endpoint_source", "fields", "omits", "surface"], "comparison");
  if (source.comparison.artifact_schema !== COMPARISON_SCHEMA) fail("INVALID_SCHEMA", "comparison artifact schema is unsupported");
  boundedString(source.comparison.endpoint_source, "comparison.endpoint_source", 128);
  boundedString(source.comparison.surface, "comparison.surface", 64);
  stringList(source.comparison.fields, "comparison.fields");
  stringList(source.comparison.omits, "comparison.omits");
  stringList(source.cursor_first_families, "cursor_first_families");
  stringList(source.default_harness_order, "default_harness_order");
  if (source.parent_mutable !== false) fail("PARENT_MUTABLE", "parent model×effort must stay unchanged");
  if (source.quota_comparison !== "same-pool-only") fail("INVALID_SCHEMA", "quota comparison must stay same-pool-only");
  if (source.selector_thresholds !== "not-inherited") fail("INVALID_SCHEMA", "selector thresholds must stay not-inherited");
  if (!Array.isArray(source.pools) || source.pools.length < 1) fail("INVALID_SCHEMA", "pools are missing");
  if (!Array.isArray(source.families) || source.families.length < 1) fail("INVALID_SCHEMA", "families are missing");
  const poolIds = new Set();
  for (const pool of source.pools) validatePool(pool, poolIds);
  const familyIds = new Set();
  for (const family of source.families) validateFamily(family, familyIds, source);
  for (const family of source.cursor_first_families) {
    if (!familyIds.has(family)) fail("INVALID_SCHEMA", `cursor_first family ${family} is unknown`);
  }
  for (const pool of source.pools) {
    for (const member of pool.members) {
      if (member.state === "unsupported") continue;
      if (!familyIds.has(member.family)) fail("INVALID_SCHEMA", `pool member ${member.family} has no family`);
      if (member.state === "ranked") {
        const family = source.families.find((entry) => entry.id === member.family);
        const onPool = family.harnesses.some((harness) => harness.selectable && harness.pool_id === pool.id);
        if (!onPool) fail("INVALID_SCHEMA", `ranked member ${member.family} is not selectable on ${pool.id}`);
      }
    }
  }
  return source;
}

function validatePool(pool, poolIds) {
  exact(pool, ["absolute_cap", "id", "members", "programmatic", "unit", "window_ids"], "pool");
  identifier(pool.id, "pool.id");
  if (poolIds.has(pool.id)) fail("INVALID_SCHEMA", `duplicate pool ${pool.id}`);
  poolIds.add(pool.id);
  stringList(pool.window_ids, "pool.window_ids");
  boundedString(pool.unit, "pool.unit", 64);
  boundedString(pool.absolute_cap, "pool.absolute_cap", 64);
  boundedString(pool.programmatic, "pool.programmatic", 64);
  if (!Array.isArray(pool.members) || pool.members.length < 1) fail("INVALID_SCHEMA", "pool.members are missing");
  const seen = new Set();
  for (const member of pool.members) {
    exact(member, ["family", "state"], "pool.member");
    identifier(member.family, "pool.member.family");
    if (!["ranked", "catalog-unranked", "unsupported"].includes(member.state)) fail("INVALID_SCHEMA", "pool.member.state is invalid");
    if (seen.has(member.family)) fail("INVALID_SCHEMA", `duplicate pool member ${member.family}`);
    seen.add(member.family);
  }
}

function validateFamily(family, familyIds, source) {
  exact(family, ["harnesses", "id", "label", "none_is_valid_effort", "provider"], "family");
  identifier(family.id, "family.id");
  if (familyIds.has(family.id)) fail("INVALID_SCHEMA", `duplicate family ${family.id}`);
  familyIds.add(family.id);
  boundedString(family.label, "family.label", 64);
  identifier(family.provider, "family.provider");
  if (typeof family.none_is_valid_effort !== "boolean") fail("INVALID_SCHEMA", "none_is_valid_effort must be boolean");
  if (!Array.isArray(family.harnesses) || family.harnesses.length < 1) fail("INVALID_SCHEMA", "family.harnesses are missing");
  const harnessIds = new Set();
  let listsNone = false;
  for (const harness of family.harnesses) {
    exact(harness, ["aiterm_required", "effort_binding", "efforts", "execution", "features", "id", "model_id", "pool_id", "selectable"], "harness");
    identifier(harness.id, "harness.id");
    if (!source.default_harness_order.includes(harness.id)) fail("INVALID_SCHEMA", `harness ${harness.id} is outside default order`);
    if (harnessIds.has(harness.id)) fail("INVALID_SCHEMA", `duplicate harness ${harness.id} on ${family.id}`);
    harnessIds.add(harness.id);
    if (harness.aiterm_required !== false) fail("AITERM_IMPLIED", "harness selection must not require Aiterm");
    if (!BINDINGS.includes(harness.effort_binding)) fail("INVALID_SCHEMA", "effort_binding is invalid");
    if (!EXECUTIONS.includes(harness.execution)) fail("INVALID_SCHEMA", "execution is invalid");
    if (typeof harness.selectable !== "boolean") fail("INVALID_SCHEMA", "selectable must be boolean");
    if (harness.model_id !== null) identifier(harness.model_id, "harness.model_id");
    identifier(harness.pool_id, "harness.pool_id");
    if (!source.pools.some((pool) => pool.id === harness.pool_id)) fail("INVALID_SCHEMA", `unknown pool ${harness.pool_id}`);
    stringList(harness.features, "harness.features");
    if (!Array.isArray(harness.efforts)) fail("INVALID_SCHEMA", "harness.efforts must be an array");
    if (harness.effort_binding === "unsupported") {
      if (harness.efforts.length !== 0) fail("INVALID_SCHEMA", "unsupported effort binding lists efforts");
    } else if (harness.efforts.length === 0) {
      if (harness.selectable) fail("INVALID_SCHEMA", "selectable harness lists no efforts");
    } else {
      stringList(harness.efforts, "harness.efforts", EFFORTS);
      if (harness.efforts.includes("none")) listsNone = true;
    }
  }
  if (listsNone !== family.none_is_valid_effort) fail("EFFORT_NONE_MISMATCH", `${family.id} none validity does not match its harnesses`);
}

export function expandCatalog(source) {
  validateRecommendationSource(source);
  const candidates = [];
  for (const family of source.families) {
    for (const harness of family.harnesses) {
      const base = {
        family: family.id,
        label: family.label,
        provider: family.provider,
        harness: harness.id,
        pool_id: harness.pool_id,
        effort_binding: harness.effort_binding,
        model_id: harness.model_id,
        execution: harness.execution,
        selectable: harness.selectable,
        features: [...harness.features],
        implies_aiterm: false,
        none_is_valid_effort: family.none_is_valid_effort,
        cursor_priority: source.cursor_first_families.includes(family.id) && harness.id === "cursor-agent",
      };
      if (harness.effort_binding === "unsupported") {
        candidates.push({ ...base, effort: null, candidate_id: `${harness.id}/${family.id}/unsupported` });
      } else {
        for (const effort of harness.efforts) {
          candidates.push({ ...base, effort, candidate_id: `${harness.id}/${family.id}/${effort}` });
        }
      }
    }
  }
  candidates.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  if (new Set(candidates.map((entry) => entry.candidate_id)).size !== candidates.length) fail("INVALID_SCHEMA", "candidate ids collide");
  return {
    schema: MODEL_CANDIDATES_SCHEMA,
    source_digest: createHash("sha256").update(canonicalJson(source)).digest("hex"),
    cursor_first_families: [...source.cursor_first_families],
    default_harness_order: [...source.default_harness_order],
    pools: source.pools,
    families: source.families.map((family) => ({ id: family.id, label: family.label, provider: family.provider, none_is_valid_effort: family.none_is_valid_effort })),
    candidates,
  };
}

export function renderCandidateTable(catalog) {
  const lines = [
    "| family | harness | effort対応 | pool | 実行面 | 選択 |",
    "|---|---|---|---|---|---|",
  ];
  const groups = new Map();
  for (const candidate of catalog.candidates) {
    const key = `${candidate.family}\0${candidate.harness}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  for (const group of groups.values()) {
    const sample = group[0];
    const ordered = [...group].sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
    const effort = sample.effort_binding === "unsupported" ? "指定不可" : ordered.map((entry) => entry.effort).join(", ");
    lines.push(`| ${sample.label} | ${sample.harness} | ${sample.effort_binding}: ${effort} | ${sample.pool_id} | ${sample.execution} | ${sample.selectable ? "可" : "不可"} |`);
  }
  return lines.join("\n");
}

export function orderMatchingCandidates(catalog, family, effort) {
  const matches = catalog.candidates.filter((candidate) => candidate.selectable && candidate.family === family && candidate.effort === effort);
  const cursorFirst = catalog.cursor_first_families.includes(family);
  const order = catalog.default_harness_order;
  return [...matches].sort((a, b) => {
    if (cursorFirst && a.harness !== b.harness) {
      if (a.harness === "cursor-agent") return -1;
      if (b.harness === "cursor-agent") return 1;
    }
    return order.indexOf(a.harness) - order.indexOf(b.harness) || a.candidate_id.localeCompare(b.candidate_id);
  });
}

export function explicitSupport(catalog, request) {
  exact(request, ["effort", "family", "harness"], "explicit");
  identifier(request.family, "explicit.family");
  identifier(request.harness, "explicit.harness");
  const family = catalog.families.find((entry) => entry.id === request.family);
  if (!family) return { ok: false, code: "EXPLICIT_UNSUPPORTED" };
  if (request.effort === "none" && family.none_is_valid_effort !== true) return { ok: false, code: "EFFORT_NONE_INVALID" };
  if (request.effort !== null && !EFFORTS.includes(request.effort)) fail("INVALID_SCHEMA", "explicit effort is invalid");
  const found = catalog.candidates.find((candidate) => candidate.selectable && candidate.harness === request.harness && candidate.family === request.family && candidate.effort === request.effort);
  if (!found) return { ok: false, code: "EXPLICIT_UNSUPPORTED" };
  return { ok: true, candidate: found };
}

export function draftChildSelection(candidate) {
  return {
    schema: RESULT_SCHEMA,
    status: "recommended",
    parent_changed: false,
    recommendation: {
      candidate_id: candidate.candidate_id,
      harness: candidate.harness,
      family: candidate.family,
      model_id: candidate.model_id,
      effort_binding: candidate.effort_binding,
      effort: candidate.effort,
      pool_id: candidate.pool_id,
    },
    quota_comparison: "not_established",
  };
}

export function validateRecommendationResult(value) {
  exact(value, ["parent_changed", "quota_comparison", "recommendation", "schema", "status"], "recommendation-result");
  if (value.schema !== RESULT_SCHEMA) fail("INVALID_SCHEMA", "result schema is unsupported");
  if (!RESULT_STATUSES.includes(value.status)) fail("INVALID_SCHEMA", "result status is invalid");
  if (value.parent_changed !== false) fail("PARENT_MUTABLE", "result changes the parent");
  if (!["established", "not_established"].includes(value.quota_comparison)) fail("INVALID_SCHEMA", "quota_comparison is invalid");
  if (value.status === "recommended") {
    exact(value.recommendation, ["candidate_id", "effort", "effort_binding", "family", "harness", "model_id", "pool_id"], "recommendation");
  } else if (value.recommendation !== null) fail("INVALID_SCHEMA", "unsuccessful result carries a recommendation");
  return value;
}

function rankSection(markdown) {
  const start = markdown.indexOf("## 順位表");
  const end = markdown.indexOf("### 構造規則");
  if (start < 0 || end < 0 || end <= start) fail("RANK_TABLE_MISSING", "rank table section is missing");
  return markdown.slice(start, end);
}

const RANK_LABELS = Object.keys(FAMILY_LABELS).sort((left, right) => right.length - left.length);
const RANK_PROSE_TOKENS = new Set([
  "GDPval-AA", "APEX", "Terminal-Bench", "Web", "Claude", "gpt-connector",
  "high", "medium", "low", "xhigh", "max", "ultra", "none",
  "partial", "recall", "pin", "repo", "critical", "quota", "effort", "FP", "UI", "X",
]);

function rankLabelPattern(label) {
  return new RegExp(`(?<![A-Za-z0-9.])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9.])`, "g");
}

function labelsInRankCell(cell) {
  return RANK_LABELS.filter((label) => rankLabelPattern(label).test(cell));
}

function unknownRankTokens(cell) {
  let rest = cell.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/\*\*/g, "");
  for (const label of RANK_LABELS) rest = rest.replace(rankLabelPattern(label), " ");
  return (rest.match(/[A-Za-z][A-Za-z0-9.-]*/g) ?? []).filter((token) => {
    if (RANK_PROSE_TOKENS.has(token)) {
      return new RegExp(`(?:^|[\\/／])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9.])`).test(rest);
    }
    const prefix = RANK_LABELS.some((label) => label.startsWith(`${token} `) || label.startsWith(`${token}.`));
    if (!prefix) return true;
    const prose = new RegExp(`(?<![A-Za-z0-9./])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9./])`).test(rest);
    return !prose;
  });
}

export function coverRankTable(markdown, catalog) {
  const section = rankSection(markdown);
  const effortToken = "none|low|medium|high|xhigh|max|ultra";
  const pattern = new RegExp(`([A-Za-z0-9][A-Za-z0-9. ]*?)×(${effortToken})(?:（[^）]*）)?(?:〜(${effortToken}))?`, "g");
  const missing = [];
  for (const match of section.matchAll(pattern)) {
    const label = match[1].trim();
    const family = FAMILY_LABELS[label];
    if (!family) fail("RANK_LABEL_UNKNOWN", `rank label ${label} is not in the recommendation source`);
    for (const effort of [match[2], match[3]].filter(Boolean)) {
      if (orderMatchingCandidates(catalog, family, effort).length === 0) missing.push(`${label}×${effort}`);
    }
  }
  const rows = section.split("\n").filter((line) => line.startsWith("|")).slice(2);
  for (const row of rows) {
    for (const cell of row.split("|").slice(2, -1).map((entry) => entry.trim())) {
      if (!/[A-Za-z0-9]/.test(cell)) continue;
      const found = labelsInRankCell(cell);
      const unknown = unknownRankTokens(cell);
      if (found.length === 0 || unknown.length > 0) fail("RANK_LABEL_UNKNOWN", `rank cell has no known model: ${cell}`);
      for (const label of found) {
        const family = FAMILY_LABELS[label];
        if (!catalog.candidates.some((candidate) => candidate.selectable && candidate.family === family)) missing.push(label);
      }
      if (found.includes("Haiku") && cell.includes("effortなし")) {
        const haiku = catalog.candidates.find((candidate) => candidate.selectable && candidate.family === "claude-haiku-4.5" && candidate.effort_binding === "unsupported");
        if (!haiku) missing.push("Haiku effortなし");
      }
      if (found.includes("ChatGPT") && !catalog.candidates.some((candidate) => candidate.selectable && candidate.family === "chatgpt" && candidate.harness === "gpt-connector" && candidate.effort === null)) {
        missing.push("ChatGPT");
      }
    }
  }
  if (missing.length > 0) fail("RANK_UNCOVERED", `rank table is not expressible: ${missing.join(", ")}`);
  return true;
}

export function replaceMarked(markdown, start, end, replacement) {
  const marked = sliceMarked(markdown, start, end, start);
  return `${markdown.slice(0, marked.from + start.length)}\n${replacement}\n${markdown.slice(marked.to)}`;
}
