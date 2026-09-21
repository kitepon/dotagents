// 実務比較 (hmer-006)。残量は収集レコードの remaining_bp だけを見る。
// 掲載先 path は docs/factory-current-state.md から読む。wire report へは送らない。
import { readFileSync } from "node:fs";

import { COMPARISON_SCHEMA, explicitSupport, orderMatchingCandidates } from "./recommendation-contract.mjs";

export { COMPARISON_SCHEMA };

const METRICS = Object.freeze(["success", "rework", "audit_effort", "total_tokens", "duration_seconds"]);
const OMITS = Object.freeze(["secret", "task_body", "cookie", "token"]);
const SURFACE = "servermanager-bughub-webui";
const ENDPOINT_SOURCE = "docs/factory-current-state.md";

export class RecommendationComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecommendationComparisonError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new RecommendationComparisonError(code, message); };

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an object`);
}

function exact(value, keys, name) {
  object(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("INVALID_SCHEMA", `${name} has invalid fields`);
}

function rejectOmitted(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectOmitted(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (OMITS.includes(key)) fail("COMPARISON_OMITTED_FIELD", `${key} is omitted from comparison`);
    rejectOmitted(value[key]);
  }
}

export function readBugHubEndpoint(markdown) {
  if (typeof markdown !== "string") fail("BUGHUB_ENDPOINT_UNREAD", "factory current state is not text");
  const line = markdown.split("\n").find((row) => row.startsWith("| 本番BugHub endpoint |"));
  const match = line?.match(/`([^`]+)`/);
  if (!match || !match[1].startsWith("/api/")) fail("BUGHUB_ENDPOINT_UNREAD", "factory current state has no BugHub endpoint");
  return match[1];
}

export function loadBugHubEndpoint(read = readFileSync) {
  const path = new URL("../../docs/factory-current-state.md", import.meta.url);
  return readBugHubEndpoint(read(path, "utf8"));
}

function poolRecord(quotas, poolId) {
  return quotas.find((row) => row.pool_id === poolId) ?? null;
}

function remainingBp(record) {
  if (!record || record.status !== "measured") return null;
  const bp = record.snapshot?.remaining_bp;
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) fail("INVALID_SCHEMA", `pool ${record.pool_id} remaining_bp is not basis points from the collector`);
  return bp;
}

function hasRoom(record) {
  const bp = remainingBp(record);
  return bp !== null && bp > 0;
}

function outcome(fields) {
  return {
    case_id: fields.case_id,
    status: fields.status,
    quota_comparison: fields.quota_comparison ?? "not_established",
    recommendation: fields.recommendation ?? null,
    reason: fields.reason,
    failure: fields.failure ?? null,
    pool_id: fields.pool_id ?? null,
    observed_at: fields.observed_at ?? null,
  };
}

function fromCandidate(candidate, record, caseId, reason) {
  return outcome({
    case_id: caseId,
    status: "recommended",
    quota_comparison: "established",
    recommendation: {
      candidate_id: candidate.candidate_id,
      harness: candidate.harness,
      family: candidate.family,
      effort: candidate.effort,
      pool_id: candidate.pool_id,
    },
    reason,
    pool_id: candidate.pool_id,
    observed_at: record.observed_at,
  });
}

function blocked(caseId, status, code, detail, record) {
  return outcome({
    case_id: caseId,
    status,
    reason: detail,
    failure: { code, detail },
    pool_id: record?.pool_id ?? null,
    observed_at: record?.observed_at ?? null,
  });
}

// 同じ pool の残量は候補がいくつでも1レコード。モデルを替えても枠は増えない。
export function recommendByRemaining(catalog, spec, quotas) {
  exact(spec, ["case_id", "family", "effort", "required_features", "explicit"], "comparison spec");
  if (typeof spec.case_id !== "string" || spec.case_id.length === 0) fail("INVALID_SCHEMA", "case_id is empty");
  if (!Array.isArray(spec.required_features) || !Array.isArray(quotas)) fail("INVALID_SCHEMA", "comparison lists are invalid");
  rejectOmitted(spec);
  rejectOmitted(quotas);
  if (spec.explicit !== null) {
    const support = explicitSupport(catalog, spec.explicit);
    if (!support.ok) return blocked(spec.case_id, "explicit_unsupported", support.code, support.code, null);
    const record = poolRecord(quotas, support.candidate.pool_id);
    const bp = remainingBp(record);
    if (bp === null) return blocked(spec.case_id, "observation_unavailable", "OBSERVATION_UNAVAILABLE", `pool ${support.candidate.pool_id} has no measured remaining`, record);
    if (bp === 0) return blocked(spec.case_id, "quota_exhausted", "QUOTA_EXHAUSTED", `pool ${support.candidate.pool_id} remaining_bp 0`, record);
    return fromCandidate(support.candidate, record, spec.case_id, `${support.candidate.candidate_id}; pool ${support.candidate.pool_id} measured; remaining_bp ${bp}`);
  }
  const features = spec.required_features;
  const ordered = orderMatchingCandidates(catalog, spec.family, spec.effort)
    .filter((candidate) => features.every((feature) => candidate.features.includes(feature)));
  if (ordered.length === 0) return blocked(spec.case_id, "no_candidate", "NO_MATCH", `no selectable candidate for ${spec.family} ${String(spec.effort)}`, null);
  const available = ordered.filter((candidate) => hasRoom(poolRecord(quotas, candidate.pool_id)));
  if (available.length === 0) {
    const first = poolRecord(quotas, ordered[0].pool_id);
    const exhausted = ordered.some((candidate) => remainingBp(poolRecord(quotas, candidate.pool_id)) === 0 || poolRecord(quotas, candidate.pool_id)?.status === "expired");
    if (exhausted) return blocked(spec.case_id, "quota_exhausted", "QUOTA_EXHAUSTED", `no remaining room for ${spec.family}`, first);
    return blocked(spec.case_id, "observation_unavailable", "OBSERVATION_UNAVAILABLE", `no measured remaining for ${spec.family}`, first);
  }
  const chosen = available[0];
  const record = poolRecord(quotas, chosen.pool_id);
  const bp = remainingBp(record);
  const skipped = ordered[0].candidate_id === chosen.candidate_id ? "" : `; skipped ${ordered[0].pool_id}`;
  return fromCandidate(chosen, record, spec.case_id, `${chosen.candidate_id}; pool ${chosen.pool_id} measured; remaining_bp ${bp}${skipped}`);
}

// 独立性は provider が2つ以上あるときだけ。ハーネス名の一致では決めない。
export function independentReview(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  return new Set(candidates.map((candidate) => candidate.provider)).size >= 2;
}

function metricValue(record, key) {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (key === "success" || key === "rework") {
    if (typeof value !== "boolean") fail("INVALID_SCHEMA", `${key} must be boolean when measured`);
    return value;
  }
  if (key === "audit_effort" || key === "total_tokens") {
    if (!Number.isInteger(value) || value < 0) fail("INVALID_SCHEMA", `${key} must be a non-negative integer when measured`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("INVALID_SCHEMA", "duration_seconds must be a non-negative number when measured");
  return value;
}

export function buildComparison(input) {
  exact(input, ["case_id", "endpoint", "records"], "comparison");
  if (typeof input.endpoint !== "string" || !input.endpoint.startsWith("/api/")) fail("INVALID_SCHEMA", "endpoint must be the current BugHub path");
  if (!Array.isArray(input.records)) fail("INVALID_SCHEMA", "records must be a list");
  rejectOmitted(input);
  const records = input.records.map((record) => {
    exact(record, ["candidate_id", "pool_id", "observed_at", ...METRICS.filter((key) => Object.hasOwn(record, key))], "comparison record");
    const missing = METRICS.filter((key) => !Object.hasOwn(record, key));
    const measured = {};
    for (const key of METRICS) {
      if (!Object.hasOwn(record, key)) continue;
      measured[key] = metricValue(record, key);
    }
    return {
      case_id: input.case_id,
      candidate_id: record.candidate_id,
      pool_id: record.pool_id,
      observed_at: record.observed_at,
      ...measured,
      missing,
    };
  });
  return {
    schema: COMPARISON_SCHEMA,
    surface: SURFACE,
    endpoint_source: ENDPOINT_SOURCE,
    endpoint: input.endpoint,
    omits: [...OMITS],
    records,
  };
}

export async function publishComparison(document, dependencies) {
  exact(document, ["schema", "surface", "endpoint_source", "endpoint", "omits", "records"], "published comparison");
  if (document.schema !== COMPARISON_SCHEMA) fail("INVALID_SCHEMA", "comparison schema is not the published schema");
  const endpointPath = readBugHubEndpoint(dependencies.currentState);
  if (document.endpoint !== endpointPath) fail("ENDPOINT_MISMATCH", "comparison endpoint is not the current BugHub path");
  let reporter;
  try { reporter = new URL(dependencies.reporterEndpoint); }
  catch { fail("ENDPOINT_MISMATCH", "reporter endpoint is not a URL"); }
  if (reporter.pathname !== endpointPath) fail("ENDPOINT_MISMATCH", "reporter endpoint path is not the current BugHub path");
  if (typeof dependencies.token !== "string" || dependencies.token.length === 0) fail("PUBLISH_UNAUTHORIZED", "factory credential is empty");
  const target = reporter;
  const response = await dependencies.request(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${dependencies.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  if (!response.ok) fail("PUBLISH_REJECTED", `comparison publish returned HTTP ${response.status}`);
  return { accepted: true, status: response.status, target: target.pathname };
}
