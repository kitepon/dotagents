import { spawn } from "node:child_process";
import { isWin32 } from '../platform.mjs';
import { createHash, randomUUID } from "node:crypto";
import { constants as FS, createReadStream } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { canonicalJson } from "./canonical-json.mjs";
import { createExecutorContractRegistry } from "./executor-contracts.mjs";
import {
  LANE_ADMISSION_CONTRACT_VERSION, LaneAdmissionError,
  decideLane, evaluateLaneAdmission, normalizedLaneConditions,
} from "./lane-admission.mjs";

const MANIFEST_SCHEMA_V25 = "dotagents.orchestration-control.v25";
const MANIFEST_SCHEMA_V26 = "dotagents.orchestration-control.v26";
const MANIFEST_SCHEMA_V27 = "dotagents.orchestration-control.v27";
const MANIFEST_SCHEMA_V28 = "dotagents.orchestration-control.v28";
const MANIFEST_SCHEMA_V29 = "dotagents.orchestration-control.v29";
const MANIFEST_SCHEMA_V30 = "dotagents.orchestration-control.v30";
const MANIFEST_SCHEMAS = Object.freeze([MANIFEST_SCHEMA_V25, MANIFEST_SCHEMA_V26, MANIFEST_SCHEMA_V27, MANIFEST_SCHEMA_V28, MANIFEST_SCHEMA_V29, MANIFEST_SCHEMA_V30]);
// Monotone capability predicates, never equality against a single version (ADR 0114 Decision 5;
// 旧: ADR 0054 refuter指摘: v26等値判定はv27を黙ってv25扱いする). Adding a version must never
// silently retire an existing capability.
const MANIFEST_SCHEMA_RANK = new Map(MANIFEST_SCHEMAS.map((schema, index) => [schema, index]));
const schemaAtLeast = (schemaVersion, floor) => MANIFEST_SCHEMA_RANK.get(schemaVersion) >= MANIFEST_SCHEMA_RANK.get(floor);
const typedConsultationSchema = (schemaVersion) => schemaAtLeast(schemaVersion, MANIFEST_SCHEMA_V26);
const explicitConsultationCancelSchema = (schemaVersion) => schemaAtLeast(schemaVersion, MANIFEST_SCHEMA_V27);
const selectorDecisionSchema = explicitConsultationCancelSchema;
const artifactGenerationSchema = (schemaVersion) => schemaAtLeast(schemaVersion, MANIFEST_SCHEMA_V28);
const laneAdmissionSchema = (schemaVersion) => schemaAtLeast(schemaVersion, MANIFEST_SCHEMA_V29);
const externalSourceSchema = (schemaVersion) => schemaAtLeast(schemaVersion, MANIFEST_SCHEMA_V30);
// control-migrate moves between adjacent versions only; no v25→v27 or v26→v28 shortcut exists.
const MIGRATION_EDGES = Object.freeze({
  [MANIFEST_SCHEMA_V25]: [MANIFEST_SCHEMA_V26],
  [MANIFEST_SCHEMA_V26]: [MANIFEST_SCHEMA_V25, MANIFEST_SCHEMA_V27],
  [MANIFEST_SCHEMA_V27]: [MANIFEST_SCHEMA_V26, MANIFEST_SCHEMA_V28],
  [MANIFEST_SCHEMA_V28]: [MANIFEST_SCHEMA_V27, MANIFEST_SCHEMA_V29],
  [MANIFEST_SCHEMA_V29]: [MANIFEST_SCHEMA_V28, MANIFEST_SCHEMA_V30],
  [MANIFEST_SCHEMA_V30]: [MANIFEST_SCHEMA_V29],
});
export const CONSULTATION_CONNECTORS_V26 = Object.freeze(["gpt-connector", "claude-native", "codex-sidecar"]);
const SELECTOR_DECISION_SCHEMA_ID = "dotagents.selector-decision.v1";
const OWNER_SCHEMA = "dotagents.orchestration-lock-owner.v1";
const MANIFEST_LIMIT = 1024 * 1024;
const OWNER_LIMIT = 1024;
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const FILES_LIMIT = 64 * 1024 * 1024;
const ARRAY_LIMIT = 256;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RESERVED_WRITER = new Set(["admitted", "dispatched", "running", "unknown"]);
const WORKER_NONTERMINAL = new Set(["planned", "admitted", "dispatched", "running", "unknown"]);
const CONSULT_NONTERMINAL = new Set(["planned", "dispatched", "running", "unknown"]);
const WORKER_TERMINAL = new Set(["completed", "failed", "cancelled"]);
// cancelled is v27-only; v26以下はstate enum検証で出現不能なので無条件追加で挙動不変（ADR 0054）。
const CONSULT_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const OPAQUE_HANDLE_LIMIT = 4096;
const OPAQUE_HANDLE_DEPTH = 4;
const DELEGATION_PACKET_SCHEMA = "dotagents.delegation-packet.v1";
const WORKER_REPORT_SCHEMA = "dotagents.worker-report.v1";
const WORKER_REPORT_SKELETON_SCHEMA = "dotagents.worker-report-skeleton.v1";
const WORKER_REPORT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const PHASE_GATE_ID = "phase-gate";
const PHASE_ORDER = ["baseline", "discovery", "design", "safety_net", "implementation", "behavior_change", "integration", "knowledge_return", "complete"];

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ROLE_EFFECT_POLICY = Object.freeze({
  policy_version: "dotagents.role-effect.v1",
  read_only_roles: Object.freeze(["refuter", "sorter", "verifier"]),
  approval_required_write_roles: Object.freeze(["integrator"]),
});
const DURABILITY_PROTOCOL = Object.freeze({ protocol_version: "fsync-rename-fsync.v1", file_sync: "required", directory_sync: "required", atomic_rename: "required" });

export class ControlRecordError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ControlRecordError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new ControlRecordError(code, message, details); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const rejectSynchronousHandle = () => fail("INVALID_SCHEMA", "synchronous sidecar workflow cannot have a durable handle");
const parentHandle = (value) => { exact(value, ["correlation_id"], "executor_handle"); identifier(value.correlation_id, "executor_handle.correlation_id"); };
const nativeHandle = (value) => { exact(value, ["agent_path"], "executor_handle"); string(value.agent_path, "executor_handle.agent_path", 1024); if (!/^\/root(?:\/[a-z0-9_]+)+$/.test(value.agent_path)) fail("INVALID_SCHEMA", "executor_handle.agent_path is not canonical"); };
const sidecarHandle = (value) => { exact(value, ["idempotency_key"], "executor_handle"); string(value.idempotency_key, "executor_handle.idempotency_key"); if (!/^(?:[A-Za-z0-9_-]{22,128}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value.idempotency_key)) fail("INVALID_SCHEMA", "executor_handle.idempotency_key is not accepted by codex-sidecar"); };
const aitermHandle = (value) => { exact(value, ["session_id", "agent_kind"], "executor_handle"); identifier(value.session_id, "executor_handle.session_id"); oneOf(value.agent_kind, ["codex", "grok", "composer"], "executor_handle.agent_kind"); };
const claudeHandle = (value) => {
  exact(value, ["session_id"], "executor_handle");
  string(value.session_id, "executor_handle.session_id", 64);
  if (!UUID_RE.test(value.session_id)) fail("INVALID_SCHEMA", "executor_handle.session_id is not a UUID");
};
const noCapabilityConstraint = () => {};
const sidecarReadonlyCapabilities = (capabilities) => { if (capabilityValue(capabilities, "workspace.write") !== "false" || capabilityValue(capabilities, "readonly.enforceable") !== "true") fail("CAPABILITY_MISMATCH", "codex-sidecar synchronous read-only workflow capability snapshot is invalid"); };
const sidecarWorkCapabilities = (capabilities) => { if (capabilityValue(capabilities, "workspace.write") !== "true" || capabilityValue(capabilities, "workspace.isolated") !== "true") fail("CAPABILITY_MISMATCH", "codex-sidecar durable work capability snapshot is invalid"); };
const executorContract = (adapter_id, workflow_id, handle_schema_id, external, nullable_handle, active_handle_required, validate_handle, validate_capabilities = noCapabilityConstraint) => ({ adapter_id, contract_version: "v1", workflow_id, handle_schema_id, external, nullable_handle, active_handle_required, validate_handle, validate_capabilities });
export const EXECUTOR_CONTRACT_REGISTRY = createExecutorContractRegistry([
  executorContract("parent", "direct", "parent.correlation.v1", false, false, true, parentHandle),
  executorContract("codex-native", "native-subagent", "codex-native.agent-path.v1", false, true, true, nativeHandle),
  ...["auditor", "explore", "generate", "opinion", "review", "risk-check"].map((workflow) => executorContract("codex-sidecar", workflow, "codex-sidecar.synchronous.v1", true, true, false, rejectSynchronousHandle, sidecarReadonlyCapabilities)),
  executorContract("codex-sidecar", "work", "codex-sidecar.idempotency-key.v1", true, false, true, sidecarHandle, sidecarWorkCapabilities),
  executorContract("aiterm", "interactive-session", "aiterm.session.v1", true, true, true, aitermHandle),
  executorContract("claude-native", "native-subagent", "claude-native.session.v1", true, true, true, claudeHandle),
]);

function exact(value, keys, name, code = "INVALID_SCHEMA") {
  if (!isObject(value)) fail(code, `${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${name} has invalid fields`);
  }
  return value;
}

function exactOptional(value, required, optional, name, code = "INVALID_SCHEMA") {
  if (!isObject(value)) fail(code, `${name} must be an object`);
  for (const key of required) if (!own(value, key)) fail(code, `${name}.${key} is required`);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code, `${name} has invalid fields`);
  return value;
}

function string(value, name, max = 128, { nonempty = true, nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || (nonempty && value.length === 0) || value.length > max || value.includes("\0")) {
    fail("INVALID_SCHEMA", `${name} must be a bounded string`);
  }
  return value;
}

function identifier(value, name) {
  string(value, name);
  if (!ID_RE.test(value) || value === "." || value === "..") fail("INVALID_SCHEMA", `${name} is not a valid identifier`);
  return value;
}

function integer(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail("INVALID_SCHEMA", `${name} must be a safe integer`);
  return value;
}

function nullableInteger(value, name, { min = 0 } = {}) {
  if (value === null) return value;
  return integer(value, name, { min });
}

function oneOf(value, values, name) {
  if (!values.includes(value)) fail("INVALID_SCHEMA", `${name} is invalid`);
  return value;
}

function timestamp(value, name) {
  string(value, name, 128);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) fail("INVALID_SCHEMA", `${name} must be canonical ISO-8601`);
  return value;
}

function boundedArray(value, name, validator, { min = 0 } = {}) {
  if (!Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an array`);
  if (value.length < min) fail("INVALID_SCHEMA", `${name} must contain at least ${min} entries`);
  if (value.length > ARRAY_LIMIT) fail("LIMIT_EXCEEDED", `${name} exceeds ${ARRAY_LIMIT} entries`);
  value.forEach((entry, index) => validator(entry, `${name}[${index}]`));
  return value;
}

function uniqueStringArray(value, name, validator, { min = 0 } = {}) {
  boundedArray(value, name, validator, { min });
  if (new Set(value).size !== value.length) fail("INVALID_SCHEMA", `${name} contains duplicates`);
  return value;
}

// Exported so quota-snapshot / selector digests share the exact canonicalization (ADR 0054).
// The definition lives in canonical-json.mjs so the pure lane-admission module can import it
// without a cycle (ADR 0114); this re-export keeps every existing consumer path stable.
export { canonicalJson };

function taskAdmissionDigest(value) {
  const snapshot = structuredClone(value);
  delete snapshot.admission_digest;
  // ADR 0116 Decision 2: a null external_source is digest-equivalent to key absence, so the
  // v29→v30 migration (which stamps null onto every stored task) never rewrites acceptance
  // evidence. Non-null bindings stay inside the digest and are immutable with the task.
  if (snapshot.external_source === null) delete snapshot.external_source;
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

// ADR 0116 Decision 1: closed external-source tuple. Exactly four keys, no free-form metadata,
// no copy of external labels/state/dependencies. null means the direct path (no binding).
function validateExternalSource(value, name = "task.external_source") {
  if (value === null) return;
  exact(value, ["namespace", "contract_version", "external_id", "immutable_digest"], name);
  identifier(value.namespace, `${name}.namespace`);
  string(value.contract_version, `${name}.contract_version`, 256);
  repoPath(value.external_id, `${name}.external_id`);
  if (!SHA256_RE.test(value.immutable_digest)) fail("INVALID_SCHEMA", `${name}.immutable_digest is invalid`);
}

function repoPath(value, name) {
  string(value, name, 1024);
  const normalized = value.normalize("NFC");
  // Repository paths are literal, not glob expressions. Square brackets are
  // nevertheless ordinary path characters (for example Next.js route segments).
  if (normalized !== value || isAbsolute(value) || value.includes("\\") || /[*?{}]/.test(value)) {
    fail("INVALID_SCHEMA", `${name} is not a canonical repository-relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("INVALID_SCHEMA", `${name} is not a literal path`);
  return value;
}

function immutableDecisionRef(value, name) {
  repoPath(value, name);
  if (!/^docs\/adr\/[^/]+\.md$/u.test(value)) {
    fail("DECISION_EVIDENCE_NOT_IMMUTABLE", `${name} must reference an immutable docs/adr Markdown file`);
  }
  return value;
}

const nullableRef = (value, name) => value === null ? value : repoPath(value, name);
const refs = (value, name, min = 0) => boundedArray(value, name, (entry, entryName) => repoPath(entry, entryName), { min });

function validateEvidence(value, name = "evidence") {
  exact(value, ["type", "ref", "digest", "observed_at"], name);
  oneOf(value.type, ["file", "command", "url", "executor-receipt", "decision"], `${name}.type`);
  if (["file", "decision"].includes(value.type)) repoPath(value.ref, `${name}.ref`);
  else if (value.type === "url") {
    string(value.ref, `${name}.ref`, 1024);
    let parsed; try { parsed = new URL(value.ref); } catch { fail("INVALID_SCHEMA", `${name}.ref must be an https URL`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail("INVALID_SCHEMA", `${name}.ref must be an https URL without credentials`);
  } else string(value.ref, `${name}.ref`, 1024);
  if (!SHA256_RE.test(value.digest)) fail("INVALID_SCHEMA", `${name}.digest is invalid`);
  timestamp(value.observed_at, `${name}.observed_at`);
  return value;
}

const evidenceArray = (value, name, min = 0) => boundedArray(value, name, validateEvidence, { min });

// --- typed lane admission (ADR 0114) ---
// The pure condition/lane logic lives in lane-admission.mjs; here we only add evidence and
// actor-correlation validation, translating LaneAdmissionError into this module's error codes.
const laneConditions = (value, name, code) => {
  try { return normalizedLaneConditions(value); }
  catch (error) {
    if (error instanceof LaneAdmissionError) fail(code, error.message);
    throw error;
  }
};

// init input declaration (ADR 0114 Decision 1): contract version + closed conditions + a
// type=decision evidence pointing at the docs-owned rationale. No free-form reason text —
// the rationale canon stays in docs/git (ADR 0113 Decision 3).
function validateLaneAdmissionDeclaration(value, name = "input.lane_admission") {
  exact(value, ["contract_version", "conditions", "decision"], name, "INVALID_INPUT");
  if (value.contract_version !== LANE_ADMISSION_CONTRACT_VERSION) fail("INVALID_INPUT", `${name}.contract_version must be ${LANE_ADMISSION_CONTRACT_VERSION}`);
  laneConditions(value.conditions, `${name}.conditions`, "INVALID_INPUT");
  validateEvidence(value.decision, `${name}.decision`);
  if (value.decision.type !== "decision") fail("INVALID_INPUT", `${name}.decision must be decision evidence`);
}

// Stored projection (ADR 0114 Decision 1/3): conditions + decision evidence + actor/time bound
// to the control declaration. No lane field — the Control's existence IS "orchestrated".
function validateStoredLaneAdmission(manifest) {
  const value = manifest.lane_admission;
  const migratedIntoV29 = manifest.transition_receipts.some((receipt) => receipt.operation === "control-migrate" && receipt.next_state === MANIFEST_SCHEMA_V29);
  if (value === null) {
    // null is the migration-produced shape only; an init-created v29 control always binds admission.
    if (!migratedIntoV29) fail("INVALID_SCHEMA", "lane admission may be null only on a control migrated into v29");
    return;
  }
  exact(value, ["contract_version", "conditions", "decision", "declared_by", "declared_at"], "manifest.lane_admission");
  if (value.contract_version !== LANE_ADMISSION_CONTRACT_VERSION) fail("INVALID_SCHEMA", `manifest.lane_admission.contract_version must be ${LANE_ADMISSION_CONTRACT_VERSION}`);
  const conditions = laneConditions(value.conditions, "manifest.lane_admission.conditions", "INVALID_SCHEMA");
  if (decideLane(conditions) !== "orchestrated") fail("INVALID_SCHEMA", "stored lane admission must satisfy at least one ADR 0061 condition");
  validateEvidence(value.decision, "manifest.lane_admission.decision");
  if (value.decision.type !== "decision") fail("INVALID_SCHEMA", "manifest.lane_admission.decision must be decision evidence");
  // Actor correlation (ADR 0114 Decision 3): the declarer is the init actor, at init time.
  if (value.declared_by !== manifest.declaration.created_by) fail("INVALID_SCHEMA", "lane admission declarer differs from control creator");
  if (value.declared_at !== manifest.declaration.created_at) fail("INVALID_SCHEMA", "lane admission declaration time differs from control creation");
}

function decodeUtf8(buffer, code, message) {
  try { return UTF8_DECODER.decode(buffer); } catch { fail(code, message); }
}

function injectTestFault(point) {
  if (process.env.NODE_ENV === "test" && process.env.DOTAGENTS_ORCHESTRATE_TEST_FAULT === point) {
    const error = new Error(`injected fault: ${point}`); error.code = "EIO"; throw error;
  }
}

export function normalizeScope(entry) {
  try {
    exact(entry, ["kind", "path"], "scope", "INVALID_SCOPE");
    if (!new Set(["file", "directory"]).has(entry.kind)) fail("INVALID_SCOPE", "scope.kind is invalid");
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.length > 1024 || entry.path.includes("\0")) fail("INVALID_SCOPE", "scope.path is invalid");
    const normalized = entry.path.normalize("NFC");
    // `[` and `]` are valid literal filename characters and are required by
    // frameworks such as Next.js (`app/[gameId]/page.tsx`). Scope entries are
    // compared as literal paths, so only actual wildcard operators stay banned.
    if (normalized !== entry.path || isAbsolute(normalized) || normalized.includes("\\") || /[*?{}]/.test(normalized)) fail("INVALID_SCOPE", "scope.path is invalid");
    if (normalized.split("/").some((part) => !part || part === "." || part === "..")) fail("INVALID_SCOPE", "scope.path is invalid");
    return { kind: entry.kind, path: normalized };
  } catch (error) {
    if (error instanceof ControlRecordError && error.code !== "INVALID_SCOPE") fail("INVALID_SCOPE", error.message);
    throw error;
  }
}

function foldPath(value) {
  return process.platform === "linux" ? value : value.toLocaleLowerCase("en-US");
}

export function scopesOverlap(left, right) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  const ap = foldPath(a.path);
  const bp = foldPath(b.path);
  if (ap === bp) return true;
  if (a.kind === "directory" && bp.startsWith(`${ap}/`)) return true;
  if (b.kind === "directory" && ap.startsWith(`${bp}/`)) return true;
  return false;
}

function validateScopeArray(value, name, min = 0) {
  boundedArray(value, name, (entry) => normalizeScope(entry), { min });
  return value;
}

function validateDeclaration(value) {
  exact(value, ["objective_ref", "project_root_realpath", "common_dir_realpath", "git_dir_realpath", "git_dir_file_id", "base_sha", "initial_dirty", "initial_status_digest", "initial_workspace_digest", "created_at", "created_by"], "declaration");
  repoPath(value.objective_ref, "declaration.objective_ref");
  if (value.project_root_realpath !== null) string(value.project_root_realpath, "declaration.project_root_realpath", 4096);
  string(value.common_dir_realpath, "declaration.common_dir_realpath", 4096);
  string(value.git_dir_realpath, "declaration.git_dir_realpath", 4096);
  string(value.git_dir_file_id, "declaration.git_dir_file_id", 128);
  if (!/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value.git_dir_file_id)) fail("INVALID_SCHEMA", "declaration.git_dir_file_id is invalid");
  if (value.base_sha !== null && !SHA1_RE.test(value.base_sha)) fail("INVALID_SCHEMA", "declaration.base_sha is invalid");
  if (typeof value.initial_dirty !== "boolean") fail("INVALID_SCHEMA", "declaration.initial_dirty must be boolean");
  if (value.initial_status_digest !== null && !SHA256_RE.test(value.initial_status_digest)) fail("INVALID_SCHEMA", "declaration.initial_status_digest is invalid");
  if (value.initial_workspace_digest !== null && !SHA256_RE.test(value.initial_workspace_digest)) fail("INVALID_SCHEMA", "declaration.initial_workspace_digest is invalid");
  if (value.project_root_realpath === null && (value.initial_dirty !== false || value.initial_status_digest !== null || value.initial_workspace_digest !== null)) fail("INVALID_SCHEMA", "bare declaration cannot be dirty");
  timestamp(value.created_at, "declaration.created_at");
  string(value.created_by, "declaration.created_by");
}

function validateContinuation(value, controlId) {
  exact(value, ["predecessor_control_id", "root_control_id", "sequence"], "continuation");
  if (value.predecessor_control_id !== null) identifier(value.predecessor_control_id, "continuation.predecessor_control_id");
  identifier(value.root_control_id, "continuation.root_control_id");
  integer(value.sequence, "continuation.sequence");
  if (value.sequence === 0 && (value.predecessor_control_id !== null || value.root_control_id !== controlId)) fail("INVALID_SCHEMA", "root continuation is invalid");
  if (value.sequence > 0 && (value.predecessor_control_id === null || value.predecessor_control_id === controlId)) fail("INVALID_SCHEMA", "successor continuation is invalid");
}

function validateDurability(value) {
  exact(value, ["protocol_version", "file_sync", "directory_sync", "atomic_rename"], "durability");
  if (JSON.stringify(value) !== JSON.stringify(DURABILITY_PROTOCOL)) fail("INVALID_SCHEMA", "durability protocol snapshot is invalid");
}

function validateContextPolicy(value, name) {
  exact(value, ["share_objective", "share_current_candidate", "share_existing_findings", "share_failed_approaches", "share_test_results"], name);
  for (const [key, current] of Object.entries(value)) if (typeof current !== "boolean") fail("INVALID_SCHEMA", `${name}.${key} must be boolean`);
}

function validateApprovalSnapshot(value, name = "approval") {
  exact(value, ["approval_ref", "purpose", "impact", "rollback", "operation_digest", "approved_by", "approved_at", "expires_at"], name);
  repoPath(value.approval_ref, `${name}.approval_ref`);
  string(value.purpose, `${name}.purpose`, 4096);
  string(value.impact, `${name}.impact`, 4096);
  string(value.rollback, `${name}.rollback`, 4096);
  if (!SHA256_RE.test(value.operation_digest)) fail("INVALID_SCHEMA", `${name}.operation_digest is invalid`);
  string(value.approved_by, `${name}.approved_by`);
  timestamp(value.approved_at, `${name}.approved_at`);
  if (value.expires_at !== null) {
    timestamp(value.expires_at, `${name}.expires_at`);
    if (Date.parse(value.expires_at) <= Date.parse(value.approved_at)) fail("INVALID_SCHEMA", `${name}.expires_at must be after approved_at`);
  }
}

function validateRoleEffectPolicy(value) {
  exact(value, ["policy_version", "read_only_roles", "approval_required_write_roles"], "role_effect_policy");
  if (value.policy_version !== ROLE_EFFECT_POLICY.policy_version) fail("INVALID_SCHEMA", "role effect policy version is unsupported");
  uniqueStringArray(value.read_only_roles, "role_effect_policy.read_only_roles", (entry, name) => identifier(entry, name));
  uniqueStringArray(value.approval_required_write_roles, "role_effect_policy.approval_required_write_roles", (entry, name) => identifier(entry, name));
  if (JSON.stringify(value) !== JSON.stringify(ROLE_EFFECT_POLICY)) fail("INVALID_SCHEMA", "role effect policy snapshot is invalid");
}

function enforceRoleEffectPolicy(task, policy) {
  if (task.effect === "write" && policy.read_only_roles.includes(task.role)) fail("ROLE_EFFECT_FORBIDDEN", `${task.role} is read-only`);
  if (task.effect === "write" && policy.approval_required_write_roles.includes(task.role) && task.classification !== "H") {
    fail("ROLE_EFFECT_FORBIDDEN", `${task.role} write requires an H approval snapshot`);
  }
}

function validateTask(value, stored = true, externalSource = false) {
  const keys = ["task_id", "title", "classification", "effect", "doc_ref", "role", "lane", "depends_on", "required_capabilities", "isolation", "context_policy", "validation", "non_goals", "known_traps", "read_scope", "write_scope", "approval", "alternative_group", ...(stored ? ["admission_digest"] : [])];
  // Version-aware task shape (ADR 0116 Decision 1): v25-v29 tasks do not carry the
  // external_source key at all — absence IS their canonical shape; v30 requires it (null =
  // direct path). The input stage passes null here because the manifest version is unknown
  // until the mutation callback runs (selector_decision precedent).
  if (externalSource === true) exact(value, [...keys, "external_source"], "task");
  else if (externalSource === false) exact(value, keys, "task");
  else exactOptional(value, keys, ["external_source"], "task");
  if (own(value, "external_source")) validateExternalSource(value.external_source);
  identifier(value.task_id, "task.task_id");
  string(value.title, "task.title", 4096);
  oneOf(value.classification, ["F", "A", "H"], "task.classification");
  oneOf(value.effect, ["read", "write"], "task.effect");
  repoPath(value.doc_ref, "task.doc_ref");
  identifier(value.role, "task.role");
  oneOf(value.lane, ["behavior-preserving", "behavior-change", "not-applicable"], "task.lane");
  uniqueStringArray(value.depends_on, "task.depends_on", (entry, name) => identifier(entry, name));
  uniqueStringArray(value.required_capabilities, "task.required_capabilities", (entry, name) => identifier(entry, name));
  oneOf(value.isolation, ["none", "dedicated-worktree"], "task.isolation");
  validateContextPolicy(value.context_policy, "task.context_policy");
  uniqueStringArray(value.validation, "task.validation", (entry, name) => string(entry, name, 4096), { min: 1 });
  uniqueStringArray(value.non_goals, "task.non_goals", (entry, name) => string(entry, name, 4096));
  uniqueStringArray(value.known_traps, "task.known_traps", (entry, name) => string(entry, name, 4096));
  validateScopeArray(value.read_scope, "task.read_scope");
  validateScopeArray(value.write_scope, "task.write_scope", value.effect === "write" ? 1 : 0);
  if (value.effect !== "write" && value.write_scope.length !== 0) fail("INVALID_SCHEMA", "non-write task cannot have write scope");
  if (value.approval !== null) validateApprovalSnapshot(value.approval, "task.approval");
  if ((value.classification === "H") !== (value.approval !== null)) fail("INVALID_SCHEMA", "only H task requires an approval snapshot");
  if (value.alternative_group !== null) identifier(value.alternative_group, "task.alternative_group");
  if (stored && (!SHA256_RE.test(value.admission_digest) || value.admission_digest !== taskAdmissionDigest(value))) fail("INVALID_SCHEMA", "task.admission_digest is invalid");
}

function validateVerification(value, name = "execution_verification") {
  exact(value, ["stage", "observed_version", "observed_at", "evidence"], name);
  oneOf(value.stage, ["unverified", "installed", "registered", "verified", "execution-verified"], `${name}.stage`);
  string(value.observed_version, `${name}.observed_version`);
  timestamp(value.observed_at, `${name}.observed_at`);
  validateEvidence(value.evidence, `${name}.evidence`);
}

function validateLineage(value) {
  exact(value, ["parent_worker_run_id", "root_assignment_id", "provider", "model", "prompt_family", "independence_group", "context_policy", "input_digest", "approach_family_ref", "shared_artifact_ids"], "lineage");
  if (value.parent_worker_run_id !== null) identifier(value.parent_worker_run_id, "lineage.parent_worker_run_id");
  identifier(value.root_assignment_id, "lineage.root_assignment_id");
  string(value.provider, "lineage.provider"); string(value.model, "lineage.model");
  identifier(value.prompt_family, "lineage.prompt_family"); identifier(value.independence_group, "lineage.independence_group");
  validateContextPolicy(value.context_policy, "lineage.context_policy");
  if (!SHA256_RE.test(value.input_digest)) fail("INVALID_SCHEMA", "lineage.input_digest is invalid");
  if (value.approach_family_ref !== null) identifier(value.approach_family_ref, "lineage.approach_family_ref");
  uniqueStringArray(value.shared_artifact_ids, "lineage.shared_artifact_ids", (entry, name) => identifier(entry, name));
}

function validateWorkflowCapabilities(value, name = "workflow_capabilities") {
  boundedArray(value, name, (entry, entryName) => {
    exact(entry, ["capability_id", "value", "evidence"], entryName);
    identifier(entry.capability_id, `${entryName}.capability_id`);
    oneOf(entry.value, ["true", "false", "unknown"], `${entryName}.value`);
    if (entry.evidence === null) {
      if (entry.value !== "unknown") fail("INVALID_SCHEMA", `${entryName}.evidence is required for known capability values`);
    } else validateEvidence(entry.evidence, `${entryName}.evidence`);
  }, { min: 1 });
  const ids = value.map((entry) => entry.capability_id);
  if (new Set(ids).size !== ids.length) fail("INVALID_SCHEMA", `${name} contains duplicates`);
  const sorted = [...ids].sort();
  if (ids.some((entry, index) => entry !== sorted[index])) fail("INVALID_SCHEMA", `${name} must be sorted by capability_id`);
}

function validateTriStateObservation(value, name) {
  exact(value, ["value", "evidence"], name);
  oneOf(value.value, ["true", "false", "unknown"], `${name}.value`);
  if (value.evidence === null) {
    if (value.value !== "unknown") fail("INVALID_SCHEMA", `${name}.evidence is required for known values`);
  } else validateEvidence(value.evidence, `${name}.evidence`);
}

function validateCapacityNumber(value, name, min) {
  exact(value, ["knowledge", "value", "evidence"], name);
  oneOf(value.knowledge, ["known", "unknown"], `${name}.knowledge`);
  if (value.knowledge === "unknown") {
    if (value.value !== null) fail("INVALID_SCHEMA", `${name} unknown value must not claim numeric data`);
    if (value.evidence !== null) validateEvidence(value.evidence, `${name}.evidence`);
    return;
  }
  integer(value.value, `${name}.value`, { min });
  if (value.evidence === null) fail("INVALID_SCHEMA", `${name}.evidence is required for known values`);
  validateEvidence(value.evidence, `${name}.evidence`);
}

function validateCapacityObservation(value, name) {
  exact(value, ["admission", "hard_inflight_limit", "soft_inflight_limit", "observed_inflight"], name);
  validateTriStateObservation(value.admission, `${name}.admission`);
  validateCapacityNumber(value.hard_inflight_limit, `${name}.hard_inflight_limit`, 1);
  validateCapacityNumber(value.soft_inflight_limit, `${name}.soft_inflight_limit`, 1);
  validateCapacityNumber(value.observed_inflight, `${name}.observed_inflight`, 0);
  if (value.hard_inflight_limit.knowledge === "known" && value.soft_inflight_limit.knowledge === "known" && value.soft_inflight_limit.value > value.hard_inflight_limit.value) {
    fail("INVALID_SCHEMA", `${name}.soft_inflight_limit exceeds hard limit`);
  }
}

function validateRegistryObservation(value) {
  exact(value, ["registry_observation_id", "executor", "workflow_id", "enabled", "workflow_capabilities", "capacity", "verification", "expires_at"], "registry_observation");
  identifier(value.registry_observation_id, "registry_observation.registry_observation_id");
  validateExecutorEnvelope(value.executor);
  if (value.executor.adapter_id === "gpt-connector") fail("EXECUTOR_FORBIDDEN", "gpt-connector is consultation-only");
  identifier(value.workflow_id, "registry_observation.workflow_id");
  validateTriStateObservation(value.enabled, "registry_observation.enabled");
  validateWorkflowCapabilities(value.workflow_capabilities, "registry_observation.workflow_capabilities");
  validateCapacityObservation(value.capacity, "registry_observation.capacity");
  validateVerification(value.verification, "registry_observation.verification");
  timestamp(value.expires_at, "registry_observation.expires_at");
  const observationEvidence = [
    value.enabled.evidence,
    ...value.workflow_capabilities.map((entry) => entry.evidence),
    value.capacity.admission.evidence,
    value.capacity.hard_inflight_limit.evidence,
    value.capacity.soft_inflight_limit.evidence,
    value.capacity.observed_inflight.evidence,
    value.verification.evidence,
  ].filter((entry) => entry !== null);
  if (observationEvidence.some((entry) => Date.parse(entry.observed_at) > Date.parse(value.verification.observed_at))) fail("INVALID_SCHEMA", "registry evidence is newer than observation snapshot");
  if (Date.parse(value.expires_at) <= Date.parse(value.verification.observed_at)) fail("INVALID_SCHEMA", "registry observation expiry must be after observation");
}

function validatePlacementCandidate(value, name) {
  exact(value, ["candidate_id", "registry_observation_id", "assignment_id", "workspace_cwd", "workspace_binding", "write_mode", "operation_digest", "budget_reservation", "lineage", "fallback", "executor_handle"], name);
  identifier(value.candidate_id, `${name}.candidate_id`);
  identifier(value.registry_observation_id, `${name}.registry_observation_id`);
  identifier(value.assignment_id, `${name}.assignment_id`);
  string(value.workspace_cwd, `${name}.workspace_cwd`, 4096);
  oneOf(value.workspace_binding, ["fixed", "executor-isolated"], `${name}.workspace_binding`);
  oneOf(value.write_mode, ["none", "direct", "isolated-alternative"], `${name}.write_mode`);
  if (value.operation_digest !== null && !SHA256_RE.test(value.operation_digest)) fail("INVALID_SCHEMA", `${name}.operation_digest is invalid`);
  validateBudgetReservation(value.budget_reservation, `${name}.budget_reservation`);
  validateLineage(value.lineage);
  validateFallback(value.fallback, `${name}.fallback`);
  validateOpaqueHandleValue(value.executor_handle, `${name}.executor_handle`);
}

function placementCandidateDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function workerDispatchCorrelationDigest(run) {
  return createHash("sha256").update(canonicalJson({
    worker_run_id: run.worker_run_id,
    executor: run.executor,
    workflow_id: run.workflow_id,
    executor_handle: run.executor_handle,
  })).digest("hex");
}

function materializedPlacementCandidate(run, registryObservationId) {
  return {
    candidate_id: run.worker_run_id,
    registry_observation_id: registryObservationId,
    assignment_id: run.assignment_id,
    workspace_cwd: run.workspace.worktree_root_realpath ?? run.workspace.git_dir_realpath,
    workspace_binding: run.workspace_binding.mode,
    write_mode: run.write_mode,
    operation_digest: run.operation_digest,
    budget_reservation: structuredClone(run.budget_reservation),
    lineage: structuredClone(run.lineage),
    fallback: structuredClone(run.fallback),
    executor_handle: structuredClone(run.executor_handle),
    recorded_workspace_fingerprint: structuredClone(run.recorded_workspace_fingerprint),
  };
}

function manualWorkerCreationDigest(run) {
  const declaration = {
    worker_run_id: run.worker_run_id,
    task_id: run.task_id,
    assignment_id: run.assignment_id,
    lineage: structuredClone(run.lineage),
    fallback: structuredClone(run.fallback),
  };
  return createHash("sha256").update(canonicalJson(declaration)).digest("hex");
}

function placementReservationDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// Shape-only validation of a persisted selector decision (ADR 0054 Decision 3). The computation
// contract lives in rate-selector.mjs; Control Record owns only the persistence shape.
function validateSelectorDecision(value) {
  exact(value, ["schema_version", "selected_quota_pool_id", "selected_executor", "evaluated_at", "reason", "pool_evaluations", "snapshot_evidence", "reservation"], "selector_decision");
  if (value.schema_version !== SELECTOR_DECISION_SCHEMA_ID) fail("INVALID_SCHEMA", "selector_decision schema is unsupported");
  identifier(value.selected_quota_pool_id, "selector_decision.selected_quota_pool_id");
  validateExecutorEnvelope(value.selected_executor);
  timestamp(value.evaluated_at, "selector_decision.evaluated_at");
  oneOf(value.reason, ["max-headroom", "hysteresis-hold", "only-eligible"], "selector_decision.reason");
  boundedArray(value.pool_evaluations, "selector_decision.pool_evaluations", (entry) => {
    exact(entry, ["quota_pool_id", "min_pace_bp", "binding_window_id", "eligible", "exclusion_reason"], "selector_decision.pool_evaluations[]");
    identifier(entry.quota_pool_id, "selector_decision.pool_evaluations[].quota_pool_id");
    if (entry.min_pace_bp !== null) integer(entry.min_pace_bp, "selector_decision.pool_evaluations[].min_pace_bp");
    if (entry.binding_window_id !== null) identifier(entry.binding_window_id, "selector_decision.pool_evaluations[].binding_window_id");
    if (typeof entry.eligible !== "boolean") fail("INVALID_SCHEMA", "selector_decision.pool_evaluations[].eligible must be boolean");
    if (entry.exclusion_reason !== null) identifier(entry.exclusion_reason, "selector_decision.pool_evaluations[].exclusion_reason");
    if (entry.eligible === (entry.exclusion_reason !== null)) fail("INVALID_SCHEMA", "selector_decision.pool_evaluations[] eligibility and exclusion reason disagree");
  }, { min: 1 });
  evidenceArray(value.snapshot_evidence, "selector_decision.snapshot_evidence", 1);
  validateBudgetReservation(value.reservation, "selector_decision.reservation");
}

function validatePlacementReservation(value, allowSelectorDecision = false) {
  const keys = ["registry_observation_id", "candidate_digest", "selected_from_revision", "eligibility", "review_reasons", "review_decision", "selected_by", "selected_at"];
  // Optional KEY, never an ever-present nullable field: the reservation object is bound whole
  // into the placement-reserve receipt subject digest, so adding a key to old reservations would
  // permanently break every migrated Control (ADR 0054 refuter最重要指摘).
  const hasSelectorDecision = value !== null && typeof value === "object" && Object.hasOwn(value, "selector_decision");
  exact(value, hasSelectorDecision ? [...keys, "selector_decision"] : keys, "placement_reservation");
  if (hasSelectorDecision) {
    if (!allowSelectorDecision) fail("INVALID_SCHEMA", "placement_reservation.selector_decision requires a v27 manifest");
    validateSelectorDecision(value.selector_decision);
  }
  identifier(value.registry_observation_id, "placement_reservation.registry_observation_id");
  if (!SHA256_RE.test(value.candidate_digest)) fail("INVALID_SCHEMA", "placement_reservation.candidate_digest is invalid");
  integer(value.selected_from_revision, "placement_reservation.selected_from_revision");
  oneOf(value.eligibility, ["eligible", "review-required"], "placement_reservation.eligibility");
  uniqueStringArray(value.review_reasons, "placement_reservation.review_reasons", (entry, name) => identifier(entry, name));
  if (value.review_reasons.some((entry, index) => entry !== [...value.review_reasons].sort()[index])) fail("INVALID_SCHEMA", "placement_reservation.review_reasons must be sorted");
  if (value.review_decision !== null) {
    validateEvidence(value.review_decision, "placement_reservation.review_decision");
    if (value.review_decision.type !== "decision") fail("INVALID_SCHEMA", "placement reservation review must be decision evidence");
  }
  string(value.selected_by, "placement_reservation.selected_by"); timestamp(value.selected_at, "placement_reservation.selected_at");
  if (value.review_decision !== null && Date.parse(value.review_decision.observed_at) > Date.parse(value.selected_at)) fail("INVALID_SCHEMA", "placement review decision is newer than selection");
  if (value.eligibility === "eligible" && (value.review_reasons.length !== 0 || value.review_decision !== null)) fail("INVALID_SCHEMA", "eligible placement cannot carry review approval");
  if (value.eligibility === "review-required" && (value.review_reasons.length === 0 || value.review_decision === null)) fail("INVALID_SCHEMA", "review-required placement needs parent decision evidence");
}

function validateBudget(value) {
  exact(value, ["max_worker_runs", "max_consultations", "max_external_runs", "max_wall_time_seconds", "max_cost_microusd", "max_runs_per_approach_family", "max_retries_per_assignment", "max_integration_runs"], "budget");
  integer(value.max_worker_runs, "budget.max_worker_runs");
  integer(value.max_consultations, "budget.max_consultations");
  integer(value.max_external_runs, "budget.max_external_runs");
  nullableInteger(value.max_wall_time_seconds, "budget.max_wall_time_seconds");
  nullableInteger(value.max_cost_microusd, "budget.max_cost_microusd");
  integer(value.max_runs_per_approach_family, "budget.max_runs_per_approach_family", { min: 1 });
  integer(value.max_retries_per_assignment, "budget.max_retries_per_assignment", { min: 0 });
  integer(value.max_integration_runs, "budget.max_integration_runs", { min: 0 });
}

function validateBudgetReservation(value, name = "budget_reservation") {
  exact(value, ["wall_time_seconds", "cost_microusd"], name);
  nullableInteger(value.wall_time_seconds, `${name}.wall_time_seconds`, { min: 1 });
  nullableInteger(value.cost_microusd, `${name}.cost_microusd`, { min: 0 });
}

function externalWorker(worker) {
  return EXECUTOR_CONTRACT_REGISTRY.get(worker.executor, worker.workflow_id)?.external ?? true;
}

function assertBudgetWithin(manifest, extraWorker = null, extraConsultation = null, { allowUnknown = false, skipPlacementLimits = false } = {}) {
  const workers = extraWorker === null ? manifest.worker_runs : [...manifest.worker_runs, extraWorker];
  const consultations = extraConsultation === null ? manifest.consultations : [...manifest.consultations, extraConsultation];
  if (workers.length > manifest.budget.max_worker_runs) fail("BUDGET_EXCEEDED", "worker run budget is exceeded");
  if (consultations.length > manifest.budget.max_consultations) fail("BUDGET_EXCEEDED", "consultation budget is exceeded");
  if (workers.filter(externalWorker).length > manifest.budget.max_external_runs) fail("BUDGET_EXCEEDED", "external worker run budget is exceeded");
  if (!skipPlacementLimits) {
    const approachCounts = new Map(); const assignmentCounts = new Map(); let integrationRuns = 0;
    for (const worker of workers) {
      const family = worker.lineage.approach_family_ref;
      if (family === null) fail("BUDGET_UNKNOWN", "worker approach family is unknown");
      approachCounts.set(family, (approachCounts.get(family) ?? 0) + 1);
      assignmentCounts.set(worker.assignment_id, (assignmentCounts.get(worker.assignment_id) ?? 0) + 1);
      const task = manifest.tasks.find((entry) => entry.task_id === worker.task_id);
      if (task?.role === "integrator") integrationRuns += 1;
    }
    if ([...approachCounts.values()].some((count) => count > manifest.budget.max_runs_per_approach_family)) fail("BUDGET_EXCEEDED", "approach family run limit is exceeded");
    if ([...assignmentCounts.values()].some((count) => count > manifest.budget.max_retries_per_assignment + 1)) fail("BUDGET_EXCEEDED", "assignment retry limit is exceeded");
    if (integrationRuns > manifest.budget.max_integration_runs) fail("BUDGET_EXCEEDED", "integration run capacity is exceeded");
  }
  const reservations = [...workers, ...consultations].map((entry) => entry.budget_reservation);
  for (const [reservationField, limitField] of [["wall_time_seconds", "max_wall_time_seconds"], ["cost_microusd", "max_cost_microusd"]]) {
    const limit = manifest.budget[limitField];
    if (limit === null) {
      if (!allowUnknown && reservations.length > 0) fail("BUDGET_UNKNOWN", `${limitField} is unknown`);
      continue;
    }
    if (reservations.some((entry) => entry[reservationField] === null)) {
      if (allowUnknown) continue;
      fail("BUDGET_UNKNOWN", `${reservationField} reservation is unknown under a known control limit`);
    }
    let total = 0;
    for (const reservation of reservations) {
      total += reservation[reservationField];
      if (!Number.isSafeInteger(total) || total > limit) fail("BUDGET_EXCEEDED", `${reservationField} budget is exceeded`);
    }
  }
}

function capabilityValue(workerOrCapabilities, capabilityId) {
  const capabilities = Array.isArray(workerOrCapabilities) ? workerOrCapabilities : workerOrCapabilities.workflow_capabilities;
  return capabilities.find((entry) => entry.capability_id === capabilityId)?.value;
}

function validateWorkflowCapabilityContract(worker, registry = EXECUTOR_CONTRACT_REGISTRY) {
  const contract = registry.get(worker.executor, worker.workflow_id);
  if (contract !== null) {
    try { contract.validate_capabilities(worker.workflow_capabilities); }
    catch (error) { if (error instanceof ControlRecordError) throw error; fail("CAPABILITY_MISMATCH", "executor workflow capability contract is invalid"); }
  }
}

function requireTaskCapabilities(worker, task) {
  const missing = task.required_capabilities.filter((capabilityId) => capabilityValue(worker, capabilityId) !== "true");
  if (missing.length) fail("CAPABILITY_MISMATCH", "worker workflow does not satisfy task required capabilities", { missing });
}

function validateExecutorEnvelope(value) {
  exact(value, ["adapter_id", "contract_version", "instance_id", "handle_schema_id"], "executor");
  identifier(value.adapter_id, "executor.adapter_id");
  identifier(value.contract_version, "executor.contract_version");
  identifier(value.instance_id, "executor.instance_id");
  identifier(value.handle_schema_id, "executor.handle_schema_id");
  return value;
}

function isKnownExecutorContract(executor, workflowId) {
  return EXECUTOR_CONTRACT_REGISTRY.has(executor, workflowId);
}

function validateOpaqueHandleValue(value, name, depth = 0) {
  if (depth > OPAQUE_HANDLE_DEPTH) fail("LIMIT_EXCEEDED", `${name} exceeds opaque handle depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { string(value, name, 1024, { nonempty: false }); return; }
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("INVALID_SCHEMA", `${name} number must be a safe integer`); return; }
  if (Array.isArray(value)) {
    if (value.length > 32) fail("LIMIT_EXCEEDED", `${name} has too many entries`);
    value.forEach((entry, index) => validateOpaqueHandleValue(entry, `${name}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) fail("INVALID_SCHEMA", `${name} has an unsupported value`);
  const keys = Object.keys(value);
  if (keys.length > 32) fail("LIMIT_EXCEEDED", `${name} has too many fields`);
  for (const key of keys) {
    string(key, `${name} key`, 128);
    validateOpaqueHandleValue(value[key], `${name}.${key}`, depth + 1);
  }
}

function validateOpaqueHandle(value) {
  if (value !== null && !isObject(value)) fail("INVALID_SCHEMA", "executor_handle must be an object or null");
  validateOpaqueHandleValue(value, "executor_handle");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > OPAQUE_HANDLE_LIMIT) fail("LIMIT_EXCEEDED", "executor_handle exceeds opaque handle limit");
}

function validateHandle(value, executor, workflowId, nullable = true, registry = EXECUTOR_CONTRACT_REGISTRY) {
  const contract = registry.get(executor, workflowId);
  if (contract === null) { validateOpaqueHandle(value); return; }
  if (value === null) {
    if (nullable && contract.nullable_handle) return;
    fail("INVALID_SCHEMA", "executor_handle cannot be null for this handle schema");
  }
  try { contract.validate_handle(value); }
  catch (error) { if (error instanceof ControlRecordError) throw error; fail("INVALID_SCHEMA", "executor handle contract is invalid"); }
}

function activeHandleRequired(executor, workflowId, registry = EXECUTOR_CONTRACT_REGISTRY) {
  const contract = registry.get(executor, workflowId);
  return contract === null || contract.active_handle_required;
}

/** Pure injection seam for compile-time executor registries; it never mutates manifest state. */
export function validateExecutorContractSnapshot(value, registry = EXECUTOR_CONTRACT_REGISTRY) {
  exact(value, ["executor", "workflow_id", "executor_handle", "workflow_capabilities"], "executor_contract_snapshot");
  validateExecutorEnvelope(value.executor); identifier(value.workflow_id, "executor_contract_snapshot.workflow_id");
  validateWorkflowCapabilities(value.workflow_capabilities, "executor_contract_snapshot.workflow_capabilities");
  const contract = registry.get(value.executor, value.workflow_id);
  if (contract === null) fail("ADAPTER_UNKNOWN", "executor adapter, workflow, or handle schema is not operationally known");
  validateHandle(value.executor_handle, value.executor, value.workflow_id, true, registry);
  validateWorkflowCapabilityContract({ executor: value.executor, workflow_id: value.workflow_id, workflow_capabilities: value.workflow_capabilities }, registry);
  return Object.freeze({ external: contract.external, handle_schema_id: contract.handle_schema_id });
}

function requireOperationalExecutor(worker) {
  if (worker.executor.adapter_id === "gpt-connector") fail("EXECUTOR_FORBIDDEN", "gpt-connector is consultation-only");
  if (!isKnownExecutorContract(worker.executor, worker.workflow_id)) {
    fail("ADAPTER_UNKNOWN", "executor adapter, workflow, or handle schema is not operationally known", {
      adapter_id: worker.executor.adapter_id,
      contract_version: worker.executor.contract_version,
      workflow_id: worker.workflow_id,
      handle_schema_id: worker.executor.handle_schema_id,
    });
  }
}

function requireOperationalManifest(manifest) {
  for (const worker of manifest.worker_runs) requireOperationalExecutor(worker);
}

function validateObservation(value) {
  exact(value, ["source", "observed_version", "observed_at", "raw_state"], "executor_observation");
  string(value.source, "executor_observation.source");
  string(value.observed_version, "executor_observation.observed_version");
  timestamp(value.observed_at, "executor_observation.observed_at");
  string(value.raw_state, "executor_observation.raw_state");
}

function validateFingerprint(value) {
  exact(value, ["digest", "head", "index_digest", "status_digest", "files", "ignored_files"], "workspace_fingerprint");
  if (!SHA256_RE.test(value.digest) || !SHA256_RE.test(value.index_digest) || !SHA256_RE.test(value.status_digest)) fail("INVALID_SCHEMA", "fingerprint digest is invalid");
  if (value.head !== null && !SHA1_RE.test(value.head)) fail("INVALID_SCHEMA", "fingerprint HEAD is invalid");
  boundedArray(value.files, "workspace_fingerprint.files", (entry) => {
    exact(entry, ["path", "state", "file_mode", "content_digest"], "fingerprint file");
    repoPath(entry.path, "fingerprint file.path"); string(entry.state, "fingerprint file.state", 16);
    nullableInteger(entry.file_mode, "fingerprint file.file_mode");
    if (entry.content_digest !== null && !SHA256_RE.test(entry.content_digest)) fail("INVALID_SCHEMA", "file digest is invalid");
    if ((entry.file_mode === null) !== (entry.content_digest === null)) fail("INVALID_SCHEMA", "file mode and content presence differ");
  });
  boundedArray(value.ignored_files, "workspace_fingerprint.ignored_files", (entry) => {
    exact(entry, ["path", "content_digest"], "ignored fingerprint file");
    repoPath(entry.path, "ignored fingerprint file.path");
    if (!SHA256_RE.test(entry.content_digest)) fail("INVALID_SCHEMA", "ignored file digest is invalid");
  });
}

function validateWorkspace(value) {
  exact(value, ["kind", "worktree_root_realpath", "git_dir_realpath", "git_dir_file_id", "common_dir_realpath", "head_at_record", "head_at_reservation"], "workspace");
  oneOf(value.kind, ["worktree", "bare"], "workspace.kind");
  string(value.git_dir_realpath, "workspace.git_dir_realpath", 4096);
  string(value.git_dir_file_id, "workspace.git_dir_file_id", 128);
  if (!/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value.git_dir_file_id)) fail("INVALID_SCHEMA", "workspace.git_dir_file_id is invalid");
  string(value.common_dir_realpath, "workspace.common_dir_realpath", 4096);
  for (const [key, current] of [["head_at_record", value.head_at_record], ["head_at_reservation", value.head_at_reservation]]) {
    if (current !== null && !SHA1_RE.test(current)) fail("INVALID_SCHEMA", `workspace.${key} is invalid`);
  }
  if (value.kind === "bare") {
    if (value.worktree_root_realpath !== null || value.head_at_record !== null || value.head_at_reservation !== null) fail("INVALID_SCHEMA", "bare workspace fields are invalid");
  } else string(value.worktree_root_realpath, "workspace.worktree_root_realpath", 4096);
}

function validateWorkspaceBinding(value) {
  if (value?.mode === "fixed") {
    exact(value, ["mode"], "workspace_binding");
    return;
  }
  exact(value, ["mode", "schema_version", "base_sha", "preserve_worktree", "execution_workspace", "provider_binding", "bound_from_revision", "binding_evidence", "bound_by", "bound_at"], "workspace_binding");
  if (value.mode !== "executor-isolated" || value.schema_version !== "codex-sidecar.delayed-worktree.v1" || value.preserve_worktree !== true || !SHA1_RE.test(value.base_sha)) fail("INVALID_SCHEMA", "executor-isolated workspace binding is invalid");
  if (value.execution_workspace === null) {
    if (value.provider_binding !== null || value.bound_from_revision !== null || value.bound_by !== null || value.bound_at !== null || value.binding_evidence.length !== 0) fail("INVALID_SCHEMA", "unbound executor workspace has binding metadata");
  } else {
    validateWorkspace(value.execution_workspace);
    validateSidecarProviderBinding(value.provider_binding);
    integer(value.bound_from_revision, "workspace_binding.bound_from_revision");
    string(value.bound_by, "workspace_binding.bound_by"); timestamp(value.bound_at, "workspace_binding.bound_at");
    evidenceArray(value.binding_evidence, "workspace_binding.binding_evidence", 1);
    if (value.execution_workspace.kind !== "worktree" || value.execution_workspace.head_at_record !== value.base_sha || value.execution_workspace.head_at_reservation !== value.base_sha) fail("INVALID_SCHEMA", "bound executor workspace differs from base snapshot");
  }
}

function validateSidecarProviderBinding(value) {
  exact(value, ["schema_version", "executor_handle", "provider_run_id", "worktree_path", "observed_state", "result_digest"], "workspace_binding.provider_binding");
  if (value.schema_version !== "dotagents.codex-sidecar.workspace-binding.v1" || value.observed_state !== "completed") fail("INVALID_SCHEMA", "sidecar provider binding is not a completed result");
  exact(value.executor_handle, ["idempotency_key"], "workspace_binding.provider_binding.executor_handle");
  string(value.executor_handle.idempotency_key, "workspace_binding.provider_binding.executor_handle.idempotency_key");
  if (!/^(?:[A-Za-z0-9_-]{22,128}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value.executor_handle.idempotency_key)) fail("INVALID_SCHEMA", "sidecar provider binding idempotency key is invalid");
  identifier(value.provider_run_id, "workspace_binding.provider_binding.provider_run_id");
  string(value.worktree_path, "workspace_binding.provider_binding.worktree_path", 4096);
  if (!isAbsolute(value.worktree_path) || !SHA256_RE.test(value.result_digest)) fail("INVALID_SCHEMA", "sidecar provider binding result is invalid");
}

function sidecarProviderBindingDigest(value) {
  validateSidecarProviderBinding(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateResult(value, write) {
  const keys = ["result_digest", "evidence", ...(write ? ["workspace_fingerprint"] : [])];
  exact(value, keys, "result");
  if (!SHA256_RE.test(value.result_digest)) fail("INVALID_SCHEMA", "result_digest is invalid");
  evidenceArray(value.evidence, "result.evidence", 1);
  if (write) validateFingerprint(value.workspace_fingerprint);
}

function validateAcceptance(value, executor, workflowId) {
  exact(value, ["decision", "accepted_from_revision", "result_digest", "executor_handle", "verification_evidence", "decision_note", "decided_by", "decided_at"], "acceptance");
  oneOf(value.decision, ["accepted", "rejected"], "acceptance.decision");
  integer(value.accepted_from_revision, "acceptance.accepted_from_revision");
  if (!SHA256_RE.test(value.result_digest)) fail("INVALID_SCHEMA", "acceptance.result_digest is invalid");
  validateHandle(value.executor_handle, executor, workflowId, true);
  evidenceArray(value.verification_evidence, "acceptance.verification_evidence", 1);
  string(value.decision_note, "acceptance.decision_note", 4096);
  string(value.decided_by, "acceptance.decided_by");
  timestamp(value.decided_at, "acceptance.decided_at");
}

function validateAdmission(value) {
  exact(value, ["admitted_by", "admitted_at", "write_reservation"], "admission");
  string(value.admitted_by, "admission.admitted_by"); timestamp(value.admitted_at, "admission.admitted_at");
  if (typeof value.write_reservation !== "boolean") fail("INVALID_SCHEMA", "admission.write_reservation must be boolean");
}

function validateFallback(value, name = "fallback") {
  if (value === null) return;
  exact(value, ["from_worker_run_id", "decision_ref"], name);
  identifier(value.from_worker_run_id, `${name}.from_worker_run_id`); repoPath(value.decision_ref, `${name}.decision_ref`);
}

function validateWorker(value, stored = true, registry = EXECUTOR_CONTRACT_REGISTRY, allowSelectorDecision = false) {
  const common = ["worker_run_id", "task_id", "assignment_id", "executor", "workflow_id", "role_ref"];
  const location = stored ? ["workspace", "recorded_workspace_fingerprint", "baseline_workspace_fingerprint"] : ["workspace_cwd"];
  exact(value, [...common, ...location, "workspace_binding", "workflow_capabilities", "budget_reservation", "write_mode", "operation_digest", "execution_verification", "lineage", "fallback", "placement_reservation", "state", "executor_handle", "executor_observation", "admission", "cancel_request", "dispatch_evidence", "dispatch_attempt_evidence", "terminal_evidence", "result", "acceptance"], "worker_run");
  identifier(value.worker_run_id, "worker_run.worker_run_id"); identifier(value.task_id, "worker_run.task_id"); identifier(value.assignment_id, "worker_run.assignment_id");
  validateExecutorEnvelope(value.executor); identifier(value.workflow_id, "worker_run.workflow_id");
  validateWorkflowCapabilities(value.workflow_capabilities);
  validateBudgetReservation(value.budget_reservation);
  string(value.role_ref, "worker_run.role_ref");
  if (stored) { validateWorkspace(value.workspace); validateWorkspaceBinding(value.workspace_binding); }
  else { string(value.workspace_cwd, "worker_run.workspace_cwd", 4096); oneOf(value.workspace_binding, ["fixed", "executor-isolated"], "worker_run.workspace_binding"); }
  oneOf(value.write_mode, ["none", "direct", "isolated-alternative"], "worker_run.write_mode");
  if (value.operation_digest !== null && !SHA256_RE.test(value.operation_digest)) fail("INVALID_SCHEMA", "worker_run.operation_digest is invalid");
  validateVerification(value.execution_verification);
  validateLineage(value.lineage);
  validateFallback(value.fallback);
  if (value.placement_reservation !== null) validatePlacementReservation(value.placement_reservation, allowSelectorDecision);
  oneOf(value.state, ["planned", "admitted", "dispatched", "running", "unknown", "completed", "failed", "cancelled"], "worker_run.state");
  validateHandle(value.executor_handle, value.executor, value.workflow_id, true, registry);
  validateWorkflowCapabilityContract(value, registry);
  const delayed = stored ? value.workspace_binding.mode === "executor-isolated" : value.workspace_binding === "executor-isolated";
  if (delayed && (value.executor.adapter_id !== "codex-sidecar" || value.workflow_id !== "work" || value.write_mode === "none")) fail("INVALID_SCHEMA", "executor-isolated binding is only valid for codex-sidecar work writers");
  if (stored && delayed) {
    if (value.workspace_binding.base_sha !== value.workspace.head_at_record) fail("INVALID_SCHEMA", "executor-isolated base differs from source workspace");
    const execution = value.workspace_binding.execution_workspace;
    if (execution !== null && (execution.common_dir_realpath !== value.workspace.common_dir_realpath || execution.worktree_root_realpath === value.workspace.worktree_root_realpath)) fail("INVALID_SCHEMA", "executor workspace is not isolated from its source");
  }
  if (value.executor_observation !== null) validateObservation(value.executor_observation);
  if (value.admission !== null) validateAdmission(value.admission);
  if (value.cancel_request !== null) validateCancelRequest(value.cancel_request, value.executor, value.workflow_id);
  evidenceArray(value.dispatch_evidence, "worker_run.dispatch_evidence");
  evidenceArray(value.dispatch_attempt_evidence, "worker_run.dispatch_attempt_evidence");
  evidenceArray(value.terminal_evidence, "worker_run.terminal_evidence");
  if (!stored && (value.state !== "planned" || value.executor_observation !== null || value.admission !== null || value.cancel_request !== null || value.dispatch_evidence.length || value.dispatch_attempt_evidence.length || value.terminal_evidence.length || value.result !== null || value.acceptance !== null)) fail("INVALID_SCHEMA", "new worker must be pristine planned state");
  if (stored) {
    if (value.cancel_request !== null) {
      if (value.state === "planned") fail("INVALID_SCHEMA", "planned worker cannot have an external cancel request");
      if (canonicalJson(value.cancel_request.executor_handle) !== canonicalJson(value.executor_handle)) fail("INVALID_SCHEMA", "cancel request handle differs from worker handle");
    }
    if (value.recorded_workspace_fingerprint !== null) validateFingerprint(value.recorded_workspace_fingerprint);
    if ((value.workspace.kind === "worktree") !== (value.recorded_workspace_fingerprint !== null)) fail("INVALID_SCHEMA", "recorded workspace fingerprint differs from workspace kind");
    if (value.recorded_workspace_fingerprint !== null && value.recorded_workspace_fingerprint.head !== value.workspace.head_at_record) fail("INVALID_SCHEMA", "recorded workspace fingerprint HEAD differs from workspace snapshot");
    if (value.baseline_workspace_fingerprint !== null) validateFingerprint(value.baseline_workspace_fingerprint);
    if (value.baseline_workspace_fingerprint !== null && value.baseline_workspace_fingerprint.head !== value.workspace.head_at_reservation) fail("INVALID_SCHEMA", "writer baseline HEAD differs from reservation snapshot");
    if (value.write_mode === "none" && value.baseline_workspace_fingerprint !== null) fail("INVALID_SCHEMA", "read run cannot have baseline fingerprint");
    if (value.write_mode !== "none" && RESERVED_WRITER.has(value.state) && value.baseline_workspace_fingerprint === null && !delayed) fail("INVALID_SCHEMA", "admitted writer requires baseline fingerprint");
    if (value.result !== null) validateResult(value.result, value.write_mode !== "none");
    if (value.acceptance !== null) validateAcceptance(value.acceptance, value.executor, value.workflow_id);
    const dispatched = value.dispatch_evidence.length > 0;
    const attempted = value.dispatch_attempt_evidence.length > 0;
    const terminal = value.terminal_evidence.length > 0;
    const admitted = value.admission !== null;
    const observed = value.executor_observation !== null;
    if (admitted && value.admission.write_reservation !== (value.write_mode !== "none")) fail("INVALID_SCHEMA", "admission contradicts write mode");
    if (value.write_mode !== "none" && admitted && value.baseline_workspace_fingerprint === null && !delayed) fail("INVALID_SCHEMA", "admitted writer requires baseline fingerprint");
    if (delayed && value.state === "completed" && value.workspace_binding.execution_workspace === null) fail("INVALID_SCHEMA", "completed executor-isolated writer must bind its execution workspace");
    if (value.state === "planned" && (admitted || observed || dispatched || attempted || terminal || value.result !== null || value.acceptance !== null)) fail("INVALID_SCHEMA", "planned worker truth table is invalid");
    if (value.state === "admitted" && (!admitted || observed || dispatched || attempted || terminal || value.result !== null || value.acceptance !== null)) fail("INVALID_SCHEMA", "admitted worker truth table is invalid");
    const missingActiveHandle = activeHandleRequired(value.executor, value.workflow_id, registry) && value.executor_handle === null;
    if (["dispatched", "running", "unknown"].includes(value.state) && (!admitted || !observed || !dispatched || attempted || terminal || missingActiveHandle || value.result !== null || value.acceptance !== null)) fail("INVALID_SCHEMA", "active worker truth table is invalid");
    if (value.state === "completed" && (!admitted || !observed || !dispatched || attempted || terminal || missingActiveHandle || value.result === null)) fail("INVALID_SCHEMA", "completed worker truth table is invalid");
    if (value.state === "failed" && (!admitted || !observed || !dispatched || attempted || !terminal || value.result !== null || value.acceptance !== null)) fail("INVALID_SCHEMA", "failed worker truth table is invalid");
    if (value.state === "cancelled") {
      const validPlanned = !admitted && observed && !dispatched && !attempted && !terminal;
      const validAdmitted = admitted && observed && !dispatched && attempted && !terminal && value.cancel_request === null;
      const validRequestedBeforeDispatch = admitted && observed && !dispatched && !attempted && terminal && value.cancel_request !== null;
      const validDispatched = admitted && observed && dispatched && !attempted && terminal;
      if ((!validPlanned && !validAdmitted && !validRequestedBeforeDispatch && !validDispatched) || value.result !== null || value.acceptance !== null) fail("INVALID_SCHEMA", "cancelled worker truth table is invalid");
    }
    if (value.state !== "completed" && value.acceptance !== null) fail("INVALID_SCHEMA", "only completed worker can have acceptance");
  }
}

/** Pure Worker-record validation with an explicit immutable contract registry. */
export function validateWorkerRecord(value, { stored = false, registry = EXECUTOR_CONTRACT_REGISTRY } = {}) {
  validateWorker(value, stored, registry);
  if (value.executor.adapter_id === "gpt-connector") fail("EXECUTOR_FORBIDDEN", "gpt-connector is consultation-only");
  const contract = registry.get(value.executor, value.workflow_id);
  if (contract === null) fail("ADAPTER_UNKNOWN", "executor adapter, workflow, or handle schema is not operationally known");
  return value;
}

function validateConsultationHandle(value, connector, name) {
  if (connector === "gpt-connector") {
    exact(value, ["slug"], name);
    string(value.slug, `${name}.slug`);
    return;
  }
  if (connector === "claude-native") {
    exact(value, ["session_id"], name);
    if (typeof value.session_id !== "string" || !UUID_RE.test(value.session_id)) fail("INVALID_SCHEMA", `${name}.session_id must be a lowercase UUID`);
    return;
  }
  if (value !== null) fail("INVALID_SCHEMA", `${name} must be null for a synchronous codex-sidecar consultation`);
}

function validateConsultation(value, schemaVersion) {
  const typed = typedConsultationSchema(schemaVersion);
  const handleField = typed ? "consultation_handle" : "slug";
  exact(value, ["consultation_id", "task_id", "assignment_id", "connector", handleField, "model", "effort", "budget_reservation", "state", "executor_observation", "decision_ref", "terminal_evidence"], "consultation");
  identifier(value.consultation_id, "consultation.consultation_id"); identifier(value.task_id, "consultation.task_id"); identifier(value.assignment_id, "consultation.assignment_id");
  if (typed) {
    oneOf(value.connector, CONSULTATION_CONNECTORS_V26, "consultation.connector");
    validateConsultationHandle(value.consultation_handle, value.connector, "consultation.consultation_handle");
  } else {
    if (value.connector !== "gpt-connector") fail("INVALID_SCHEMA", "consultation connector is invalid");
    string(value.slug, "consultation.slug");
  }
  string(value.model, "consultation.model"); string(value.effort, "consultation.effort");
  // Bind effort to the product contract for the typed connectors so a planned consultation can
  // always be dispatched by its request builder. gpt-connector stays opaque for v25 migration compatibility.
  if (typed && value.connector === "claude-native") oneOf(value.effort, ["low", "medium", "high", "xhigh", "max"], "consultation.effort");
  if (typed && value.connector === "codex-sidecar") oneOf(value.effort, ["low", "medium", "high", "xhigh"], "consultation.effort");
  validateBudgetReservation(value.budget_reservation, "consultation.budget_reservation");
  const states = explicitConsultationCancelSchema(schemaVersion)
    ? ["planned", "dispatched", "running", "unknown", "completed", "failed", "cancelled"]
    : ["planned", "dispatched", "running", "unknown", "completed", "failed"];
  oneOf(value.state, states, "consultation.state");
  if (value.executor_observation !== null) validateObservation(value.executor_observation);
  if (value.decision_ref !== null) repoPath(value.decision_ref, "consultation.decision_ref");
  evidenceArray(value.terminal_evidence, "consultation.terminal_evidence");
  const observed = value.executor_observation !== null; const terminal = value.terminal_evidence.length > 0;
  if (value.state === "planned" && (observed || value.decision_ref !== null || terminal)) fail("INVALID_SCHEMA", "planned consultation truth table is invalid");
  // cancelled is planned-shaped: the cancellation decision lives only in the consultation-cancel
  // transition receipt, and migration-produced cancelled has no such receipt (ADR 0054 Decision 3).
  if (value.state === "cancelled" && (observed || value.decision_ref !== null || terminal)) fail("INVALID_SCHEMA", "cancelled consultation truth table is invalid");
  if (["dispatched", "running", "unknown"].includes(value.state) && (!observed || value.decision_ref !== null || terminal)) fail("INVALID_SCHEMA", "active consultation truth table is invalid");
  if (value.state === "completed" && (!observed || value.decision_ref === null || terminal)) fail("INVALID_SCHEMA", "completed consultation truth table is invalid");
  if (value.state === "failed" && (!observed || value.decision_ref !== null || !terminal)) fail("INVALID_SCHEMA", "failed consultation truth table is invalid");
}

function validateFinalization(value) {
  exact(value, ["task_id", "finalization_ref", "recorded_by", "recorded_at"], "task_finalization");
  identifier(value.task_id, "task_finalization.task_id"); repoPath(value.finalization_ref, "task_finalization.finalization_ref");
  string(value.recorded_by, "task_finalization.recorded_by"); timestamp(value.recorded_at, "task_finalization.recorded_at");
}

function validateTaskCancellation(value) {
  exact(value, ["task_id", "cancelled_from_revision", "decision", "cancelled_by", "cancelled_at"], "task_cancellation");
  identifier(value.task_id, "task_cancellation.task_id"); integer(value.cancelled_from_revision, "task_cancellation.cancelled_from_revision");
  validateEvidence(value.decision, "task_cancellation.decision");
  if (value.decision.type !== "decision") fail("INVALID_SCHEMA", "task cancellation requires decision evidence");
  string(value.cancelled_by, "task_cancellation.cancelled_by"); timestamp(value.cancelled_at, "task_cancellation.cancelled_at");
  if (Date.parse(value.decision.observed_at) > Date.parse(value.cancelled_at)) fail("INVALID_SCHEMA", "task cancellation decision is newer than record");
}

function validateCancelRequest(value, executor, workflowId) {
  exact(value, ["requested_from_revision", "decision", "executor_handle", "requested_by", "requested_at"], "cancel_request");
  integer(value.requested_from_revision, "cancel_request.requested_from_revision");
  validateEvidence(value.decision, "cancel_request.decision");
  if (value.decision.type !== "decision") fail("INVALID_SCHEMA", "cancel request requires decision evidence");
  validateHandle(value.executor_handle, executor, workflowId, false);
  string(value.requested_by, "cancel_request.requested_by"); timestamp(value.requested_at, "cancel_request.requested_at");
  if (Date.parse(value.decision.observed_at) > Date.parse(value.requested_at)) fail("INVALID_SCHEMA", "cancel request decision is newer than request");
}

function validateCampaignMember(value, name) {
  exact(value, ["kind", "id"], name);
  oneOf(value.kind, ["worker-run", "consultation"], `${name}.kind`);
  identifier(value.id, `${name}.id`);
}

function validateCampaignRelease(value, auditRequired) {
  exact(value, ["released_from_revision", "audit_evidence", "decision", "released_by", "released_at"], "campaign.release");
  integer(value.released_from_revision, "campaign.release.released_from_revision");
  evidenceArray(value.audit_evidence, "campaign.release.audit_evidence", auditRequired ? 1 : 0);
  if (!auditRequired && value.audit_evidence.length !== 0) fail("INVALID_SCHEMA", "campaign without audit requirement cannot store audit evidence");
  validateEvidence(value.decision, "campaign.release.decision");
  if (value.decision.type !== "decision") fail("INVALID_SCHEMA", "campaign release requires decision evidence");
  string(value.released_by, "campaign.release.released_by"); timestamp(value.released_at, "campaign.release.released_at");
  if ([value.decision, ...value.audit_evidence].some((entry) => Date.parse(entry.observed_at) > Date.parse(value.released_at))) fail("INVALID_SCHEMA", "campaign release evidence is newer than release");
}

function validateCampaign(value) {
  exact(value, ["campaign_id", "campaign_type", "members", "gated_task_ids", "audit_required", "declared_from_revision", "declared_by", "declared_at", "release"], "campaign");
  identifier(value.campaign_id, "campaign.campaign_id");
  oneOf(value.campaign_type, ["discovery", "refutation", "design", "implementation", "final-audit"], "campaign.campaign_type");
  boundedArray(value.members, "campaign.members", validateCampaignMember, { min: 1 });
  if (new Set(value.members.map((entry) => `${entry.kind}\0${entry.id}`)).size !== value.members.length) fail("INVALID_SCHEMA", "campaign members contain duplicates");
  uniqueStringArray(value.gated_task_ids, "campaign.gated_task_ids", identifier, { min: 1 });
  if (typeof value.audit_required !== "boolean") fail("INVALID_SCHEMA", "campaign.audit_required must be boolean");
  integer(value.declared_from_revision, "campaign.declared_from_revision");
  string(value.declared_by, "campaign.declared_by"); timestamp(value.declared_at, "campaign.declared_at");
  if (value.release !== null) validateCampaignRelease(value.release, value.audit_required);
}

function campaignMemberState(manifest, member) {
  const collection = member.kind === "worker-run" ? manifest.worker_runs : manifest.consultations;
  const idKey = member.kind === "worker-run" ? "worker_run_id" : "consultation_id";
  return collection.find((entry) => entry[idKey] === member.id)?.state ?? null;
}

function campaignAllTerminal(manifest, campaign) {
  return campaign.members.every((member) => {
    const state = campaignMemberState(manifest, member);
    if (member.kind === "worker-run") return WORKER_TERMINAL.has(state);
    if (CONSULT_TERMINAL.has(state)) return true;
    const consultation = manifest.consultations.find((entry) => entry.consultation_id === member.id);
    return consultation !== undefined && orphanedPlannedConsultation(manifest, consultation);
  });
}

function campaignReadyForRelease(manifest, campaign) {
  return campaignAllTerminal(manifest, campaign) && campaign.members.every((member) => {
    if (member.kind !== "worker-run") return true;
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === member.id);
    return run.state !== "completed" || run.acceptance !== null;
  });
}

function campaignDeclarationDigest(campaign) {
  return createHash("sha256").update(canonicalJson({
    campaign_id: campaign.campaign_id, campaign_type: campaign.campaign_type,
    members: campaign.members, gated_task_ids: campaign.gated_task_ids,
    audit_required: campaign.audit_required,
  })).digest("hex");
}

function validateControlFinalization(value) {
  exact(value, ["objective_ref", "acceptance_matrix_ref", "final_audit_evidence", "regression_evidence", "knowledge_return_refs", "parent_decision", "finalized_from_revision", "finalized_by", "finalized_at"], "control_finalization");
  repoPath(value.objective_ref, "control_finalization.objective_ref");
  repoPath(value.acceptance_matrix_ref, "control_finalization.acceptance_matrix_ref");
  evidenceArray(value.final_audit_evidence, "control_finalization.final_audit_evidence", 1);
  evidenceArray(value.regression_evidence, "control_finalization.regression_evidence", 1);
  refs(value.knowledge_return_refs, "control_finalization.knowledge_return_refs", 1);
  validateEvidence(value.parent_decision, "control_finalization.parent_decision");
  if (value.parent_decision.type !== "decision") fail("INVALID_SCHEMA", "control finalization parent decision must be decision evidence");
  integer(value.finalized_from_revision, "control_finalization.finalized_from_revision");
  string(value.finalized_by, "control_finalization.finalized_by");
  timestamp(value.finalized_at, "control_finalization.finalized_at");
}

function taskFinalizationDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function controlFinalizationDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function phaseStep(phase) {
  return { phase, state: "pending", evidence: [], decision: null, advanced_from_revision: null, advanced_by: null, advanced_at: null };
}

function validatePhaseStep(value, name, gate) {
  exact(value, ["phase", "state", "evidence", "decision", "advanced_from_revision", "advanced_by", "advanced_at"], name);
  oneOf(value.phase, PHASE_ORDER, `${name}.phase`);
  const allowedStates = value.phase === "safety_net"
    ? ["pending", "completed", "not-required"]
    : value.phase === "behavior_change"
      ? ["pending", "completed", "not-applicable"]
      : ["pending", "completed"];
  oneOf(value.state, allowedStates, `${name}.state`);
  evidenceArray(value.evidence, `${name}.evidence`);
  if (value.decision !== null) {
    validateEvidence(value.decision, `${name}.decision`);
    if (value.decision.type !== "decision") fail("INVALID_SCHEMA", `${name}.decision must be decision evidence`);
  }
  const advanced = value.state !== "pending";
  if (!advanced) {
    if (value.evidence.length !== 0 || value.decision !== null || value.advanced_from_revision !== null || value.advanced_by !== null || value.advanced_at !== null) fail("INVALID_SCHEMA", `${name} pending state has advancement data`);
    return;
  }
  integer(value.advanced_from_revision, `${name}.advanced_from_revision`); string(value.advanced_by, `${name}.advanced_by`); timestamp(value.advanced_at, `${name}.advanced_at`);
  if ([...value.evidence, ...(value.decision === null ? [] : [value.decision])].some((entry) => Date.parse(entry.observed_at) > Date.parse(value.advanced_at))) fail("INVALID_SCHEMA", `${name} evidence is newer than advancement`);
  if (value.phase === "baseline" && (value.state !== "completed" || value.evidence.length === 0)) fail("INVALID_SCHEMA", "baseline requires completed evidence");
  if (value.phase === "knowledge_return" && (value.state !== "completed" || value.evidence.length === 0)) fail("INVALID_SCHEMA", "knowledge return requires completed evidence");
  if (value.phase === "design" && (value.state !== "completed" || value.decision === null)) fail("INVALID_SCHEMA", "design requires decision");
  if (value.phase === "safety_net") {
    if (gate.risk === "high" && (value.state !== "completed" || value.evidence.length === 0)) fail("INVALID_SCHEMA", "high risk safety net requires evidence");
    if (gate.risk === "standard" && value.state !== "not-required" && value.state !== "completed") fail("INVALID_SCHEMA", "standard safety net state is invalid");
    if (value.state === "not-required" && (gate.risk !== "standard" || value.decision === null)) fail("INVALID_SCHEMA", "standard safety net omission requires decision");
  }
  if (value.phase === "behavior_change") {
    if (gate.behavior_lane === "behavior-preserving" && (value.state !== "not-applicable" || value.decision === null)) fail("INVALID_SCHEMA", "behavior-preserving lane requires not-applicable decision");
    if (gate.behavior_lane === "behavior-change" && (value.state !== "completed" || value.decision === null)) fail("INVALID_SCHEMA", "behavior-change lane requires completed decision");
  }
  if (value.phase === "complete" && (value.state !== "completed" || value.decision === null)) fail("INVALID_SCHEMA", "complete requires decision");
}

function validatePhaseGate(value) {
  if (value === null) return;
  exact(value, ["workflow", "risk", "behavior_lane", "phases", "declared_from_revision", "declared_by", "declared_at"], "phase_gate");
  if (value.workflow !== "dotagents.phase-gate.v1") fail("INVALID_SCHEMA", "phase gate workflow is invalid");
  oneOf(value.risk, ["standard", "high"], "phase_gate.risk"); oneOf(value.behavior_lane, ["behavior-preserving", "behavior-change"], "phase_gate.behavior_lane");
  if (!Array.isArray(value.phases) || value.phases.length !== PHASE_ORDER.length) fail("INVALID_SCHEMA", "phase gate phases are invalid");
  value.phases.forEach((entry, index) => { validatePhaseStep(entry, `phase_gate.phases[${index}]`, value); if (entry.phase !== PHASE_ORDER[index]) fail("INVALID_SCHEMA", "phase gate order is invalid"); });
  integer(value.declared_from_revision, "phase_gate.declared_from_revision"); string(value.declared_by, "phase_gate.declared_by"); timestamp(value.declared_at, "phase_gate.declared_at");
  let pendingSeen = false;
  for (const step of value.phases) {
    if (step.state === "pending") pendingSeen = true;
    else if (pendingSeen) fail("INVALID_SCHEMA", "phase gate has skipped phase");
  }
}

function phaseGateCurrent(manifest) {
  if (manifest.phase_gate === null) return null;
  return manifest.phase_gate.phases.find((step) => step.state === "pending")?.phase ?? null;
}

function phaseGateComplete(manifest) {
  return manifest.phase_gate !== null && manifest.phase_gate.phases.at(-1).state === "completed";
}

function phaseGateDeclarationDigest(gate) {
  return createHash("sha256").update(canonicalJson({ workflow: gate.workflow, risk: gate.risk, behavior_lane: gate.behavior_lane })).digest("hex");
}

function artifactDescriptorDigest(artifact) {
  return createHash("sha256").update(canonicalJson({ artifact_id: artifact.artifact_id, artifact_kind: artifact.artifact_kind, artifact_ref: artifact.artifact_ref, artifact_digest: artifact.artifact_digest })).digest("hex");
}

function artifactGenerationDigest(superseded, current) {
  const descriptor = (artifact) => ({ artifact_id: artifact.artifact_id, artifact_kind: artifact.artifact_kind, artifact_ref: artifact.artifact_ref, artifact_digest: artifact.artifact_digest });
  return createHash("sha256").update(canonicalJson({ schema_version: "dotagents.artifact-generation.v1", superseded: descriptor(superseded), current: descriptor(current) })).digest("hex");
}

function docsArtifactRef(value, name) {
  repoPath(value, name);
  if (!value.startsWith("docs/")) fail("INVALID_SCHEMA", `${name} must be under docs/`);
}

function versionedArtifactRef(value, digest, name) {
  docsArtifactRef(value, name);
  const basename = value.split("/").at(-1);
  if (!basename.includes(digest)) fail("INVALID_SCHEMA", `${name} must include the full artifact digest in its basename`);
}

function validateArtifact(value, name = "artifact") {
  exact(value, ["artifact_id", "artifact_kind", "artifact_ref", "artifact_digest", "status", "recorded_from_revision", "recorded_by", "recorded_at", "status_from_revision", "status_by", "status_at"], name);
  identifier(value.artifact_id, `${name}.artifact_id`); oneOf(value.artifact_kind, ["finding", "approach", "gap", "decision"], `${name}.artifact_kind`);
  docsArtifactRef(value.artifact_ref, `${name}.artifact_ref`); if (!SHA256_RE.test(value.artifact_digest)) fail("INVALID_SCHEMA", `${name}.artifact_digest is invalid`);
  oneOf(value.status, ["current", "closed", "superseded"], `${name}.status`);
  integer(value.recorded_from_revision, `${name}.recorded_from_revision`); string(value.recorded_by, `${name}.recorded_by`); timestamp(value.recorded_at, `${name}.recorded_at`);
  if (value.status === "current") {
    if (value.status_from_revision !== null || value.status_by !== null || value.status_at !== null) fail("INVALID_SCHEMA", `${name} current status has update metadata`);
  } else {
    integer(value.status_from_revision, `${name}.status_from_revision`); string(value.status_by, `${name}.status_by`); timestamp(value.status_at, `${name}.status_at`);
  }
}

function familyDeclarationDigest(family) {
  return createHash("sha256").update(canonicalJson({ approach_family_ref: family.approach_family_ref, context_policy: family.context_policy })).digest("hex");
}

function familyBlockDigest(family) {
  return createHash("sha256").update(canonicalJson({ declaration_digest: familyDeclarationDigest(family), block: family.block })).digest("hex");
}

function familyReopenDigest(family) {
  return createHash("sha256").update(canonicalJson({ block_digest: familyBlockDigest(family), reopen: family.reopen })).digest("hex");
}

function validateFamilyAction(value, name) {
  exact(value, ["decision_artifact_id", "basis_artifact_ids", "from_revision", "by", "at"], name);
  identifier(value.decision_artifact_id, `${name}.decision_artifact_id`);
  uniqueStringArray(value.basis_artifact_ids, `${name}.basis_artifact_ids`, (entry, entryName) => identifier(entry, entryName), { min: 1 });
  integer(value.from_revision, `${name}.from_revision`); string(value.by, `${name}.by`); timestamp(value.at, `${name}.at`);
}

function validateFamilyGovernance(value, name = "family_governance") {
  exact(value, ["approach_family_ref", "context_policy", "state", "declared_from_revision", "declared_by", "declared_at", "block", "reopen"], name);
  identifier(value.approach_family_ref, `${name}.approach_family_ref`); validateContextPolicy(value.context_policy, `${name}.context_policy`);
  oneOf(value.state, ["open", "blocked", "reopened"], `${name}.state`);
  integer(value.declared_from_revision, `${name}.declared_from_revision`); string(value.declared_by, `${name}.declared_by`); timestamp(value.declared_at, `${name}.declared_at`);
  if (value.block !== null) validateFamilyAction(value.block, `${name}.block`);
  if (value.reopen !== null) validateFamilyAction(value.reopen, `${name}.reopen`);
  if (value.state === "open" && (value.block !== null || value.reopen !== null)) fail("INVALID_SCHEMA", "open family governance cannot have actions");
  if (value.state === "blocked" && (value.block === null || value.reopen !== null)) fail("INVALID_SCHEMA", "blocked family governance is invalid");
  if (value.state === "reopened" && (value.block === null || value.reopen === null)) fail("INVALID_SCHEMA", "reopened family governance is invalid");
}

function requireFamilyArtifacts(manifest, family) {
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const checkAction = (action, name) => {
    if (action === null) return;
    const decision = byId.get(action.decision_artifact_id);
    if (decision === undefined || decision.artifact_kind !== "decision") fail("INVALID_SCHEMA", `${name} decision artifact is invalid`);
    for (const artifactId of action.basis_artifact_ids) {
      const artifact = byId.get(artifactId);
      if (artifact === undefined || !["approach", "gap", "decision"].includes(artifact.artifact_kind)) fail("INVALID_SCHEMA", `${name} basis artifact is invalid`);
    }
  };
  checkAction(family.block, "family governance block"); checkAction(family.reopen, "family governance reopen");
  if (family.reopen !== null && !family.reopen.basis_artifact_ids.some((artifactId) => !family.block.basis_artifact_ids.includes(artifactId))) fail("INVALID_SCHEMA", "family governance reopen has no new basis artifact");
}

function governedFamily(manifest, lineage) {
  if (lineage.approach_family_ref === null) return null;
  return manifest.family_governance.find((family) => family.approach_family_ref === lineage.approach_family_ref) ?? null;
}

function requireFamilyEligible(manifest, lineage) {
  const family = governedFamily(manifest, lineage);
  if (family === null) return;
  if (canonicalJson(family.context_policy) !== canonicalJson(lineage.context_policy)) fail("CONTEXT_POLICY_MISMATCH", "worker lineage differs from governed family context policy");
  if (family.state === "blocked") fail("APPROACH_FAMILY_BLOCKED", "approach family is blocked");
}

function validateArtifactReferences(manifest, lineage, name) {
  if (lineage.shared_artifact_ids.length > 0 && !lineage.context_policy.share_existing_findings) fail("INVALID_SCHEMA", `${name} shares findings while context policy forbids it`);
  for (const artifactId of lineage.shared_artifact_ids) {
    const artifact = manifest.artifacts.find((entry) => entry.artifact_id === artifactId);
    if (artifact === undefined || artifact.artifact_kind !== "finding") fail("INVALID_SCHEMA", `${name} references invalid finding artifact`);
  }
}

const TRANSITION_OPERATIONS = [
  "control-init", "task-record", "task-cancel-record", "registry-observation-record", "placement-reserve", "worker-run-record", "consultation-record", "worker-admit", "worker-cancel-request",
  "worker-workspace-bind", "worker-observe", "worker-report-import", "consultation-observe", "consultation-cancel", "campaign-record", "campaign-release", "phase-gate-record", "phase-gate-advance", "artifact-record", "artifact-status-record", "artifact-generation-record", "approach-family-record", "approach-family-block", "approach-family-reopen", "worker-accept", "worker-reject", "task-finalize", "control-migrate", "control-finalize", "control-archive",
];

function receiptDigest(value) {
  const payload = structuredClone(value);
  delete payload.receipt_digest;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function validateTransitionReceipt(value, name) {
  exact(value, ["revision", "actor_id", "operation", "subject", "subject_digest", "previous_state", "next_state", "evidence", "recorded_at", "previous_receipt_digest", "receipt_digest"], name);
  integer(value.revision, `${name}.revision`); string(value.actor_id, `${name}.actor_id`);
  oneOf(value.operation, TRANSITION_OPERATIONS, `${name}.operation`);
  exact(value.subject, ["kind", "id"], `${name}.subject`);
  oneOf(value.subject.kind, ["control", "task", "registry-observation", "worker-run", "consultation", "campaign", "phase-gate", "artifact", "approach-family", "task-finalization"], `${name}.subject.kind`);
  identifier(value.subject.id, `${name}.subject.id`);
  if (value.subject_digest !== null && !SHA256_RE.test(value.subject_digest)) fail("INVALID_SCHEMA", `${name}.subject_digest is invalid`);
  if (value.previous_state !== null) string(value.previous_state, `${name}.previous_state`);
  string(value.next_state, `${name}.next_state`);
  evidenceArray(value.evidence, `${name}.evidence`);
  timestamp(value.recorded_at, `${name}.recorded_at`);
  if (value.previous_receipt_digest !== null && !SHA256_RE.test(value.previous_receipt_digest)) fail("INVALID_SCHEMA", `${name}.previous_receipt_digest is invalid`);
  if (!SHA256_RE.test(value.receipt_digest) || value.receipt_digest !== receiptDigest(value)) fail("INVALID_SCHEMA", `${name}.receipt_digest is invalid`);
}

function manifestSchemaAtRevision(manifest, revision) {
  let schemaVersion = manifest.schema_version;
  const laterMigrations = manifest.transition_receipts
    .filter((receipt) => receipt.operation === "control-migrate" && receipt.revision > revision)
    .sort((left, right) => right.revision - left.revision);
  for (const receipt of laterMigrations) {
    if (receipt.next_state !== schemaVersion) fail("INVALID_SCHEMA", "control migrate receipts do not reconstruct schema history");
    schemaVersion = receipt.previous_state;
  }
  return schemaVersion;
}

export function validateManifest(value) {
  if (!isObject(value) || !MANIFEST_SCHEMAS.includes(value.schema_version)) fail("INVALID_SCHEMA", "unsupported manifest schema");
  // Version-aware top-level shape (ADR 0114 Decision 4): v25-v28 manifests do not carry the
  // lane_admission key at all — absence IS their canonical shape; only v29 requires it.
  const manifestKeys = ["schema_version", "record_revision", "control_id", "status", "declaration", "continuation", "durability", "budget", "role_effect_policy", "document_refs", "registry_observations", "tasks", "task_cancellations", "worker_runs", "consultations", "campaigns", "phase_gate", "artifacts", "family_governance", "task_finalizations", "control_finalization", "transition_receipts", "last_update"];
  if (laneAdmissionSchema(value.schema_version)) manifestKeys.push("lane_admission");
  exact(value, manifestKeys, "manifest");
  integer(value.record_revision, "manifest.record_revision"); identifier(value.control_id, "manifest.control_id"); oneOf(value.status, ["active", "archived"], "manifest.status");
  validateDeclaration(value.declaration); validateContinuation(value.continuation, value.control_id); validateDurability(value.durability); validateBudget(value.budget); validateRoleEffectPolicy(value.role_effect_policy); refs(value.document_refs, "manifest.document_refs");
  boundedArray(value.registry_observations, "manifest.registry_observations", validateRegistryObservation);
  boundedArray(value.tasks, "manifest.tasks", (entry) => validateTask(entry, true, externalSourceSchema(value.schema_version)));
  boundedArray(value.task_cancellations, "manifest.task_cancellations", validateTaskCancellation);
  boundedArray(value.worker_runs, "manifest.worker_runs", (entry) => validateWorker(entry, true, EXECUTOR_CONTRACT_REGISTRY, selectorDecisionSchema(value.schema_version)));
  boundedArray(value.consultations, "manifest.consultations", (entry) => validateConsultation(entry, value.schema_version));
  boundedArray(value.campaigns, "manifest.campaigns", validateCampaign);
  validatePhaseGate(value.phase_gate);
  boundedArray(value.artifacts, "manifest.artifacts", validateArtifact);
  boundedArray(value.family_governance, "manifest.family_governance", validateFamilyGovernance);
  boundedArray(value.task_finalizations, "manifest.task_finalizations", validateFinalization);
  if (value.control_finalization !== null) validateControlFinalization(value.control_finalization);
  boundedArray(value.transition_receipts, "manifest.transition_receipts", validateTransitionReceipt, { min: 1 });
  if (laneAdmissionSchema(value.schema_version)) validateStoredLaneAdmission(value);
  if (!artifactGenerationSchema(value.schema_version) && value.transition_receipts.some((receipt) => receipt.operation === "artifact-generation-record")) fail("INVALID_SCHEMA", "artifact generation receipt requires a v28 or newer manifest");
  exact(value.last_update, ["actor_id", "updated_at"], "last_update"); string(value.last_update.actor_id, "last_update.actor_id"); timestamp(value.last_update.updated_at, "last_update.updated_at");
  if (value.transition_receipts.length !== value.record_revision + 1) fail("INVALID_SCHEMA", "transition receipt count differs from record revision");
  for (let index = 0; index < value.transition_receipts.length; index++) {
    const receipt = value.transition_receipts[index];
    if (receipt.revision !== index) fail("INVALID_SCHEMA", "transition receipt revision is not contiguous");
    const expectedPrevious = index === 0 ? null : value.transition_receipts[index - 1].receipt_digest;
    if (receipt.previous_receipt_digest !== expectedPrevious) fail("INVALID_SCHEMA", "transition receipt chain is invalid");
    const subjectDigestRequired = ["placement-reserve", "worker-run-record", "worker-workspace-bind", "campaign-record", "phase-gate-record", "artifact-record", "artifact-status-record", "artifact-generation-record", "approach-family-record", "approach-family-block", "approach-family-reopen", "task-finalize", "control-finalize"].includes(receipt.operation);
    const subjectDigestAllowed = subjectDigestRequired || (receipt.operation === "worker-observe" && receipt.next_state === "dispatched");
    if ((subjectDigestRequired && receipt.subject_digest === null) || (!subjectDigestAllowed && receipt.subject_digest !== null)) fail("INVALID_SCHEMA", "transition subject digest is invalid for operation");
  }
  const migrateReceipts = value.transition_receipts.filter((receipt) => receipt.operation === "control-migrate");
  for (let index = 0; index < migrateReceipts.length; index++) {
    const receipt = migrateReceipts[index];
    if (receipt.subject.kind !== "control" || receipt.subject.id !== value.control_id || receipt.evidence.length !== 0) fail("INVALID_SCHEMA", "control migrate receipt subject is invalid");
    if (!MANIFEST_SCHEMAS.includes(receipt.previous_state) || !MANIFEST_SCHEMAS.includes(receipt.next_state) || receipt.previous_state === receipt.next_state) fail("INVALID_SCHEMA", "control migrate receipt schema transition is invalid");
    if (index > 0 && migrateReceipts[index - 1].next_state !== receipt.previous_state) fail("INVALID_SCHEMA", "control migrate receipts do not chain");
  }
  if (migrateReceipts.length > 0 && migrateReceipts.at(-1).next_state !== value.schema_version) fail("INVALID_SCHEMA", "control migrate receipt differs from manifest schema version");
  const firstReceipt = value.transition_receipts[0];
  if (firstReceipt.operation !== "control-init" || firstReceipt.subject.kind !== "control" || firstReceipt.subject.id !== value.control_id || firstReceipt.previous_state !== null || firstReceipt.next_state !== "active") fail("INVALID_SCHEMA", "initial transition receipt is invalid");
  const lastReceipt = value.transition_receipts.at(-1);
  if (lastReceipt.actor_id !== value.last_update.actor_id || lastReceipt.recorded_at !== value.last_update.updated_at) fail("INVALID_SCHEMA", "last update differs from transition receipt");
  if ((value.status === "archived") !== (lastReceipt.operation === "control-archive" && lastReceipt.previous_state === "finalized" && lastReceipt.next_state === "archived")) fail("INVALID_SCHEMA", "control status differs from transition receipt");
  const controlFinalizeReceipts = value.transition_receipts.filter((receipt) => receipt.operation === "control-finalize");
  if ((value.control_finalization === null) !== (controlFinalizeReceipts.length === 0) || controlFinalizeReceipts.length > 1) fail("INVALID_SCHEMA", "control finalization differs from transition receipts");
  if (value.control_finalization !== null) {
    if (value.control_finalization.objective_ref !== value.declaration.objective_ref) fail("INVALID_SCHEMA", "control finalization objective differs from declaration");
    const receipt = controlFinalizeReceipts[0];
    if (receipt.subject.kind !== "control" || receipt.subject.id !== value.control_id || receipt.subject_digest !== controlFinalizationDigest(value.control_finalization) || receipt.previous_state !== "active" || receipt.next_state !== "finalized" || receipt.actor_id !== value.control_finalization.finalized_by || Date.parse(receipt.recorded_at) < Date.parse(value.control_finalization.finalized_at)) fail("INVALID_SCHEMA", "control finalization receipt is invalid");
    const expectedRevision = value.control_finalization.finalized_from_revision + 1;
    if (receipt.revision !== expectedRevision) fail("INVALID_SCHEMA", "control finalization revision is invalid");
    const finalization = value.control_finalization;
    const matrixEvidence = receipt.evidence[0];
    const auditStart = 1; const regressionStart = auditStart + finalization.final_audit_evidence.length;
    const knowledgeStart = regressionStart + finalization.regression_evidence.length;
    const decisionIndex = knowledgeStart + finalization.knowledge_return_refs.length;
    if (receipt.evidence.length !== decisionIndex + 1
      || !matrixEvidence || matrixEvidence.type !== "file" || matrixEvidence.ref !== finalization.acceptance_matrix_ref || matrixEvidence.observed_at !== finalization.finalized_at
      || canonicalJson(receipt.evidence.slice(auditStart, regressionStart)) !== canonicalJson(finalization.final_audit_evidence)
      || canonicalJson(receipt.evidence.slice(regressionStart, knowledgeStart)) !== canonicalJson(finalization.regression_evidence)
      || finalization.knowledge_return_refs.some((ref, index) => {
        const descriptor = receipt.evidence[knowledgeStart + index];
        return !descriptor || descriptor.type !== "file" || descriptor.ref !== ref || descriptor.observed_at !== finalization.finalized_at;
      })
      || canonicalJson(receipt.evidence[decisionIndex]) !== canonicalJson(finalization.parent_decision)) fail("INVALID_SCHEMA", "control finalization evidence is not fully bound");
    const expectedFinalReceiptIndex = value.status === "archived" ? value.transition_receipts.length - 2 : value.transition_receipts.length - 1;
    if (value.transition_receipts[expectedFinalReceiptIndex]?.operation !== "control-finalize") fail("INVALID_SCHEMA", "control finalization is not terminal before archive");
  }
  const unique = (items, key) => { const seen = new Set(); for (const item of items) { if (seen.has(item[key])) fail("INVALID_SCHEMA", `duplicate ${key}`); seen.add(item[key]); } };
  unique(value.registry_observations, "registry_observation_id"); unique(value.tasks, "task_id"); unique(value.task_cancellations, "task_id"); unique(value.worker_runs, "worker_run_id"); unique(value.consultations, "consultation_id"); unique(value.campaigns, "campaign_id"); unique(value.artifacts, "artifact_id"); unique(value.family_governance, "approach_family_ref"); unique(value.task_finalizations, "task_id");
  const registries = new Map(value.registry_observations.map((entry) => [entry.registry_observation_id, entry]));
  for (const cancellation of value.task_cancellations) {
    if (!value.tasks.some((task) => task.task_id === cancellation.task_id)) fail("INVALID_SCHEMA", "task cancellation references unknown task");
    const receipts = value.transition_receipts.filter((receipt) => receipt.operation === "task-cancel-record" && receipt.subject.kind === "task" && receipt.subject.id === cancellation.task_id);
    if (receipts.length !== 1) fail("INVALID_SCHEMA", "task cancellation receipt is missing or duplicated");
    const receipt = receipts[0];
    if (receipt.revision !== cancellation.cancelled_from_revision + 1 || receipt.actor_id !== cancellation.cancelled_by || receipt.previous_state !== "active" || receipt.next_state !== "cancelled" || Date.parse(receipt.recorded_at) < Date.parse(cancellation.cancelled_at) || canonicalJson(receipt.evidence) !== canonicalJson([cancellation.decision])) fail("INVALID_SCHEMA", "task cancellation receipt is invalid");
  }
  if (value.transition_receipts.filter((receipt) => receipt.operation === "task-cancel-record").length !== value.task_cancellations.length) fail("INVALID_SCHEMA", "task cancellation receipts differ from records");
  for (const campaign of value.campaigns) {
    const recordReceipts = value.transition_receipts.filter((receipt) => receipt.operation === "campaign-record" && receipt.subject.kind === "campaign" && receipt.subject.id === campaign.campaign_id);
    if (recordReceipts.length !== 1) fail("INVALID_SCHEMA", "campaign record receipt is missing or duplicated");
    const recorded = recordReceipts[0];
    if (recorded.subject_digest !== campaignDeclarationDigest(campaign) || recorded.revision !== campaign.declared_from_revision + 1 || recorded.actor_id !== campaign.declared_by || recorded.previous_state !== null || recorded.next_state !== "declared" || recorded.evidence.length !== 0 || Date.parse(recorded.recorded_at) < Date.parse(campaign.declared_at)) fail("INVALID_SCHEMA", "campaign record receipt is invalid");
    const releaseReceipts = value.transition_receipts.filter((receipt) => receipt.operation === "campaign-release" && receipt.subject.kind === "campaign" && receipt.subject.id === campaign.campaign_id);
    if (campaign.release === null) {
      if (releaseReceipts.length !== 0) fail("INVALID_SCHEMA", "campaign release receipt exists without release");
    } else {
      if (releaseReceipts.length !== 1) fail("INVALID_SCHEMA", "campaign release receipt is missing or duplicated");
      const released = releaseReceipts[0];
      if (released.revision !== campaign.release.released_from_revision + 1 || released.actor_id !== campaign.release.released_by || released.previous_state !== "declared" || released.next_state !== "released" || canonicalJson(released.evidence) !== canonicalJson([campaign.release.decision, ...campaign.release.audit_evidence]) || Date.parse(released.recorded_at) < Date.parse(campaign.release.released_at)) fail("INVALID_SCHEMA", "campaign release receipt is invalid");
    }
  }
  if (value.transition_receipts.filter((receipt) => receipt.operation === "campaign-record").length !== value.campaigns.length) fail("INVALID_SCHEMA", "campaign record receipts differ from campaigns");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "campaign-release").length !== value.campaigns.filter((campaign) => campaign.release !== null).length) fail("INVALID_SCHEMA", "campaign release receipts differ from campaigns");
  const phaseGateRecords = value.transition_receipts.filter((receipt) => receipt.operation === "phase-gate-record");
  const phaseGateAdvances = value.transition_receipts.filter((receipt) => receipt.operation === "phase-gate-advance");
  if (value.phase_gate === null) {
    if (phaseGateRecords.length !== 0 || phaseGateAdvances.length !== 0) fail("INVALID_SCHEMA", "phase gate receipts exist without phase gate");
  } else {
    if (phaseGateRecords.length !== 1 || phaseGateRecords[0].subject.kind !== "phase-gate" || phaseGateRecords[0].subject.id !== PHASE_GATE_ID || phaseGateRecords[0].subject_digest !== phaseGateDeclarationDigest(value.phase_gate) || phaseGateRecords[0].revision !== value.phase_gate.declared_from_revision + 1 || phaseGateRecords[0].actor_id !== value.phase_gate.declared_by || phaseGateRecords[0].previous_state !== null || phaseGateRecords[0].next_state !== "recorded" || phaseGateRecords[0].evidence.length !== 0 || Date.parse(phaseGateRecords[0].recorded_at) < Date.parse(value.phase_gate.declared_at)) fail("INVALID_SCHEMA", "phase gate record receipt is invalid");
    const advanced = value.phase_gate.phases.filter((step) => step.state !== "pending");
    if (phaseGateAdvances.length !== advanced.length) fail("INVALID_SCHEMA", "phase gate advance receipts differ from phase state");
    for (const step of advanced) {
      const receipts = phaseGateAdvances.filter((receipt) => receipt.subject.kind === "phase-gate" && receipt.subject.id === step.phase);
      const expectedEvidence = [...step.evidence, ...(step.decision === null ? [] : [step.decision])];
      if (receipts.length !== 1 || receipts[0].revision !== step.advanced_from_revision + 1 || receipts[0].actor_id !== step.advanced_by || receipts[0].previous_state !== "pending" || receipts[0].next_state !== step.state || canonicalJson(receipts[0].evidence) !== canonicalJson(expectedEvidence) || Date.parse(receipts[0].recorded_at) < Date.parse(step.advanced_at)) fail("INVALID_SCHEMA", "phase gate advance receipt is invalid");
    }
  }
  const artifactById = new Map(value.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const generationReceipts = value.transition_receipts.filter((receipt) => receipt.operation === "artifact-generation-record");
  const generationByPredecessor = new Map(); const generationBySuccessor = new Map();
  for (const receipt of generationReceipts) {
    const predecessor = artifactById.get(receipt.subject.id);
    const successors = value.artifacts.filter((artifact) => artifact.recorded_from_revision + 1 === receipt.revision && artifact.recorded_by === receipt.actor_id && Date.parse(receipt.recorded_at) >= Date.parse(artifact.recorded_at));
    if (predecessor === undefined || successors.length !== 1) fail("INVALID_SCHEMA", "artifact generation pair is invalid");
    const successor = successors[0];
    if (generationByPredecessor.has(predecessor.artifact_id) || generationBySuccessor.has(successor.artifact_id)) fail("INVALID_SCHEMA", "artifact generation pair is duplicated");
    if (predecessor.status !== "superseded" || predecessor.status_from_revision + 1 !== receipt.revision || predecessor.status_by !== receipt.actor_id || predecessor.status_at !== successor.recorded_at || Date.parse(receipt.recorded_at) < Date.parse(predecessor.status_at)) fail("INVALID_SCHEMA", "artifact generation predecessor metadata is invalid");
    if (predecessor.artifact_kind !== successor.artifact_kind || predecessor.artifact_ref === successor.artifact_ref || predecessor.artifact_digest === successor.artifact_digest) fail("INVALID_SCHEMA", "artifact generation descriptor transition is invalid");
    if (receipt.subject.kind !== "artifact" || receipt.previous_state !== "current" || receipt.next_state !== "superseded" || receipt.evidence.length !== 0 || receipt.subject_digest !== artifactGenerationDigest(predecessor, successor)) fail("INVALID_SCHEMA", "artifact generation receipt is invalid");
    generationByPredecessor.set(predecessor.artifact_id, receipt); generationBySuccessor.set(successor.artifact_id, receipt);
  }
  for (const artifact of value.artifacts) {
    const subjectReceipts = value.transition_receipts.filter((receipt) => receipt.subject.kind === "artifact" && receipt.subject.id === artifact.artifact_id);
    const records = subjectReceipts.filter((receipt) => receipt.operation === "artifact-record");
    const updates = subjectReceipts.filter((receipt) => receipt.operation === "artifact-status-record").sort((left, right) => left.revision - right.revision);
    const generationCreate = generationBySuccessor.get(artifact.artifact_id) ?? null;
    const generationUpdate = generationByPredecessor.get(artifact.artifact_id) ?? null;
    const descriptorDigest = artifactDescriptorDigest(artifact);
    if (records.length + (generationCreate === null ? 0 : 1) !== 1) fail("INVALID_SCHEMA", "artifact creation receipt is missing or duplicated");
    if (records.length === 1 && (records[0].subject_digest !== descriptorDigest || records[0].revision !== artifact.recorded_from_revision + 1 || records[0].actor_id !== artifact.recorded_by || records[0].previous_state !== null || records[0].next_state !== "current" || records[0].evidence.length !== 0 || Date.parse(records[0].recorded_at) < Date.parse(artifact.recorded_at))) fail("INVALID_SCHEMA", "artifact record receipt is invalid");
    if (records.length === 1 && artifactGenerationSchema(manifestSchemaAtRevision(value, records[0].revision))) versionedArtifactRef(artifact.artifact_ref, artifact.artifact_digest, "artifact.artifact_ref");
    if (subjectReceipts.length !== records.length + updates.length + (generationUpdate === null ? 0 : 1)) fail("INVALID_SCHEMA", "artifact receipt operation is invalid");
    let state = "current";
    for (const receipt of updates) {
      if (receipt.subject_digest !== descriptorDigest || receipt.evidence.length !== 0 || receipt.previous_state !== state || state !== "current" || !["closed", "superseded"].includes(receipt.next_state)) fail("INVALID_SCHEMA", "artifact status receipt is invalid");
      state = receipt.next_state;
    }
    if (generationUpdate !== null) {
      if (updates.length !== 0 || state !== "current") fail("INVALID_SCHEMA", "artifact generation conflicts with status receipt");
      state = "superseded";
    }
    const terminalReceipt = generationUpdate ?? updates[0] ?? null;
    if (artifact.status !== state || (artifact.status === "current" ? terminalReceipt !== null : terminalReceipt === null)) fail("INVALID_SCHEMA", "artifact status differs from receipts");
    if (artifact.status !== "current" && (terminalReceipt.revision !== artifact.status_from_revision + 1 || terminalReceipt.actor_id !== artifact.status_by || Date.parse(terminalReceipt.recorded_at) < Date.parse(artifact.status_at))) fail("INVALID_SCHEMA", "artifact status metadata is invalid");
  }
  const artifactSubjectReceipts = value.transition_receipts.filter((receipt) => receipt.subject.kind === "artifact");
  if (artifactSubjectReceipts.some((receipt) => !["artifact-record", "artifact-status-record", "artifact-generation-record"].includes(receipt.operation))) fail("INVALID_SCHEMA", "artifact receipt operation is invalid");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "artifact-record").length + generationReceipts.length !== value.artifacts.length) fail("INVALID_SCHEMA", "artifact creation receipts differ from artifacts");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "artifact-status-record").length + generationReceipts.length !== value.artifacts.filter((artifact) => artifact.status !== "current").length) fail("INVALID_SCHEMA", "artifact terminal receipts differ from artifacts");
  for (const family of value.family_governance) {
    requireFamilyArtifacts(value, family);
    const receipts = value.transition_receipts.filter((receipt) => receipt.subject.kind === "approach-family" && receipt.subject.id === family.approach_family_ref);
    const records = receipts.filter((receipt) => receipt.operation === "approach-family-record");
    const blocks = receipts.filter((receipt) => receipt.operation === "approach-family-block");
    const reopens = receipts.filter((receipt) => receipt.operation === "approach-family-reopen");
    if (records.length !== 1 || records[0].subject_digest !== familyDeclarationDigest(family) || records[0].revision !== family.declared_from_revision + 1 || records[0].actor_id !== family.declared_by || records[0].previous_state !== null || records[0].next_state !== "open" || records[0].evidence.length !== 0 || Date.parse(records[0].recorded_at) < Date.parse(family.declared_at)) fail("INVALID_SCHEMA", "family governance record receipt is invalid");
    if (family.block === null) {
      if (blocks.length !== 0 || reopens.length !== 0 || receipts.length !== 1) fail("INVALID_SCHEMA", "family governance action receipts are invalid");
      continue;
    }
    if (blocks.length !== 1 || blocks[0].subject_digest !== familyBlockDigest(family) || blocks[0].revision !== family.block.from_revision + 1 || blocks[0].actor_id !== family.block.by || blocks[0].previous_state !== "open" || blocks[0].next_state !== "blocked" || blocks[0].evidence.length !== 0 || Date.parse(blocks[0].recorded_at) < Date.parse(family.block.at)) fail("INVALID_SCHEMA", "family governance block receipt is invalid");
    if (family.reopen === null) {
      if (reopens.length !== 0 || receipts.length !== 2) fail("INVALID_SCHEMA", "family governance reopen receipt is invalid");
      continue;
    }
    if (reopens.length !== 1 || receipts.length !== 3 || reopens[0].subject_digest !== familyReopenDigest(family) || reopens[0].revision !== family.reopen.from_revision + 1 || reopens[0].actor_id !== family.reopen.by || reopens[0].previous_state !== "blocked" || reopens[0].next_state !== "reopened" || reopens[0].evidence.length !== 0 || Date.parse(reopens[0].recorded_at) < Date.parse(family.reopen.at)) fail("INVALID_SCHEMA", "family governance reopen receipt is invalid");
  }
  if (value.transition_receipts.filter((receipt) => receipt.operation === "approach-family-record").length !== value.family_governance.length) fail("INVALID_SCHEMA", "family governance record receipts differ from records");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "approach-family-block").length !== value.family_governance.filter((family) => family.block !== null).length) fail("INVALID_SCHEMA", "family governance block receipts differ from records");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "approach-family-reopen").length !== value.family_governance.filter((family) => family.reopen !== null).length) fail("INVALID_SCHEMA", "family governance reopen receipts differ from records");
  for (const run of value.worker_runs) {
    const creationReceipts = value.transition_receipts.filter((receipt) => receipt.subject.kind === "worker-run" && receipt.subject.id === run.worker_run_id && ["worker-run-record", "placement-reserve"].includes(receipt.operation));
    if (creationReceipts.length !== 1) fail("INVALID_SCHEMA", "worker creation receipt is missing or duplicated");
    const receipt = creationReceipts[0];
    if (run.placement_reservation === null) {
      if (receipt.operation !== "worker-run-record" || receipt.subject_digest !== manualWorkerCreationDigest(run)) fail("INVALID_SCHEMA", "manual worker creation receipt is invalid");
    } else {
      if (receipt.operation !== "placement-reserve" || receipt.revision !== run.placement_reservation.selected_from_revision + 1 || receipt.actor_id !== run.placement_reservation.selected_by || Date.parse(receipt.recorded_at) < Date.parse(run.placement_reservation.selected_at)) fail("INVALID_SCHEMA", "placement reservation receipt is invalid");
      const registry = registries.get(run.placement_reservation.registry_observation_id);
      if (registry === undefined) fail("INVALID_SCHEMA", "placement reservation registry snapshot is missing");
      if (!sameRegistryScope(run, registry)
        || canonicalJson(run.workflow_capabilities) !== canonicalJson(registry.workflow_capabilities)
        || canonicalJson(run.execution_verification) !== canonicalJson(registry.verification)) {
        fail("INVALID_SCHEMA", "placement reservation differs from registry snapshot");
      }
      const materialized = materializedPlacementCandidate(run, run.placement_reservation.registry_observation_id);
      const currentCandidateMatches = run.placement_reservation.candidate_digest === placementCandidateDigest(materialized);
      const dispatchReceipt = value.transition_receipts.find((entry) => entry.operation === "worker-observe" && entry.subject.kind === "worker-run" && entry.subject.id === run.worker_run_id && entry.next_state === "dispatched");
      const dispatchHandleBound = dispatchReceipt?.subject_digest === workerDispatchCorrelationDigest(run);
      const nullHandleCandidateMatches = run.executor_handle !== null
        && run.placement_reservation.candidate_digest === placementCandidateDigest({ ...materialized, executor_handle: null });
      if (!currentCandidateMatches && !(nullHandleCandidateMatches && dispatchHandleBound)) fail("INVALID_SCHEMA", "placement reservation candidate digest is invalid");
      if (receipt.subject_digest !== placementReservationDigest(run.placement_reservation)) fail("INVALID_SCHEMA", "placement reservation content differs from creation receipt");
    }
    const cancelReceipts = value.transition_receipts.filter((entry) => entry.operation === "worker-cancel-request" && entry.subject.kind === "worker-run" && entry.subject.id === run.worker_run_id);
    if (run.cancel_request === null) {
      if (cancelReceipts.length !== 0) fail("INVALID_SCHEMA", "worker cancel request receipt exists without request");
    } else {
      if (cancelReceipts.length !== 1) fail("INVALID_SCHEMA", "worker cancel request receipt is missing or duplicated");
      const cancelReceipt = cancelReceipts[0];
      if (cancelReceipt.revision !== run.cancel_request.requested_from_revision + 1 || cancelReceipt.actor_id !== run.cancel_request.requested_by || cancelReceipt.previous_state !== cancelReceipt.next_state || !["admitted", "dispatched", "running", "unknown"].includes(cancelReceipt.previous_state) || Date.parse(cancelReceipt.recorded_at) < Date.parse(run.cancel_request.requested_at) || canonicalJson(cancelReceipt.evidence) !== canonicalJson([run.cancel_request.decision])) fail("INVALID_SCHEMA", "worker cancel request receipt is invalid");
    }
    const bindReceipts = value.transition_receipts.filter((entry) => entry.operation === "worker-workspace-bind" && entry.subject.kind === "worker-run" && entry.subject.id === run.worker_run_id);
    if (run.workspace_binding.mode === "fixed" || run.workspace_binding.execution_workspace === null) {
      if (bindReceipts.length !== 0) fail("INVALID_SCHEMA", "workspace bind receipt exists without binding");
    } else {
      if (bindReceipts.length !== 1) fail("INVALID_SCHEMA", "workspace bind receipt is missing or duplicated");
      const bindReceipt = bindReceipts[0];
      if (bindReceipt.revision !== run.workspace_binding.bound_from_revision + 1 || bindReceipt.actor_id !== run.workspace_binding.bound_by || bindReceipt.previous_state !== bindReceipt.next_state || !["dispatched", "running", "unknown"].includes(bindReceipt.previous_state) || Date.parse(bindReceipt.recorded_at) < Date.parse(run.workspace_binding.bound_at) || canonicalJson(bindReceipt.evidence) !== canonicalJson(run.workspace_binding.binding_evidence) || bindReceipt.subject_digest !== sidecarProviderBindingDigest(run.workspace_binding.provider_binding)) fail("INVALID_SCHEMA", "workspace bind receipt is invalid");
    }
  }
  if (value.transition_receipts.filter((receipt) => receipt.operation === "worker-cancel-request").length !== value.worker_runs.filter((run) => run.cancel_request !== null).length) fail("INVALID_SCHEMA", "worker cancel request receipts differ from records");
  if (value.transition_receipts.filter((receipt) => receipt.operation === "worker-workspace-bind").length !== value.worker_runs.filter((run) => run.workspace_binding.mode === "executor-isolated" && run.workspace_binding.execution_workspace !== null).length) fail("INVALID_SCHEMA", "workspace bind receipts differ from records");
  assertBudgetWithin(value, null, null, { allowUnknown: true });
  const tasks = new Map(value.tasks.map((task) => [task.task_id, task]));
  for (const task of value.tasks) enforceRoleEffectPolicy(task, value.role_effect_policy);
  for (const task of value.tasks) {
    for (const dependency of task.depends_on) if (!tasks.has(dependency) || dependency === task.task_id) fail("INVALID_SCHEMA", "task dependency is invalid");
  }
  const visiting = new Set(); const visited = new Set();
  const visitTask = (taskId) => {
    if (visiting.has(taskId)) fail("INVALID_SCHEMA", "task dependency cycle detected");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasks.get(taskId).depends_on) visitTask(dependency);
    visiting.delete(taskId); visited.add(taskId);
  };
  for (const taskId of tasks.keys()) visitTask(taskId);
  for (const run of value.worker_runs) {
    const task = tasks.get(run.task_id); if (!task) fail("INVALID_SCHEMA", "worker references unknown task");
    if (run.role_ref !== task.role) fail("INVALID_SCHEMA", "worker role differs from task snapshot");
    if ((task.effect === "write") !== (run.write_mode !== "none")) fail("INVALID_SCHEMA", "worker write mode contradicts task");
    if (JSON.stringify(run.lineage.context_policy) !== JSON.stringify(task.context_policy)) fail("INVALID_SCHEMA", "worker lineage context policy contradicts task");
    requireTaskCapabilities(run, task);
    if (run.workspace_binding.mode === "executor-isolated" && task.isolation !== "dedicated-worktree") fail("INVALID_SCHEMA", "executor-isolated worker contradicts task isolation");
  }
  const workers = new Map(value.worker_runs.map((run) => [run.worker_run_id, run]));
  for (const run of value.worker_runs) {
    if (run.fallback !== null) {
      const prior = workers.get(run.fallback.from_worker_run_id);
      if (!prior || prior.worker_run_id === run.worker_run_id || prior.task_id !== run.task_id || prior.state !== "failed") fail("INVALID_SCHEMA", "fallback must reference a failed Run of the same Task");
    }
    if (run.lineage.parent_worker_run_id === null) {
      if (run.lineage.root_assignment_id !== run.assignment_id) fail("INVALID_SCHEMA", "root worker lineage is invalid");
    } else {
      const parent = workers.get(run.lineage.parent_worker_run_id);
      if (!parent || parent.worker_run_id === run.worker_run_id || run.lineage.root_assignment_id !== parent.lineage.root_assignment_id) fail("INVALID_SCHEMA", "child worker lineage is invalid");
    }
  }
  const lineageVisiting = new Set(); const lineageVisited = new Set();
  const visitWorker = (runId) => {
    if (lineageVisiting.has(runId)) fail("INVALID_SCHEMA", "worker lineage cycle detected");
    if (lineageVisited.has(runId)) return;
    lineageVisiting.add(runId);
    const parent = workers.get(runId).lineage.parent_worker_run_id; if (parent !== null) visitWorker(parent);
    lineageVisiting.delete(runId); lineageVisited.add(runId);
  };
  for (const runId of workers.keys()) visitWorker(runId);
  for (const consultation of value.consultations) if (!tasks.has(consultation.task_id)) fail("INVALID_SCHEMA", "consultation references invalid task");
  for (const run of value.worker_runs) validateArtifactReferences(value, run.lineage, "worker lineage");
  for (const campaign of value.campaigns) {
    for (const taskId of campaign.gated_task_ids) if (!tasks.has(taskId)) fail("INVALID_SCHEMA", "campaign references invalid gated task");
    for (const member of campaign.members) if (campaignMemberState(value, member) === null) fail("INVALID_SCHEMA", "campaign references invalid member");
    if (campaign.release !== null && !campaignReadyForRelease(value, campaign)) fail("INVALID_SCHEMA", "released campaign has unready members");
  }
  for (const finalization of value.task_finalizations) {
    if (!tasks.has(finalization.task_id)) fail("INVALID_SCHEMA", "finalization references unknown task");
    if (value.task_cancellations.some((entry) => entry.task_id === finalization.task_id)) fail("INVALID_SCHEMA", "cancelled task cannot be finalized");
    if (!taskReadyForFinalization(value, finalization.task_id)) fail("INVALID_SCHEMA", "finalized task has active or undecided child execution");
    const receipts = value.transition_receipts.filter((receipt) => receipt.operation === "task-finalize" && receipt.subject.kind === "task-finalization" && receipt.subject.id === finalization.task_id);
    if (receipts.length !== 1) fail("INVALID_SCHEMA", "task finalization receipt is missing or duplicated");
    const receipt = receipts[0]; const descriptor = receipt.evidence[0];
    if (receipt.subject_digest !== taskFinalizationDigest(finalization) || receipt.actor_id !== finalization.recorded_by || receipt.previous_state !== "unfinalized" || receipt.next_state !== "finalized" || Date.parse(receipt.recorded_at) < Date.parse(finalization.recorded_at)
      || receipt.evidence.length !== 1 || !descriptor || descriptor.type !== "decision" || descriptor.ref !== finalization.finalization_ref || descriptor.observed_at !== finalization.recorded_at) fail("INVALID_SCHEMA", "task finalization receipt is invalid");
  }
  if (value.transition_receipts.filter((receipt) => receipt.operation === "task-finalize").length !== value.task_finalizations.length) fail("INVALID_SCHEMA", "task finalization receipts differ from records");
  if (value.control_finalization !== null) assertControlReadyForFinalization(value, "INVALID_SCHEMA");
  return value;
}

function apiInput(value, required, optional = [], name = "input") {
  exactOptional(value, required, optional, name, "INVALID_INPUT");
  if (required.includes("cwd")) string(value.cwd, `${name}.cwd`, 4096);
  return value;
}

function safeEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return env;
}

async function runGit(cwd, args, { allowFailure = false, limit = GIT_OUTPUT_LIMIT } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["--no-optional-locks", "-C", cwd, ...args], { env: safeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let outSize = 0; let errSize = 0; let exceeded = false;
    child.stdout.on("data", (chunk) => { outSize += chunk.length; if (outSize <= limit + 1) stdout.push(chunk); if (outSize > limit) { exceeded = true; child.kill(); } });
    child.stderr.on("data", (chunk) => { errSize += chunk.length; if (errSize <= 64 * 1024) stderr.push(chunk); });
    child.on("error", (error) => rejectPromise(new ControlRecordError("GIT_FAILURE", "git could not be executed", { cause: error.code })));
    child.on("close", (code, signal) => {
      if (exceeded) return rejectPromise(new ControlRecordError("LIMIT_EXCEEDED", "git output exceeds limit"));
      const out = Buffer.concat(stdout);
      if (code !== 0 && !allowFailure) return rejectPromise(new ControlRecordError("GIT_FAILURE", "git command failed", { exit_code: code, signal, stderr: Buffer.concat(stderr).toString("utf8").slice(0, 4096) }));
      resolvePromise({ code, stdout: out, stderr: Buffer.concat(stderr) });
    });
  });
}

async function canonicalCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096) fail("INVALID_INPUT", "cwd is required");
  let path;
  try { path = await realpath(resolve(cwd)); } catch (error) { fail("IO_FAILURE", "cwd cannot be resolved", { cause: error.code }); }
  let info;
  try { info = await stat(path); } catch (error) { fail("IO_FAILURE", "cwd cannot be inspected", { cause: error.code }); }
  if (!info.isDirectory()) fail("INVALID_INPUT", "cwd must be a directory");
  return path;
}

async function gitIdentity(cwd) {
  const rootCwd = await canonicalCwd(cwd);
  const inside = await runGit(rootCwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  const bareResult = await runGit(rootCwd, ["rev-parse", "--is-bare-repository"], { allowFailure: true });
  if (bareResult.code !== 0 || (inside.code !== 0 && bareResult.stdout.toString().trim() !== "true")) fail("NOT_GIT_REPOSITORY", "cwd is not a git repository");
  const bare = bareResult.stdout.toString().trim() === "true";
  try {
    const commonRaw = (await runGit(rootCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.toString().trim();
    const gitRaw = (await runGit(rootCwd, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).stdout.toString().trim();
    const common = await realpath(commonRaw); const gitDir = await realpath(gitRaw);
    const gitDirStat = await lstat(gitDir, { bigint: true });
    if (gitDirStat.isSymbolicLink() || !gitDirStat.isDirectory()) fail("STATE_PATH_UNSAFE", "git directory is not a safe directory");
    const gitDirFileId = `${gitDirStat.dev.toString(10)}:${gitDirStat.ino.toString(10)}`;
    if (bare) return { kind: "bare", cwd: rootCwd, projectRoot: null, worktreeRoot: null, commonDir: common, gitDir, gitDirFileId, head: null };
    const topRaw = (await runGit(rootCwd, ["rev-parse", "--show-toplevel"])).stdout.toString().trim();
    const top = await realpath(topRaw);
    const headResult = await runGit(top, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const head = headResult.code === 0 ? headResult.stdout.toString().trim() : null;
    if (head !== null && !SHA1_RE.test(head)) fail("GIT_FAILURE", "git returned an invalid HEAD");
    return { kind: "worktree", cwd: rootCwd, projectRoot: top, worktreeRoot: top, commonDir: common, gitDir, gitDirFileId, head };
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    fail("GIT_FAILURE", "git identity resolution failed");
  }
}

function workspaceObject(identity, reservation = null) {
  return {
    kind: identity.kind,
    worktree_root_realpath: identity.worktreeRoot,
    git_dir_realpath: identity.gitDir,
    git_dir_file_id: identity.gitDirFileId,
    common_dir_realpath: identity.commonDir,
    head_at_record: identity.kind === "bare" ? null : identity.head,
    head_at_reservation: identity.kind === "bare" ? null : reservation,
  };
}

function workspaceBindingObject(mode, sourceWorkspace) {
  if (mode === "fixed") return { mode: "fixed" };
  return {
    mode: "executor-isolated", schema_version: "codex-sidecar.delayed-worktree.v1",
    base_sha: sourceWorkspace.head_at_record, preserve_worktree: true,
    execution_workspace: null, provider_binding: null, bound_from_revision: null, binding_evidence: [], bound_by: null, bound_at: null,
  };
}

function effectiveWorkspace(run) {
  return run.workspace_binding.mode === "executor-isolated" ? run.workspace_binding.execution_workspace : run.workspace;
}

function requiredExecutionWorkspace(run) {
  const workspace = effectiveWorkspace(run);
  if (workspace === null) fail("INVALID_TRANSITION", "executor execution workspace is not bound");
  return workspace;
}

function sameWorkspaceIdentity(stored, actual) {
  return stored.kind === actual.kind && stored.worktree_root_realpath === actual.worktreeRoot && stored.git_dir_realpath === actual.gitDir && stored.git_dir_file_id === actual.gitDirFileId && stored.common_dir_realpath === actual.commonDir;
}

function gitDirFileIdentity(value) {
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(value);
  return match === null ? null : { device: match[1], inode: match[2] };
}

function sameGitDirGeneration(storedFileId, actualFileId) {
  if (storedFileId === actualFileId) return true;
  const stored = gitDirFileIdentity(storedFileId);
  const actual = gitDirFileIdentity(actualFileId);
  return stored !== null && actual !== null && stored.inode === actual.inode;
}

function gitDirDeviceChanged(storedFileId, actualFileId) {
  if (storedFileId === actualFileId) return false;
  const stored = gitDirFileIdentity(storedFileId);
  const actual = gitDirFileIdentity(actualFileId);
  return stored !== null && actual !== null && stored.inode === actual.inode && stored.device !== actual.device;
}

function requireTaskIsolation(manifest, task, workspace, bindingMode = "fixed") {
  if (bindingMode === "executor-isolated") {
    if (task.isolation !== "dedicated-worktree") fail("INVALID_SCHEMA", "executor-isolated binding requires dedicated-worktree task isolation");
    return;
  }
  if (task.isolation === "dedicated-worktree" && (workspace.kind !== "worktree" || workspace.worktreeRoot === manifest.declaration.project_root_realpath)) {
    fail("WORKSPACE_DRIFT", "dedicated worktree is required");
  }
}

async function ensureDir(path, { create = false } = {}) {
  try {
    if (create) await mkdir(path, { mode: 0o700 });
    let info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("STATE_PATH_UNSAFE", "state path is not a safe directory");
    if (create && !isWin32()) { await chmod(path, 0o700); info = await lstat(path); }
    if (!isWin32() && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)) fail("STATE_PATH_UNSAFE", "state directory owner or mode is unsafe");
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    if (create && error.code === "EEXIST") return ensureDir(path);
    fail("IO_FAILURE", "state directory operation failed", { cause: error.code });
  }
}

const STATE_BINDING_SCHEMA = "dotagents.orchestration-state-binding.v1";
const BINDING_LIMIT = 4096;

// mode-fidelity probe: 今まさに自分がmkdir(0700)した新品ディレクトリの読み戻しで
// 「このFSはPOSIX modeを忠実に保持・表示するか」を判定する。fresh directoryなら改ざんの
// 窓が無いため、capable FS上の0777（改ざん）とmode非忠実FS（metadata無しDrvFS等）を区別できる。
// これはmode表示の忠実性の証明であって、アクセス強制力の証明ではない（dmask等で0700を表示する
// mode非忠実mountは既存実装と同様に受け入れる。以後の異常は既存のlstat/nlink/uid検査が拾う）。
async function probeStateModeFidelity(baseDir) {
  if (isWin32()) return false;
  if (process.env.NODE_ENV === "test" && process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY) {
    const forced = process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY;
    if (forced === "capable") return true;
    if (forced === "incapable") return false;
    fail("INVALID_INPUT", "unknown state fidelity test override");
  }
  const path = join(baseDir, `.dotagents-state-probe-${randomUUID()}`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { fail("IO_FAILURE", "state fidelity probe could not be created", { cause: error.code }); }
  let capable;
  try {
    await chmod(path, 0o700);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("STATE_PATH_UNSAFE", "state fidelity probe was replaced");
    capable = info.uid === process.getuid() && (info.mode & 0o777) === 0o700;
  } catch (error) {
    await rmdir(path).catch(() => {});
    if (error instanceof ControlRecordError) throw error;
    fail("IO_FAILURE", "state fidelity probe failed", { cause: error.code });
  }
  try { await rmdir(path); }
  catch (error) { fail("IO_FAILURE", "state fidelity probe could not be removed", { cause: error.code }); }
  return capable;
}

function externalStateBase() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = typeof xdg === "string" && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "state");
  if (!isAbsolute(base)) fail("INVALID_INPUT", "XDG_STATE_HOME must be an absolute path");
  return base;
}

// 外部stateのkeyはrepo identity（commonDir realpath）から決定的に導出する。repo側に
// 可変ポインタ（marker）を置かない＝差し替え可能な参照自体を存在させない。
function externalStateKey(identity) {
  return createHash("sha256").update(identity.commonDir, "utf8").digest("hex");
}

async function commonDirFileId(identity) {
  let info;
  try { info = await lstat(identity.commonDir, { bigint: true }); }
  catch (error) { fail("IO_FAILURE", "common dir cannot be inspected", { cause: error.code }); }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("STATE_PATH_UNSAFE", "common dir is not a safe directory");
  return `${info.dev.toString(10)}:${info.ino.toString(10)}`;
}

function validateBinding(value) {
  exact(value, ["schema_version", "common_dir_realpath", "common_dir_file_id", "created_at"], "state binding", "STATE_PATH_UNSAFE");
  if (value.schema_version !== STATE_BINDING_SCHEMA || typeof value.common_dir_realpath !== "string" || typeof value.common_dir_file_id !== "string" || typeof value.created_at !== "string" || new Date(value.created_at).toISOString() !== value.created_at) {
    fail("STATE_PATH_UNSAFE", "state binding is malformed");
  }
  return value;
}

// binding照合は外部stateへの一切の書込み（lock-owner含む）より前に行う。
async function verifyExternalBinding(keyDir, identity, create) {
  const bindingPath = join(keyDir, "binding.json");
  const fileId = await commonDirFileId(identity);
  let data = null;
  try { data = await safeBoundedFile(bindingPath, BINDING_LIMIT, "STATE_PATH_UNSAFE", { privateState: true }); }
  catch (error) {
    if (!(error instanceof ControlRecordError) || error.code !== "IO_FAILURE" || error.details?.cause !== "ENOENT") throw error;
  }
  if (data === null) {
    if (!create) fail("STATE_PATH_UNSAFE", "external state exists without a binding", { binding_path: bindingPath });
    const binding = { schema_version: STATE_BINDING_SCHEMA, common_dir_realpath: identity.commonDir, common_dir_file_id: fileId, created_at: new Date().toISOString() };
    try { await writeSynced(bindingPath, Buffer.from(`${JSON.stringify(binding)}\n`)); await syncDirectory(keyDir); }
    catch (error) {
      if (error instanceof ControlRecordError && error.details?.cause === "EEXIST") return verifyExternalBinding(keyDir, identity, false);
      throw error;
    }
    return;
  }
  let parsed;
  try { parsed = JSON.parse(decodeUtf8(data.buffer, "STATE_PATH_UNSAFE", "state binding is not valid UTF-8")); }
  catch (error) { if (error instanceof ControlRecordError) throw error; fail("STATE_PATH_UNSAFE", "state binding is not valid JSON"); }
  const binding = validateBinding(parsed);
  if (binding.common_dir_realpath !== identity.commonDir || binding.common_dir_file_id !== fileId) {
    fail("STATE_PATH_UNSAFE", "external state binding does not match this repository", { binding_path: bindingPath });
  }
}

// `<XDG>/dotagents`はfactory-reporter等の他コンポーネントと同居する共有namespace。
// mode 0700は要求できない（既存慣行は0775 namespace＋各コンポーネント0700）が、
// dir実体・symlink拒否・owner一致は要求する。新規作成時は0700で作る。
async function ensureNamespaceDir(path, create) {
  try {
    if (create) await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("STATE_PATH_UNSAFE", "state namespace is not a safe directory");
    if (!isWin32() && info.uid !== process.getuid()) fail("STATE_PATH_UNSAFE", "state namespace owner is unsafe");
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    if (create && error.code === "EEXIST") return ensureNamespaceDir(path, false);
    fail("IO_FAILURE", "state namespace operation failed", { cause: error.code });
  }
}

async function externalStatePaths(identity, create) {
  const base = externalStateBase();
  const repos = join(base, "dotagents", "orchestrate", "repos");
  const keyDir = join(repos, externalStateKey(identity));
  if (create) {
    // 祖先（~/.local/state等）は所有外の共有ディレクトリなので存在だけ保証する。
    // strict 0700検査は`orchestrate`層＝orchestrate専有subtreeから下にだけ適用する
    // （in-repo配置で`.git`自体に0700を要求しないのと同じ構造）。
    try { await mkdir(base, { recursive: true, mode: 0o700 }); }
    catch (error) { fail("IO_FAILURE", "external state base cannot be created", { cause: error.code }); }
    await ensureNamespaceDir(join(base, "dotagents"), true);
    await ensureDir(join(base, "dotagents", "orchestrate"), { create: true });
    await ensureDir(repos, { create: true });
    await ensureDir(keyDir, { create: true });
    await verifyExternalBinding(keyDir, identity, true);
    await ensureDir(join(keyDir, "controls"), { create: true });
    await ensureDir(join(keyDir, "lock-owners"), { create: true });
  } else {
    await ensureDir(keyDir);
    await verifyExternalBinding(keyDir, identity, false);
    await ensureDir(join(keyDir, "controls")); await ensureDir(join(keyDir, "lock-owners"));
  }
  return { root: keyDir, controls: join(keyDir, "controls"), owners: join(keyDir, "lock-owners") };
}

async function externalKeyDirExists(identity) {
  const keyDir = join(externalStateBase(), "dotagents", "orchestrate", "repos", externalStateKey(identity));
  try { const info = await lstat(keyDir); return info.isDirectory() && !info.isSymbolicLink(); }
  catch (error) { if (error.code === "ENOENT") return false; fail("IO_FAILURE", "external state cannot be inspected", { cause: error.code }); }
}

async function inRepoStateUsable(root) {
  // 現行と同一の検査（ensureDir）が通るかだけを判定し、判定自体は挙動を変えない。
  try { await ensureDir(root); return true; }
  catch (error) {
    if (error instanceof ControlRecordError && ["STATE_PATH_UNSAFE"].includes(error.code)) return false;
    if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") return null;
    throw error;
  }
}

async function statePaths(identity, create = false) {
  const inRepoRoot = join(identity.commonDir, "dotagents", "orchestrate");
  const controls = join(inRepoRoot, "controls"); const owners = join(inRepoRoot, "lock-owners");
  const usable = await inRepoStateUsable(inRepoRoot);
  if (usable === true) {
    // 既存のin-repo store（ext4等）。従来と同一経路・同一検査。外部stateが同居していたら曖昧なので明示エラー。
    if (await externalKeyDirExists(identity)) {
      fail("STATE_PATH_UNSAFE", "both in-repo and external Control state exist for this repository; remove one manually", { in_repo: inRepoRoot, external: join(externalStateBase(), "dotagents", "orchestrate", "repos", externalStateKey(identity)) });
    }
    if (create) { await ensureDir(controls, { create: true }); await ensureDir(owners, { create: true }); }
    else { await ensureDir(controls); await ensureDir(owners); }
    return { root: inRepoRoot, controls, owners };
  }
  if (usable === false) {
    // in-repo stateは存在するが0700/owner検査に落ちた。capable FSなら改ざん＝従来どおり失敗させる。
    // mode非忠実FS（DrvFS等）でだけ外部stateへ進む。非空の残骸は黙って無視せず명示エラー。
    const capable = await probeStateModeFidelity(identity.commonDir);
    if (capable) { await ensureDir(inRepoRoot); }
    let rootInfo;
    try { rootInfo = await lstat(inRepoRoot); } catch (error) { fail("IO_FAILURE", "in-repo state cannot be inspected", { cause: error.code }); }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      fail("STATE_PATH_UNSAFE", "in-repo Control state residue exists on a mode-infidelity filesystem; review and remove it manually", { residue_path: inRepoRoot });
    }
    let entries = [];
    try { entries = await readdir(inRepoRoot); } catch (error) { fail("IO_FAILURE", "in-repo state cannot be listed", { cause: error.code }); }
    const nonEmpty = [];
    for (const entry of entries) {
      const children = await readdir(join(inRepoRoot, entry)).catch(() => null);
      if (children === null || children.length > 0) nonEmpty.push(entry);
    }
    if (nonEmpty.length > 0) {
      fail("STATE_PATH_UNSAFE", "in-repo Control state residue exists on a mode-infidelity filesystem; review and remove it manually", { residue_path: inRepoRoot, entries: nonEmpty });
    }
    return externalStatePaths(identity, create);
  }
  // in-repo stateが存在しない（ENOENT）。
  if (!create) {
    if (await externalKeyDirExists(identity)) return externalStatePaths(identity, false);
    await ensureDir(inRepoRoot); // 従来と同一のIO_FAILURE(ENOENT)を出す
  }
  if (isWin32()) {
    await ensureDir(join(identity.commonDir, "dotagents"), { create: true });
    await ensureDir(inRepoRoot, { create: true }); await ensureDir(controls, { create: true }); await ensureDir(owners, { create: true });
    return { root: inRepoRoot, controls, owners };
  }
  const capable = await probeStateModeFidelity(identity.commonDir);
  if (capable) {
    if (await externalKeyDirExists(identity)) {
      fail("STATE_PATH_UNSAFE", "external Control state already exists for this repository on a mode-capable filesystem; migrate or remove it manually", { external: join(externalStateBase(), "dotagents", "orchestrate", "repos", externalStateKey(identity)) });
    }
    await ensureDir(join(identity.commonDir, "dotagents"), { create: true });
    await ensureDir(inRepoRoot, { create: true }); await ensureDir(controls, { create: true }); await ensureDir(owners, { create: true });
    return { root: inRepoRoot, controls, owners };
  }
  return externalStatePaths(identity, create);
}

async function safeBoundedFile(path, limit, unsafeCode = "STATE_PATH_UNSAFE", { privateState = false } = {}) {
  let handle;
  try {
    handle = await open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail(unsafeCode, "path is not a safe regular file");
    if (privateState && !isWin32() && (before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600)) fail(unsafeCode, "state file owner or mode is unsafe");
    if (before.size > limit) fail("LIMIT_EXCEEDED", "file exceeds limit");
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > limit) fail("LIMIT_EXCEEDED", "file exceeds limit");
    const after = await handle.stat(); const pathInfo = await lstat(path);
    if (!after.isFile() || after.nlink !== 1 || pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || after.dev !== pathInfo.dev || after.ino !== pathInfo.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail(unsafeCode, "file changed while reading");
    return { buffer: buffer.subarray(0, offset), stat: after };
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    if (error.code === "ELOOP") fail(unsafeCode, "symlink is forbidden");
    fail("IO_FAILURE", "file read failed", { cause: error.code });
  } finally { await handle?.close().catch(() => {}); }
}

async function readManifest(path) {
  const { buffer } = await safeBoundedFile(path, MANIFEST_LIMIT, "STATE_PATH_UNSAFE", { privateState: true });
  let parsed; try { parsed = JSON.parse(decodeUtf8(buffer, "INVALID_SCHEMA", "manifest is not valid UTF-8")); } catch (error) { if (error instanceof ControlRecordError) throw error; fail("INVALID_SCHEMA", "manifest is not valid JSON"); }
  return validateManifest(parsed);
}

async function scanManifests(paths) {
  let entries;
  try { entries = await readdir(paths.controls); } catch (error) { fail("IO_FAILURE", "controls cannot be listed", { cause: error.code }); }
  if (entries.length > ARRAY_LIMIT) fail("LIMIT_EXCEEDED", "too many controls");
  const manifests = [];
  for (const entry of entries.sort()) {
    if (!ID_RE.test(entry) || entry === "." || entry === "..") fail("STATE_PATH_UNSAFE", "unknown controls entry");
    const dir = join(paths.controls, entry); await ensureDir(dir);
    const children = await readdir(dir);
    if (children.length !== 1 || children[0] !== "manifest.json") fail("STATE_PATH_UNSAFE", "control directory has unknown entries");
    const manifest = await readManifest(join(dir, "manifest.json"));
    if (manifest.control_id !== entry) fail("INVALID_SCHEMA", "control directory and manifest disagree");
    manifests.push(manifest);
  }
  validateGlobalManifests(manifests);
  return manifests;
}

function validateOwner(value) {
  exact(value, ["schema_version", "token", "pid", "acquired_at"], "lock owner", "LOCK_MALFORMED");
  if (value.schema_version !== OWNER_SCHEMA || typeof value.token !== "string" || !UUID_RE.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.acquired_at !== "string" || new Date(value.acquired_at).toISOString() !== value.acquired_at) fail("LOCK_MALFORMED", "lock owner is malformed");
  return value;
}

async function readOwner(path) {
  let data;
  try { data = await safeBoundedFile(path, OWNER_LIMIT, "STATE_PATH_UNSAFE", { privateState: true }); } catch (error) {
    if (error instanceof ControlRecordError && ["STATE_PATH_UNSAFE", "LIMIT_EXCEEDED"].includes(error.code)) throw error;
    throw error;
  }
  let parsed; try { parsed = JSON.parse(decodeUtf8(data.buffer, "LOCK_MALFORMED", "lock owner is not valid UTF-8")); } catch (error) { if (error instanceof ControlRecordError) throw error; fail("LOCK_MALFORMED", "lock owner is malformed"); }
  return { owner: validateOwner(parsed), stat: data.stat };
}

async function writeSynced(path, buffer, mode = 0o600) {
  let handle;
  try { handle = await open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, mode); await handle.writeFile(buffer); await handle.sync(); }
  catch (error) { if (error instanceof ControlRecordError) throw error; fail("IO_FAILURE", "synced write failed", { cause: error.code }); }
  finally { await handle?.close().catch(() => {}); }
}

async function syncDirectory(path) {
  if (isWin32()) return "unsupported";
  let handle;
  try { handle = await open(path, FS.O_RDONLY); await handle.sync(); return "supported"; }
  finally { await handle?.close().catch(() => {}); }
}

async function safeUnlinkOwner(path, expectedOwner, expectedStat) {
  const current = await readOwner(path);
  if (current.stat.dev !== expectedStat.dev || current.stat.ino !== expectedStat.ino || current.stat.nlink !== 1 || JSON.stringify(current.owner) !== JSON.stringify(expectedOwner)) fail("LOCK_TOKEN_MISMATCH", "lock owner changed");
  try { await unlink(path); injectTestFault("owner-release-after-unlink"); await syncDirectory(dirname(path)); }
  catch (error) { if (error instanceof ControlRecordError) throw error; fail("LOCK_OUTCOME_UNKNOWN", "lock owner release outcome is unknown", { cause: error.code }); }
}

async function acquireLock(ownersDir) {
  const token = randomUUID(); const owner = { schema_version: OWNER_SCHEMA, token, pid: process.pid, acquired_at: new Date().toISOString() };
  const pending = join(ownersDir, `.${token}.pending`); const published = join(ownersDir, `${token}.owner`);
  await writeSynced(pending, Buffer.from(`${JSON.stringify(owner)}\n`));
  let publishedRenamed = false;
  try { await rename(pending, published); publishedRenamed = true; injectTestFault("owner-publish-after-rename"); await syncDirectory(ownersDir); }
  catch (error) {
    await rm(pending, { force: true }).catch(() => {});
    if (publishedRenamed) {
      try { const observed = await readOwner(published); await safeUnlinkOwner(published, owner, observed.stat); } catch {}
    }
    if (error instanceof ControlRecordError) throw error;
    fail("IO_FAILURE", "lock publication failed", { cause: error.code });
  }
  const self = await readOwner(published);
  try {
    const entries = (await readdir(ownersDir)).filter((entry) => entry.endsWith(".owner"));
    const others = [];
    for (const entry of entries) {
      if (entry === `${token}.owner`) continue;
      let found;
      try { found = await readOwner(join(ownersDir, entry)); }
      catch (error) {
        // 競合したownerは自身のLOCK_CONTENDED処理で、readdir後かつread前に
        // 正規削除されうる。消滅済みownerは保持者ではないため再走査対象から外す。
        if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") continue;
        throw error;
      }
      others.push(found.owner);
    }
    if (others.length) fail("LOCK_CONTENDED", "mutation lock is contended", { owners: others.map(({ token: t, pid, acquired_at }) => ({ token: t, pid, acquired_at })) });
    return { token, owner, path: published, stat: self.stat };
  } catch (error) {
    await safeUnlinkOwner(published, owner, self.stat).catch(() => {});
    throw error;
  }
}

async function releaseLock(lock) { await safeUnlinkOwner(lock.path, lock.owner, lock.stat); }

// Quota pool locks (ADR 0054 Wave A): per-pool lease directories reusing the owner-file
// protocol. Scope is a single host and a single Control store; the lease spans CLI
// invocations, so the recorded pid is expected to be dead while the lease is logically
// held — recovery is therefore explicit-token release only, never pid-based.
async function quotaPoolLockDir(identity, poolId, { create = false } = {}) {
  const paths = await statePaths(identity, create);
  const root = join(paths.root, "quota-pool-locks"); const dir = join(root, poolId);
  if (create) { await ensureDir(root, { create: true }); await ensureDir(dir, { create: true }); }
  else { await ensureDir(root); await ensureDir(dir); }
  return dir;
}

async function readQuotaPoolLockOwner(identity, poolId, token, missingCode = "QUOTA_POOL_LOCK_REQUIRED") {
  let dir;
  try { dir = await quotaPoolLockDir(identity, poolId); }
  catch (error) {
    if (error instanceof ControlRecordError && error.code === "IO_FAILURE") fail(missingCode, "quota pool lock is not held; acquire quota-pool-lock first");
    throw error;
  }
  const path = join(dir, `${token}.owner`);
  let observed;
  try { observed = await readOwner(path); }
  catch (error) {
    if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") fail(missingCode, "quota pool lock is not held; acquire quota-pool-lock first");
    throw error;
  }
  if (observed.owner.token !== token) fail("LOCK_TOKEN_MISMATCH", "quota pool lock token differs from owner body");
  return { path, ...observed };
}

async function withLock(identity, operation) {
  const paths = await statePaths(identity, true); const lock = await acquireLock(paths.owners);
  let primary;
  try { return await operation(paths); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await releaseLock(lock); }
    catch (error) { if (!primary) throw error; }
  }
}

async function atomicManifest(paths, manifest, { newControl = false } = {}) {
  validateManifest(manifest);
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (encoded.length > MANIFEST_LIMIT) fail("LIMIT_EXCEEDED", "manifest exceeds limit");
  const dir = join(paths.controls, manifest.control_id); const target = join(dir, "manifest.json");
  if (newControl) {
    await ensureDir(dir, { create: true });
    try { injectTestFault("new-control-before-parent-sync"); await syncDirectory(paths.controls); }
    catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); fail("IO_FAILURE", "new control directory commit failed", { cause: error.code }); }
  } else await ensureDir(dir);
  const temp = join(dir, `.manifest.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeSynced(temp, encoded); await rename(temp, target); renamed = true; injectTestFault("manifest-after-rename"); await syncDirectory(dir);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (!renamed) {
      if (newControl) await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof ControlRecordError) throw error;
      fail("IO_FAILURE", "manifest commit failed", { cause: error.code });
    }
    let observed_match = false;
    try {
      const observed = await readManifest(target);
      observed_match = observed.record_revision === manifest.record_revision && createHash("sha256").update(JSON.stringify(observed)).digest("hex") === createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    } catch {}
    fail("COMMIT_OUTCOME_UNKNOWN", "manifest commit outcome is unknown", { observed_match });
  }
}

function targetManifest(manifests, controlId) {
  const manifest = manifests.find((entry) => entry.control_id === controlId);
  if (!manifest) fail("CONTROL_NOT_FOUND", "control does not exist");
  return manifest;
}

function transitionReceipt({ revision, actorId, operation, subjectKind, subjectId, subjectDigest = null, previousState, nextState, evidence, recordedAt, previousReceiptDigest }) {
  const receipt = {
    revision, actor_id: actorId, operation, subject: { kind: subjectKind, id: subjectId },
    subject_digest: subjectDigest,
    previous_state: previousState, next_state: nextState, evidence: structuredClone(evidence),
    recorded_at: recordedAt, previous_receipt_digest: previousReceiptDigest, receipt_digest: "",
  };
  receipt.receipt_digest = receiptDigest(receipt);
  return receipt;
}

function closedTaskIds(manifest) {
  return new Set([
    ...manifest.task_finalizations.map((entry) => entry.task_id),
    ...manifest.task_cancellations.map((entry) => entry.task_id),
  ]);
}

// A planned consultation of a cancelled task can never dispatch (requireTaskNotCancelled) and has
// no planned->terminal transition in v25/v26, so it is exempted from closure demands instead of
// being rewritten (ADR 0053). The record keeps state "planned" for audit; dispatched and later
// states must still be collected to terminal. In v27 the explicit escape is consultation-cancel,
// so the exemption does not apply there (ADR 0054 Decision 3).
function orphanedPlannedConsultation(manifest, consultation) {
  if (explicitConsultationCancelSchema(manifest.schema_version)) return false;
  return consultation.state === "planned" && manifest.task_cancellations.some((entry) => entry.task_id === consultation.task_id);
}

function requiredClosingReceipts(manifest) {
  let count = 0;
  for (const run of manifest.worker_runs) {
    if (WORKER_NONTERMINAL.has(run.state)) count += 1;
    else if (run.state === "completed" && run.acceptance === null) count += 1;
    if (WORKER_NONTERMINAL.has(run.state) && run.workspace_binding.mode === "executor-isolated" && run.workspace_binding.execution_workspace === null) count += 1;
  }
  for (const consultation of manifest.consultations) {
    if (orphanedPlannedConsultation(manifest, consultation)) continue;
    if (consultation.state === "planned") count += 2;
    else if (CONSULT_NONTERMINAL.has(consultation.state)) count += 1;
  }
  count += manifest.campaigns.filter((campaign) => campaign.release === null).length;
  count += manifest.phase_gate === null
    ? PHASE_ORDER.length + 1
    : manifest.phase_gate.phases.filter((step) => step.state === "pending").length;
  const closedTasks = closedTaskIds(manifest);
  count += manifest.tasks.filter((task) => !closedTasks.has(task.task_id)).length;
  if (manifest.control_finalization === null) count += 1;
  if (manifest.status !== "archived") count += 1;
  return count;
}

async function mutation(input, transition, mutate) {
  const identity = await gitIdentity(input.cwd);
  return withLock(identity, async (paths) => {
    const manifests = await scanManifests(paths); const manifest = targetManifest(manifests, input.control_id);
    requireOperationalManifest(manifest);
    assertBudgetWithin(manifest);
    if (manifest.status === "archived") fail("RECORD_ARCHIVED", "control is archived");
    if (manifest.record_revision !== input.expected_revision) fail("REVISION_CONFLICT", "record revision does not match");
    const next = structuredClone(manifest); await mutate(next, manifests, identity);
    const receiptInput = typeof transition === "function" ? transition(manifest, next) : transition;
    exactOptional(receiptInput, ["operation", "subjectKind", "subjectId", "previousState", "nextState", "evidence"], ["subjectDigest"], "transition", "INVALID_SCHEMA");
    if (manifest.control_finalization !== null && receiptInput.operation !== "control-archive") fail("CONTROL_FINALIZED", "control is finalized and only archive remains");
    const now = new Date().toISOString();
    next.record_revision += 1;
    next.transition_receipts.push(transitionReceipt({
      revision: next.record_revision, actorId: input.actor_id, recordedAt: now,
      previousReceiptDigest: manifest.transition_receipts.at(-1).receipt_digest, ...receiptInput,
    }));
    next.last_update = { actor_id: input.actor_id, updated_at: now };
    validateManifest(next);
    const closingReceipts = requiredClosingReceipts(next);
    if (next.transition_receipts.length + closingReceipts > ARRAY_LIMIT) fail("CONTROL_CAPACITY_RESERVED", "control must close before receipt capacity is exhausted", { closing_receipts: closingReceipts });
    validateGlobalManifests(manifests.map((entry) => entry.control_id === next.control_id ? next : entry));
    await atomicManifest(paths, next);
    return { manifest: next, revision: next.record_revision };
  });
}

function validateMutationBase(input, extraRequired, extraOptional = []) {
  apiInput(input, ["cwd", "control_id", "actor_id", "expected_revision", ...extraRequired], extraOptional);
  identifier(input.control_id, "input.control_id"); string(input.actor_id, "input.actor_id"); integer(input.expected_revision, "input.expected_revision");
}

async function ensureDocumentAvailable(identity, docRef) {
  repoPath(docRef, "doc_ref");
  if (identity.kind === "bare") {
    const result = await runGit(identity.cwd, ["rev-parse", `HEAD:${docRef}`], { allowFailure: true });
    const oid = result.stdout.toString().trim(); if (result.code !== 0 || !SHA1_RE.test(oid)) fail("IO_FAILURE", "task document is unavailable"); return;
  }
  await inspectScopePath(identity.worktreeRoot, { kind: "file", path: docRef });
  const result = await runGit(identity.worktreeRoot, ["hash-object", "--no-filters", "--", join(identity.worktreeRoot, ...docRef.split("/"))], { allowFailure: true });
  const oid = result.stdout.toString().trim();
  if (result.code !== 0) fail("IO_FAILURE", "task document is unavailable");
  if (!SHA1_RE.test(oid)) fail("GIT_FAILURE", "git returned invalid document oid");
}

async function inspectScopePath(root, entry) {
  if (root === null) return;
  const normalized = normalizeScope(entry); let current = root;
  for (const component of normalized.path.split("/")) {
    current = join(current, component);
    let info; try { info = await lstat(current); } catch (error) { if (error.code === "ENOENT") return; fail("IO_FAILURE", "scope path inspection failed", { cause: error.code }); }
    if (info.isSymbolicLink()) fail("STATE_PATH_UNSAFE", "scope contains a symlink");
  }
}

async function inspectTaskScopes(workspace, task) {
  if (workspace.kind === "bare") return;
  for (const entry of [...task.read_scope, ...task.write_scope]) await inspectScopePath(workspace.worktreeRoot, entry);
}

export async function init(input) {
  // control-record v2 (ADR 0114 Decision 7): v1 init input is rejected with a versioned error,
  // never backfilled with a fabricated admission.
  if (isObject(input) && !own(input, "lane_admission")) fail("CONTRACT_VERSION_MISMATCH", "control-record v2 init requires input.lane_admission; v1 init input is no longer accepted");
  apiInput(input, ["cwd", "control_id", "objective_ref", "actor_id", "document_refs", "budget", "lane_admission"], ["predecessor_control_id"]);
  identifier(input.control_id, "input.control_id"); repoPath(input.objective_ref, "input.objective_ref"); string(input.actor_id, "input.actor_id"); refs(input.document_refs, "input.document_refs");
  validateBudget(input.budget);
  validateLaneAdmissionDeclaration(input.lane_admission);
  // Pure decision over the four booleans only (ADR 0114 Decision 2); all-false cannot open a Control.
  if (decideLane(input.lane_admission.conditions) !== "orchestrated") fail("LANE_ADMISSION_NOT_ORCHESTRATED", "control init requires at least one ADR 0061 condition to be declared true");
  const identity = await gitIdentity(input.cwd);
  return withLock(identity, async (paths) => {
    const manifests = await scanManifests(paths);
    if (manifests.some((entry) => entry.control_id === input.control_id)) fail("CONTROL_EXISTS", "control already exists");
    if (manifests.length >= ARRAY_LIMIT) fail("CONTROL_CAPACITY_REACHED", "control capacity is reached");
    let continuation = { predecessor_control_id: null, root_control_id: input.control_id, sequence: 0 };
    if (input.predecessor_control_id !== undefined) {
      identifier(input.predecessor_control_id, "input.predecessor_control_id");
      const predecessor = manifests.find((entry) => entry.control_id === input.predecessor_control_id);
      if (!predecessor || predecessor.status !== "archived") fail("CONTINUATION_NOT_READY", "predecessor control must exist and be archived");
      if (predecessor.declaration.objective_ref !== input.objective_ref) fail("CONTINUATION_NOT_READY", "successor objective must match predecessor");
      continuation = { predecessor_control_id: predecessor.control_id, root_control_id: predecessor.continuation.root_control_id, sequence: predecessor.continuation.sequence + 1 };
    }
    const initialFingerprint = identity.kind === "bare" ? null : await fingerprintWorkspace({ cwd: identity.worktreeRoot });
    if (initialFingerprint !== null && initialFingerprint.head !== identity.head) fail("WORKSPACE_DRIFT", "control workspace HEAD changed during initialization");
    const initialStatus = initialFingerprint === null
      ? { dirty: false, status_digest: null }
      : { dirty: initialFingerprint.files.length > 0, status_digest: initialFingerprint.status_digest };
    const now = new Date().toISOString();
    const initialReceipt = transitionReceipt({
      revision: 0, actorId: input.actor_id, operation: "control-init", subjectKind: "control", subjectId: input.control_id,
      previousState: null, nextState: "active", evidence: [], recordedAt: now, previousReceiptDigest: null,
    });
    const manifest = {
      schema_version: MANIFEST_SCHEMA_V29, record_revision: 0, control_id: input.control_id, status: "active",
      declaration: {
        objective_ref: input.objective_ref, project_root_realpath: identity.projectRoot,
        common_dir_realpath: identity.commonDir, git_dir_realpath: identity.gitDir,
        git_dir_file_id: identity.gitDirFileId, base_sha: identity.kind === "bare" ? null : identity.head,
        initial_dirty: initialStatus.dirty, initial_status_digest: initialStatus.status_digest,
        initial_workspace_digest: initialFingerprint?.digest ?? null,
        created_at: now, created_by: input.actor_id,
      }, continuation, durability: structuredClone(DURABILITY_PROTOCOL),
      budget: structuredClone(input.budget), role_effect_policy: structuredClone(ROLE_EFFECT_POLICY), document_refs: [...input.document_refs],
      // Stored projection only (ADR 0114 Decision 1/3): closed conditions + docs decision ref,
      // declarer bound to the init actor and time. No lane field, no free-form rationale.
      lane_admission: {
        contract_version: LANE_ADMISSION_CONTRACT_VERSION,
        conditions: normalizedLaneConditions(input.lane_admission.conditions),
        decision: structuredClone(input.lane_admission.decision),
        declared_by: input.actor_id, declared_at: now,
      },
      registry_observations: [], tasks: [], task_cancellations: [], worker_runs: [], consultations: [], campaigns: [], phase_gate: null, artifacts: [], family_governance: [], task_finalizations: [], control_finalization: null,
      transition_receipts: [initialReceipt], last_update: { actor_id: input.actor_id, updated_at: now },
    };
    await atomicManifest(paths, manifest, { newControl: true }); return { manifest, revision: 0 };
  });
}

export async function status(input) {
  apiInput(input, ["cwd", "control_id"]); identifier(input.control_id, "input.control_id");
  const identity = await gitIdentity(input.cwd); const paths = await statePaths(identity); const controlDir = join(paths.controls, input.control_id);
  await ensureDir(controlDir).catch((error) => { if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") fail("CONTROL_NOT_FOUND", "control does not exist"); throw error; });
  const manifest = await readManifest(join(controlDir, "manifest.json")).catch((error) => { if (error instanceof ControlRecordError && error.code === "IO_FAILURE") fail("CONTROL_NOT_FOUND", "control does not exist"); throw error; });
  if (manifest.control_id !== input.control_id) fail("INVALID_SCHEMA", "control id mismatch"); return manifest;
}

function registryUnknownFields(observation) {
  const fields = [];
  if (observation.enabled.value === "unknown") fields.push("enabled");
  for (const capability of observation.workflow_capabilities) if (capability.value === "unknown") fields.push(`capability:${capability.capability_id}`);
  if (observation.capacity.admission.value === "unknown") fields.push("capacity:admission");
  for (const field of ["hard_inflight_limit", "soft_inflight_limit", "observed_inflight"]) {
    if (observation.capacity[field].knowledge === "unknown") fields.push(`capacity:${field}`);
  }
  return fields.sort();
}

function briefManifest(manifest) {
  const closedTasks = closedTaskIds(manifest);
  const activeWorkers = manifest.worker_runs.filter((run) => WORKER_NONTERMINAL.has(run.state)).map((run) => ({
    worker_run_id: run.worker_run_id, task_id: run.task_id, state: run.state,
    executor: structuredClone(run.executor), workflow_id: run.workflow_id,
    executor_handle: structuredClone(run.executor_handle), executor_observation: structuredClone(run.executor_observation),
    cancel_request: structuredClone(run.cancel_request),
  }));
  const activeConsultations = manifest.consultations.filter((entry) => CONSULT_NONTERMINAL.has(entry.state)).map((entry) => ({
    consultation_id: entry.consultation_id, task_id: entry.task_id, state: entry.state,
    connector: entry.connector,
    consultation_handle: typedConsultationSchema(manifest.schema_version) ? structuredClone(entry.consultation_handle) : { slug: entry.slug },
    model: entry.model, effort: entry.effort,
    executor_observation: structuredClone(entry.executor_observation),
  }));
  const unknownRegistry = manifest.registry_observations.map((entry) => ({
    registry_observation_id: entry.registry_observation_id, fields: registryUnknownFields(entry),
  })).filter((entry) => entry.fields.length > 0);
  const workerUncollected = activeWorkers.filter((entry) => ["dispatched", "running", "unknown"].includes(entry.state)).map((entry) => entry.worker_run_id);
  const consultationUncollected = activeConsultations.filter((entry) => ["dispatched", "running", "unknown"].includes(entry.state)).map((entry) => entry.consultation_id);
  const campaigns = manifest.campaigns.map((campaign) => ({
    campaign_id: campaign.campaign_id, campaign_type: campaign.campaign_type,
    all_terminal: campaignAllTerminal(manifest, campaign), audit_required: campaign.audit_required,
    released: campaign.release !== null,
  }));
  const phaseGate = manifest.phase_gate === null ? { configured: false, current_phase: null } : {
    configured: true, risk: manifest.phase_gate.risk, behavior_lane: manifest.phase_gate.behavior_lane,
    current_phase: phaseGateCurrent(manifest), complete: phaseGateComplete(manifest),
  };
  return {
    schema_version: "dotagents.orchestration-status-brief.v7",
    control_id: manifest.control_id, manifest_schema_version: manifest.schema_version,
    record_revision: manifest.record_revision, status: manifest.status,
    objective_ref: manifest.declaration.objective_ref, last_update: structuredClone(manifest.last_update),
    counts: {
      tasks: manifest.tasks.length, registry_observations: manifest.registry_observations.length,
      task_cancellations: manifest.task_cancellations.length,
      worker_runs: manifest.worker_runs.length, consultations: manifest.consultations.length, campaigns: manifest.campaigns.length, artifacts: manifest.artifacts.length, family_governance: manifest.family_governance.length,
    },
    active: { worker_runs: activeWorkers, consultations: activeConsultations }, campaigns, phase_gate: phaseGate,
    artifacts: manifest.artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_kind: artifact.artifact_kind, status: artifact.status })),
    family_governance: manifest.family_governance.map((family) => ({ approach_family_ref: family.approach_family_ref, state: family.state })),
    cancellations: {
      task_ids: manifest.task_cancellations.map((entry) => entry.task_id).sort(),
      worker_run_ids: manifest.worker_runs.filter((run) => run.cancel_request !== null && WORKER_NONTERMINAL.has(run.state)).map((run) => run.worker_run_id).sort(),
    },
    unresolved: {
      task_ids: manifest.tasks.filter((task) => !closedTasks.has(task.task_id)).map((task) => task.task_id).sort(),
      worker_acceptance_ids: manifest.worker_runs.filter((run) => run.state === "completed" && run.acceptance === null).map((run) => run.worker_run_id).sort(),
      campaign_ids: campaigns.filter((campaign) => !campaign.released).map((campaign) => campaign.campaign_id).sort(),
      control_finalization_missing: manifest.control_finalization === null,
      phase_gate_unconfigured: manifest.phase_gate === null,
    },
    unknown: {
      worker_run_ids: manifest.worker_runs.filter((run) => run.state === "unknown").map((run) => run.worker_run_id).sort(),
      consultation_ids: manifest.consultations.filter((entry) => entry.state === "unknown").map((entry) => entry.consultation_id).sort(),
      registry_observations: unknownRegistry,
    },
    uncollected: { worker_run_ids: workerUncollected.sort(), consultation_ids: consultationUncollected.sort() },
  };
}

export async function statusBrief(input) {
  return briefManifest(await status(input));
}

function advisoryBound(items, compare) {
  const sorted = [...items].sort(compare);
  return { items: sorted.slice(0, ARRAY_LIMIT), truncated: sorted.length > ARRAY_LIMIT };
}

function advisoryEmpty(evaluatedAt) {
  return {
    schema_version: "orchestrate.advisory-snapshot.v1", evaluated_at: evaluatedAt,
    active_control_ids: [], unknown: { worker_run_ids: [], consultation_ids: [] },
    uncollected: { worker_run_ids: [], consultation_ids: [] }, write_conflicts: [], h_reference_gaps: [], capacity_warnings: [], truncated: false,
  };
}

function advisoryRegistryKey(registry) { return `${registry.workflow_id}\0${canonicalJson(registry.executor)}`; }

function advisoryUpperBound(values, target) {
  let low = 0; let high = values.length;
  while (low < high) { const middle = low + Math.floor((high - low) / 2); if (values[middle] <= target) low = middle + 1; else high = middle; }
  return low;
}

function advisoryLowerBound(values, target) {
  let low = 0; let high = values.length;
  while (low < high) { const middle = low + Math.floor((high - low) / 2); if (values[middle] < target) low = middle + 1; else high = middle; }
  return low;
}

function advisoryCapacityIndex(manifests) {
  const index = new Map();
  for (const manifest of manifests) for (const run of manifest.worker_runs) {
    const key = advisoryRegistryKey(run); const entry = index.get(key) ?? { plannedOrAdmitted: 0, frontiers: [] };
    if (["planned", "admitted"].includes(run.state)) entry.plannedOrAdmitted += 1;
    else if (["dispatched", "running", "unknown"].includes(run.state)) entry.frontiers.push(dispatchEvidenceFrontier(run));
    index.set(key, entry);
  }
  for (const entry of index.values()) entry.frontiers.sort((left, right) => left - right);
  return index;
}

function advisoryCapacityReservation(index, registry) {
  const entry = index.get(advisoryRegistryKey(registry)); if (entry === undefined) return { reservations: 0, ambiguous: false };
  const observedAt = Date.parse(registry.capacity.observed_inflight.evidence.observed_at);
  const after = entry.frontiers.length - advisoryUpperBound(entry.frontiers, observedAt);
  const ambiguous = advisoryLowerBound(entry.frontiers, observedAt) !== advisoryUpperBound(entry.frontiers, observedAt);
  return { reservations: entry.plannedOrAdmitted + after, ambiguous };
}

function advisoryCapacityWarnings(allManifests, activeManifests, evaluatedAt) {
  const groups = new Map();
  const activeScopes = new Set(activeManifests.flatMap((manifest) => manifest.registry_observations).map(advisoryRegistryKey));
  for (const manifest of allManifests) for (const registry of manifest.registry_observations) {
    if (Date.parse(registry.verification.observed_at) > Date.parse(evaluatedAt)) continue;
    const key = advisoryRegistryKey(registry);
    if (!activeScopes.has(key)) continue;
    const entries = groups.get(key) ?? []; entries.push(registry); groups.set(key, entries);
  }
  const capacityIndex = advisoryCapacityIndex(activeManifests);
  const warnings = [];
  for (const entries of groups.values()) {
    const latestAt = Math.max(...entries.map((entry) => Date.parse(entry.verification.observed_at)));
    const latest = entries.filter((entry) => Date.parse(entry.verification.observed_at) === latestAt);
    const bodies = new Set(latest.map((entry) => { const body = structuredClone(entry); delete body.registry_observation_id; return canonicalJson(body); }));
    for (const registry of latest) {
      const reasons = new Set();
      if (bodies.size > 1) reasons.add("ambiguous");
      if (Date.parse(registry.expires_at) <= Date.parse(evaluatedAt)) reasons.add("expired");
      if (registry.capacity.admission.value === "unknown") reasons.add("admission-unknown");
      const hardLimit = registry.capacity.hard_inflight_limit; const softLimit = registry.capacity.soft_inflight_limit; const inflight = registry.capacity.observed_inflight;
      if (hardLimit.knowledge === "unknown" || softLimit.knowledge === "unknown" || inflight.knowledge === "unknown") reasons.add("limit-unknown");
      else {
        const { reservations, ambiguous } = advisoryCapacityReservation(capacityIndex, registry);
        const effective = Number.isSafeInteger(inflight.value + reservations) ? inflight.value + reservations : Number.POSITIVE_INFINITY;
        if (ambiguous) reasons.add("ambiguous");
        if (effective >= hardLimit.value) reasons.add("hard-reached");
        else if (effective >= softLimit.value) reasons.add("soft-reached");
      }
      for (const reason of reasons) warnings.push({ registry_observation_id: registry.registry_observation_id, reason });
    }
  }
  return warnings;
}

function advisoryWriterIndex(manifests) {
  const emptyNode = () => ({ children: new Map(), exactDirectories: { count: 0, alternativeGroups: new Map() }, exactFiles: { count: 0, alternativeGroups: new Map() }, subtree: null });
  const root = emptyNode();
  const worktrees = new Map();
  const addSummary = (summary, run, task) => {
    summary.count += 1;
    if (run.write_mode === "isolated-alternative" && task.alternative_group !== null) summary.alternativeGroups.set(task.alternative_group, (summary.alternativeGroups.get(task.alternative_group) ?? 0) + 1);
  };
  for (const manifest of manifests) for (const run of manifest.worker_runs) {
    if (!RESERVED_WRITER.has(run.state) || run.write_mode === "none") continue;
    const task = taskForRun(manifest, run); const workspace = effectiveWorkspace(run);
    if (workspace !== null) { const entries = worktrees.get(workspace.worktree_root_realpath) ?? []; entries.push({ run, task }); worktrees.set(workspace.worktree_root_realpath, entries); }
    for (const scope of task.write_scope) {
      let node = root;
      for (const segment of scope.path.split("/")) { const child = node.children.get(segment) ?? emptyNode(); node.children.set(segment, child); node = child; }
      addSummary(scope.kind === "directory" ? node.exactDirectories : node.exactFiles, run, task);
    }
  }
  const summarize = (node) => {
    const summary = { count: node.exactDirectories.count + node.exactFiles.count, alternativeGroups: new Map(node.exactDirectories.alternativeGroups) };
    for (const [group, count] of node.exactFiles.alternativeGroups) summary.alternativeGroups.set(group, (summary.alternativeGroups.get(group) ?? 0) + count);
    for (const child of node.children.values()) {
      const childSummary = summarize(child); summary.count += childSummary.count;
      for (const [group, count] of childSummary.alternativeGroups) summary.alternativeGroups.set(group, (summary.alternativeGroups.get(group) ?? 0) + count);
    }
    node.subtree = summary; return summary;
  };
  summarize(root); return { root, worktrees };
}

function advisorySummaryConflicts(summary, run, task) {
  if (summary.count === 0) return false;
  const allowed = run.write_mode === "isolated-alternative" && task.alternative_group !== null ? (summary.alternativeGroups.get(task.alternative_group) ?? 0) : 0;
  return summary.count > allowed;
}

function advisoryCombinedSummary(left, right) {
  const alternativeGroups = new Map(left.alternativeGroups);
  for (const [group, count] of right.alternativeGroups) alternativeGroups.set(group, (alternativeGroups.get(group) ?? 0) + count);
  return { count: left.count + right.count, alternativeGroups };
}

function advisoryScopeConflict(index, run, task) {
  for (const scope of task.write_scope) {
    let node = index.root; const segments = scope.path.split("/");
    for (let indexAt = 0; indexAt < segments.length; indexAt++) {
      node = node.children.get(segments[indexAt]); if (node === undefined) break;
      const terminal = indexAt === segments.length - 1;
      if (advisorySummaryConflicts(terminal ? advisoryCombinedSummary(node.exactDirectories, node.exactFiles) : node.exactDirectories, run, task)) return true;
      if (terminal && scope.kind === "directory" && advisorySummaryConflicts(node.subtree, run, task)) return true;
    }
  }
  return false;
}

function advisoryWriteConflicts(manifests) {
  const index = advisoryWriterIndex(manifests); const conflicts = [];
  for (const manifest of manifests) for (const run of manifest.worker_runs) {
    if (run.state !== "planned" || run.write_mode === "none") continue;
    const task = taskForRun(manifest, run); if (manifest.task_cancellations.some((entry) => entry.task_id === task.task_id)) continue;
    const workspace = effectiveWorkspace(run);
    if (workspace !== null && (index.worktrees.get(workspace.worktree_root_realpath) ?? []).length) {
      conflicts.push({ control_id: manifest.control_id, worker_run_id: run.worker_run_id, reason: "same-worktree-writer" }); continue;
    }
    if (advisoryScopeConflict(index, run, task)) conflicts.push({ control_id: manifest.control_id, worker_run_id: run.worker_run_id, reason: "overlapping-write-scope" });
  }
  return conflicts;
}

// Read-only lane evaluation (ADR 0114 Decision 8): pure computation over the declared
// conditions. Touches no filesystem, no git, no state root, no cache — and it is an optional
// diagnostic, never a required step of the normal lane.
export async function laneAdmissionEvaluate(input) {
  apiInput(input, ["conditions"]);
  try { return evaluateLaneAdmission(input.conditions); }
  catch (error) {
    if (error instanceof LaneAdmissionError) fail("INVALID_INPUT", error.message);
    throw error;
  }
}

export async function advisorySnapshot(input) {
  apiInput(input, ["cwd", "evaluated_at"]); timestamp(input.evaluated_at, "input.evaluated_at");
  const identity = await gitIdentity(input.cwd);
  let paths;
  try { paths = await statePaths(identity); }
  catch (error) {
    if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") return advisoryEmpty(input.evaluated_at);
    throw error;
  }
  const allManifests = await scanManifests(paths);
  const manifests = allManifests.filter((manifest) => manifest.status === "active");
  const unknownWorkers = []; const unknownConsultations = []; const uncollectedWorkers = []; const uncollectedConsultations = []; const hGaps = [];
  for (const manifest of manifests) {
    const hActiveTaskIds = new Set(manifest.worker_runs.filter((run) => ["planned", "admitted"].includes(run.state)).map((run) => run.task_id));
    for (const run of manifest.worker_runs) {
      if (run.state === "unknown") unknownWorkers.push(run.worker_run_id);
      if (["dispatched", "running", "unknown"].includes(run.state)) uncollectedWorkers.push(run.worker_run_id);
      const task = manifest.tasks.find((entry) => entry.task_id === run.task_id);
      if (task?.classification === "H" && ["planned", "admitted"].includes(run.state)) {
        if (run.operation_digest === null) hGaps.push({ task_id: task.task_id, reason: "operation-digest-missing" });
        else if (run.operation_digest !== task.approval.operation_digest) hGaps.push({ task_id: task.task_id, reason: "operation-digest-mismatch" });
      }
    }
    for (const consultation of manifest.consultations) {
      if (consultation.state === "unknown") unknownConsultations.push(consultation.consultation_id);
      if (["dispatched", "running", "unknown"].includes(consultation.state)) uncollectedConsultations.push(consultation.consultation_id);
      const task = manifest.tasks.find((entry) => entry.task_id === consultation.task_id);
      if (task?.classification === "H" && CONSULT_NONTERMINAL.has(consultation.state)) {
        hActiveTaskIds.add(task.task_id); hGaps.push({ task_id: task.task_id, reason: "consultation-operation-contract-missing" });
      }
    }
    for (const task of manifest.tasks) if (task.classification === "H" && hActiveTaskIds.has(task.task_id) && task.approval.expires_at !== null && Date.parse(task.approval.expires_at) <= Date.parse(input.evaluated_at)) hGaps.push({ task_id: task.task_id, reason: "approval-expired" });
  }
  const conflicts = advisoryWriteConflicts(manifests);
  const active = advisoryBound(manifests.map((manifest) => manifest.control_id), (left, right) => left.localeCompare(right));
  const unknownWorker = advisoryBound(unknownWorkers, (left, right) => left.localeCompare(right));
  const unknownConsultation = advisoryBound(unknownConsultations, (left, right) => left.localeCompare(right));
  const uncollectedWorker = advisoryBound(uncollectedWorkers, (left, right) => left.localeCompare(right));
  const uncollectedConsultation = advisoryBound(uncollectedConsultations, (left, right) => left.localeCompare(right));
  const writeConflicts = advisoryBound([...new Map(conflicts.map((entry) => [`${entry.control_id}\0${entry.worker_run_id}\0${entry.reason}`, entry])).values()], (left, right) => left.control_id.localeCompare(right.control_id) || left.worker_run_id.localeCompare(right.worker_run_id) || left.reason.localeCompare(right.reason));
  const hReferenceGaps = advisoryBound([...new Map(hGaps.map((entry) => [`${entry.task_id}\0${entry.reason}`, entry])).values()], (left, right) => left.task_id.localeCompare(right.task_id) || left.reason.localeCompare(right.reason));
  const capacityWarnings = advisoryBound(advisoryCapacityWarnings(allManifests, manifests, input.evaluated_at), (left, right) => left.registry_observation_id.localeCompare(right.registry_observation_id) || left.reason.localeCompare(right.reason));
  return {
    schema_version: "orchestrate.advisory-snapshot.v1", evaluated_at: input.evaluated_at, active_control_ids: active.items,
    unknown: { worker_run_ids: unknownWorker.items, consultation_ids: unknownConsultation.items },
    uncollected: { worker_run_ids: uncollectedWorker.items, consultation_ids: uncollectedConsultation.items },
    write_conflicts: writeConflicts.items, h_reference_gaps: hReferenceGaps.items, capacity_warnings: capacityWarnings.items,
    truncated: active.truncated || unknownWorker.truncated || unknownConsultation.truncated || uncollectedWorker.truncated || uncollectedConsultation.truncated || writeConflicts.truncated || hReferenceGaps.truncated || capacityWarnings.truncated,
  };
}

function manifestEvidence(manifest) {
  const found = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (!isObject(value)) return;
    const keys = Object.keys(value).sort();
    if (keys.length === 4 && keys.join("\0") === "digest\0observed_at\0ref\0type" && ["file", "command", "url", "executor-receipt", "decision"].includes(value.type)) {
      found.set(canonicalJson(value), structuredClone(value)); return;
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(manifest);
  return [...found.values()].sort((left, right) => left.type.localeCompare(right.type) || left.ref.localeCompare(right.ref) || left.digest.localeCompare(right.digest));
}

function resumeIssue(code, subjectKind, subjectId) {
  return { code, subject_kind: subjectKind, subject_id: subjectId };
}

function uniqueIssues(issues) {
  const unique = new Map(issues.map((entry) => [canonicalJson(entry), entry]));
  return [...unique.values()].sort((left, right) => left.code.localeCompare(right.code) || left.subject_kind.localeCompare(right.subject_kind) || left.subject_id.localeCompare(right.subject_id));
}

async function gitHistoryContainsEvidence(identity, ref, expectedDigest, budget) {
  const history = await runGit(identity.cwd, ["log", "--format=%H", "--max-count=256", "--all", "--", ref], { allowFailure: true, limit: 256 * 65 });
  if (history.code !== 0) return false;
  const commits = decodeUtf8(history.stdout, "STATE_PATH_UNSAFE", "evidence history contains invalid UTF-8").split("\n").filter(Boolean);
  if (commits.some((commit) => !/^[0-9a-f]{40,64}$/.test(commit))) fail("GIT_FAILURE", "evidence history contains an invalid commit id");
  const seenBlobs = new Set();
  for (const commit of commits) {
    const tree = await runGit(identity.cwd, ["ls-tree", "-z", commit, "--", ref], { allowFailure: true, limit: 4096 });
    if (tree.code !== 0) continue;
    const entries = decodeUtf8(tree.stdout, "STATE_PATH_UNSAFE", "evidence tree entry contains invalid UTF-8").split("\0").filter(Boolean);
    if (entries.length !== 1) continue;
    const separator = entries[0].indexOf("\t");
    const metadata = separator < 0 ? [] : entries[0].slice(0, separator).split(" ");
    const path = separator < 0 ? "" : entries[0].slice(separator + 1);
    if (path !== ref || metadata.length !== 3 || !["100644", "100755"].includes(metadata[0]) || metadata[1] !== "blob" || !/^[0-9a-f]+$/.test(metadata[2])) continue;
    const blob = metadata[2]; if (seenBlobs.has(blob)) continue; seenBlobs.add(blob);
    const sizeResult = await runGit(identity.cwd, ["cat-file", "-s", blob], { allowFailure: true, limit: 128 });
    if (sizeResult.code !== 0) continue;
    const sizeText = decodeUtf8(sizeResult.stdout, "STATE_PATH_UNSAFE", "evidence blob size contains invalid UTF-8").trim();
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) fail("GIT_FAILURE", "evidence blob size is invalid");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > budget.remaining) fail("LIMIT_EXCEEDED", "evidence history exceeds 64 MiB");
    const shown = await runGit(identity.cwd, ["cat-file", "blob", blob], { limit: size + 1 });
    if (shown.stdout.length !== size) fail("GIT_FAILURE", "evidence blob size changed while reading");
    budget.remaining -= size;
    if (createHash("sha256").update(shown.stdout).digest("hex") === expectedDigest) return true;
  }
  return false;
}

async function evidenceRetention(manifest, identity) {
  const descriptors = manifestEvidence(manifest); const local = []; const opaque = [];
  const budget = { remaining: FILES_LIMIT };
  for (const descriptor of descriptors) {
    if (descriptor.type === "decision" && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(descriptor.ref)) {
      opaque.push({ type: descriptor.type, ref: descriptor.ref, digest: descriptor.digest }); continue;
    }
    if (!["file", "decision"].includes(descriptor.type)) {
      opaque.push({ type: descriptor.type, ref: descriptor.ref, digest: descriptor.digest }); continue;
    }
    if (identity.kind === "bare") {
      local.push({ type: descriptor.type, ref: descriptor.ref, digest: descriptor.digest, status: "unverifiable", observed_digest: null, error_code: "BARE_EVIDENCE_UNVERIFIED" });
      continue;
    }
    try {
      const observed = await hashRegularFile(identity.projectRoot, descriptor.ref, budget);
      // file型もdecision型と同じ同一path・exact-digestのbounded履歴照合で救済する（resume専用の緩和。
      // finalization/archive側のfile型厳格判定は不変Decision 2026-07-15どおり変更しない＝非対称は意図）。
      // 履歴に無いdigest（未commitのdirty状態で観測した証拠等）は従来どおりfail closedになる。
      const retainedInHistory = observed !== descriptor.digest
        ? await gitHistoryContainsEvidence(identity, descriptor.ref, descriptor.digest, budget)
        : false;
      local.push({
        type: descriptor.type, ref: descriptor.ref, digest: descriptor.digest,
        status: observed === descriptor.digest ? "retained" : retainedInHistory ? "retained-history" : observed === null ? "missing" : "digest-mismatch",
        observed_digest: observed, error_code: retainedInHistory ? "RETAINED_IN_GIT_HISTORY" : null,
      });
    } catch (error) {
      if (!(error instanceof ControlRecordError)) throw error;
      local.push({ type: descriptor.type, ref: descriptor.ref, digest: descriptor.digest, status: "unsafe", observed_digest: null, error_code: error.code });
    }
  }
  return { local, opaque };
}

async function artifactRetention(manifest, identity) {
  const entries = [];
  for (const artifact of manifest.artifacts) {
    try {
      const observed = await artifactDocumentDigest(identity, artifact.artifact_ref);
      entries.push({ artifact_id: artifact.artifact_id, artifact_ref: artifact.artifact_ref, digest: artifact.artifact_digest, status: observed === artifact.artifact_digest ? "retained" : "digest-mismatch", observed_digest: observed, error_code: null });
    } catch (error) {
      if (!(error instanceof ControlRecordError)) throw error;
      entries.push({ artifact_id: artifact.artifact_id, artifact_ref: artifact.artifact_ref, digest: artifact.artifact_digest, status: error.code === "ARTIFACT_UNAVAILABLE" ? "missing" : "unsafe", observed_digest: null, error_code: error.code });
    }
  }
  return entries;
}

export async function resumeCheck(input) {
  apiInput(input, ["cwd", "control_id"]); identifier(input.control_id, "input.control_id");
  const identity = await gitIdentity(input.cwd);
  return withLock(identity, async (paths) => {
    const manifests = await scanManifests(paths); const manifest = targetManifest(manifests, input.control_id);
    const brief = briefManifest(manifest); const blocking = []; const review = [];
    const fingerprintCache = new Map();
    const readResumeFingerprint = async (workspace, scopeGuard = []) => {
      if (workspace.kind === "bare") return null;
      const key = `${workspace.gitDirFileId}\0${workspace.worktreeRoot}\0${canonicalJson(scopeGuard)}`;
      if (!fingerprintCache.has(key)) fingerprintCache.set(key, fingerprintWorkspace({ cwd: workspace.worktreeRoot, scope_guard: scopeGuard }));
      return fingerprintCache.get(key);
    };
    let currentFingerprint = null; let controlFingerprintAvailable = true;
    if (identity.kind !== "bare") {
      try { currentFingerprint = await readResumeFingerprint(identity); }
      catch (error) {
        if (!(error instanceof ControlRecordError)) throw error;
        controlFingerprintAvailable = false;
        blocking.push(resumeIssue("control-workspace-unverifiable", "control", manifest.control_id));
      }
    }
    const currentStatus = identity.kind === "bare"
      ? { dirty: false, status_digest: null }
      : controlFingerprintAvailable
        ? { dirty: currentFingerprint.files.length > 0, status_digest: currentFingerprint.status_digest }
        : { dirty: null, status_digest: null };
    const pathsMatch = manifest.declaration.project_root_realpath === identity.projectRoot
      && manifest.declaration.common_dir_realpath === identity.commonDir
      && manifest.declaration.git_dir_realpath === identity.gitDir;
    const identityMatches = pathsMatch
      && sameGitDirGeneration(manifest.declaration.git_dir_file_id, identity.gitDirFileId);
    if (!identityMatches) blocking.push(resumeIssue("control-worktree-generation-changed", "control", manifest.control_id));
    else if (gitDirDeviceChanged(manifest.declaration.git_dir_file_id, identity.gitDirFileId)) {
      review.push(resumeIssue("control-worktree-device-changed", "control", manifest.control_id));
    }
    if (currentFingerprint !== null && currentFingerprint.head !== identity.head) blocking.push(resumeIssue("control-workspace-changed-during-check", "control", manifest.control_id));
    if (manifest.declaration.base_sha !== identity.head) review.push(resumeIssue("control-head-changed", "control", manifest.control_id));
    if (controlFingerprintAvailable && (manifest.declaration.initial_dirty !== currentStatus.dirty || manifest.declaration.initial_status_digest !== currentStatus.status_digest)) review.push(resumeIssue("control-dirty-state-changed", "control", manifest.control_id));
    if (controlFingerprintAvailable && manifest.declaration.initial_workspace_digest !== currentFingerprint?.digest && !(manifest.declaration.initial_workspace_digest === null && currentFingerprint === null)) review.push(resumeIssue("control-workspace-content-changed", "control", manifest.control_id));
    for (const run of manifest.worker_runs.filter((entry) => WORKER_NONTERMINAL.has(entry.state))) {
      const active = ["dispatched", "running", "unknown"].includes(run.state);
      if (active && run.workspace_binding.mode === "executor-isolated" && run.workspace_binding.execution_workspace === null) {
        review.push(resumeIssue("worker-execution-workspace-unbound", "worker-run", run.worker_run_id));
        review.push(resumeIssue("worker-requery-required", "worker-run", run.worker_run_id));
        continue;
      }
      const storedWorkspace = active && run.workspace_binding.mode === "executor-isolated" ? run.workspace_binding.execution_workspace : run.workspace;
      let workspace;
      try { workspace = await gitIdentity(storedWorkspace.worktree_root_realpath ?? storedWorkspace.git_dir_realpath); }
      catch (error) {
        if (!(error instanceof ControlRecordError)) throw error;
        blocking.push(resumeIssue("worker-workspace-unavailable", "worker-run", run.worker_run_id)); continue;
      }
      if (!sameWorkspaceIdentity(storedWorkspace, workspace)) blocking.push(resumeIssue("worker-worktree-generation-changed", "worker-run", run.worker_run_id));
      const task = manifest.tasks.find((entry) => entry.task_id === run.task_id);
      const expectedHead = storedWorkspace.head_at_reservation ?? storedWorkspace.head_at_record;
      const headChanged = expectedHead !== workspace.head;
      let writerHeadSafe = !headChanged;
      if (headChanged && !(run.write_mode !== "none" && RESERVED_WRITER.has(run.state))) {
        const code = run.write_mode !== "none" && RESERVED_WRITER.has(run.state) ? "writer-head-changed" : "worker-head-changed";
        (code === "writer-head-changed" ? blocking : review).push(resumeIssue(code, "worker-run", run.worker_run_id));
      }
      let workspaceFingerprint = null;
      const resumeScope = run.write_mode !== "none" ? task.write_scope : [];
      if (workspace.kind !== "bare") {
        try { workspaceFingerprint = await readResumeFingerprint(workspace, resumeScope); }
        catch (error) {
          if (!(error instanceof ControlRecordError)) throw error;
          blocking.push(resumeIssue("worker-workspace-unverifiable", "worker-run", run.worker_run_id));
        }
      }
      if (workspaceFingerprint !== null) {
        if (headChanged && run.write_mode !== "none" && RESERVED_WRITER.has(run.state)) {
          try {
            await assertTaskSafeHeadAdvance(run.baseline_workspace_fingerprint, workspaceFingerprint, { cwd: workspace.worktreeRoot, task });
            writerHeadSafe = true;
            review.push(resumeIssue("writer-head-advanced-outside-task-scope", "worker-run", run.worker_run_id));
          } catch (error) {
            if (!(error instanceof ControlRecordError)) throw error;
            blocking.push(resumeIssue("writer-head-changed", "worker-run", run.worker_run_id));
          }
        }
        if (workspaceFingerprint.head !== workspace.head) blocking.push(resumeIssue("worker-workspace-changed-during-check", "worker-run", run.worker_run_id));
        if (run.write_mode === "none" || run.state === "planned") {
          if (run.recorded_workspace_fingerprint.digest !== workspaceFingerprint.digest) review.push(resumeIssue("worker-workspace-content-changed", "worker-run", run.worker_run_id));
        } else if (run.workspace_binding.mode === "executor-isolated") {
          const changed = fingerprintChangedPaths(workspaceFingerprint);
          if (changed.some((path) => !inWriteScope(path, task))) blocking.push(resumeIssue("writer-scope-drift", "worker-run", run.worker_run_id));
          else if (changed.length > 0) review.push(resumeIssue("writer-work-in-progress", "worker-run", run.worker_run_id));
        } else {
          if (writerHeadSafe) {
            try {
              const changed = await changedPaths(run.baseline_workspace_fingerprint, workspaceFingerprint, { cwd: workspace.worktreeRoot, task });
              if (changed.some((path) => !inWriteScope(path, task))) blocking.push(resumeIssue("writer-scope-drift", "worker-run", run.worker_run_id));
              else if (changed.length > 0) review.push(resumeIssue("writer-work-in-progress", "worker-run", run.worker_run_id));
            } catch (error) {
              if (!(error instanceof ControlRecordError)) throw error;
              blocking.push(resumeIssue("writer-workspace-drift", "worker-run", run.worker_run_id));
            }
          }
        }
      }
      if (["dispatched", "running", "unknown"].includes(run.state)) review.push(resumeIssue("worker-requery-required", "worker-run", run.worker_run_id));
    }
    for (const consultation of manifest.consultations.filter((entry) => ["dispatched", "running", "unknown"].includes(entry.state))) {
      review.push(resumeIssue("consultation-requery-required", "consultation", consultation.consultation_id));
    }
    const retention = await evidenceRetention(manifest, identity);
    for (const entry of retention.local) {
      if (["missing", "digest-mismatch", "unsafe"].includes(entry.status)) blocking.push(resumeIssue(`evidence-${entry.status}`, "evidence", entry.ref));
      else if (entry.status === "unverifiable") review.push(resumeIssue("evidence-unverifiable", "evidence", entry.ref));
      // file型のmissing由来救済（path消失だが履歴にbytes実在＝archive退避等）は無音にせずreviewへ出す。
      else if (entry.status === "retained-history" && entry.type === "file" && entry.observed_digest === null) review.push(resumeIssue("evidence-retained-history-missing", "evidence", entry.ref));
    }
    for (const entry of retention.opaque) if (entry.type === "decision") review.push(resumeIssue("evidence-legacy-decision-ref", "evidence", entry.ref));
    const artifacts = await artifactRetention(manifest, identity);
    for (const entry of artifacts) if (entry.status !== "retained") blocking.push(resumeIssue(`artifact-${entry.status}`, "artifact", entry.artifact_id));
    const blockingReasons = uniqueIssues(blocking); const reviewReasons = uniqueIssues(review);
    return {
      schema_version: "dotagents.orchestration-resume-check.v7", checked_at: new Date().toISOString(),
      outcome: blockingReasons.length > 0 ? "blocked" : reviewReasons.length > 0 ? "review-required" : "ready",
      brief,
      current_workspace: {
        kind: identity.kind, project_root_realpath: identity.projectRoot, common_dir_realpath: identity.commonDir,
        git_dir_realpath: identity.gitDir, git_dir_file_id: identity.gitDirFileId, head: identity.head,
        dirty: currentStatus.dirty, status_digest: currentStatus.status_digest,
        workspace_digest: currentFingerprint?.digest ?? null,
      },
      evidence_retention: retention, artifact_retention: artifacts, blocking_reasons: blockingReasons, review_reasons: reviewReasons,
    };
  });
}

export async function taskRecord(input) {
  validateMutationBase(input, ["task"]); validateTask(input.task, false, null);
  return mutation(input, { operation: "task-record", subjectKind: "task", subjectId: input.task.task_id, previousState: null, nextState: "recorded", evidence: [] }, async (manifest, manifests, identity) => {
    if (manifest.phase_gate === null) fail("PHASE_GATE_NOT_RECORDED", "record phase gate before the first task");
    enforceRoleEffectPolicy(input.task, manifest.role_effect_policy);
    if (identity.kind === "bare" && input.task.effect === "write") fail("BARE_WRITE_FORBIDDEN", "bare repository cannot have write tasks");
    if (manifests.flatMap((entry) => entry.tasks).some((task) => task.task_id === input.task.task_id)) fail("DUPLICATE_ID", "task id already exists");
    if (input.task.depends_on.some((dependency) => !manifest.tasks.some((task) => task.task_id === dependency))) fail("INVALID_SCHEMA", "task dependency must already exist in this control");
    if (externalSourceSchema(manifest.schema_version)) {
      if (!own(input.task, "external_source")) fail("INVALID_SCHEMA", "task.external_source is required on a v30 or newer manifest");
    } else if (own(input.task, "external_source")) {
      fail("SCHEMA_UPGRADE_REQUIRED", "task external_source requires a v30 or newer manifest; run control-migrate first");
    }
    await ensureDocumentAvailable(identity, input.task.doc_ref);
    const stored = structuredClone(input.task); stored.admission_digest = taskAdmissionDigest(stored); manifest.tasks.push(stored);
  });
}

export async function taskCancelRecord(input) {
  validateMutationBase(input, ["task_id", "decision"]); identifier(input.task_id, "input.task_id"); validateEvidence(input.decision, "input.decision");
  if (input.decision.type !== "decision") fail("INVALID_SCHEMA", "task cancellation requires decision evidence");
  return mutation(input, { operation: "task-cancel-record", subjectKind: "task", subjectId: input.task_id, previousState: "active", nextState: "cancelled", evidence: [input.decision] }, async (manifest) => {
    if (!manifest.tasks.some((task) => task.task_id === input.task_id)) fail("INVALID_SCHEMA", "task does not exist");
    if (manifest.task_cancellations.some((entry) => entry.task_id === input.task_id)) fail("DUPLICATE_ID", "task cancellation already exists");
    if (manifest.task_finalizations.some((entry) => entry.task_id === input.task_id)) fail("INVALID_TRANSITION", "finalized task cannot be cancelled");
    manifest.task_cancellations.push({
      task_id: input.task_id, cancelled_from_revision: manifest.record_revision,
      decision: structuredClone(input.decision), cancelled_by: input.actor_id,
      cancelled_at: new Date().toISOString(),
    });
  });
}

export async function registryObservationRecord(input) {
  validateMutationBase(input, ["observation"]); validateRegistryObservation(input.observation);
  return mutation(input, {
    operation: "registry-observation-record", subjectKind: "registry-observation",
    subjectId: input.observation.registry_observation_id, previousState: null, nextState: "observed",
    evidence: [input.observation.verification.evidence],
  }, async (manifest, manifests) => {
    const all = manifests.flatMap((entry) => entry.registry_observations);
    if (all.some((entry) => entry.registry_observation_id === input.observation.registry_observation_id)) fail("DUPLICATE_ID", "registry observation id already exists");
    manifest.registry_observations.push(structuredClone(input.observation));
  });
}

const placementReason = new Map([
  ["ADAPTER_UNKNOWN", "adapter-unknown"], ["EXECUTOR_FORBIDDEN", "policy-forbidden"],
  ["CAPABILITY_MISMATCH", "capability-mismatch"], ["VERIFICATION_REQUIRED", "verification-insufficient"],
  ["BUDGET_EXCEEDED", "budget-exceeded"], ["BUDGET_UNKNOWN", "budget-unknown"],
  ["DEPENDENCY_NOT_READY", "dependency-not-ready"], ["WRITE_CONFLICT", "write-conflict"],
  ["CAMPAIGN_NOT_RELEASED", "campaign-not-released"],
  ["ASSIGNMENT_ACTIVE", "assignment-active"], ["APPROVAL_MISMATCH", "policy-forbidden"],
  ["APPROVAL_EXPIRED", "policy-forbidden"], ["ROLE_EFFECT_FORBIDDEN", "policy-forbidden"],
  ["BARE_WRITE_FORBIDDEN", "workspace-invalid"], ["WORKSPACE_DRIFT", "workspace-invalid"],
  ["NOT_GIT_REPOSITORY", "workspace-invalid"], ["STATE_PATH_UNSAFE", "workspace-invalid"],
  ["ARTIFACT_UNAVAILABLE", "artifact-unavailable"], ["ARTIFACT_DIGEST_MISMATCH", "artifact-digest-mismatch"],
  ["IO_FAILURE", "workspace-invalid"], ["GIT_FAILURE", "workspace-invalid"],
  ["INVALID_SCHEMA", "candidate-invalid"], ["DUPLICATE_ID", "worker-run-id-active"],
]);

function placementResult(candidate, hardReasons, reviewReasons) {
  const hard = [...new Set(hardReasons)].sort(); const review = [...new Set(reviewReasons)].sort();
  return {
    candidate_id: candidate.candidate_id,
    registry_observation_id: candidate.registry_observation_id,
    eligibility: hard.length ? "ineligible" : review.length ? "review-required" : "eligible",
    reasons: hard.length ? hard : review,
  };
}

function sameRegistryScope(left, right) {
  return left.workflow_id === right.workflow_id && canonicalJson(left.executor) === canonicalJson(right.executor);
}

function sameExecutorWorkflow(run, registry) {
  return sameRegistryScope(run, registry);
}

function registryRefreshState(manifests, registry, evaluatedAt) {
  const evaluated = Date.parse(evaluatedAt); const observed = Date.parse(registry.verification.observed_at);
  if (observed > evaluated) return { superseded: false, ambiguous: false, notYetObserved: true };
  const snapshots = manifests.flatMap((control) => control.registry_observations)
    .filter((entry) => sameRegistryScope(entry, registry) && Date.parse(entry.verification.observed_at) <= evaluated);
  const latestTime = snapshots.reduce((latest, entry) => Math.max(latest, Date.parse(entry.verification.observed_at)), Number.NEGATIVE_INFINITY);
  const latest = snapshots.filter((entry) => Date.parse(entry.verification.observed_at) === latestTime);
  const superseded = !latest.some((entry) => entry.registry_observation_id === registry.registry_observation_id);
  const bodies = new Set(latest.map((entry) => {
    const body = structuredClone(entry); delete body.registry_observation_id; return canonicalJson(body);
  }));
  return { superseded, ambiguous: bodies.size > 1, notYetObserved: false };
}

function dispatchEvidenceFrontier(run) {
  return Math.max(...run.dispatch_evidence.map((entry) => Date.parse(entry.observed_at)));
}

function unobservedCapacityReservations(manifests, registry) {
  const observedAt = registry.capacity.observed_inflight.evidence.observed_at;
  let reservations = 0; let ambiguous = false;
  for (const control of manifests) for (const run of control.worker_runs) {
    if (!sameExecutorWorkflow(run, registry)) continue;
    if (["planned", "admitted"].includes(run.state)) {
      reservations += 1;
      continue;
    }
    if (["dispatched", "running", "unknown"].includes(run.state)) {
      const comparison = dispatchEvidenceFrontier(run) - Date.parse(observedAt);
      if (comparison > 0) reservations += 1;
      else if (comparison === 0) ambiguous = true;
    }
  }
  return { reservations, ambiguous };
}

async function evaluatePlacementCandidate({ manifest, manifests, task, candidate, evaluatedAt, controlIdentity }) {
  const hard = []; const review = [];
  if (manifest.task_finalizations.some((entry) => entry.task_id === task.task_id)) hard.push("task-finalized");
  const allWorkers = manifests.flatMap((entry) => entry.worker_runs);
  if (manifest.task_cancellations.some((entry) => entry.task_id === task.task_id)) return { result: placementResult(candidate, ["task-cancelled"], []), stored: null, registry: null };
  const pendingCampaigns = unreleasedCampaignsForTask(manifest, task.task_id);
  if (pendingCampaigns.length) return { result: placementResult(candidate, ["campaign-not-released"], []), stored: null, registry: null };
  const registry = manifest.registry_observations.find((entry) => entry.registry_observation_id === candidate.registry_observation_id);
  if (!registry) return { result: placementResult(candidate, ["registry-missing"], []), stored: null, registry: null };
  const refresh = registryRefreshState(manifests, registry, evaluatedAt);
  if (refresh.notYetObserved) hard.push("registry-not-yet-observed");
  if (refresh.superseded) hard.push("registry-superseded");
  if (refresh.ambiguous) review.push("registry-refresh-ambiguous");
  if (Date.parse(registry.expires_at) <= Date.parse(evaluatedAt)) hard.push("registry-expired");
  if (registry.enabled.value === "false") hard.push("enabled-false");
  else if (registry.enabled.value === "unknown") hard.push("enabled-unknown");
  if (!isKnownExecutorContract(registry.executor, registry.workflow_id)) hard.push("adapter-unknown");
  const rank = verificationRank.get(registry.verification.stage);
  if (registry.executor.adapter_id !== "parent" && rank < 3) hard.push("verification-insufficient");
  if (task.effect === "write" && registry.executor.adapter_id !== "parent" && rank !== 4) hard.push("verification-insufficient");
  if (registry.capacity.admission.value === "false") hard.push("capacity-admission-false");
  else if (registry.capacity.admission.value === "unknown") review.push("capacity-review-required");
  const hardLimit = registry.capacity.hard_inflight_limit; const softLimit = registry.capacity.soft_inflight_limit; const inflight = registry.capacity.observed_inflight;
  if (hardLimit.knowledge === "unknown" || inflight.knowledge === "unknown") review.push("capacity-review-required");
  if (softLimit.knowledge === "unknown") review.push("capacity-review-required");
  else {
    const { reservations, ambiguous } = unobservedCapacityReservations(manifests, registry);
    const effectiveInflight = Number.isSafeInteger(inflight.value + reservations) ? inflight.value + reservations : Number.POSITIVE_INFINITY;
    if (effectiveInflight >= hardLimit.value) hard.push("capacity-hard-exhausted");
    if (softLimit.knowledge === "known" && effectiveInflight >= softLimit.value && effectiveInflight < hardLimit.value) review.push("capacity-review-required");
    if (ambiguous) review.push("capacity-review-required");
  }
  if (candidate.lineage.approach_family_ref === null) hard.push("approach-family-unknown");
  else if (manifest.worker_runs.filter((run) => run.lineage.approach_family_ref === candidate.lineage.approach_family_ref).length >= manifest.budget.max_runs_per_approach_family) hard.push("approach-family-limit");
  const family = governedFamily(manifest, candidate.lineage);
  if (family !== null) {
    if (canonicalJson(family.context_policy) !== canonicalJson(candidate.lineage.context_policy)) hard.push("approach-family-context-mismatch");
    if (family.state === "blocked") hard.push("approach-family-blocked");
  }
  if (manifest.worker_runs.filter((run) => run.assignment_id === candidate.assignment_id).length >= manifest.budget.max_retries_per_assignment + 1) hard.push("retry-limit");
  if (task.role === "integrator" && manifest.worker_runs.filter((run) => manifest.tasks.find((entry) => entry.task_id === run.task_id)?.role === "integrator").length >= manifest.budget.max_integration_runs) hard.push("integration-capacity-exhausted");
  let stored = null;
  try {
    const workspace = await gitIdentity(candidate.workspace_cwd);
    const synthetic = {
      worker_run_id: candidate.candidate_id, task_id: task.task_id, assignment_id: candidate.assignment_id,
      executor: structuredClone(registry.executor), workflow_id: registry.workflow_id, role_ref: task.role,
      workspace_cwd: candidate.workspace_cwd, workspace_binding: candidate.workspace_binding, workflow_capabilities: structuredClone(registry.workflow_capabilities),
      budget_reservation: structuredClone(candidate.budget_reservation), write_mode: candidate.write_mode,
      operation_digest: candidate.operation_digest, execution_verification: structuredClone(registry.verification),
      lineage: structuredClone(candidate.lineage), fallback: structuredClone(candidate.fallback), placement_reservation: null, state: "planned", executor_handle: structuredClone(candidate.executor_handle),
      executor_observation: null, admission: null, cancel_request: null, dispatch_evidence: [], dispatch_attempt_evidence: [],
      terminal_evidence: [], result: null, acceptance: null,
    };
    validateWorker(synthetic, false); requireOperationalExecutor(synthetic); requireTaskCapabilities(synthetic, task);
    validateArtifactReferences(manifest, synthetic.lineage, "placement lineage");
    await requireLiveArtifactReferences(controlIdentity, manifest, synthetic.lineage, "placement lineage");
    if (synthetic.fallback !== null) await ensureDocumentAvailable(controlIdentity, synthetic.fallback.decision_ref);
    if (synthetic.role_ref !== task.role || JSON.stringify(synthetic.lineage.context_policy) !== JSON.stringify(task.context_policy)) fail("CAPABILITY_MISMATCH", "candidate lineage differs from task");
    if (workspace.commonDir !== manifest.declaration.common_dir_realpath) fail("WORKSPACE_DRIFT", "candidate common dir differs from control");
    if (task.effect === "write" && workspace.kind === "bare") fail("BARE_WRITE_FORBIDDEN", "bare workspace cannot write");
    requireTaskIsolation(manifest, task, workspace, candidate.workspace_binding);
    const expectedMode = task.effect === "write" ? new Set(["direct", "isolated-alternative"]) : new Set(["none"]);
    if (!expectedMode.has(synthetic.write_mode)) fail("INVALID_SCHEMA", "write mode contradicts task");
    if (task.classification === "F" && task.effect === "write" && registry.executor.adapter_id !== "parent") fail("EXECUTOR_FORBIDDEN", "F write task must use parent");
    if (task.classification === "H") {
      if (candidate.operation_digest !== task.approval.operation_digest) fail("APPROVAL_MISMATCH", "H operation digest differs from approval");
      if (task.approval.expires_at !== null && Date.parse(task.approval.expires_at) <= Date.parse(evaluatedAt)) fail("APPROVAL_EXPIRED", "H approval is expired");
    }
    if (synthetic.lineage.parent_worker_run_id === null) {
      if (synthetic.lineage.root_assignment_id !== synthetic.assignment_id) fail("INVALID_SCHEMA", "root lineage is invalid");
    } else {
      const parent = manifest.worker_runs.find((entry) => entry.worker_run_id === synthetic.lineage.parent_worker_run_id);
      if (!parent || parent.lineage.root_assignment_id !== synthetic.lineage.root_assignment_id) fail("INVALID_SCHEMA", "parent lineage is invalid");
    }
    requireDependenciesReady(manifest, task);
    if (allWorkers.some((run) => run.worker_run_id === synthetic.worker_run_id)) fail("DUPLICATE_ID", "worker run id already exists");
    assignmentAllows(allWorkers, synthetic.assignment_id, "worker");
    await inspectTaskScopes(workspace, task);
    stored = structuredClone(synthetic); delete stored.workspace_cwd; stored.workspace = workspaceObject(workspace); stored.workspace_binding = workspaceBindingObject(candidate.workspace_binding, stored.workspace); stored.recorded_workspace_fingerprint = null; stored.baseline_workspace_fingerprint = null;
    assertBudgetWithin(manifest, stored, null, { skipPlacementLimits: true });
    const conflicts = conflictList(manifests, stored, task); if (conflicts.length) fail("WRITE_CONFLICT", "candidate conflicts with active writer");
  } catch (error) {
    if (!(error instanceof ControlRecordError) || !placementReason.has(error.code)) throw error;
    hard.push(placementReason.get(error.code));
  }
  return { result: placementResult(candidate, hard, review), stored, registry };
}

export async function placementDryRun(input) {
  apiInput(input, ["cwd", "control_id", "task_id", "evaluated_at", "candidates"]);
  identifier(input.control_id, "input.control_id"); identifier(input.task_id, "input.task_id"); timestamp(input.evaluated_at, "input.evaluated_at");
  boundedArray(input.candidates, "input.candidates", validatePlacementCandidate, { min: 1 });
  const candidateIds = input.candidates.map((entry) => entry.candidate_id);
  if (new Set(candidateIds).size !== candidateIds.length) fail("INVALID_INPUT", "candidate ids must be unique");
  const identity = await gitIdentity(input.cwd);
  return withLock(identity, async (paths) => {
    const manifests = await scanManifests(paths); const manifest = targetManifest(manifests, input.control_id);
    requireOperationalManifest(manifest);
    if (manifest.status === "archived") fail("RECORD_ARCHIVED", "control is archived");
    if (manifest.control_finalization !== null) fail("CONTROL_FINALIZED", "control is finalized");
    const task = manifest.tasks.find((entry) => entry.task_id === input.task_id);
    if (!task) fail("INVALID_INPUT", "placement task does not exist");
    const results = [];
    for (const candidate of [...input.candidates].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))) {
      results.push((await evaluatePlacementCandidate({ manifest, manifests, task, candidate, evaluatedAt: input.evaluated_at, controlIdentity: identity })).result);
    }
    return { control_id: manifest.control_id, control_revision: manifest.record_revision, task_id: task.task_id, evaluated_at: input.evaluated_at, candidates: results };
  });
}

export async function reservePlacement(input) {
  validateMutationBase(input, ["task_id", "candidate", "review_decision"], ["selector_decision", "quota_pool_lock_token"]);
  identifier(input.task_id, "input.task_id"); validatePlacementCandidate(input.candidate, "input.candidate");
  if (input.review_decision !== null) {
    validateEvidence(input.review_decision, "input.review_decision");
    if (input.review_decision.type !== "decision") fail("INVALID_SCHEMA", "placement review must be decision evidence");
  }
  if (input.selector_decision !== undefined) validateSelectorDecision(input.selector_decision);
  if (input.quota_pool_lock_token !== undefined) {
    if (input.selector_decision === undefined) fail("INVALID_SCHEMA", "quota_pool_lock_token requires a selector_decision");
    if (typeof input.quota_pool_lock_token !== "string" || !UUID_RE.test(input.quota_pool_lock_token)) fail("INVALID_INPUT", "quota_pool_lock_token must be a canonical UUID");
  }
  return mutation(input, (before, next) => {
    const run = next.worker_runs.find((entry) => entry.worker_run_id === input.candidate.candidate_id);
    const evidence = run === undefined ? [] : [run.execution_verification.evidence, ...(run.placement_reservation.review_decision === null ? [] : [run.placement_reservation.review_decision])];
    return { operation: "placement-reserve", subjectKind: "worker-run", subjectId: input.candidate.candidate_id, subjectDigest: run === undefined ? null : placementReservationDigest(run.placement_reservation), previousState: null, nextState: "planned", evidence };
  }, async (manifest, manifests, identity) => {
    const task = manifest.tasks.find((entry) => entry.task_id === input.task_id);
    if (!task) fail("INVALID_SCHEMA", "placement task does not exist");
    const evaluatedAt = new Date().toISOString();
    const evaluation = await evaluatePlacementCandidate({ manifest, manifests, task, candidate: input.candidate, evaluatedAt, controlIdentity: identity });
    if (evaluation.result.eligibility === "ineligible") fail("PLACEMENT_INELIGIBLE", "placement candidate is ineligible", { reasons: evaluation.result.reasons });
    if (evaluation.result.eligibility === "review-required" && input.review_decision === null) fail("PLACEMENT_REVIEW_REQUIRED", "placement candidate requires parent review", { reasons: evaluation.result.reasons });
    if (evaluation.result.eligibility === "eligible" && input.review_decision !== null) fail("INVALID_SCHEMA", "eligible placement cannot carry review approval");
    if (evaluation.stored === null || evaluation.registry === null) fail("PLACEMENT_INELIGIBLE", "placement candidate cannot be materialized");
    const stored = evaluation.stored;
    const registryObservationId = evaluation.registry.registry_observation_id;
    stored.recorded_workspace_fingerprint = stored.workspace.kind === "bare" ? null : await fingerprintWorkspace({ cwd: stored.workspace.worktree_root_realpath, scope_guard: task.effect === "write" ? task.write_scope : [] });
    if (input.selector_decision !== undefined && !selectorDecisionSchema(manifest.schema_version)) fail("SCHEMA_UPGRADE_REQUIRED", "placement selector_decision requires a v27 or newer manifest; run control-migrate first");
    // ADR 0054 Wave A: a selector-based reservation must hold the quota pool lease so the
    // observe->select->reserve critical section serializes per pool within this store. The
    // token is verified against the lease owner file and never written into the manifest
    // (the reservation is digest-bound; extra keys would break existing Controls).
    if (input.selector_decision !== undefined) {
      if (input.quota_pool_lock_token === undefined) fail("QUOTA_POOL_LOCK_REQUIRED", "selector-based placement requires the quota pool lock; acquire quota-pool-lock first");
      await readQuotaPoolLockOwner(identity, input.selector_decision.selected_quota_pool_id, input.quota_pool_lock_token);
    }
    stored.placement_reservation = {
      registry_observation_id: registryObservationId,
      candidate_digest: placementCandidateDigest(materializedPlacementCandidate(stored, registryObservationId)),
      selected_from_revision: manifest.record_revision,
      eligibility: evaluation.result.eligibility,
      review_reasons: [...evaluation.result.reasons],
      review_decision: structuredClone(input.review_decision),
      selected_by: input.actor_id,
      selected_at: evaluatedAt,
    };
    if (input.selector_decision !== undefined) stored.placement_reservation.selector_decision = structuredClone(input.selector_decision);
    manifest.worker_runs.push(stored);
  });
}

const verificationRank = new Map([["unverified", 0], ["installed", 1], ["registered", 2], ["verified", 3], ["execution-verified", 4]]);

function assignmentAllows(allRuns, assignment, kind) {
  const prior = allRuns.filter((run) => run.assignment_id === assignment);
  for (const run of prior) {
    if (kind === "worker") {
      if (WORKER_NONTERMINAL.has(run.state) || (run.state === "completed" && run.acceptance?.decision !== "rejected")) fail("ASSIGNMENT_ACTIVE", "assignment is not eligible for retry");
    } else if (!["failed", "cancelled"].includes(run.state)) fail("ASSIGNMENT_ACTIVE", "consultation assignment is not eligible for retry");
  }
}

export async function workerRunRecord(input) {
  validateMutationBase(input, ["worker_run"]);
  validateWorkerRecord(input.worker_run);
  if (input.worker_run.placement_reservation !== null) fail("INVALID_SCHEMA", "manual worker record cannot forge placement reservation");
  const workspaceIdentity = await gitIdentity(input.worker_run.workspace_cwd);
  return mutation(input, (before, next) => {
    const run = next.worker_runs.find((entry) => entry.worker_run_id === input.worker_run.worker_run_id);
    return {
      operation: "worker-run-record", subjectKind: "worker-run", subjectId: input.worker_run.worker_run_id,
      subjectDigest: run === undefined ? null : manualWorkerCreationDigest(run), previousState: null, nextState: "planned",
      evidence: run === undefined ? [] : [run.execution_verification.evidence],
    };
  }, async (manifest, manifests, identity) => {
    const task = manifest.tasks.find((entry) => entry.task_id === input.worker_run.task_id); if (!task) fail("INVALID_SCHEMA", "worker task does not exist");
    requireTaskNotCancelled(manifest, task.task_id);
    requireTaskNotFinalized(manifest, task.task_id);
    requireTaskCapabilities(input.worker_run, task);
    if (input.worker_run.role_ref !== task.role) fail("INVALID_SCHEMA", "worker role differs from task snapshot");
    if (JSON.stringify(input.worker_run.lineage.context_policy) !== JSON.stringify(task.context_policy)) fail("INVALID_SCHEMA", "worker lineage context policy differs from task snapshot");
    requireFamilyEligible(manifest, input.worker_run.lineage);
    if (workspaceIdentity.commonDir !== manifest.declaration.common_dir_realpath) fail("WORKSPACE_DRIFT", "worker common dir differs from control");
    if (task.effect === "write" && workspaceIdentity.kind === "bare") fail("BARE_WRITE_FORBIDDEN", "bare workspace cannot write");
    requireTaskIsolation(manifest, task, workspaceIdentity, input.worker_run.workspace_binding);
    const expectedMode = task.effect === "write" ? new Set(["direct", "isolated-alternative"]) : new Set(["none"]);
    if (!expectedMode.has(input.worker_run.write_mode)) fail("INVALID_SCHEMA", "write_mode contradicts task");
    const parentExecutor = input.worker_run.executor.adapter_id === "parent";
    if (task.classification === "F" && task.effect === "write" && !parentExecutor) fail("EXECUTOR_FORBIDDEN", "F write task must use parent");
    const rank = verificationRank.get(input.worker_run.execution_verification.stage);
    if (!parentExecutor && rank < 3) fail("VERIFICATION_REQUIRED", "external executor must be verified");
    if (task.effect === "write" && !parentExecutor && rank !== 4) fail("VERIFICATION_REQUIRED", "external writer must be execution-verified");
    const allWorkers = manifests.flatMap((entry) => entry.worker_runs);
    if (allWorkers.some((run) => run.worker_run_id === input.worker_run.worker_run_id)) fail("DUPLICATE_ID", "worker run id already exists");
    assignmentAllows(allWorkers, input.worker_run.assignment_id, "worker");
    if (input.worker_run.fallback !== null) await ensureDocumentAvailable(identity, input.worker_run.fallback.decision_ref);
    validateArtifactReferences(manifest, input.worker_run.lineage, "worker lineage");
    await requireLiveArtifactReferences(identity, manifest, input.worker_run.lineage, "worker lineage");
    if (input.worker_run.lineage.parent_worker_run_id === null) {
      if (input.worker_run.lineage.root_assignment_id !== input.worker_run.assignment_id) fail("INVALID_SCHEMA", "root worker lineage is invalid");
    } else {
      const parent = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run.lineage.parent_worker_run_id);
      if (!parent || input.worker_run.lineage.root_assignment_id !== parent.lineage.root_assignment_id) fail("INVALID_SCHEMA", "parent worker lineage is invalid");
    }
    await inspectTaskScopes(workspaceIdentity, task);
    const stored = structuredClone(input.worker_run); delete stored.workspace_cwd; stored.workspace = workspaceObject(workspaceIdentity); stored.workspace_binding = workspaceBindingObject(input.worker_run.workspace_binding, stored.workspace);
    stored.recorded_workspace_fingerprint = workspaceIdentity.kind === "bare" ? null : await fingerprintWorkspace({ cwd: workspaceIdentity.worktreeRoot, scope_guard: task.effect === "write" ? task.write_scope : [] });
    stored.baseline_workspace_fingerprint = null;
    assertBudgetWithin(manifest, stored, null);
    manifest.worker_runs.push(stored);
  });
}

export async function consultationRecord(input) {
  validateMutationBase(input, ["consultation"]);
  if (input.consultation === null || typeof input.consultation !== "object" || Array.isArray(input.consultation)) fail("INVALID_SCHEMA", "consultation must be an object");
  const inputTyped = Object.hasOwn(input.consultation, "consultation_handle");
  validateConsultation(input.consultation, inputTyped ? MANIFEST_SCHEMA_V26 : MANIFEST_SCHEMA_V25);
  if (input.consultation.state !== "planned" || input.consultation.executor_observation !== null || input.consultation.decision_ref !== null || input.consultation.terminal_evidence.length) fail("INVALID_SCHEMA", "new consultation must be pristine planned state");
  return mutation(input, { operation: "consultation-record", subjectKind: "consultation", subjectId: input.consultation.consultation_id, previousState: null, nextState: "planned", evidence: [] }, async (manifest, manifests) => {
    if (typedConsultationSchema(manifest.schema_version) !== inputTyped) {
      if (inputTyped) fail("SCHEMA_UPGRADE_REQUIRED", "typed consultation_handle requires a typed-schema manifest; run control-migrate first");
      fail("INVALID_SCHEMA", "typed-schema manifest consultation requires consultation_handle");
    }
    const task = manifest.tasks.find((entry) => entry.task_id === input.consultation.task_id); if (!task) fail("INVALID_SCHEMA", "consultation task does not exist");
    requireTaskNotCancelled(manifest, task.task_id);
    requireTaskNotFinalized(manifest, task.task_id);
    if (task.classification === "H") fail("CONSULTATION_OPERATION_CONTRACT_MISSING", "H task consultation requires an operation digest contract");
    const all = manifests.flatMap((entry) => entry.consultations);
    if (all.some((entry) => entry.consultation_id === input.consultation.consultation_id)) fail("DUPLICATE_ID", "consultation id already exists");
    assignmentAllows(all, input.consultation.assignment_id, "consultation");
    assertBudgetWithin(manifest, null, input.consultation);
    manifest.consultations.push(structuredClone(input.consultation));
  });
}

// Explicit one-shot schema migration (ADR 0045 / ADR 0054). Mutation-time auto-upgrade is
// forbidden; finalized controls are blocked by CONTROL_FINALIZED and archived by RECORD_ARCHIVED.
// Moves between adjacent versions only.
export async function controlMigrate(input) {
  validateMutationBase(input, ["target_schema_version"]);
  oneOf(input.target_schema_version, MANIFEST_SCHEMAS, "input.target_schema_version");
  return mutation(input, (before) => ({
    operation: "control-migrate", subjectKind: "control", subjectId: input.control_id,
    previousState: before.schema_version, nextState: input.target_schema_version, evidence: [],
  }), async (manifest) => {
    if (manifest.schema_version === input.target_schema_version) fail("INVALID_TRANSITION", "manifest is already at the target schema version");
    if (!MIGRATION_EDGES[manifest.schema_version].includes(input.target_schema_version)) fail("INVALID_TRANSITION", "schema migration must move between adjacent versions");
    const cancelledTaskIds = new Set(manifest.task_cancellations.map((entry) => entry.task_id));
    const hasCancelReceipt = (consultationId) => manifest.transition_receipts.some((receipt) => receipt.operation === "consultation-cancel" && receipt.subject.kind === "consultation" && receipt.subject.id === consultationId);
    if (manifest.schema_version === MANIFEST_SCHEMA_V25 && input.target_schema_version === MANIFEST_SCHEMA_V26) {
      for (const consultation of manifest.consultations) {
        consultation.consultation_handle = { slug: consultation.slug };
        delete consultation.slug;
      }
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V26 && input.target_schema_version === MANIFEST_SCHEMA_V25) {
      if (manifest.consultations.some((entry) => entry.connector !== "gpt-connector")) fail("ROLLBACK_UNSUPPORTED", "v25 rollback is impossible while non gpt-connector consultations exist");
      for (const consultation of manifest.consultations) {
        consultation.slug = consultation.consultation_handle.slug;
        delete consultation.consultation_handle;
      }
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V26 && input.target_schema_version === MANIFEST_SCHEMA_V27) {
      // Deterministic orphan conversion (ADR 0054 Decision 3): the ADR 0053 closure exemption
      // retires in v27, where the explicit escape is consultation-cancel.
      for (const consultation of manifest.consultations) {
        if (consultation.state === "planned" && cancelledTaskIds.has(consultation.task_id)) consultation.state = "cancelled";
      }
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V27 && input.target_schema_version === MANIFEST_SCHEMA_V26) {
      // v27 -> v26 rollback: v27-only features block it; migration-produced cancelled is restored.
      for (const run of manifest.worker_runs) {
        if (run.placement_reservation !== null && Object.hasOwn(run.placement_reservation, "selector_decision")) fail("ROLLBACK_UNSUPPORTED", "v26 rollback is impossible while selector decisions exist");
      }
      for (const consultation of manifest.consultations) {
        if (consultation.state !== "cancelled") continue;
        if (hasCancelReceipt(consultation.consultation_id)) fail("ROLLBACK_UNSUPPORTED", "v26 rollback is impossible while explicitly cancelled consultations exist");
        if (!cancelledTaskIds.has(consultation.task_id)) fail("ROLLBACK_UNSUPPORTED", "cancelled consultation cannot be classified for rollback");
        consultation.state = "planned";
      }
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V27 && input.target_schema_version === MANIFEST_SCHEMA_V28) {
      // v28 adds only a new receipt operation. Existing descriptors remain byte-for-byte stable;
      // legacy artifact refs are grandfathered but cannot become generation predecessors.
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V28 && input.target_schema_version === MANIFEST_SCHEMA_V29) {
      // v29 adds the lane_admission top-level key (ADR 0114 Decision 4). Admission binding is
      // init-only, so a migrated control carries null forever — never a fabricated declaration.
      manifest.lane_admission = null;
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V29 && input.target_schema_version === MANIFEST_SCHEMA_V28) {
      // v29 -> v28 removes the key and is possible only for migration-produced null admissions.
      // An init-created v29 control cannot roll back (ADR 0114 Decision 6): dropping a declared
      // admission would be silent data loss, and behavior rollback is the supported path.
      if (manifest.lane_admission !== null) fail("ROLLBACK_UNSUPPORTED", "v28 rollback is impossible for a control initialized with lane admission");
      delete manifest.lane_admission;
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V29 && input.target_schema_version === MANIFEST_SCHEMA_V30) {
      // v30 adds the per-task external_source key (ADR 0116 Decision 1/3). Stamping null onto
      // every stored task is the only conversion; admission digests are unchanged because a
      // null binding is digest-normalized away (Decision 2).
      for (const task of manifest.tasks) task.external_source = null;
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V30 && input.target_schema_version === MANIFEST_SCHEMA_V29) {
      // v30 -> v29 removes the key and is possible only while every binding is null. A non-null
      // binding is acceptance-bound correlation evidence; dropping it would be silent data loss
      // (ADR 0116 Decision 3), so behavior rollback is the supported path instead.
      if (manifest.tasks.some((task) => task.external_source !== null)) fail("ROLLBACK_UNSUPPORTED", "v29 rollback is impossible while non-null external source bindings exist");
      for (const task of manifest.tasks) delete task.external_source;
    } else if (manifest.schema_version === MANIFEST_SCHEMA_V28 && input.target_schema_version === MANIFEST_SCHEMA_V27) {
      // v28 -> v27 is lossless only before the v28-only composite receipt has been used.
      if (manifest.transition_receipts.some((receipt) => receipt.operation === "artifact-generation-record")) fail("ROLLBACK_UNSUPPORTED", "v27 rollback is impossible while artifact generation receipts exist");
    } else {
      // MIGRATION_EDGES already bounds reachable pairs; an unlisted pair here is a programming
      // error in this function, so refuse loudly instead of guessing a default conversion
      // (ADR 0114 Decision 4 — the old catch-all silently treated new edges as v28->v27 rollback).
      fail("INVALID_TRANSITION", "schema migration pair has no explicit conversion");
    }
    manifest.schema_version = input.target_schema_version;
  });
}

// planned -> cancelled escape (ADR 0054 Decision 3, v27 only). The parent decision evidence is
// held by the transition receipt alone; the record stays planned-shaped for audit.
export async function consultationCancel(input) {
  validateMutationBase(input, ["consultation_id", "decision"]);
  identifier(input.consultation_id, "input.consultation_id"); validateEvidence(input.decision, "input.decision");
  if (input.decision.type !== "decision") fail("INVALID_SCHEMA", "consultation cancel requires decision evidence");
  return mutation(input, { operation: "consultation-cancel", subjectKind: "consultation", subjectId: input.consultation_id, previousState: "planned", nextState: "cancelled", evidence: [input.decision] }, async (manifest) => {
    if (!explicitConsultationCancelSchema(manifest.schema_version)) fail("SCHEMA_UPGRADE_REQUIRED", "consultation cancel requires a v27 or newer manifest; run control-migrate first");
    const consultation = manifest.consultations.find((entry) => entry.consultation_id === input.consultation_id);
    if (!consultation) fail("INVALID_SCHEMA", "consultation does not exist");
    if (consultation.state !== "planned") fail("INVALID_TRANSITION", "only a planned consultation can be cancelled");
    consultation.state = "cancelled";
  });
}

function validateCampaignDeclaration(value) {
  exact(value, ["campaign_id", "campaign_type", "members", "gated_task_ids", "audit_required"], "campaign");
  identifier(value.campaign_id, "campaign.campaign_id");
  oneOf(value.campaign_type, ["discovery", "refutation", "design", "implementation", "final-audit"], "campaign.campaign_type");
  boundedArray(value.members, "campaign.members", validateCampaignMember, { min: 1 });
  if (new Set(value.members.map((entry) => `${entry.kind}\0${entry.id}`)).size !== value.members.length) fail("INVALID_SCHEMA", "campaign members contain duplicates");
  uniqueStringArray(value.gated_task_ids, "campaign.gated_task_ids", identifier, { min: 1 });
  if (typeof value.audit_required !== "boolean") fail("INVALID_SCHEMA", "campaign.audit_required must be boolean");
}

function campaignProjection(manifest, campaign) {
  const members = campaign.members.map((member) => ({ ...structuredClone(member), state: campaignMemberState(manifest, member) }));
  return {
    schema_version: "dotagents.campaign-status.v1", campaign_id: campaign.campaign_id,
    campaign_type: campaign.campaign_type, members, gated_task_ids: [...campaign.gated_task_ids],
    all_terminal: campaignAllTerminal(manifest, campaign), audit_required: campaign.audit_required,
    released: campaign.release !== null, release: structuredClone(campaign.release),
  };
}

export async function campaignRecord(input) {
  validateMutationBase(input, ["campaign"]); validateCampaignDeclaration(input.campaign);
  return mutation(input, (_before, next) => {
    const campaign = next.campaigns.find((entry) => entry.campaign_id === input.campaign.campaign_id);
    return { operation: "campaign-record", subjectKind: "campaign", subjectId: input.campaign.campaign_id, subjectDigest: campaign === undefined ? null : campaignDeclarationDigest(campaign), previousState: null, nextState: "declared", evidence: [] };
  }, async (manifest, manifests) => {
    if (manifests.flatMap((entry) => entry.campaigns).some((campaign) => campaign.campaign_id === input.campaign.campaign_id)) fail("DUPLICATE_ID", "campaign id already exists");
    for (const taskId of input.campaign.gated_task_ids) if (!manifest.tasks.some((task) => task.task_id === taskId)) fail("INVALID_SCHEMA", "campaign gated task does not exist");
    for (const member of input.campaign.members) if (campaignMemberState(manifest, member) === null) fail("INVALID_SCHEMA", "campaign member does not exist");
    manifest.campaigns.push({
      ...structuredClone(input.campaign), declared_from_revision: manifest.record_revision,
      declared_by: input.actor_id, declared_at: new Date().toISOString(), release: null,
    });
  });
}

export async function campaignStatus(input) {
  apiInput(input, ["cwd", "control_id", "campaign_id"]); identifier(input.control_id, "input.control_id"); identifier(input.campaign_id, "input.campaign_id");
  const identity = await gitIdentity(input.cwd); const manifests = await scanManifests(await statePaths(identity)); const manifest = targetManifest(manifests, input.control_id);
  const campaign = manifest.campaigns.find((entry) => entry.campaign_id === input.campaign_id); if (!campaign) fail("INVALID_SCHEMA", "campaign does not exist");
  return campaignProjection(manifest, campaign);
}

export async function releaseCampaign(input) {
  validateMutationBase(input, ["campaign_id", "audit_evidence", "decision"]); identifier(input.campaign_id, "input.campaign_id");
  evidenceArray(input.audit_evidence, "input.audit_evidence"); validateEvidence(input.decision, "input.decision");
  if (input.decision.type !== "decision") fail("INVALID_SCHEMA", "campaign release requires decision evidence");
  const receiptEvidence = [input.decision, ...input.audit_evidence];
  if (receiptEvidence.length > ARRAY_LIMIT) fail("LIMIT_EXCEEDED", "campaign release receipt evidence exceeds limit");
  return mutation(input, { operation: "campaign-release", subjectKind: "campaign", subjectId: input.campaign_id, previousState: "declared", nextState: "released", evidence: receiptEvidence }, async (manifest) => {
    const campaign = manifest.campaigns.find((entry) => entry.campaign_id === input.campaign_id); if (!campaign) fail("INVALID_SCHEMA", "campaign does not exist");
    if (campaign.release !== null) fail("DUPLICATE_ID", "campaign is already released");
    if (!campaignReadyForRelease(manifest, campaign)) fail("CAMPAIGN_NOT_READY", "campaign members are not terminal and parent-decided");
    if (campaign.audit_required && input.audit_evidence.length === 0) fail("EVIDENCE_REQUIRED", "campaign release requires audit evidence");
    if (!campaign.audit_required && input.audit_evidence.length !== 0) fail("INVALID_SCHEMA", "campaign without audit requirement cannot store audit evidence");
    campaign.release = {
      released_from_revision: manifest.record_revision, audit_evidence: structuredClone(input.audit_evidence),
      decision: structuredClone(input.decision), released_by: input.actor_id, released_at: new Date().toISOString(),
    };
  });
}

export async function phaseGateRecord(input) {
  validateMutationBase(input, ["risk", "behavior_lane"]);
  oneOf(input.risk, ["standard", "high"], "input.risk");
  oneOf(input.behavior_lane, ["behavior-preserving", "behavior-change"], "input.behavior_lane");
  return mutation(input, (before, next) => ({
    operation: "phase-gate-record", subjectKind: "phase-gate", subjectId: PHASE_GATE_ID,
    subjectDigest: next.phase_gate === null ? null : phaseGateDeclarationDigest(next.phase_gate),
    previousState: null, nextState: "recorded", evidence: [],
  }), async (manifest) => {
    if (manifest.phase_gate !== null) fail("DUPLICATE_ID", "phase gate is already recorded");
    manifest.phase_gate = {
      workflow: "dotagents.phase-gate.v1", risk: input.risk, behavior_lane: input.behavior_lane,
      phases: PHASE_ORDER.map(phaseStep), declared_from_revision: manifest.record_revision,
      declared_by: input.actor_id, declared_at: new Date().toISOString(),
    };
  });
}

export async function phaseGateStatus(input) {
  apiInput(input, ["cwd", "control_id"]); identifier(input.control_id, "input.control_id");
  const manifest = await status(input);
  if (manifest.phase_gate === null) return { schema_version: "dotagents.phase-gate-status.v1", configured: false, current_phase: null, phase_gate: null };
  return {
    schema_version: "dotagents.phase-gate-status.v1", configured: true, current_phase: phaseGateCurrent(manifest),
    complete: phaseGateComplete(manifest), phase_gate: structuredClone(manifest.phase_gate),
  };
}

export async function phaseGateAdvance(input) {
  validateMutationBase(input, ["phase", "state", "evidence", "decision"]);
  oneOf(input.phase, PHASE_ORDER, "input.phase");
  evidenceArray(input.evidence, "input.evidence");
  if (input.decision !== null) {
    validateEvidence(input.decision, "input.decision");
    if (input.decision.type !== "decision") fail("INVALID_SCHEMA", "phase gate decision must be decision evidence");
  }
  return mutation(input, () => ({
    operation: "phase-gate-advance", subjectKind: "phase-gate", subjectId: input.phase,
    previousState: "pending", nextState: input.state,
    evidence: [...input.evidence, ...(input.decision === null ? [] : [input.decision])],
  }), async (manifest) => {
    if (manifest.phase_gate === null) fail("PHASE_GATE_NOT_RECORDED", "phase gate is not recorded");
    const current = phaseGateCurrent(manifest);
    if (current !== input.phase) fail("PHASE_ORDER_INVALID", "phase is not current", { current_phase: current });
    const step = manifest.phase_gate.phases.find((entry) => entry.phase === input.phase);
    const candidate = {
      phase: step.phase, state: input.state, evidence: structuredClone(input.evidence), decision: structuredClone(input.decision),
      advanced_from_revision: manifest.record_revision, advanced_by: input.actor_id, advanced_at: new Date().toISOString(),
    };
    validatePhaseStep(candidate, "input.phase_gate_step", manifest.phase_gate);
    Object.assign(step, candidate);
  });
}

function artifactProjection(artifact) {
  return { schema_version: "dotagents.artifact-status.v1", artifact_id: artifact.artifact_id, artifact_kind: artifact.artifact_kind, artifact_ref: artifact.artifact_ref, artifact_digest: artifact.artifact_digest, status: artifact.status };
}

export async function artifactRecord(input) {
  validateMutationBase(input, ["artifact"]);
  exact(input.artifact, ["artifact_id", "artifact_kind", "artifact_ref", "artifact_digest", "status"], "input.artifact");
  validateArtifact({ ...input.artifact, recorded_from_revision: 0, recorded_by: "placeholder", recorded_at: "2026-07-14T00:00:00.000Z", status_from_revision: null, status_by: null, status_at: null }, "input.artifact");
  if (input.artifact.status !== "current") fail("INVALID_SCHEMA", "new artifact status must be current");
  return mutation(input, (before, next) => {
    const artifact = next.artifacts.find((entry) => entry.artifact_id === input.artifact.artifact_id);
    return { operation: "artifact-record", subjectKind: "artifact", subjectId: input.artifact.artifact_id, subjectDigest: artifact === undefined ? null : artifactDescriptorDigest(artifact), previousState: null, nextState: "current", evidence: [] };
  }, async (manifest, manifests, identity) => {
    if (artifactGenerationSchema(manifest.schema_version)) versionedArtifactRef(input.artifact.artifact_ref, input.artifact.artifact_digest, "input.artifact.artifact_ref");
    if (manifests.flatMap((entry) => entry.artifacts).some((entry) => entry.artifact_id === input.artifact.artifact_id)) fail("DUPLICATE_ID", "artifact id already exists");
    await requireArtifactDocumentDigest(identity, input.artifact.artifact_ref, input.artifact.artifact_digest);
    manifest.artifacts.push({ ...structuredClone(input.artifact), recorded_from_revision: manifest.record_revision, recorded_by: input.actor_id, recorded_at: new Date().toISOString(), status_from_revision: null, status_by: null, status_at: null });
  });
}

export async function artifactStatus(input) {
  apiInput(input, ["cwd", "control_id", "artifact_id"]); identifier(input.control_id, "input.control_id"); identifier(input.artifact_id, "input.artifact_id");
  const manifest = await status({ cwd: input.cwd, control_id: input.control_id }); const artifact = manifest.artifacts.find((entry) => entry.artifact_id === input.artifact_id); if (artifact === undefined) fail("INVALID_SCHEMA", "artifact does not exist");
  return artifactProjection(artifact);
}

export async function artifactStatusRecord(input) {
  validateMutationBase(input, ["artifact_id", "status"]); identifier(input.artifact_id, "input.artifact_id"); oneOf(input.status, ["closed", "superseded"], "input.status");
  return mutation(input, (before, next) => {
    const artifact = next.artifacts.find((entry) => entry.artifact_id === input.artifact_id);
    return { operation: "artifact-status-record", subjectKind: "artifact", subjectId: input.artifact_id, subjectDigest: artifact === undefined ? null : artifactDescriptorDigest(artifact), previousState: before.artifacts.find((entry) => entry.artifact_id === input.artifact_id)?.status ?? null, nextState: input.status, evidence: [] };
  }, async (manifest, _manifests, identity) => {
    const artifact = manifest.artifacts.find((entry) => entry.artifact_id === input.artifact_id); if (artifact === undefined) fail("INVALID_SCHEMA", "artifact does not exist");
    if (artifact.status !== "current") fail("INVALID_TRANSITION", "artifact status is terminal");
    await requireArtifactDocumentDigest(identity, artifact.artifact_ref, artifact.artifact_digest);
    artifact.status = input.status; artifact.status_from_revision = manifest.record_revision; artifact.status_by = input.actor_id; artifact.status_at = new Date().toISOString();
  });
}

export async function artifactGenerationRecord(input) {
  validateMutationBase(input, ["superseded_artifact_id", "artifact"]);
  identifier(input.superseded_artifact_id, "input.superseded_artifact_id");
  exact(input.artifact, ["artifact_id", "artifact_kind", "artifact_ref", "artifact_digest", "status"], "input.artifact");
  validateArtifact({ ...input.artifact, recorded_from_revision: 0, recorded_by: "placeholder", recorded_at: "2026-07-14T00:00:00.000Z", status_from_revision: null, status_by: null, status_at: null }, "input.artifact");
  if (input.artifact.status !== "current") fail("INVALID_SCHEMA", "new artifact status must be current");
  return mutation(input, (_before, next) => {
    const superseded = next.artifacts.find((entry) => entry.artifact_id === input.superseded_artifact_id);
    const current = next.artifacts.find((entry) => entry.artifact_id === input.artifact.artifact_id);
    return { operation: "artifact-generation-record", subjectKind: "artifact", subjectId: input.superseded_artifact_id, subjectDigest: superseded === undefined || current === undefined ? null : artifactGenerationDigest(superseded, current), previousState: "current", nextState: "superseded", evidence: [] };
  }, async (manifest, manifests, identity) => {
    if (!artifactGenerationSchema(manifest.schema_version)) fail("SCHEMA_UPGRADE_REQUIRED", "artifact generation requires a v28 or newer manifest; run control-migrate first");
    const superseded = manifest.artifacts.find((entry) => entry.artifact_id === input.superseded_artifact_id);
    if (superseded === undefined) fail("INVALID_SCHEMA", "superseded artifact does not exist");
    if (superseded.status !== "current") fail("INVALID_TRANSITION", "superseded artifact status is terminal");
    if (superseded.artifact_kind !== input.artifact.artifact_kind) fail("INVALID_SCHEMA", "artifact generation must preserve artifact kind");
    if (superseded.artifact_digest === input.artifact.artifact_digest) fail("INVALID_SCHEMA", "artifact generation must change content digest");
    if (superseded.artifact_ref === input.artifact.artifact_ref) fail("INVALID_SCHEMA", "artifact generation must use a new artifact ref");
    versionedArtifactRef(superseded.artifact_ref, superseded.artifact_digest, "superseded artifact ref");
    versionedArtifactRef(input.artifact.artifact_ref, input.artifact.artifact_digest, "input.artifact.artifact_ref");
    if (manifests.flatMap((entry) => entry.artifacts).some((entry) => entry.artifact_id === input.artifact.artifact_id)) fail("DUPLICATE_ID", "artifact id already exists");
    await requireArtifactDocumentDigest(identity, superseded.artifact_ref, superseded.artifact_digest);
    await requireArtifactDocumentDigest(identity, input.artifact.artifact_ref, input.artifact.artifact_digest);
    const now = new Date().toISOString();
    superseded.status = "superseded"; superseded.status_from_revision = manifest.record_revision; superseded.status_by = input.actor_id; superseded.status_at = now;
    manifest.artifacts.push({ ...structuredClone(input.artifact), recorded_from_revision: manifest.record_revision, recorded_by: input.actor_id, recorded_at: now, status_from_revision: null, status_by: null, status_at: null });
  });
}

function familyGovernanceProjection(family) {
  return {
    schema_version: "dotagents.approach-family-status.v1", approach_family_ref: family.approach_family_ref,
    context_policy: structuredClone(family.context_policy), state: family.state,
    block: structuredClone(family.block), reopen: structuredClone(family.reopen),
  };
}

async function requireFamilyActionArtifacts(identity, manifest, decisionArtifactId, basisArtifactIds) {
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const decision = byId.get(decisionArtifactId);
  if (decision === undefined || decision.artifact_kind !== "decision") fail("ARTIFACT_INVALID", "family action decision artifact is invalid");
  await requireArtifactDocumentDigest(identity, decision.artifact_ref, decision.artifact_digest);
  for (const artifactId of basisArtifactIds) {
    const artifact = byId.get(artifactId);
    if (artifact === undefined || !["approach", "gap", "decision"].includes(artifact.artifact_kind)) fail("ARTIFACT_INVALID", "family action basis artifact is invalid");
    await requireArtifactDocumentDigest(identity, artifact.artifact_ref, artifact.artifact_digest);
  }
}

export async function approachFamilyGovernanceRecord(input) {
  validateMutationBase(input, ["approach_family_ref", "context_policy"]);
  identifier(input.approach_family_ref, "input.approach_family_ref"); validateContextPolicy(input.context_policy, "input.context_policy");
  return mutation(input, (_before, next) => {
    const family = next.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref);
    return { operation: "approach-family-record", subjectKind: "approach-family", subjectId: input.approach_family_ref, subjectDigest: family === undefined ? null : familyDeclarationDigest(family), previousState: null, nextState: "open", evidence: [] };
  }, async (manifest) => {
    if (manifest.family_governance.some((entry) => entry.approach_family_ref === input.approach_family_ref)) fail("DUPLICATE_ID", "approach family governance already exists");
    for (const run of manifest.worker_runs.filter((entry) => entry.lineage.approach_family_ref === input.approach_family_ref)) {
      if (canonicalJson(run.lineage.context_policy) !== canonicalJson(input.context_policy)) fail("CONTEXT_POLICY_MISMATCH", "existing worker lineage differs from governed family context policy");
    }
    manifest.family_governance.push({ approach_family_ref: input.approach_family_ref, context_policy: structuredClone(input.context_policy), state: "open", declared_from_revision: manifest.record_revision, declared_by: input.actor_id, declared_at: new Date().toISOString(), block: null, reopen: null });
  });
}

export async function approachFamilyStatus(input) {
  apiInput(input, ["cwd", "control_id", "approach_family_ref"]); identifier(input.control_id, "input.control_id"); identifier(input.approach_family_ref, "input.approach_family_ref");
  const manifest = await status({ cwd: input.cwd, control_id: input.control_id }); const family = manifest.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref);
  if (family === undefined) fail("INVALID_SCHEMA", "approach family governance does not exist");
  return familyGovernanceProjection(family);
}

function validateFamilyActionInput(input) {
  identifier(input.approach_family_ref, "input.approach_family_ref"); identifier(input.decision_artifact_id, "input.decision_artifact_id");
  uniqueStringArray(input.basis_artifact_ids, "input.basis_artifact_ids", (entry, name) => identifier(entry, name), { min: 1 });
}

export async function approachFamilyBlock(input) {
  validateMutationBase(input, ["approach_family_ref", "decision_artifact_id", "basis_artifact_ids"]); validateFamilyActionInput(input);
  return mutation(input, (_before, next) => {
    const family = next.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref);
    return { operation: "approach-family-block", subjectKind: "approach-family", subjectId: input.approach_family_ref, subjectDigest: family === undefined ? null : familyBlockDigest(family), previousState: "open", nextState: "blocked", evidence: [] };
  }, async (manifest, _manifests, identity) => {
    const family = manifest.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref); if (family === undefined) fail("INVALID_SCHEMA", "approach family governance does not exist");
    if (family.state === "reopened") fail("FAMILY_CYCLE_EXHAUSTED", "approach family block/reopen cycle is exhausted");
    if (family.state !== "open") fail("INVALID_TRANSITION", "only open approach family can be blocked");
    await requireFamilyActionArtifacts(identity, manifest, input.decision_artifact_id, input.basis_artifact_ids);
    family.state = "blocked"; family.block = { decision_artifact_id: input.decision_artifact_id, basis_artifact_ids: [...input.basis_artifact_ids], from_revision: manifest.record_revision, by: input.actor_id, at: new Date().toISOString() };
  });
}

export async function approachFamilyReopen(input) {
  validateMutationBase(input, ["approach_family_ref", "decision_artifact_id", "basis_artifact_ids"]); validateFamilyActionInput(input);
  return mutation(input, (_before, next) => {
    const family = next.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref);
    return { operation: "approach-family-reopen", subjectKind: "approach-family", subjectId: input.approach_family_ref, subjectDigest: family === undefined ? null : familyReopenDigest(family), previousState: "blocked", nextState: "reopened", evidence: [] };
  }, async (manifest, _manifests, identity) => {
    const family = manifest.family_governance.find((entry) => entry.approach_family_ref === input.approach_family_ref); if (family === undefined) fail("INVALID_SCHEMA", "approach family governance does not exist");
    if (family.state !== "blocked") fail("INVALID_TRANSITION", "only blocked approach family can be reopened");
    if (!input.basis_artifact_ids.some((artifactId) => !family.block.basis_artifact_ids.includes(artifactId))) fail("REOPEN_BASIS_NOT_NEW", "approach family reopen needs a new basis artifact");
    await requireFamilyActionArtifacts(identity, manifest, input.decision_artifact_id, input.basis_artifact_ids);
    family.state = "reopened"; family.reopen = { decision_artifact_id: input.decision_artifact_id, basis_artifact_ids: [...input.basis_artifact_ids], from_revision: manifest.record_revision, by: input.actor_id, at: new Date().toISOString() };
  });
}

function taskForRun(manifest, run) { const task = manifest.tasks.find((entry) => entry.task_id === run.task_id); if (!task) fail("INVALID_SCHEMA", "worker task missing"); return task; }

function requireTaskNotCancelled(manifest, taskId) {
  if (manifest.task_cancellations.some((entry) => entry.task_id === taskId)) fail("TASK_CANCELLED", "task is cancelled");
}

function requireTaskNotFinalized(manifest, taskId) {
  if (manifest.task_finalizations.some((entry) => entry.task_id === taskId)) fail("TASK_FINALIZED", "task is finalized");
}

function requireDependenciesReady(manifest, task) {
  const finalized = new Set(manifest.task_finalizations.map((entry) => entry.task_id));
  const pending = task.depends_on.filter((dependency) => !finalized.has(dependency));
  if (pending.length) fail("DEPENDENCY_NOT_READY", "task dependencies are not finalized", { pending });
}

function unreleasedCampaignsForTask(manifest, taskId) {
  return manifest.campaigns.filter((campaign) => campaign.gated_task_ids.includes(taskId) && campaign.release === null).map((campaign) => campaign.campaign_id).sort();
}

function requireCampaignsReleased(manifest, taskId) {
  const pending = unreleasedCampaignsForTask(manifest, taskId);
  if (pending.length) fail("CAMPAIGN_NOT_RELEASED", "parent-declared campaign gate is not released", { pending });
}

function conflictList(manifests, candidate, candidateTask) {
  const conflicts = [];
  for (const control of manifests) for (const existing of control.worker_runs) {
    if (!RESERVED_WRITER.has(existing.state) || existing.write_mode === "none" || existing.worker_run_id === candidate.worker_run_id) continue;
    const existingTask = control.tasks.find((task) => task.task_id === existing.task_id); if (!existingTask) fail("INVALID_SCHEMA", "admitted worker task missing");
    const existingWorkspace = effectiveWorkspace(existing); const candidateWorkspace = effectiveWorkspace(candidate);
    const sameWorktree = existingWorkspace !== null && candidateWorkspace !== null && existingWorkspace.worktree_root_realpath === candidateWorkspace.worktree_root_realpath;
    const overlap = existingTask.write_scope.some((a) => candidateTask.write_scope.some((b) => scopesOverlap(a, b)));
    const alternative = !sameWorktree && overlap && existing.write_mode === "isolated-alternative" && candidate.write_mode === "isolated-alternative" && existingTask.alternative_group !== null && existingTask.alternative_group === candidateTask.alternative_group;
    if (sameWorktree || (overlap && !alternative)) conflicts.push({ control_id: control.control_id, worker_run_id: existing.worker_run_id, reason: sameWorktree ? "same-worktree-writer" : "overlapping-write-scope" });
  }
  return conflicts;
}

function validateGlobalManifests(manifests) {
  const uniqueGlobal = (items, key) => {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item[key])) fail("INVALID_SCHEMA", `global duplicate ${key}`);
      seen.add(item[key]);
    }
  };
  uniqueGlobal(manifests.flatMap((control) => control.tasks), "task_id");
  uniqueGlobal(manifests.flatMap((control) => control.registry_observations), "registry_observation_id");
  uniqueGlobal(manifests.flatMap((control) => control.worker_runs), "worker_run_id");
  uniqueGlobal(manifests.flatMap((control) => control.consultations), "consultation_id");
  uniqueGlobal(manifests.flatMap((control) => control.campaigns), "campaign_id");
  uniqueGlobal(manifests.flatMap((control) => control.artifacts), "artifact_id");
  const byControlId = new Map(manifests.map((control) => [control.control_id, control]));
  for (const control of manifests) {
    if (control.continuation.predecessor_control_id === null) continue;
    const predecessor = byControlId.get(control.continuation.predecessor_control_id);
    if (!predecessor || predecessor.status !== "archived" || control.continuation.sequence !== predecessor.continuation.sequence + 1 || control.continuation.root_control_id !== predecessor.continuation.root_control_id || control.declaration.objective_ref !== predecessor.declaration.objective_ref) {
      fail("INVALID_SCHEMA", "control continuation chain is invalid");
    }
  }

  const assignments = new Map();
  for (const control of manifests) {
    for (const run of control.worker_runs) {
      const tuple = `worker\u0000${run.task_id}`;
      const previous = assignments.get(run.assignment_id);
      if (previous !== undefined && previous !== tuple) fail("INVALID_SCHEMA", "assignment immutable tuple changed");
      assignments.set(run.assignment_id, tuple);
    }
    for (const consultation of control.consultations) {
      const tuple = `consultation\u0000${consultation.task_id}`;
      const previous = assignments.get(consultation.assignment_id);
      if (previous !== undefined && previous !== tuple) fail("INVALID_SCHEMA", "assignment immutable tuple changed");
      assignments.set(consultation.assignment_id, tuple);
    }
  }

  const activeWriters = manifests.flatMap((control) => control.worker_runs
    .filter((run) => RESERVED_WRITER.has(run.state) && run.write_mode !== "none")
    .map((run) => ({ control, run, task: control.tasks.find((task) => task.task_id === run.task_id) })));
  for (let leftIndex = 0; leftIndex < activeWriters.length; leftIndex++) {
    const left = activeWriters[leftIndex];
    if (!left.task) fail("INVALID_SCHEMA", "active writer task is missing");
    for (let rightIndex = leftIndex + 1; rightIndex < activeWriters.length; rightIndex++) {
      const right = activeWriters[rightIndex];
      if (!right.task) fail("INVALID_SCHEMA", "active writer task is missing");
      const leftWorkspace = effectiveWorkspace(left.run); const rightWorkspace = effectiveWorkspace(right.run);
      const sameWorktree = leftWorkspace !== null && rightWorkspace !== null && leftWorkspace.worktree_root_realpath === rightWorkspace.worktree_root_realpath;
      const overlap = left.task.write_scope.some((a) => right.task.write_scope.some((b) => scopesOverlap(a, b)));
      const alternative = !sameWorktree && overlap && left.run.write_mode === "isolated-alternative" && right.run.write_mode === "isolated-alternative" && left.task.alternative_group !== null && left.task.alternative_group === right.task.alternative_group;
      if (sameWorktree || (overlap && !alternative)) fail("INVALID_SCHEMA", "active writer manifests conflict");
    }
  }
}

export async function admitWorker(input) {
  validateMutationBase(input, ["worker_run_id"]); identifier(input.worker_run_id, "input.worker_run_id");
  return mutation(input, { operation: "worker-admit", subjectKind: "worker-run", subjectId: input.worker_run_id, previousState: "planned", nextState: "admitted", evidence: [] }, async (manifest, manifests, identity) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    if (run.state !== "planned") fail("INVALID_TRANSITION", "only planned worker can be admitted");
    const task = taskForRun(manifest, run);
    requireTaskNotCancelled(manifest, task.task_id);
    requireDependenciesReady(manifest, task);
    requireCampaignsReleased(manifest, task.task_id);
    requireFamilyEligible(manifest, run.lineage);
    await requireLiveArtifactReferences(identity, manifest, run.lineage, "worker lineage");
    if (task.classification === "H") {
      if (run.operation_digest === null || run.operation_digest !== task.approval.operation_digest) fail("APPROVAL_MISMATCH", "worker operation is outside the H approval scope");
      if (task.approval.expires_at !== null && Date.now() >= Date.parse(task.approval.expires_at)) fail("APPROVAL_EXPIRED", "H approval has expired");
    }
    const workspace = await gitIdentity(run.workspace.worktree_root_realpath ?? run.workspace.git_dir_realpath);
    if (!sameWorkspaceIdentity(run.workspace, workspace)) fail("WORKSPACE_DRIFT", "workspace identity changed");
    requireTaskIsolation(manifest, task, workspace, run.workspace_binding.mode);
    await inspectTaskScopes(workspace, task);
    if (task.effect === "write") {
      const conflicts = conflictList(manifests, run, task); if (conflicts.length) fail("WRITE_CONFLICT", "write reservation conflicts", { conflicts });
      if (run.workspace_binding.mode === "fixed") {
        run.baseline_workspace_fingerprint = await fingerprintWorkspace({ cwd: workspace.worktreeRoot, scope_guard: task.write_scope });
        run.workspace.head_at_reservation = workspace.head;
      }
    }
    run.state = "admitted";
    run.admission = { admitted_by: input.actor_id, admitted_at: new Date().toISOString(), write_reservation: task.effect === "write" };
  });
}

export async function bindWorkerWorkspace(input) {
  validateMutationBase(input, ["worker_run_id", "workspace_cwd", "provider_binding", "binding_evidence"]);
  identifier(input.worker_run_id, "input.worker_run_id"); string(input.workspace_cwd, "input.workspace_cwd", 4096); validateSidecarProviderBinding(input.provider_binding); evidenceArray(input.binding_evidence, "input.binding_evidence", 1);
  let pathInfo;
  try { pathInfo = await lstat(resolve(input.workspace_cwd)); }
  catch (error) { fail("IO_FAILURE", "execution workspace cannot be inspected", { cause: error.code }); }
  if (pathInfo.isSymbolicLink()) fail("STATE_PATH_UNSAFE", "execution workspace path cannot be a symlink");
  const workspace = await gitIdentity(input.workspace_cwd);
  return mutation(input, (before, next) => {
    const run = before.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    const bound = next.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    return { operation: "worker-workspace-bind", subjectKind: "worker-run", subjectId: input.worker_run_id, subjectDigest: sidecarProviderBindingDigest(bound.workspace_binding.provider_binding), previousState: run?.state ?? null, nextState: run?.state ?? "missing", evidence: input.binding_evidence };
  }, async (manifest) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    if (!["dispatched", "running", "unknown"].includes(run.state)) fail("INVALID_TRANSITION", "worker state cannot bind an execution workspace");
    if (run.workspace_binding.mode !== "executor-isolated") fail("INVALID_TRANSITION", "worker does not use executor-isolated workspace binding");
    if (run.workspace_binding.execution_workspace !== null) fail("DUPLICATE_ID", "execution workspace is already bound");
    if (run.executor.adapter_id !== "codex-sidecar" || run.workflow_id !== "work" || run.executor_handle === null || canonicalJson(run.executor_handle) !== canonicalJson(input.provider_binding.executor_handle)) fail("REPORT_CORRELATION_MISMATCH", "provider binding does not match the sidecar Run handle");
    if (workspace.kind !== "worktree" || workspace.commonDir !== manifest.declaration.common_dir_realpath || workspace.worktreeRoot === run.workspace.worktree_root_realpath || workspace.head !== run.workspace_binding.base_sha) fail("WORKSPACE_DRIFT", "execution workspace differs from the reserved sidecar base");
    if (resolve(input.provider_binding.worktree_path) !== workspace.worktreeRoot) fail("REPORT_CORRELATION_MISMATCH", "provider worktree path differs from the bound workspace");
    const task = taskForRun(manifest, run); requireTaskIsolation(manifest, task, workspace); await inspectTaskScopes(workspace, task);
    run.workspace_binding.execution_workspace = workspaceObject(workspace, workspace.head);
    run.workspace_binding.provider_binding = structuredClone(input.provider_binding);
    run.workspace_binding.bound_from_revision = manifest.record_revision;
    run.workspace_binding.binding_evidence = structuredClone(input.binding_evidence);
    run.workspace_binding.bound_by = input.actor_id;
    run.workspace_binding.bound_at = new Date().toISOString();
  });
}

export async function requestWorkerCancel(input) {
  validateMutationBase(input, ["worker_run_id", "decision"]); identifier(input.worker_run_id, "input.worker_run_id"); validateEvidence(input.decision, "input.decision");
  if (input.decision.type !== "decision") fail("INVALID_SCHEMA", "worker cancel request requires decision evidence");
  return mutation(input, (before) => {
    const run = before.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    return { operation: "worker-cancel-request", subjectKind: "worker-run", subjectId: input.worker_run_id, previousState: run?.state ?? null, nextState: run?.state ?? "missing", evidence: [input.decision] };
  }, async (manifest) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    if (!["admitted", "dispatched", "running", "unknown"].includes(run.state)) fail("INVALID_TRANSITION", "worker state cannot accept an external cancel request");
    if (run.cancel_request !== null) fail("DUPLICATE_ID", "worker cancel request already exists");
    if (run.executor_handle === null) fail("INVALID_TRANSITION", "worker cancel request requires an executor handle");
    run.cancel_request = {
      requested_from_revision: manifest.record_revision, decision: structuredClone(input.decision),
      executor_handle: structuredClone(run.executor_handle), requested_by: input.actor_id,
      requested_at: new Date().toISOString(),
    };
  });
}

const workerTransitions = {
  planned: new Set(["admitted", "cancelled"]), admitted: new Set(["dispatched", "cancelled"]), dispatched: new Set(["running", "unknown", "completed", "failed", "cancelled"]), running: new Set(["unknown", "completed", "failed", "cancelled"]), unknown: new Set(["running", "completed", "failed", "cancelled"]), completed: new Set(), failed: new Set(), cancelled: new Set(),
};

function observationCore(observation) { return { source: observation.source, observed_version: observation.observed_version, observed_at: observation.observed_at, raw_state: observation.raw_state }; }

function validateWorkerObservation(value, executor, workflowId) {
  exactOptional(value, ["state", "source", "observed_version", "observed_at", "raw_state"], ["executor_handle", "dispatch_evidence", "dispatch_attempt_evidence", "result", "terminal_evidence"], "observation");
  oneOf(value.state, ["running", "unknown", "completed", "failed", "cancelled", "dispatched"], "observation.state");
  validateObservation(observationCore(value));
  if (own(value, "executor_handle")) validateHandle(value.executor_handle, executor, workflowId, true);
  for (const field of ["dispatch_evidence", "dispatch_attempt_evidence", "terminal_evidence"]) if (own(value, field)) evidenceArray(value[field], `observation.${field}`, 1);
  if (own(value, "result")) validateResult(value.result, false);
}

function handlesEqual(a, b) { return a === null || b === null ? a === b : JSON.stringify(a) === JSON.stringify(b); }

function fingerprintHasStagedChanges(fingerprint) {
  return fingerprint.files.some((entry) => entry.state !== "?" && entry.state[0] !== ".");
}

async function assertTaskSafeHeadAdvance(baseline, completed, { cwd, task }) {
  if (fingerprintHasStagedChanges(baseline) || fingerprintHasStagedChanges(completed)) fail("WORKSPACE_DRIFT", "workspace HEAD advanced with staged changes");
  const ancestor = await runGit(cwd, ["merge-base", "--is-ancestor", baseline.head, completed.head], { allowFailure: true, limit: 128 });
  if (ancestor.code !== 0) fail("WORKSPACE_DRIFT", "workspace HEAD did not advance by fast-forward");
  const index = await runGit(cwd, ["diff", "--cached", "--quiet", completed.head, "--"], { allowFailure: true, limit: 128 });
  if (index.code !== 0) fail("WORKSPACE_DRIFT", "workspace index differs from advanced HEAD");
  const indexFlags = await runGit(cwd, ["ls-files", "-v", "-z"], { limit: GIT_OUTPUT_LIMIT });
  const flagged = decodeUtf8(indexFlags.stdout, "WORKSPACE_DRIFT", "workspace index flags contain invalid UTF-8").split("\0").filter(Boolean);
  if (flagged.some((entry) => entry.length < 3 || entry[0] !== "H" || entry[1] !== " ")) fail("WORKSPACE_DRIFT", "workspace index has special path flags");
  const committed = await runGit(cwd, ["log", "--format=", "--name-only", "-z", "--no-renames", `${baseline.head}..${completed.head}`, "--"], { limit: GIT_OUTPUT_LIMIT });
  const paths = [...new Set(decodeUtf8(committed.stdout, "WORKSPACE_DRIFT", "advanced HEAD paths contain invalid UTF-8").split("\0").filter(Boolean))];
  if (paths.length > ARRAY_LIMIT) fail("WORKSPACE_DRIFT", "advanced HEAD changed too many paths");
  const taskScopes = [...task.read_scope, ...task.write_scope];
  for (const path of paths) {
    try { repoPath(path, "advanced HEAD path"); } catch (error) { if (error instanceof ControlRecordError) fail("WORKSPACE_DRIFT", "advanced HEAD contains unsafe path"); throw error; }
    if (taskScopes.some((scope) => scopesOverlap(scope, { kind: "file", path }))) fail("WORKSPACE_DRIFT", "advanced HEAD changed task scope");
  }
}

async function changedPaths(baseline, completed, context) {
  if (baseline.head !== completed.head) await assertTaskSafeHeadAdvance(baseline, completed, context);
  else if (baseline.index_digest !== completed.index_digest) fail("WORKSPACE_DRIFT", "workspace index changed");
  if (JSON.stringify(baseline.ignored_files) !== JSON.stringify(completed.ignored_files)) fail("WORKSPACE_DRIFT", "ignored output changed");
  const before = new Map(baseline.files.map((entry) => [foldPath(entry.path), entry])); const after = new Map(completed.files.map((entry) => [foldPath(entry.path), entry]));
  const keys = new Set([...before.keys(), ...after.keys()]); const changed = [];
  for (const key of keys) if (JSON.stringify(before.get(key) ?? null) !== JSON.stringify(after.get(key) ?? null)) changed.push((after.get(key) ?? before.get(key)).path);
  return changed;
}

function fingerprintChangedPaths(fingerprint) {
  return [...new Set([...fingerprint.files.map((entry) => entry.path), ...fingerprint.ignored_files.map((entry) => entry.path)])].sort();
}

function inWriteScope(path, task) { return task.write_scope.some((entry) => scopesOverlap(entry, { kind: "file", path })); }

function workerObservationEvidence(observation) {
  if (own(observation, "dispatch_evidence")) return observation.dispatch_evidence;
  if (own(observation, "dispatch_attempt_evidence")) return observation.dispatch_attempt_evidence;
  if (own(observation, "terminal_evidence")) return observation.terminal_evidence;
  if (own(observation, "result")) return observation.result.evidence;
  return [];
}

function packetDigest(value) {
  const payload = structuredClone(value);
  delete payload.packet_digest;
  delete payload.record_revision;
  delete payload.worker.state;
  delete payload.report_template;
  // ADR 0116 Decision 2: the packet embeds the stored task verbatim and report import
  // recomputes this digest from the CURRENT manifest, so a null external_source must be
  // digest-equivalent to key absence — otherwise a v29-dispatched in-flight worker's report
  // becomes permanently unimportable after the v29→v30 migration (and vice versa on rollback).
  if (payload.task?.external_source === null) delete payload.task.external_source;
  if (payload.workspace_binding?.mode === "executor-isolated") {
    payload.workspace_binding.execution_workspace = null;
    payload.workspace_binding.provider_binding = null;
    payload.workspace_binding.bound_from_revision = null;
    payload.workspace_binding.binding_evidence = [];
    payload.workspace_binding.bound_by = null;
    payload.workspace_binding.bound_at = null;
  }
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function workerReportTemplate(packet) {
  return {
    schema_id: WORKER_REPORT_SCHEMA,
    packet_digest: packet.packet_digest,
    required_fields: ["schema_version", "control_id", "task_id", "worker_run_id", "assignment_id", "packet_digest", "executor_handle", "observed_state", "status", "result_digest", "evidence", "validation_results", "changed_paths", "claims"],
    prohibited_fields: ["prompt", "raw_log", "secret", "extra"],
  };
}

function workerReportSkeleton(packet, run) {
  const digestPlaceholder = "REPLACE_WITH_SHA256";
  const timestampPlaceholder = "REPLACE_WITH_TIMESTAMP_YYYY-MM-DDTHH:mm:ss.sssZ";
  return {
    schema_version: WORKER_REPORT_SKELETON_SCHEMA,
    packet_digest: packet.packet_digest,
    report: {
      schema_version: WORKER_REPORT_SCHEMA,
      control_id: packet.control_id,
      task_id: packet.task.task_id,
      worker_run_id: packet.worker.worker_run_id,
      assignment_id: packet.worker.assignment_id,
      packet_digest: packet.packet_digest,
      executor_handle: structuredClone(run.executor_handle),
      observed_state: "completed",
      status: "completed",
      result_digest: digestPlaceholder,
      evidence: [{
        type: "executor-receipt",
        ref: "REPLACE_WITH_EXECUTOR_RECEIPT_REF",
        digest: digestPlaceholder,
        observed_at: timestampPlaceholder,
      }],
      validation_results: packet.validation.map((validationRef) => ({
        validation_ref: validationRef,
        outcome: "passed",
        evidence: { type: "command", ref: validationRef, digest: digestPlaceholder, observed_at: timestampPlaceholder },
      })),
      changed_paths: [],
      claims: [],
    },
    placeholders: {
      result_digest: "64文字のlowercase SHA-256へ置換する",
      evidence_ref: "boundedなexecutor receipt参照へ置換する",
      evidence_digest: "64文字のlowercase SHA-256へ置換する",
      observed_at: "UTCのYYYY-MM-DDTHH:mm:ss.sssZ形式（ミリ秒3桁・末尾Z）へ置換する",
      changed_paths: "実workspaceの変更pathとexact一致するrepo-relative pathだけを入れる",
      claims: "検証可能なbounded claimだけを入れる",
      executor_handle: run.executor_handle === null ? "dispatch後の相関済みhandleへ置換する" : "相関済みhandleを変更しない",
    },
  };
}

function delegationPacket(manifest, task, run, { allowCancelled = false, reportCorrelation = false } = {}) {
  requireOperationalExecutor(run);
  if (!allowCancelled) requireTaskNotCancelled(manifest, task.task_id);
  const allowedStates = reportCorrelation ? ["dispatched", "running", "unknown"] : ["planned", "admitted"];
  if (!allowedStates.includes(run.state)) fail("INVALID_TRANSITION", "worker state cannot receive a delegation packet");
  if (!reportCorrelation && run.write_mode !== "none" && run.state === "planned") fail("INVALID_TRANSITION", "writer must be admitted before generating a delegation packet");
  const packet = {
    schema_version: DELEGATION_PACKET_SCHEMA,
    packet_digest: "",
    control_id: manifest.control_id,
    record_revision: manifest.record_revision,
    task: structuredClone(task),
    worker: {
      worker_run_id: run.worker_run_id, assignment_id: run.assignment_id, state: run.state,
      role_ref: run.role_ref, write_mode: run.write_mode, operation_digest: run.operation_digest,
      fallback: structuredClone(run.fallback),
    },
    executor: structuredClone(run.executor),
    workflow_id: run.workflow_id,
    workspace: structuredClone(run.workspace),
    workspace_binding: structuredClone(run.workspace_binding),
    scope: { read_scope: structuredClone(task.read_scope), write_scope: structuredClone(task.write_scope) },
    classification: task.classification,
    effect: task.effect,
    capabilities: structuredClone(run.workflow_capabilities),
    budget: structuredClone(run.budget_reservation),
    lineage: structuredClone(run.lineage),
    validation: structuredClone(task.validation),
    non_goals: structuredClone(task.non_goals),
    known_traps: structuredClone(task.known_traps),
    report_schema_id: WORKER_REPORT_SCHEMA,
    report_template: null,
  };
  packet.packet_digest = packetDigest(packet);
  packet.report_template = workerReportTemplate(packet);
  return packet;
}

function validateReportValidation(value) {
  boundedArray(value, "worker_report.validation_results", (entry, name) => {
    exact(entry, ["validation_ref", "outcome", "evidence"], name);
    string(entry.validation_ref, `${name}.validation_ref`, 4096); oneOf(entry.outcome, ["passed", "failed", "unknown"], `${name}.outcome`);
    validateEvidence(entry.evidence, `${name}.evidence`);
  });
}

function validateWorkerReport(value, run, task) {
  exact(value, ["schema_version", "control_id", "task_id", "worker_run_id", "assignment_id", "packet_digest", "executor_handle", "observed_state", "status", "result_digest", "evidence", "validation_results", "changed_paths", "claims"], "worker_report");
  if (value.schema_version !== WORKER_REPORT_SCHEMA) fail("INVALID_SCHEMA", "unsupported worker report schema");
  identifier(value.control_id, "worker_report.control_id"); identifier(value.task_id, "worker_report.task_id"); identifier(value.worker_run_id, "worker_report.worker_run_id"); identifier(value.assignment_id, "worker_report.assignment_id");
  if (!SHA256_RE.test(value.packet_digest) || !SHA256_RE.test(value.result_digest)) fail("INVALID_SCHEMA", "worker report digest is invalid");
  validateHandle(value.executor_handle, run.executor, run.workflow_id, !activeHandleRequired(run.executor, run.workflow_id));
  oneOf(value.observed_state, ["completed"], "worker_report.observed_state"); oneOf(value.status, ["completed"], "worker_report.status");
  evidenceArray(value.evidence, "worker_report.evidence", 1); validateReportValidation(value.validation_results);
  const latestEvidenceTime = Date.now() + WORKER_REPORT_FUTURE_SKEW_MS;
  for (const item of [...value.evidence, ...value.validation_results.map((entry) => entry.evidence)]) {
    if (Date.parse(item.observed_at) > latestEvidenceTime) fail("EVIDENCE_FROM_FUTURE", "worker report evidence exceeds the permitted clock skew");
  }
  boundedArray(value.changed_paths, "worker_report.changed_paths", (entry, name) => repoPath(entry, name));
  uniqueStringArray(value.changed_paths, "worker_report.changed_paths", (entry, name) => repoPath(entry, name));
  uniqueStringArray(value.claims, "worker_report.claims", (entry, name) => string(entry, name, 1024));
  const validationRefs = value.validation_results.map((entry) => entry.validation_ref);
  if (validationRefs.length !== task.validation.length || new Set(validationRefs).size !== validationRefs.length || validationRefs.some((entry) => !task.validation.includes(entry))) fail("VALIDATION_INCOMPLETE", "worker report does not cover task validation");
  if (value.validation_results.some((entry) => entry.outcome === "failed")) fail("REPORT_NONZERO", "worker report contains a failed validation");
  if (value.validation_results.some((entry) => entry.outcome === "unknown")) fail("VALIDATION_INCOMPLETE", "worker report has unknown validation result");
}

export async function delegationPacketForWorker(input) {
  exact(input, ["cwd", "control_id", "worker_run_id"], "input"); string(input.cwd, "input.cwd", 4096); identifier(input.control_id, "input.control_id"); identifier(input.worker_run_id, "input.worker_run_id");
  const identity = await gitIdentity(input.cwd); const manifests = await scanManifests(await statePaths(identity)); const manifest = targetManifest(manifests, input.control_id);
  if (manifest.status === "archived") fail("RECORD_ARCHIVED", "control is archived"); requireOperationalManifest(manifest);
  const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
  await requireLiveArtifactReferences(identity, manifest, run.lineage, "worker lineage");
  return delegationPacket(manifest, taskForRun(manifest, run), run);
}

export async function recoverDelegationPacketForWorker(input) {
  exact(input, ["cwd", "control_id", "worker_run_id"], "input"); string(input.cwd, "input.cwd", 4096); identifier(input.control_id, "input.control_id"); identifier(input.worker_run_id, "input.worker_run_id");
  const identity = await gitIdentity(input.cwd); const manifests = await scanManifests(await statePaths(identity)); const manifest = targetManifest(manifests, input.control_id);
  if (manifest.status === "archived") fail("RECORD_ARCHIVED", "control is archived"); requireOperationalManifest(manifest);
  const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
  await requireLiveArtifactReferences(identity, manifest, run.lineage, "worker lineage");
  return delegationPacket(manifest, taskForRun(manifest, run), run, { allowCancelled: true, reportCorrelation: true });
}

export async function workerReportSkeletonForWorker(input) {
  exact(input, ["cwd", "control_id", "worker_run_id"], "input"); string(input.cwd, "input.cwd", 4096); identifier(input.control_id, "input.control_id"); identifier(input.worker_run_id, "input.worker_run_id");
  const identity = await gitIdentity(input.cwd); const manifests = await scanManifests(await statePaths(identity)); const manifest = targetManifest(manifests, input.control_id);
  if (manifest.status === "archived") fail("RECORD_ARCHIVED", "control is archived"); requireOperationalManifest(manifest);
  const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
  await requireLiveArtifactReferences(identity, manifest, run.lineage, "worker lineage");
  if (run.write_mode !== "none" && run.state === "planned") fail("INVALID_TRANSITION", "writer must be admitted before generating a Worker Report skeleton");
  const active = ["dispatched", "running", "unknown"].includes(run.state);
  const packet = delegationPacket(manifest, taskForRun(manifest, run), run, active ? { allowCancelled: true, reportCorrelation: true } : undefined);
  return workerReportSkeleton(packet, run);
}

export function workerReportTemplateForPacket(packet) {
  exact(packet, ["schema_version", "packet_digest", "control_id", "record_revision", "task", "worker", "executor", "workflow_id", "workspace", "workspace_binding", "scope", "classification", "effect", "capabilities", "budget", "lineage", "validation", "non_goals", "known_traps", "report_schema_id", "report_template"], "delegation_packet");
  if (packet.schema_version !== DELEGATION_PACKET_SCHEMA || packet.report_schema_id !== WORKER_REPORT_SCHEMA || packet.packet_digest !== packetDigest(packet)) fail("INVALID_SCHEMA", "delegation packet is invalid");
  return workerReportTemplate(packet);
}

export async function importWorkerReport(input) {
  validateMutationBase(input, ["worker_run_id", "report"]); identifier(input.worker_run_id, "input.worker_run_id");
  return mutation(input, (before) => {
    const run = before.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    return { operation: "worker-report-import", subjectKind: "worker-run", subjectId: input.worker_run_id, previousState: run?.state ?? null, nextState: "completed", evidence: input.report?.evidence ?? [] };
  }, async (manifest) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    const task = taskForRun(manifest, run);
    validateWorkerReport(input.report, run, task);
    if (!workerTransitions[run.state].has("completed") || !["dispatched", "running", "unknown"].includes(run.state)) fail("INVALID_TRANSITION", "only active worker can import a completed report");
    if (input.report.control_id !== manifest.control_id || input.report.task_id !== task.task_id || input.report.worker_run_id !== run.worker_run_id || input.report.assignment_id !== run.assignment_id) fail("REPORT_CORRELATION_MISMATCH", "worker report identity does not match assignment");
    const packet = delegationPacket(manifest, task, run, { allowCancelled: true, reportCorrelation: true });
    if (input.report.packet_digest !== packet.packet_digest) fail("REPORT_CORRELATION_MISMATCH", "worker report packet digest does not match");
    if (!handlesEqual(run.executor_handle, input.report.executor_handle)) fail("REPORT_CORRELATION_MISMATCH", "worker report executor handle does not match");
    if (run.workspace_binding.mode === "executor-isolated" && run.workspace_binding.provider_binding.result_digest !== input.report.result_digest) fail("REPORT_CORRELATION_MISMATCH", "worker report digest differs from the sidecar result");
    let result = { result_digest: input.report.result_digest, evidence: structuredClone(input.report.evidence) };
    if (run.write_mode !== "none") {
      const storedWorkspace = requiredExecutionWorkspace(run); const workspace = await gitIdentity(storedWorkspace.worktree_root_realpath);
      if (!sameWorkspaceIdentity(storedWorkspace, workspace)) fail("WORKSPACE_DRIFT", "workspace identity changed"); await inspectTaskScopes(workspace, task);
      const fingerprint = await fingerprintWorkspace({ cwd: workspace.worktreeRoot, scope_guard: task.write_scope });
      const actualChanged = run.workspace_binding.mode === "executor-isolated"
        ? fingerprintChangedPaths(fingerprint)
        : await changedPaths(run.baseline_workspace_fingerprint, fingerprint, { cwd: workspace.worktreeRoot, task });
      if (run.workspace_binding.mode === "executor-isolated" && fingerprint.head !== run.workspace_binding.base_sha) fail("WORKSPACE_DRIFT", "execution workspace HEAD differs from sidecar base");
      if (actualChanged.some((path) => !inWriteScope(path, task)) || input.report.changed_paths.some((path) => !inWriteScope(path, task)) || JSON.stringify([...actualChanged].sort()) !== JSON.stringify([...input.report.changed_paths].sort())) fail("WORKSPACE_DRIFT", "worker report changed paths do not match workspace scope");
      result.workspace_fingerprint = fingerprint;
    } else if (input.report.changed_paths.length !== 0) fail("WORKSPACE_DRIFT", "read-only worker report cannot claim changed paths");
    run.result = result; run.state = "completed";
    run.executor_observation = { source: run.executor.adapter_id, observed_version: run.execution_verification.observed_version, observed_at: new Date().toISOString(), raw_state: "completed-report-import" };
  });
}

export async function observeWorker(input) {
  validateMutationBase(input, ["worker_run_id", "observation"]); identifier(input.worker_run_id, "input.worker_run_id");
  return mutation(input, (before, next) => {
    const run = before.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    const nextRun = next.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id);
    return {
      operation: "worker-observe", subjectKind: "worker-run", subjectId: input.worker_run_id,
      subjectDigest: input.observation.state === "dispatched" && nextRun !== undefined ? workerDispatchCorrelationDigest(nextRun) : undefined,
      previousState: run?.state ?? null, nextState: input.observation.state, evidence: workerObservationEvidence(input.observation),
    };
  }, async (manifest) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    validateWorkerObservation(input.observation, run.executor, run.workflow_id); const observation = input.observation;
    if (!workerTransitions[run.state].has(observation.state)) fail("INVALID_TRANSITION", "worker transition is invalid");
    if (own(observation, "executor_handle")) {
      if (run.executor_handle !== null && !handlesEqual(run.executor_handle, observation.executor_handle)) fail("INVALID_SCHEMA", "executor handle conflicts");
      if (observation.executor_handle !== null) run.executor_handle = structuredClone(observation.executor_handle);
    }
    if (observation.state === "dispatched") {
      if (!own(observation, "dispatch_evidence") || observation.dispatch_evidence.length === 0 || (activeHandleRequired(run.executor, run.workflow_id) && run.executor_handle === null)) fail("EVIDENCE_REQUIRED", "dispatch evidence and required handle are required");
      if (own(observation, "result") || own(observation, "terminal_evidence") || own(observation, "dispatch_attempt_evidence")) fail("INVALID_SCHEMA", "invalid dispatched evidence fields");
      run.dispatch_evidence.push(...structuredClone(observation.dispatch_evidence));
    } else if (run.state === "admitted" && observation.state === "cancelled" && run.cancel_request === null) {
      if (!own(observation, "dispatch_attempt_evidence")) fail("EVIDENCE_REQUIRED", "dispatch attempt evidence is required");
      if (own(observation, "result") || own(observation, "terminal_evidence") || own(observation, "dispatch_evidence")) fail("INVALID_SCHEMA", "invalid cancelled evidence fields");
      run.dispatch_attempt_evidence.push(...structuredClone(observation.dispatch_attempt_evidence));
    } else if (run.state === "planned" && observation.state === "cancelled") {
      if (["executor_handle", "result", "terminal_evidence", "dispatch_evidence", "dispatch_attempt_evidence"].some((key) => own(observation, key))) fail("INVALID_SCHEMA", "planned cancellation cannot carry execution fields");
    } else if (observation.state === "completed") {
      if (!own(observation, "result")) fail("EVIDENCE_REQUIRED", "completed result evidence is required");
      if (own(observation, "terminal_evidence") || own(observation, "dispatch_evidence") || own(observation, "dispatch_attempt_evidence")) fail("INVALID_SCHEMA", "invalid completed evidence fields");
      const task = taskForRun(manifest, run); let result = structuredClone(observation.result);
      if (run.write_mode !== "none") {
        const storedWorkspace = requiredExecutionWorkspace(run); const workspace = await gitIdentity(storedWorkspace.worktree_root_realpath);
        if (!sameWorkspaceIdentity(storedWorkspace, workspace)) fail("WORKSPACE_DRIFT", "workspace identity changed"); await inspectTaskScopes(workspace, task);
        const fingerprint = await fingerprintWorkspace({ cwd: workspace.worktreeRoot, scope_guard: task.write_scope });
        const actualChanged = run.workspace_binding.mode === "executor-isolated" ? fingerprintChangedPaths(fingerprint) : await changedPaths(run.baseline_workspace_fingerprint, fingerprint, { cwd: workspace.worktreeRoot, task });
        if (run.workspace_binding.mode === "executor-isolated" && fingerprint.head !== run.workspace_binding.base_sha) fail("WORKSPACE_DRIFT", "execution workspace HEAD differs from sidecar base");
        if (actualChanged.some((path) => !inWriteScope(path, task))) fail("WORKSPACE_DRIFT", "workspace changed outside write scope");
        result.workspace_fingerprint = fingerprint;
      }
      run.result = result;
    } else if (["failed", "cancelled"].includes(observation.state) && run.state !== "planned") {
      if (!own(observation, "terminal_evidence")) fail("EVIDENCE_REQUIRED", "terminal evidence is required");
      if (own(observation, "result") || own(observation, "dispatch_evidence") || own(observation, "dispatch_attempt_evidence")) fail("INVALID_SCHEMA", "invalid terminal evidence fields");
      run.terminal_evidence.push(...structuredClone(observation.terminal_evidence));
    } else if (["running", "unknown"].includes(observation.state)) {
      if (["result", "terminal_evidence", "dispatch_evidence", "dispatch_attempt_evidence"].some((key) => own(observation, key))) fail("INVALID_SCHEMA", "nonterminal observation has terminal evidence");
    }
    run.state = observation.state; run.executor_observation = observationCore(observation);
  });
}

// cancelled is reached only through the consultation-cancel mutation (or v26->v27 migration),
// never through observeConsultation — an empty transition set also keeps the state lookup total.
const consultTransitions = { planned: new Set(["dispatched"]), dispatched: new Set(["running", "unknown", "completed", "failed"]), running: new Set(["running", "unknown", "completed", "failed"]), unknown: new Set(["running", "unknown", "completed", "failed"]), completed: new Set(), failed: new Set(), cancelled: new Set() };

export async function observeConsultation(input) {
  validateMutationBase(input, ["consultation_id", "observation"]); identifier(input.consultation_id, "input.consultation_id");
  return mutation(input, (before) => {
    const consultation = before.consultations.find((entry) => entry.consultation_id === input.consultation_id);
    return { operation: "consultation-observe", subjectKind: "consultation", subjectId: input.consultation_id, previousState: consultation?.state ?? null, nextState: input.observation.state, evidence: input.observation.terminal_evidence ?? [] };
  }, async (manifest) => {
    const consultation = manifest.consultations.find((entry) => entry.consultation_id === input.consultation_id); if (!consultation) fail("INVALID_SCHEMA", "consultation does not exist");
    exactOptional(input.observation, ["state", "source", "observed_version", "observed_at", "raw_state"], ["decision_ref", "terminal_evidence", "consultation_handle"], "observation");
    const observation = input.observation; oneOf(observation.state, ["dispatched", "running", "unknown", "completed", "failed"], "observation.state"); validateObservation(observationCore(observation));
    if (observation.source !== consultation.connector) fail("INVALID_SCHEMA", "consultation observation source differs from the recorded connector");
    if (Object.hasOwn(observation, "consultation_handle")) {
      const expectedHandle = typedConsultationSchema(manifest.schema_version) ? consultation.consultation_handle : { slug: consultation.slug };
      if (canonicalJson(observation.consultation_handle) !== canonicalJson(expectedHandle)) fail("INVALID_SCHEMA", "consultation observation handle differs from the recorded consultation handle");
    }
    if (!consultTransitions[consultation.state].has(observation.state)) fail("INVALID_TRANSITION", "consultation transition is invalid");
    if (consultation.state === "planned" && observation.state === "dispatched") {
      const task = manifest.tasks.find((entry) => entry.task_id === consultation.task_id); if (!task) fail("INVALID_SCHEMA", "consultation task is missing");
      requireTaskNotCancelled(manifest, task.task_id);
      if (task.classification === "H") fail("CONSULTATION_OPERATION_CONTRACT_MISSING", "H task consultation requires an operation digest contract");
      requireDependenciesReady(manifest, task);
      requireCampaignsReleased(manifest, task.task_id);
    }
    if (observation.state === "completed") { if (!own(observation, "decision_ref")) fail("EVIDENCE_REQUIRED", "completed consultation requires decision_ref"); repoPath(observation.decision_ref, "observation.decision_ref"); if (own(observation, "terminal_evidence")) fail("INVALID_SCHEMA", "completed consultation cannot have terminal evidence"); consultation.decision_ref = observation.decision_ref; }
    else if (observation.state === "failed") { if (!own(observation, "terminal_evidence")) fail("EVIDENCE_REQUIRED", "failed consultation requires evidence"); evidenceArray(observation.terminal_evidence, "observation.terminal_evidence", 1); if (own(observation, "decision_ref")) fail("INVALID_SCHEMA", "failed consultation cannot have decision_ref"); consultation.terminal_evidence.push(...structuredClone(observation.terminal_evidence)); }
    else if (own(observation, "decision_ref") || own(observation, "terminal_evidence")) fail("INVALID_SCHEMA", "nonterminal consultation has terminal fields");
    consultation.state = observation.state; consultation.executor_observation = observationCore(observation);
  });
}

export async function conflictCheck(input) {
  apiInput(input, ["cwd", "control_id"], ["proposed_worker_run"]); identifier(input.control_id, "input.control_id");
  const identity = await gitIdentity(input.cwd); const paths = await statePaths(identity); const manifests = await scanManifests(paths); const manifest = targetManifest(manifests, input.control_id);
  if (input.proposed_worker_run !== undefined) {
    validateWorker(input.proposed_worker_run, false); requireOperationalExecutor(input.proposed_worker_run); const task = manifest.tasks.find((entry) => entry.task_id === input.proposed_worker_run.task_id); if (!task) fail("INVALID_SCHEMA", "proposed worker task missing");
    const workspace = await gitIdentity(input.proposed_worker_run.workspace_cwd); const candidate = { ...input.proposed_worker_run, workspace: workspaceObject(workspace) }; delete candidate.workspace_cwd;
    return { conflicts: conflictList(manifests, candidate, task) };
  }
  const conflicts = [];
  const admitted = manifests.flatMap((control) => control.worker_runs.filter((run) => RESERVED_WRITER.has(run.state)).map((run) => ({ control, run })));
  for (let index = 0; index < admitted.length; index++) {
    const { control, run } = admitted[index]; const task = control.tasks.find((entry) => entry.task_id === run.task_id);
    conflicts.push(...conflictList(manifests.slice(index + 1), run, task));
  }
  return { conflicts };
}

async function decide(input, decision) {
  validateMutationBase(input, ["worker_run_id", "result_digest", "verification_evidence", "decision_note", "decided_by"]);
  identifier(input.worker_run_id, "input.worker_run_id"); if (!SHA256_RE.test(input.result_digest)) fail("INVALID_SCHEMA", "result_digest is invalid"); evidenceArray(input.verification_evidence, "input.verification_evidence", 1); string(input.decision_note, "input.decision_note", 4096); string(input.decided_by, "input.decided_by");
  return mutation(input, { operation: decision === "accepted" ? "worker-accept" : "worker-reject", subjectKind: "worker-run", subjectId: input.worker_run_id, previousState: "acceptance-pending", nextState: decision, evidence: input.verification_evidence }, async (manifest) => {
    const run = manifest.worker_runs.find((entry) => entry.worker_run_id === input.worker_run_id); if (!run) fail("INVALID_SCHEMA", "worker run does not exist");
    if (run.state !== "completed" || run.result === null || run.acceptance !== null) fail("INVALID_TRANSITION", "worker cannot be accepted or rejected");
    if (run.result.result_digest !== input.result_digest) fail("INVALID_SCHEMA", "result digest differs from observation");
    if (decision === "accepted" && run.write_mode !== "none") {
      const storedWorkspace = requiredExecutionWorkspace(run); const workspace = await gitIdentity(storedWorkspace.worktree_root_realpath); if (!sameWorkspaceIdentity(storedWorkspace, workspace)) fail("WORKSPACE_DRIFT", "workspace identity changed");
      const task = taskForRun(manifest, run); await inspectTaskScopes(workspace, task); const fingerprint = await fingerprintWorkspace({ cwd: workspace.worktreeRoot, scope_guard: task.write_scope });
      if (JSON.stringify(fingerprint) !== JSON.stringify(run.result.workspace_fingerprint)) fail("WORKSPACE_DRIFT", "workspace changed after completion");
    }
    run.acceptance = { decision, accepted_from_revision: manifest.record_revision, result_digest: input.result_digest, executor_handle: structuredClone(run.executor_handle), verification_evidence: structuredClone(input.verification_evidence), decision_note: input.decision_note, decided_by: input.decided_by, decided_at: new Date().toISOString() };
  });
}

export const accept = (input) => decide(input, "accepted");
export const reject = (input) => decide(input, "rejected");

function taskReadyForFinalization(manifest, taskId) {
  const workerReady = manifest.worker_runs.filter((run) => run.task_id === taskId)
    .every((run) => !WORKER_NONTERMINAL.has(run.state) && (run.state !== "completed" || run.acceptance !== null));
  const consultationReady = manifest.consultations.filter((entry) => entry.task_id === taskId)
    .every((entry) => !CONSULT_NONTERMINAL.has(entry.state) && (entry.state !== "completed" || entry.decision_ref !== null));
  return workerReady && consultationReady;
}

async function documentEvidence(identity, ref, type, observedAt) {
  let digest;
  try { digest = await artifactDocumentDigest(identity, ref); }
  catch (error) {
    if (error instanceof ControlRecordError && error.code === "ARTIFACT_UNAVAILABLE") fail("EVIDENCE_UNAVAILABLE", "finalization evidence document is unavailable", { ref });
    throw error;
  }
  return { type, ref, digest, observed_at: observedAt };
}

async function verifyEvidenceDocuments(identity, evidence) {
  for (const descriptor of evidence.filter((entry) => ["file", "decision"].includes(entry.type))) {
    const observed = await documentEvidence(identity, descriptor.ref, descriptor.type, descriptor.observed_at);
    if (observed.digest !== descriptor.digest) fail("EVIDENCE_DIGEST_MISMATCH", "finalization evidence digest differs from document", { ref: descriptor.ref });
  }
}

async function verifyFinalizationRetention(manifest, identity) {
  const receipts = manifest.transition_receipts.filter((receipt) => ["task-finalize", "control-finalize"].includes(receipt.operation));
  if (identity.kind === "bare") {
    for (const receipt of receipts) await verifyEvidenceDocuments(identity, receipt.evidence);
    return;
  }
  const budget = { remaining: FILES_LIMIT };
  for (const descriptor of receipts.flatMap((receipt) => receipt.evidence).filter((entry) => ["file", "decision"].includes(entry.type))) {
    const observed = await hashRegularFile(identity.projectRoot, descriptor.ref, budget);
    if (observed === descriptor.digest) continue;
    const retainedInHistory = descriptor.type === "decision"
      ? await gitHistoryContainsEvidence(identity, descriptor.ref, descriptor.digest, budget)
      : false;
    if (retainedInHistory) continue;
    if (observed === null) fail("EVIDENCE_UNAVAILABLE", "finalization evidence document is unavailable", { ref: descriptor.ref });
    fail("EVIDENCE_DIGEST_MISMATCH", "finalization evidence digest differs from document", { ref: descriptor.ref });
  }
}

export async function taskFinalizeRecord(input) {
  validateMutationBase(input, ["task_id", "finalization_ref", "recorded_by"]); identifier(input.task_id, "input.task_id"); immutableDecisionRef(input.finalization_ref, "input.finalization_ref"); string(input.recorded_by, "input.recorded_by");
  if (input.recorded_by !== input.actor_id) fail("INVALID_SCHEMA", "task finalization recorder must be the mutation actor");
  let finalizationEvidence = null;
  return mutation(input, (_before, next) => {
    const finalization = next.task_finalizations.find((entry) => entry.task_id === input.task_id);
    return { operation: "task-finalize", subjectKind: "task-finalization", subjectId: input.task_id, subjectDigest: taskFinalizationDigest(finalization), previousState: "unfinalized", nextState: "finalized", evidence: [finalizationEvidence] };
  }, async (manifest, _manifests, identity) => {
    if (!manifest.tasks.some((task) => task.task_id === input.task_id)) fail("INVALID_SCHEMA", "task does not exist");
    if (manifest.task_finalizations.some((entry) => entry.task_id === input.task_id)) fail("DUPLICATE_ID", "task finalization already exists");
    if (manifest.task_cancellations.some((entry) => entry.task_id === input.task_id)) fail("INVALID_TRANSITION", "cancelled task cannot be finalized");
    if (!taskReadyForFinalization(manifest, input.task_id)) fail("FINALIZATION_NOT_READY", "task has active or undecided child execution");
    const recordedAt = new Date().toISOString();
    finalizationEvidence = await documentEvidence(identity, input.finalization_ref, "decision", recordedAt);
    manifest.task_finalizations.push({ task_id: input.task_id, finalization_ref: input.finalization_ref, recorded_by: input.recorded_by, recorded_at: recordedAt });
  });
}

function assertControlReadyForFinalization(manifest, code) {
  const workerReady = manifest.worker_runs.every((run) => !WORKER_NONTERMINAL.has(run.state) && (run.state !== "completed" || run.acceptance !== null));
  const consultationReady = manifest.consultations.every((entry) => orphanedPlannedConsultation(manifest, entry)
    || (!CONSULT_NONTERMINAL.has(entry.state) && (entry.state !== "completed" || entry.decision_ref !== null)));
  const closedTasks = closedTaskIds(manifest);
  const tasksClosed = manifest.tasks.every((task) => closedTasks.has(task.task_id));
  const campaignsReleased = manifest.campaigns.every((campaign) => campaign.release !== null);
  if (!workerReady || !consultationReady || !tasksClosed || !campaignsReleased || !phaseGateComplete(manifest)) fail(code, "control is not ready for finalization");
}

export async function finalizeControl(input) {
  validateMutationBase(input, ["acceptance_matrix_ref", "final_audit_evidence", "regression_evidence", "knowledge_return_refs", "parent_decision", "finalized_by"]);
  repoPath(input.acceptance_matrix_ref, "input.acceptance_matrix_ref");
  evidenceArray(input.final_audit_evidence, "input.final_audit_evidence", 1);
  evidenceArray(input.regression_evidence, "input.regression_evidence", 1);
  refs(input.knowledge_return_refs, "input.knowledge_return_refs", 1);
  validateEvidence(input.parent_decision, "input.parent_decision");
  if (input.parent_decision.type !== "decision") fail("INVALID_SCHEMA", "parent_decision must be decision evidence");
  immutableDecisionRef(input.parent_decision.ref, "input.parent_decision.ref");
  string(input.finalized_by, "input.finalized_by");
  if (input.finalized_by !== input.actor_id) fail("INVALID_SCHEMA", "control finalizer must be the mutation actor");
  if (1 + input.final_audit_evidence.length + input.regression_evidence.length + input.knowledge_return_refs.length + 1 > ARRAY_LIMIT) fail("LIMIT_EXCEEDED", "control finalization receipt evidence exceeds limit");
  let receiptEvidence = null;
  return mutation(input, (_before, next) => ({
    operation: "control-finalize", subjectKind: "control", subjectId: input.control_id,
    subjectDigest: controlFinalizationDigest(next.control_finalization), previousState: "active", nextState: "finalized", evidence: receiptEvidence,
  }), async (manifest, _manifests, identity) => {
    if (manifest.control_finalization !== null) fail("DUPLICATE_ID", "control finalization already exists");
    assertControlReadyForFinalization(manifest, "FINALIZATION_NOT_READY");
    if ([...input.final_audit_evidence, ...input.regression_evidence].some((entry) => !["file", "decision"].includes(entry.type))) fail("EVIDENCE_REQUIRED", "final audit and regression require retained document evidence");
    await verifyEvidenceDocuments(identity, [...input.final_audit_evidence, ...input.regression_evidence, input.parent_decision]);
    const finalizedAt = new Date().toISOString();
    const matrixEvidence = await documentEvidence(identity, input.acceptance_matrix_ref, "file", finalizedAt);
    const knowledgeEvidence = [];
    for (const ref of input.knowledge_return_refs) knowledgeEvidence.push(await documentEvidence(identity, ref, "file", finalizedAt));
    receiptEvidence = [matrixEvidence, ...structuredClone(input.final_audit_evidence), ...structuredClone(input.regression_evidence), ...knowledgeEvidence, structuredClone(input.parent_decision)];
    manifest.control_finalization = {
      objective_ref: manifest.declaration.objective_ref,
      acceptance_matrix_ref: input.acceptance_matrix_ref,
      final_audit_evidence: structuredClone(input.final_audit_evidence),
      regression_evidence: structuredClone(input.regression_evidence),
      knowledge_return_refs: [...input.knowledge_return_refs],
      parent_decision: structuredClone(input.parent_decision),
      finalized_from_revision: manifest.record_revision,
      finalized_by: input.finalized_by,
      finalized_at: finalizedAt,
    };
  });
}

export async function archive(input) {
  validateMutationBase(input, []);
  return mutation(input, { operation: "control-archive", subjectKind: "control", subjectId: input.control_id, previousState: "finalized", nextState: "archived", evidence: [] }, async (manifest, _manifests, identity) => {
    if (manifest.control_finalization === null) fail("ARCHIVE_NOT_READY", "control-level finalization is required before archive");
    assertControlReadyForFinalization(manifest, "ARCHIVE_NOT_READY");
    await verifyFinalizationRetention(manifest, identity);
    manifest.status = "archived";
  });
}

function pidState(pid) {
  try { process.kill(pid, 0); return "live"; } catch (error) { if (error.code === "EPERM") return "live"; if (error.code === "ESRCH") return "dead"; fail("IO_FAILURE", "PID liveness is unknown", { cause: error.code }); }
}

export async function quotaPoolLockAcquire(input) {
  apiInput(input, ["cwd", "quota_pool_id"]);
  identifier(input.quota_pool_id, "input.quota_pool_id");
  const identity = await gitIdentity(input.cwd);
  const dir = await quotaPoolLockDir(identity, input.quota_pool_id, { create: true });
  const lock = await acquireLock(dir);
  return { quota_pool_id: input.quota_pool_id, token: lock.token, acquired_at: lock.owner.acquired_at };
}

export async function quotaPoolLockRelease(input) {
  apiInput(input, ["cwd", "quota_pool_id", "token"]);
  identifier(input.quota_pool_id, "input.quota_pool_id");
  if (typeof input.token !== "string" || !UUID_RE.test(input.token)) fail("INVALID_INPUT", "token must be a canonical UUID");
  const identity = await gitIdentity(input.cwd);
  const observed = await readQuotaPoolLockOwner(identity, input.quota_pool_id, input.token, "LOCK_NOT_FOUND");
  await safeUnlinkOwner(observed.path, observed.owner, observed.stat);
  return { released: true, quota_pool_id: input.quota_pool_id, token: input.token };
}

export async function recoverLock(input) {
  apiInput(input, ["cwd", "expected_token"]); if (typeof input.expected_token !== "string" || !UUID_RE.test(input.expected_token)) fail("INVALID_INPUT", "expected_token must be a canonical UUID");
  const identity = await gitIdentity(input.cwd); const paths = await statePaths(identity); const path = join(paths.owners, `${input.expected_token}.owner`);
  let observed; try { observed = await readOwner(path); } catch (error) { if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") fail("LOCK_NOT_FOUND", "lock owner does not exist"); throw error; }
  if (observed.owner.token !== input.expected_token) fail("LOCK_TOKEN_MISMATCH", "lock token differs from owner body");
  if (pidState(observed.owner.pid) === "live") fail("LOCK_LIVE", "lock owner process is live");
  await safeUnlinkOwner(path, observed.owner, observed.stat); return { recovered: true, token: input.expected_token };
}

function parseStatus(buffer) {
  const records = decodeUtf8(buffer, "STATE_PATH_UNSAFE", "git status contains invalid UTF-8").split("\0"); const files = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]; if (!record) continue;
    const kind = record[0]; let path; let state;
    if (kind === "?") { state = "?"; path = record.slice(2); }
    else if (kind === "1") { const parts = record.split(" "); if (parts.length < 9) fail("GIT_FAILURE", "malformed git status"); state = parts[1]; path = parts.slice(8).join(" "); }
    else if (kind === "2") { const parts = record.split(" "); if (parts.length < 10) fail("GIT_FAILURE", "malformed git status"); state = parts[1]; path = parts.slice(9).join(" "); index += 1; }
    else if (kind === "u") { const parts = record.split(" "); if (parts.length < 11) fail("GIT_FAILURE", "malformed git status"); state = parts[1]; path = parts.slice(10).join(" "); }
    else if (kind === "!") continue;
    else fail("GIT_FAILURE", "unknown git status record");
    try { repoPath(path, "status path"); } catch (error) { if (error instanceof ControlRecordError) fail("STATE_PATH_UNSAFE", "git status contains unsafe path"); throw error; }
    files.push({ path, state });
  }
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)) || a.state.localeCompare(b.state)); return files;
}

async function hashRegularFile(root, path, budget) {
  const full = join(root, ...path.split("/")); const rel = relative(root, full);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("STATE_PATH_UNSAFE", "file escapes worktree");
  await inspectScopePath(root, { kind: "file", path });
  let handle;
  try {
    handle = await open(full, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)); const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail("STATE_PATH_UNSAFE", "changed path is not a regular single-link file");
    if (before.size > budget.remaining) fail("LIMIT_EXCEEDED", "changed file content exceeds 64 MiB");
    budget.remaining -= before.size; const hash = createHash("sha256"); let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { total += chunk.length; if (total > before.size || total > FILES_LIMIT) fail("WORKSPACE_DRIFT", "file grew while hashing"); hash.update(chunk); }
    const after = await handle.stat(); const pathInfo = await lstat(full);
    if (total !== before.size || !after.isFile() || after.nlink !== 1 || pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || after.dev !== pathInfo.dev || after.ino !== pathInfo.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("WORKSPACE_DRIFT", "file changed while hashing");
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") fail("STATE_PATH_UNSAFE", "symlink is forbidden");
    fail("IO_FAILURE", "changed file hashing failed", { cause: error.code });
  } finally { await handle?.close().catch(() => {}); }
}

async function artifactDocumentDigest(identity, artifactRef) {
  const budget = { remaining: FILES_LIMIT };
  if (identity.kind === "bare") {
    const headResult = await runGit(identity.cwd, ["rev-parse", "--verify", "HEAD"], { allowFailure: true, limit: 128 });
    const head = headResult.code === 0 ? headResult.stdout.toString().trim() : null;
    if (head === null || !/^[0-9a-f]{40,64}$/.test(head)) fail("ARTIFACT_UNAVAILABLE", "artifact document is unavailable");
    const tree = await runGit(identity.cwd, ["ls-tree", "-z", head, "--", artifactRef], { allowFailure: true, limit: 4096 });
    if (tree.code !== 0) fail("ARTIFACT_UNAVAILABLE", "artifact document is unavailable");
    const entries = decodeUtf8(tree.stdout, "STATE_PATH_UNSAFE", "artifact tree entry contains invalid UTF-8").split("\0").filter(Boolean);
    if (entries.length !== 1) fail("ARTIFACT_UNAVAILABLE", "artifact document is unavailable");
    const separator = entries[0].indexOf("\t");
    const metadata = separator < 0 ? [] : entries[0].slice(0, separator).split(" ");
    const path = separator < 0 ? "" : entries[0].slice(separator + 1);
    if (path !== artifactRef || metadata.length !== 3 || !["100644", "100755"].includes(metadata[0]) || metadata[1] !== "blob" || !/^[0-9a-f]+$/.test(metadata[2])) fail("STATE_PATH_UNSAFE", "bare artifact is not a regular file");
    const shown = await runGit(identity.cwd, ["show", `${head}:${artifactRef}`], { allowFailure: true, limit: FILES_LIMIT });
    if (shown.code !== 0) fail("ARTIFACT_UNAVAILABLE", "artifact document is unavailable");
    return createHash("sha256").update(shown.stdout).digest("hex");
  }
  const observed = await hashRegularFile(identity.worktreeRoot, artifactRef, budget);
  if (observed === null) fail("ARTIFACT_UNAVAILABLE", "artifact document is unavailable");
  return observed;
}

async function requireLiveArtifactReferences(identity, manifest, lineage, name) {
  for (const artifactId of lineage.shared_artifact_ids) {
    const artifact = manifest.artifacts.find((entry) => entry.artifact_id === artifactId);
    if (artifact === undefined || artifact.artifact_kind !== "finding") fail("INVALID_SCHEMA", `${name} references invalid finding artifact`);
    await requireArtifactDocumentDigest(identity, artifact.artifact_ref, artifact.artifact_digest);
  }
}

async function requireArtifactDocumentDigest(identity, artifactRef, expectedDigest) {
  const observed = await artifactDocumentDigest(identity, artifactRef);
  if (observed !== expectedDigest) fail("ARTIFACT_DIGEST_MISMATCH", "artifact document digest differs from record");
}

async function fingerprintPass(identity, scopeGuard) {
  if (identity.kind !== "worktree") fail("INVALID_INPUT", "fingerprint requires a worktree");
  const refreshed = await gitIdentity(identity.worktreeRoot); if (!sameWorkspaceIdentity(workspaceObject(identity), refreshed)) fail("WORKSPACE_DRIFT", "workspace identity changed");
  const indexPathRaw = (await runGit(identity.worktreeRoot, ["rev-parse", "--git-path", "index"])).stdout.toString().trim();
  const indexPath = isAbsolute(indexPathRaw) ? indexPathRaw : resolve(identity.worktreeRoot, indexPathRaw);
  let indexBuffer;
  try { indexBuffer = (await safeBoundedFile(indexPath, GIT_OUTPUT_LIMIT)).buffer; } catch (error) { if (error instanceof ControlRecordError && error.code === "IO_FAILURE" && error.details?.cause === "ENOENT") indexBuffer = Buffer.alloc(0); else throw error; }
  const statusBuffer = (await runGit(identity.worktreeRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"], { limit: GIT_OUTPUT_LIMIT })).stdout;
  const statusFiles = parseStatus(statusBuffer); const budget = { remaining: FILES_LIMIT }; const files = [];
  for (const entry of statusFiles) {
    const full = join(identity.worktreeRoot, ...entry.path.split("/")); let info;
    try { info = await lstat(full); } catch (error) { if (error.code !== "ENOENT") fail("IO_FAILURE", "changed path inspection failed", { cause: error.code }); }
    let digest = null;
    if (info) {
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail("STATE_PATH_UNSAFE", "changed path is not a regular single-link file");
      digest = await hashRegularFile(identity.worktreeRoot, entry.path, budget);
    }
    files.push({ path: entry.path, state: entry.state, file_mode: info ? info.mode : null, content_digest: digest });
  }
  const ignoredFiles = [];
  if (scopeGuard.length > 0) {
    const ignoredBuffer = (await runGit(identity.worktreeRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...scopeGuard.map((entry) => entry.path)], { limit: GIT_OUTPUT_LIMIT })).stdout;
    const ignoredPaths = decodeUtf8(ignoredBuffer, "STATE_PATH_UNSAFE", "ignored paths contain invalid UTF-8").split("\0").filter(Boolean);
    if (ignoredPaths.length > ARRAY_LIMIT) fail("LIMIT_EXCEEDED", "too many ignored files in write scope");
    ignoredPaths.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    for (const path of ignoredPaths) {
      repoPath(path, "ignored path");
      const contentDigest = await hashRegularFile(identity.worktreeRoot, path, budget);
      if (contentDigest === null) fail("WORKSPACE_DRIFT", "ignored file disappeared during fingerprint");
      ignoredFiles.push({ path, content_digest: contentDigest });
    }
  }
  const value = { head: refreshed.head, index_digest: createHash("sha256").update(indexBuffer).digest("hex"), status_digest: createHash("sha256").update(statusBuffer).digest("hex"), files, ignored_files: ignoredFiles };
  return { digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"), ...value };
}

export async function fingerprintWorkspace(input) {
  apiInput(input, ["cwd"], ["scope_guard"]); const scopeGuard = input.scope_guard ?? []; validateScopeArray(scopeGuard, "input.scope_guard");
  const identity = await gitIdentity(input.cwd); const first = await fingerprintPass(identity, scopeGuard); const second = await fingerprintPass(identity, scopeGuard);
  if (JSON.stringify(first) !== JSON.stringify(second)) fail("WORKSPACE_DRIFT", "workspace changed during fingerprint"); return first;
}
