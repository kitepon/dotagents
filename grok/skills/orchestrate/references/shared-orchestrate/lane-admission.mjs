// GENERATED FILE: lib/orchestrate/lane-admission.mjs から生成。直接編集禁止。
// Typed lane admission (ADR 0114). Pure module: no I/O, no process, no network, no filesystem.
// The lane decision takes ONLY the four ADR 0061 condition booleans — never a string — so
// non-classifier behavior is guaranteed by the API boundary type, not by tests alone
// (ADR 0114 Decision 2). Evidence validation (repo paths, digests, timestamps) stays in
// control-record.mjs; this module owns nothing but the closed condition record and the
// lane decision derived from it.
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";

export const LANE_ADMISSION_CONTRACT_VERSION = "dotagents.lane-admission.v1";
export const LANE_ADMISSION_EVALUATION_SCHEMA = "dotagents.lane-admission-evaluation.v1";

// ADR 0061の4条件と1対1。増減はADR 0061の改訂だけが行える（ADR 0113 Decision 2）。
export const LANE_CONDITION_KEYS = Object.freeze([
  "planned_interruption",
  "chained_acceptance",
  "multi_repo_write_coordination",
  "decision_evidence_required",
]);

export class LaneAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LaneAdmissionError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new LaneAdmissionError(code, message); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Exact 4-key record of booleans. Unknown keys, missing keys, and non-boolean values are
// rejected; nothing else is ever read, so no string can influence the lane decision.
export function validateLaneConditions(value, name = "conditions") {
  if (!isObject(value)) fail("INVALID_CONDITIONS", `${name} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== LANE_CONDITION_KEYS.length || LANE_CONDITION_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail("INVALID_CONDITIONS", `${name} must have exactly the four ADR 0061 condition keys`);
  }
  for (const key of LANE_CONDITION_KEYS) {
    if (typeof value[key] !== "boolean") fail("INVALID_CONDITIONS", `${name}.${key} must be a boolean`);
  }
  return value;
}

// Fixed key order projection so digests never depend on caller key order.
export function normalizedLaneConditions(conditions) {
  validateLaneConditions(conditions);
  const normalized = {};
  for (const key of LANE_CONDITION_KEYS) normalized[key] = conditions[key];
  return normalized;
}

export function decideLane(conditions) {
  validateLaneConditions(conditions);
  return LANE_CONDITION_KEYS.some((key) => conditions[key]) ? "orchestrated" : "normal";
}

// Evaluation result (returned to callers / CLI; never persisted — ADR 0114 Decision 1).
// The digest binds {contract_version, lane, conditions} only: it is the statement-free
// decision identity, distinct from any stored-projection digest (ADR 0114 Decision 3).
export function evaluateLaneAdmission(conditions) {
  const normalized = normalizedLaneConditions(conditions);
  const lane = decideLane(normalized);
  const identity = { contract_version: LANE_ADMISSION_CONTRACT_VERSION, lane, conditions: normalized };
  return {
    schema_version: LANE_ADMISSION_EVALUATION_SCHEMA,
    contract_version: LANE_ADMISSION_CONTRACT_VERSION,
    lane,
    conditions: normalized,
    evaluation_digest: createHash("sha256").update(canonicalJson(identity)).digest("hex"),
  };
}
