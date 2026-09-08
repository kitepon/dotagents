import { createHash } from "node:crypto";

export const ADAPTER_SCHEMA = "dotagents.executor-adapter.v1";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_INTERFACES = 32;
const MAX_OPERATIONS = 64;
const MAX_CHANGED_FILES = 256;
const SIDECAR_REQUEST_SCHEMA = "dotagents.codex-sidecar.request.v1";
const SIDECAR_OBSERVATION_SCHEMA = "dotagents.codex-sidecar.observation.v1";
const CODEX_NATIVE_REQUEST_SCHEMA = "dotagents.codex-native.request.v1";
const CODEX_NATIVE_OBSERVATION_SCHEMA = "dotagents.codex-native.observation.v1";
const SIDECAR_OUTPUT_LIMIT = 64 * 1024;
const CODEX_NATIVE_OUTPUT_LIMIT = 64 * 1024;
const CODEX_NATIVE_STATUSES = new Set(["created", "running", "completed", "failed", "unknown", "interrupted"]);
const HANDSHAKE_ONLY_MESSAGE = "Routing smoke only. Do not perform work. Report your agent path, role recognition, and readiness to wait.";
const AITERM_OBSERVATION_SCHEMA = "dotagents.aiterm.observation.v1";
const AITERM_AGENT_KINDS = new Set(["codex", "grok", "composer"]);
const AITERM_STATUSES = new Set(["running", "completed", "failed", "unknown", "interrupted"]);
const AITERM_OUTPUT_LIMIT = 64 * 1024;
const CLAUDE_NATIVE_REQUEST_SCHEMA = "dotagents.claude-native.request.v1";
const CLAUDE_NATIVE_OBSERVATION_SCHEMA = "dotagents.claude-native.observation.v1";
const CLAUDE_NATIVE_CONSULT_REQUEST_SCHEMA = "dotagents.claude-native.consult-request.v1";
const CLAUDE_NATIVE_CONSULT_OBSERVATION_SCHEMA = "dotagents.claude-native.consult-observation.v1";
const SIDECAR_CONSULT_REQUEST_SCHEMA = "dotagents.codex-sidecar.consult-request.v1";
const SIDECAR_CONSULT_OBSERVATION_SCHEMA = "dotagents.codex-sidecar.consult-observation.v1";
const SIDECAR_CONSULT_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CLAUDE_NATIVE_STATUSES = new Set(["running", "unknown", "completed", "failed"]);
const CLAUDE_NATIVE_BUILTIN_TOOLS = new Set(["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit"]);
const CLAUDE_NATIVE_OUTPUT_LIMIT = 64 * 1024;
const GPT_CONNECTOR_REQUEST_SCHEMA = "dotagents.gpt-connector.request.v1";
const GPT_CONNECTOR_OBSERVATION_SCHEMA = "dotagents.gpt-connector.observation.v1";
const GPT_CONNECTOR_JOB_STATES = new Set(["queued", "uploading", "submitted", "running", "succeeded", "failed"]);
const GPT_CONNECTOR_OUTPUT_LIMIT = 64 * 1024;
const CLAUDE_INTERNAL_OBSERVATION_SCHEMA = "dotagents.claude-internal.observation.v1";
const CLAUDE_APPENDIX_REFERENCE = "claude/skills/orchestrate/SKILL.md";
const ADAPTER_FAILURE_SCHEMA = "dotagents.executor-adapter.failure.v1";
const FAILURE_FAMILIES = Object.freeze(["credential-missing", "rate-limited", "timeout", "non-zero-exit", "malformed-report", "workspace-missing", "unsupported-capability"]);
const ADAPTER_LANES = Object.freeze(["worker", "consultation", "host-projection"]);
// Keyed by adapter_id x lane (ADR 0045): the same adapter can carry a durable worker
// contract and a consultation contract with different timeout recovery semantics.
const ADAPTER_FAILURE_SUPPORT = Object.freeze({
  "codex-sidecar": Object.freeze({
    worker: Object.freeze({
      "credential-missing": ["mapped", "SidecarError:RUN_AUTH_UNCERTAIN"], "rate-limited": ["unknown", "no public typed code"],
      timeout: ["mapped", "SidecarError:RUN_READY_TIMEOUT|APP_SERVER_TIMEOUT"], "non-zero-exit": ["unknown", "no public typed code"],
      "malformed-report": ["mapped", "SidecarError:RUN_STORE_CORRUPT|PROTOCOL_ERROR"], "workspace-missing": ["unknown", "WORKTREE_ERROR is not specific enough"],
      "unsupported-capability": ["mapped", "SidecarError:RUN_UNSUPPORTED_PLATFORM|APP_SERVER_UNIMPLEMENTED"], timeout_recovery_operation: "result",
    }),
    consultation: Object.freeze({
      "credential-missing": ["unknown", "synchronous consult returns untyped MCP errors"], "rate-limited": ["unknown", "synchronous consult returns untyped MCP errors"],
      timeout: ["caller-event", "synchronous consult has no requery entry; the caller terminates from its own observation"], "non-zero-exit": ["not-applicable", "consultation has no process exit contract"],
      "malformed-report": ["caller-event", "strict consult observation validation"], "workspace-missing": ["caller-event", "pre-dispatch absolute projectRoot validation"],
      "unsupported-capability": ["unknown", "synchronous consult returns untyped MCP errors"], timeout_recovery_operation: null,
    }),
  }),
  "codex-native": Object.freeze({
    worker: Object.freeze({
      "credential-missing": ["unknown", "host tool has no typed provider code"], "rate-limited": ["unknown", "host tool has no typed provider code"],
      timeout: ["caller-event", "parent host timeout"], "non-zero-exit": ["not-applicable", "native agent has no process exit contract"],
      "malformed-report": ["caller-event", "strict Worker Report import"], "workspace-missing": ["unknown", "host tool has no typed provider code"],
      "unsupported-capability": ["caller-event", "routing and packet validation"], timeout_recovery_operation: null,
    }),
  }),
  aiterm: Object.freeze({
    worker: Object.freeze({
      "credential-missing": ["unknown", "MCP returns untyped error text"], "rate-limited": ["unknown", "MCP returns untyped error text"],
      timeout: ["caller-event", "MCP wait timeout followed by pty_read"], "non-zero-exit": ["unknown", "MCP returns untyped error text"],
      "malformed-report": ["caller-event", "strict Worker Report import"], "workspace-missing": ["unknown", "MCP returns untyped error text"],
      "unsupported-capability": ["unknown", "MCP returns untyped error text"], timeout_recovery_operation: "pty_read",
    }),
  }),
  "claude-native": Object.freeze({
    worker: Object.freeze({
      "credential-missing": ["unknown", "headless CLI has no stable typed credential code"], "rate-limited": ["unknown", "stream event mapping is not yet versioned"],
      timeout: ["caller-event", "caller timeout preserves the same session id"], "non-zero-exit": ["caller-event", "process terminal receipt"],
      "malformed-report": ["caller-event", "strict Worker Report import"], "workspace-missing": ["caller-event", "pre-dispatch absolute workspace validation"],
      "unsupported-capability": ["caller-event", "explicit tool and permission policy validation"], timeout_recovery_operation: null,
    }),
    consultation: Object.freeze({
      "credential-missing": ["unknown", "headless CLI has no stable typed credential code"], "rate-limited": ["unknown", "stream event mapping is not yet versioned"],
      timeout: ["caller-event", "caller timeout preserves the same session id"], "non-zero-exit": ["caller-event", "process terminal receipt"],
      "malformed-report": ["caller-event", "strict consultation observation validation"], "workspace-missing": ["not-applicable", "consultation record has no workspace field"],
      "unsupported-capability": ["caller-event", "consultation tool policy disables all tools"], timeout_recovery_operation: null,
    }),
  }),
  "gpt-connector": Object.freeze({
    consultation: Object.freeze({
      "credential-missing": ["mapped", "ConsultFailure:AUTH_REQUIRED"], "rate-limited": ["unknown", "no ConsultFailure rate-limit code"],
      timeout: ["mapped", "ConsultFailure:UPLOAD_TIMEOUT plus caller sessions recovery"], "non-zero-exit": ["not-applicable", "consultation job has no process exit contract"],
      "malformed-report": ["caller-event", "strict ConsultSnapshot validation"], "workspace-missing": ["not-applicable", "consultation adapter forbids file dispatch"],
      "unsupported-capability": ["mapped", "ConsultFailure capability codes"], timeout_recovery_operation: "sessions",
    }),
  }),
  "claude-internal": Object.freeze({
    "host-projection": Object.freeze({
      "credential-missing": ["not-applicable", "projection-only lane"], "rate-limited": ["not-applicable", "projection-only lane"],
      timeout: ["not-applicable", "projection-only lane"], "non-zero-exit": ["not-applicable", "projection-only lane"],
      "malformed-report": ["not-applicable", "projection-only lane"], "workspace-missing": ["not-applicable", "projection-only lane"],
      "unsupported-capability": ["caller-event", "appendix projection cannot dispatch"], timeout_recovery_operation: null,
    }),
  }),
});
const PROVIDER_FAILURE_CODES = Object.freeze({
  "codex-sidecar": Object.freeze({
    worker: Object.freeze({
      RUN_AUTH_UNCERTAIN: ["credential-missing", "unknown"], RUN_READY_TIMEOUT: ["timeout", "unknown"], APP_SERVER_TIMEOUT: ["timeout", "unknown"],
      RUN_STORE_CORRUPT: ["malformed-report", "unknown"], PROTOCOL_ERROR: ["malformed-report", "unknown"],
      RUN_UNSUPPORTED_PLATFORM: ["unsupported-capability", "unknown"], APP_SERVER_UNIMPLEMENTED: ["unsupported-capability", "unknown"],
    }),
  }),
  "gpt-connector": Object.freeze({
    consultation: Object.freeze({
      AUTH_REQUIRED: ["credential-missing", "failed"], UPLOAD_TIMEOUT: ["timeout", "failed"],
      MODEL_NOT_AVAILABLE: ["unsupported-capability", "failed"], EFFORT_NOT_SUPPORTED: ["unsupported-capability", "failed"], FILE_TYPE_NOT_SUPPORTED: ["unsupported-capability", "failed"],
    }),
  }),
});

export class ExecutorAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorAdapterError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new ExecutorAdapterError(code, message); };
const object = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an object`);
  return value;
};
const exact = (value, keys, name) => {
  object(value, name);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const exactOptional = (value, required, optional, name) => {
  object(value, name);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const identifier = (value, name) => {
  if (typeof value !== "string" || !ID_RE.test(value)) fail("INVALID_SCHEMA", `${name} is not a bounded identifier`);
};
const boundedArray = (value, name, maximum, validator, minimum = 1) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("INVALID_SCHEMA", `${name} has invalid length`);
  value.forEach((entry, index) => validator(entry, `${name}[${index}]`));
};
const boundedString = (value, name, maximum = 4096) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("INVALID_SCHEMA", `${name} is not a bounded string`);
};

function canonicalTimestamp(value, name) {
  boundedString(value, name, 64);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail("INVALID_SCHEMA", `${name} is not canonical ISO UTC`);
  return value;
}

function validateRestrictions(value) {
  exact(value, ["node_execution", "credential_access", "dispatch_authority"], "restrictions");
  if (value.node_execution !== "forbidden") fail("INVALID_SCHEMA", "restrictions.node_execution must be forbidden");
  if (value.credential_access !== "forbidden") fail("INVALID_SCHEMA", "restrictions.credential_access must be forbidden");
  if (!["parent", "external-product", "projection-only"].includes(value.dispatch_authority)) fail("INVALID_SCHEMA", "restrictions.dispatch_authority is invalid");
}

function validateOperation(value, name) {
  exact(value, ["operation_id", "transport", "tool_name", "effect"], name);
  identifier(value.operation_id, `${name}.operation_id`);
  if (!["host-tool", "mcp", "pty", "projection"].includes(value.transport)) fail("INVALID_SCHEMA", `${name}.transport is invalid`);
  if (typeof value.tool_name !== "string" || value.tool_name.length === 0 || value.tool_name.length > 256 || value.tool_name.includes("\0")) fail("INVALID_SCHEMA", `${name}.tool_name is invalid`);
  if (!["control", "observe"].includes(value.effect)) fail("INVALID_SCHEMA", `${name}.effect is invalid`);
}

function validateInterface(value, name) {
  exact(value, ["interface_id", "operations"], name);
  identifier(value.interface_id, `${name}.interface_id`);
  boundedArray(value.operations, `${name}.operations`, MAX_OPERATIONS, validateOperation);
  const ids = value.operations.map((entry) => entry.operation_id);
  if (new Set(ids).size !== ids.length) fail("DUPLICATE_OPERATION", `${name}.operations contains duplicate ids`);
}

export function validateAdapterDescriptor(value) {
  exact(value, ["schema_version", "adapter_id", "contract_version", "lane", "interfaces", "restrictions"], "adapter");
  if (value.schema_version !== ADAPTER_SCHEMA) fail("INVALID_SCHEMA", "adapter schema is unsupported");
  identifier(value.adapter_id, "adapter.adapter_id"); identifier(value.contract_version, "adapter.contract_version");
  if (!["worker", "consultation", "host-projection"].includes(value.lane)) fail("INVALID_SCHEMA", "adapter.lane is invalid");
  boundedArray(value.interfaces, "adapter.interfaces", MAX_INTERFACES, validateInterface);
  if (new Set(value.interfaces.map((entry) => entry.interface_id)).size !== value.interfaces.length) fail("DUPLICATE_INTERFACE", "adapter.interfaces contains duplicate ids");
  validateRestrictions(value.restrictions);
  if (value.adapter_id === "gpt-connector" && value.lane !== "consultation") fail("LANE_FORBIDDEN", "gpt-connector is consultation-only");
  if (value.contract_version.startsWith("consult-") && value.lane !== "consultation") fail("LANE_FORBIDDEN", "consult contracts are consultation-lane only");
  if (value.adapter_id === "claude-internal") {
    const projection = value.interfaces.length === 1 && value.interfaces[0].interface_id === "appendix-projection"
      && value.interfaces[0].operations.length === 1 && value.interfaces[0].operations[0].operation_id === "observe"
      && value.interfaces[0].operations[0].transport === "projection" && value.interfaces[0].operations[0].tool_name === "appendix_projection"
      && value.interfaces[0].operations[0].effect === "observe";
    if (value.lane !== "host-projection" || !projection) fail("LANE_FORBIDDEN", "claude-internal is observation-projection only");
  }
  return value;
}

export function validateAdapterCatalog(value) {
  boundedArray(value, "adapter_catalog", MAX_INTERFACES, validateAdapterDescriptor);
  const keys = value.map((entry) => `${entry.adapter_id}\0${entry.contract_version}`);
  if (new Set(keys).size !== keys.length) fail("DUPLICATE_ADAPTER", "adapter catalog contains duplicate adapter contracts");
  return value;
}

const restrictions = (dispatchAuthority) => ({ node_execution: "forbidden", credential_access: "forbidden", dispatch_authority: dispatchAuthority });

const DEFAULT_CATALOG = Object.freeze(validateAdapterCatalog([
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "codex-sidecar", contract_version: "v1", lane: "worker", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "durable-work", operations: [
      { operation_id: "start", transport: "mcp", tool_name: "codex_work_start", effect: "control" },
      { operation_id: "result", transport: "mcp", tool_name: "codex_work_result", effect: "observe" },
      { operation_id: "cancel", transport: "mcp", tool_name: "codex_work_cancel", effect: "control" },
      { operation_id: "inspect-recovery", transport: "mcp", tool_name: "codex_work_recover", effect: "observe" },
      { operation_id: "quarantine", transport: "mcp", tool_name: "codex_work_recover", effect: "control" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "codex-native", contract_version: "v1", lane: "worker", restrictions: restrictions("parent"),
    interfaces: [{ interface_id: "native-agent", operations: [
      { operation_id: "spawn", transport: "host-tool", tool_name: "spawn_agent", effect: "control" },
      { operation_id: "followup", transport: "host-tool", tool_name: "followup_task", effect: "control" },
      { operation_id: "interrupt", transport: "host-tool", tool_name: "interrupt_agent", effect: "control" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "aiterm", contract_version: "v1", lane: "worker", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "interactive-session", operations: [
      ...["codex_agent", "grok_agent", "composer_agent", "pty_read", "pty_send", "pty_key", "pty_close", "pty_list"].map((tool_name) => ({ operation_id: tool_name, transport: "mcp", tool_name, effect: tool_name === "pty_read" || tool_name === "pty_list" ? "observe" : "control" })),
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "claude-native", contract_version: "v1", lane: "worker", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "headless-session", operations: [
      { operation_id: "start", transport: "pty", tool_name: "claude", effect: "control" },
      { operation_id: "resume", transport: "pty", tool_name: "claude", effect: "control" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "claude-native", contract_version: "consult-v1", lane: "consultation", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "consultation-session", operations: [
      { operation_id: "start", transport: "pty", tool_name: "claude", effect: "control" },
      { operation_id: "resume", transport: "pty", tool_name: "claude", effect: "control" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "codex-sidecar", contract_version: "consult-v1", lane: "consultation", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "consultation-opinion", operations: [
      { operation_id: "consult", transport: "mcp", tool_name: "codex_opinion", effect: "control" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "gpt-connector", contract_version: "v1", lane: "consultation", restrictions: restrictions("external-product"),
    interfaces: [{ interface_id: "consultation-job", operations: [
      { operation_id: "consult", transport: "mcp", tool_name: "consult", effect: "control" },
      { operation_id: "sessions", transport: "mcp", tool_name: "sessions", effect: "observe" },
    ] }],
  },
  {
    schema_version: ADAPTER_SCHEMA, adapter_id: "claude-internal", contract_version: "v1", lane: "host-projection", restrictions: restrictions("projection-only"),
    interfaces: [{ interface_id: "appendix-projection", operations: [
      { operation_id: "observe", transport: "projection", tool_name: "appendix_projection", effect: "observe" },
    ] }],
  },
]));

export function defaultAdapterCatalog() {
  return structuredClone(DEFAULT_CATALOG);
}

export function lookupAdapter({ adapter_id, contract_version }, catalog = DEFAULT_CATALOG) {
  identifier(adapter_id, "lookup.adapter_id"); identifier(contract_version, "lookup.contract_version"); validateAdapterCatalog(catalog);
  const adapter = catalog.find((entry) => entry.adapter_id === adapter_id && entry.contract_version === contract_version);
  if (!adapter) fail("ADAPTER_UNKNOWN", "adapter contract is unknown");
  return structuredClone(adapter);
}

export function lookupInterface({ adapter_id, contract_version, interface_id }, catalog = DEFAULT_CATALOG) {
  identifier(interface_id, "lookup.interface_id"); const adapter = lookupAdapter({ adapter_id, contract_version }, catalog);
  const iface = adapter.interfaces.find((entry) => entry.interface_id === interface_id);
  if (!iface) fail("INTERFACE_UNKNOWN", "adapter interface is unknown");
  return { adapter, interface: structuredClone(iface) };
}

export function lookupOperation({ adapter_id, contract_version, interface_id, operation_id }, catalog = DEFAULT_CATALOG) {
  identifier(operation_id, "lookup.operation_id"); const { adapter, interface: iface } = lookupInterface({ adapter_id, contract_version, interface_id }, catalog);
  const operation = iface.operations.find((entry) => entry.operation_id === operation_id);
  if (!operation) fail("OPERATION_UNKNOWN", "adapter operation is unknown");
  return { adapter, interface: iface, operation: structuredClone(operation) };
}

function sidecarOperation(operation_id) {
  return lookupOperation({ adapter_id: "codex-sidecar", contract_version: "v1", interface_id: "durable-work", operation_id }).operation;
}

function nativeOperation(operation_id) {
  return lookupOperation({ adapter_id: "codex-native", contract_version: "v1", interface_id: "native-agent", operation_id }).operation;
}

function claudeNativeOperation(operation_id) {
  return lookupOperation({ adapter_id: "claude-native", contract_version: "v1", interface_id: "headless-session", operation_id }).operation;
}

function gptConnectorOperation(operation_id) {
  return lookupOperation({ adapter_id: "gpt-connector", contract_version: "v1", interface_id: "consultation-job", operation_id }).operation;
}

function adapterLane(value, name) {
  if (!ADAPTER_LANES.includes(value)) fail("INVALID_SCHEMA", `${name} is not an adapter lane`);
  return value;
}

export function lookupAdapterFailureSupport({ adapter_id, lane, failure_family }) {
  identifier(adapter_id, "adapter failure support.adapter_id");
  adapterLane(lane, "adapter failure support.lane");
  if (!Object.hasOwn(ADAPTER_FAILURE_SUPPORT, adapter_id)) fail("ADAPTER_UNKNOWN", "adapter failure support is unknown");
  if (!FAILURE_FAMILIES.includes(failure_family)) fail("FAILURE_FAMILY_UNKNOWN", "adapter failure family is unknown");
  const lanes = ADAPTER_FAILURE_SUPPORT[adapter_id];
  if (!Object.hasOwn(lanes, lane)) fail("ADAPTER_UNKNOWN", "adapter failure support is unknown for this lane");
  const support = lanes[lane];
  const [status, evidence_basis] = support[failure_family];
  return { adapter_id, lane, failure_family, status, evidence_basis, timeout_recovery_operation: failure_family === "timeout" ? support.timeout_recovery_operation : null };
}

export function projectAdapterFailure(input) {
  exact(input, ["adapter_id", "lane", "provider_code"], "adapter failure"); identifier(input.adapter_id, "adapter failure.adapter_id"); adapterLane(input.lane, "adapter failure.lane"); boundedString(input.provider_code, "adapter failure.provider_code", 128);
  const laneCodes = PROVIDER_FAILURE_CODES[input.adapter_id]?.[input.lane];
  if (laneCodes === undefined) {
    lookupAdapterFailureSupport({ adapter_id: input.adapter_id, lane: input.lane, failure_family: "timeout" });
    fail("FAILURE_UNMAPPED", "adapter lane has no typed provider failure mapping");
  }
  const mapped = laneCodes[input.provider_code];
  if (mapped === undefined) fail("FAILURE_UNMAPPED", "provider failure code is not mapped");
  const [failure_family, state] = mapped; const support = lookupAdapterFailureSupport({ adapter_id: input.adapter_id, lane: input.lane, failure_family });
  return {
    schema_version: ADAPTER_FAILURE_SCHEMA, adapter_id: input.adapter_id, lane: input.lane, provider_code: input.provider_code, failure_family, state,
    recovery_operation: failure_family === "timeout" ? support.timeout_recovery_operation : null,
  };
}

export function projectAdapterCallerTimeout(input) {
  exact(input, ["adapter_id", "lane"], "adapter caller timeout"); identifier(input.adapter_id, "adapter caller timeout.adapter_id"); adapterLane(input.lane, "adapter caller timeout.lane");
  const support = lookupAdapterFailureSupport({ adapter_id: input.adapter_id, lane: input.lane, failure_family: "timeout" });
  if (!new Set(["caller-event", "mapped"]).has(support.status)) fail("FAILURE_UNMAPPED", "adapter has no caller timeout contract");
  return { schema_version: ADAPTER_FAILURE_SCHEMA, adapter_id: input.adapter_id, lane: input.lane, provider_code: null, failure_family: "timeout", state: "unknown", recovery_operation: support.timeout_recovery_operation };
}

export function projectClaudeInternalAppendixObservation(input) {
  exact(input, ["observed_at"], "claude internal appendix observation");
  boundedString(input.observed_at, "claude internal appendix observation.observed_at", 64);
  if (Number.isNaN(Date.parse(input.observed_at)) || new Date(input.observed_at).toISOString() !== input.observed_at) fail("INVALID_SCHEMA", "claude internal appendix observation.observed_at is not canonical ISO UTC");
  return {
    schema_version: CLAUDE_INTERNAL_OBSERVATION_SCHEMA, adapter_id: "claude-internal",
    appendix_ref: CLAUDE_APPENDIX_REFERENCE, observed_at: input.observed_at,
    state: "unknown", executor_handle: null, terminal: null,
  };
}

function gptConnectorSlug(value, name = "slug") {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value)) fail("INVALID_SCHEMA", `${name} is not a caller-known consult slug`);
  return value;
}

function gptConnectorRequest(operation_id, argumentsValue) {
  const operation = gptConnectorOperation(operation_id);
  return { schema_version: GPT_CONNECTOR_REQUEST_SCHEMA, operation_id, tool_name: operation.tool_name, arguments: structuredClone(argumentsValue) };
}

export function gptConnectorConsultRequest(input) {
  exact(input, ["prompt", "model", "effort", "slug"], "gpt connector consult input");
  nativeTask(input.prompt, "gpt connector consult input.prompt"); boundedString(input.model, "gpt connector consult input.model", 256); boundedString(input.effort, "gpt connector consult input.effort", 64); gptConnectorSlug(input.slug, "gpt connector consult input.slug");
  return gptConnectorRequest("consult", { prompt: input.prompt, model: input.model, effort: input.effort, slug: input.slug, keepOpen: false, dryRun: false });
}

export function gptConnectorSessionsRequest(input) {
  exact(input, ["slug"], "gpt connector sessions input"); gptConnectorSlug(input.slug, "gpt connector sessions input.slug");
  return gptConnectorRequest("sessions", { slug: input.slug });
}

export function gptConnectorTimeoutRecoveryRequest(input) {
  exact(input, ["slug"], "gpt connector timeout recovery input"); gptConnectorSlug(input.slug, "gpt connector timeout recovery input.slug");
  return gptConnectorSessionsRequest({ slug: input.slug });
}

function validateGptConnectorResult(value, name) {
  exactOptional(value, ["text", "status", "endTurn", "resolvedModel", "resolvedEffort", "attachments", "archived"], ["sessionId"], name);
  boundedString(value.text, `${name}.text`, 48 * 1024); boundedString(value.status, `${name}.status`, 256);
  if (value.endTurn !== true) fail("INVALID_SCHEMA", `${name}.endTurn must be true`);
  if (value.resolvedModel !== null) boundedString(value.resolvedModel, `${name}.resolvedModel`, 256);
  if (value.resolvedEffort !== null) boundedString(value.resolvedEffort, `${name}.resolvedEffort`, 64);
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId))) fail("INVALID_SCHEMA", `${name}.sessionId is invalid`);
  exact(value.attachments, ["count", "names", "mimeTypes", "readBack", "retention", "cleanup"], `${name}.attachments`);
  if (!Number.isSafeInteger(value.attachments.count) || value.attachments.count < 0 || value.attachments.count > 20) fail("INVALID_SCHEMA", `${name}.attachments.count is invalid`);
  boundedArray(value.attachments.names, `${name}.attachments.names`, 20, (entry, entryName) => boundedString(entry, entryName, 256), 0);
  boundedArray(value.attachments.mimeTypes, `${name}.attachments.mimeTypes`, 20, (entry, entryName) => { if (entry !== null) boundedString(entry, entryName, 256); }, 0);
  if (value.attachments.names.length !== value.attachments.count || value.attachments.mimeTypes.length !== value.attachments.count) fail("INVALID_SCHEMA", `${name}.attachments does not match count`);
  if (value.attachments.readBack !== "confirmed" || value.attachments.retention !== "unknown" || !["not_supported", "failed", "deleted"].includes(value.attachments.cleanup)) fail("INVALID_SCHEMA", `${name}.attachments is invalid`);
  if (typeof value.archived !== "boolean") fail("INVALID_SCHEMA", `${name}.archived is invalid`);
}

function validateGptConnectorError(value, name) {
  exactOptional(value, ["code", "message", "retry"], ["partialUpload"], name); boundedString(value.code, `${name}.code`, 128); boundedString(value.message, `${name}.message`, 16 * 1024);
  if (!["never", "after_input_change", "after_auth", "after_runtime_update", "status_first"].includes(value.retry)) fail("INVALID_SCHEMA", `${name}.retry is invalid`);
  if (value.partialUpload !== undefined) {
    exact(value.partialUpload, ["count", "cleanup"], `${name}.partialUpload`);
    if (!Number.isSafeInteger(value.partialUpload.count) || value.partialUpload.count < 1 || value.partialUpload.count > 20 || !["not_supported", "failed"].includes(value.partialUpload.cleanup)) fail("INVALID_SCHEMA", `${name}.partialUpload is invalid`);
  }
}

function validateGptConnectorTimestamp(value, name) {
  boundedString(value, name, 64);
  if (Number.isNaN(Date.parse(value))) fail("INVALID_SCHEMA", `${name} is invalid`);
}

export function projectGptConnectorObservation(value) {
  exact(value, ["slug", "provider"], "gpt connector observation"); gptConnectorSlug(value.slug, "gpt connector observation.slug");
  exact(value.provider, ["slug", "state", "createdAt", "updatedAt", "result", "error"], "gpt connector observation.provider");
  if (value.provider.slug !== value.slug) fail("INVALID_SCHEMA", "gpt connector observation.provider.slug does not match the caller-known slug");
  if (!GPT_CONNECTOR_JOB_STATES.has(value.provider.state)) fail("INVALID_SCHEMA", "gpt connector observation.provider.state is invalid");
  validateGptConnectorTimestamp(value.provider.createdAt, "gpt connector observation.provider.createdAt"); validateGptConnectorTimestamp(value.provider.updatedAt, "gpt connector observation.provider.updatedAt");
  if (["queued", "uploading", "submitted", "running"].includes(value.provider.state)) {
    if (value.provider.result !== null || value.provider.error !== null) fail("INVALID_SCHEMA", "active gpt connector job must not project terminal data");
  } else if (value.provider.state === "succeeded") {
    if (value.provider.error !== null) fail("INVALID_SCHEMA", "successful gpt connector job must not project an error");
    validateGptConnectorResult(value.provider.result, "gpt connector observation.provider.result");
  } else {
    if (value.provider.result !== null) fail("INVALID_SCHEMA", "failed gpt connector job must not project a result");
    validateGptConnectorError(value.provider.error, "gpt connector observation.provider.error");
  }
  if (Buffer.byteLength(canonicalJson(value), "utf8") > GPT_CONNECTOR_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "gpt connector observation exceeds projection limit");
  const state = value.provider.state === "succeeded" ? "completed"
    : value.provider.state === "failed" ? "failed"
      : value.provider.state === "running" ? "running" : "dispatched";
  const terminal = value.provider.state === "succeeded" ? { resolved_model: value.provider.result.resolvedModel, resolved_effort: value.provider.result.resolvedEffort, session_id: value.provider.result.sessionId ?? null, archived: value.provider.result.archived } : value.provider.state === "failed" ? { error_code: value.provider.error.code, retry: value.provider.error.retry } : null;
  return { schema_version: GPT_CONNECTOR_OBSERVATION_SCHEMA, consultation_handle: { slug: value.slug }, state, raw_status: value.provider.state, terminal };
}

export function projectGptConnectorTimeoutObservation(input) {
  exact(input, ["slug"], "gpt connector timeout observation"); gptConnectorSlug(input.slug, "gpt connector timeout observation.slug");
  return { schema_version: GPT_CONNECTOR_OBSERVATION_SCHEMA, consultation_handle: { slug: input.slug }, state: "unknown", raw_status: "caller_timeout", terminal: null };
}

function aitermSessionId(value, name = "session_id") {
  boundedString(value, name, 256);
  return value;
}

function aitermAgentKind(value, name = "agent_kind") {
  if (!AITERM_AGENT_KINDS.has(value)) fail("INVALID_SCHEMA", `${name} is invalid`);
  return value;
}

function aitermWorkspace(value, name) {
  sidecarProjectRoot(value, name);
  return value;
}

function aitermHandle(value, name = "aiterm handle") {
  exact(value, ["session_id", "agent_kind"], name);
  aitermSessionId(value.session_id, `${name}.session_id`); aitermAgentKind(value.agent_kind, `${name}.agent_kind`);
  return value;
}

export function projectAitermLaunchObservation(value) {
  exact(value, ["session_id", "agent_kind", "workspace_cwd"], "aiterm launch observation");
  const handle = { session_id: value.session_id, agent_kind: value.agent_kind };
  aitermHandle(handle, "aiterm launch observation.executor_handle"); aitermWorkspace(value.workspace_cwd, "aiterm launch observation.workspace_cwd");
  return { schema_version: AITERM_OBSERVATION_SCHEMA, executor_handle: handle, workspace_cwd: value.workspace_cwd, state: "running", terminal: null };
}

export function projectAitermObservation(value) {
  exact(value, ["handle", "status", "report_ref", "evidence_refs"], "aiterm observation"); aitermHandle(value.handle, "aiterm observation.handle");
  if (!AITERM_STATUSES.has(value.status)) fail("INVALID_SCHEMA", "aiterm observation.status is invalid");
  if (value.report_ref !== null) boundedString(value.report_ref, "aiterm observation.report_ref", 1024);
  boundedArray(value.evidence_refs, "aiterm observation.evidence_refs", 64, (entry, name) => boundedString(entry, name, 1024), 0);
  if (new Set(value.evidence_refs).size !== value.evidence_refs.length) fail("INVALID_SCHEMA", "aiterm observation.evidence_refs contains duplicates");
  if (value.status === "completed" && (value.report_ref === null || value.evidence_refs.length === 0)) fail("EVIDENCE_REQUIRED", "completed aiterm observation requires Worker Report reference and provider terminal evidence");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > AITERM_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "aiterm observation exceeds projection limit");
  return { schema_version: AITERM_OBSERVATION_SCHEMA, executor_handle: structuredClone(value.handle), state: value.status, report_ref: value.report_ref, evidence_refs: structuredClone(value.evidence_refs) };
}

function claudeNativeHandle(value, name = "claude native handle") {
  exact(value, ["session_id"], name);
  boundedString(value.session_id, `${name}.session_id`, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.session_id)) fail("INVALID_SCHEMA", `${name}.session_id is not a UUID`);
  return value;
}

function claudeNativeToolPolicy(value) {
  exact(value, ["permission_mode", "tools", "allowed_tools"], "claude native tool policy");
  if (value.permission_mode !== "dontAsk") fail("INVALID_SCHEMA", "claude native tool policy.permission_mode must be dontAsk");
  boundedArray(value.tools, "claude native tool policy.tools", 16, (entry, name) => {
    boundedString(entry, name, 64);
    if (!CLAUDE_NATIVE_BUILTIN_TOOLS.has(entry)) fail("INVALID_SCHEMA", `${name} is not an approved built-in Worker tool`);
  });
  if (new Set(value.tools).size !== value.tools.length) fail("INVALID_SCHEMA", "claude native tool policy.tools contains duplicates");
  const selected = new Set(value.tools);
  boundedArray(value.allowed_tools, "claude native tool policy.allowed_tools", 32, (entry, name) => {
    boundedString(entry, name, 256);
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:\([^\0\r\n]{1,192}\))?$/.exec(entry);
    if (match === null || !selected.has(match[1])) fail("INVALID_SCHEMA", `${name} is not bounded by tools`);
  });
  if (new Set(value.allowed_tools).size !== value.allowed_tools.length) fail("INVALID_SCHEMA", "claude native tool policy.allowed_tools contains duplicates");
  return value;
}

function claudeNativeRequest(operation_id, input) {
  exact(input, ["handle", "prompt", "workspace_cwd", "model", "effort", "tool_policy"], `claude native ${operation_id} input`);
  claudeNativeHandle(input.handle, `claude native ${operation_id} input.handle`);
  nativeTask(input.prompt, `claude native ${operation_id} input.prompt`);
  sidecarProjectRoot(input.workspace_cwd, `claude native ${operation_id} input.workspace_cwd`);
  boundedString(input.model, `claude native ${operation_id} input.model`, 256);
  if (!["low", "medium", "high", "xhigh", "max"].includes(input.effort)) fail("INVALID_SCHEMA", `claude native ${operation_id} input.effort is invalid`);
  claudeNativeToolPolicy(input.tool_policy);
  const operation = claudeNativeOperation(operation_id);
  const sessionFlag = operation_id === "start" ? "--session-id" : "--resume";
  const argv = [
    "--print", "--verbose", "--output-format", "stream-json", "--input-format", "text",
    sessionFlag, input.handle.session_id, "--model", input.model, "--effort", input.effort,
    "--permission-mode", input.tool_policy.permission_mode,
    "--tools", input.tool_policy.tools.join(","), "--allowedTools", input.tool_policy.allowed_tools.join(","),
    "--disable-slash-commands", "--no-chrome",
  ];
  return {
    schema_version: CLAUDE_NATIVE_REQUEST_SCHEMA, operation_id, tool_name: operation.tool_name,
    arguments: { cwd: input.workspace_cwd, argv, stdin: input.prompt },
  };
}

// These packets are data only. The parent owns process creation, stdin, timeout, and terminal collection.
export function claudeNativeStartRequest(input) {
  return claudeNativeRequest("start", input);
}

export function claudeNativeResumeRequest(input) {
  return claudeNativeRequest("resume", input);
}

export function projectClaudeNativeObservation(value) {
  exact(value, ["handle", "status", "exit_code", "signal", "report_ref", "evidence_refs"], "claude native observation");
  claudeNativeHandle(value.handle, "claude native observation.handle");
  if (!CLAUDE_NATIVE_STATUSES.has(value.status)) fail("INVALID_SCHEMA", "claude native observation.status is invalid");
  if (value.exit_code !== null && (!Number.isSafeInteger(value.exit_code) || value.exit_code < 0 || value.exit_code > 255)) fail("INVALID_SCHEMA", "claude native observation.exit_code is invalid");
  if (value.signal !== null) boundedString(value.signal, "claude native observation.signal", 32);
  if (value.report_ref !== null) boundedString(value.report_ref, "claude native observation.report_ref", 1024);
  boundedArray(value.evidence_refs, "claude native observation.evidence_refs", 64, (entry, name) => boundedString(entry, name, 1024), 0);
  if (new Set(value.evidence_refs).size !== value.evidence_refs.length) fail("INVALID_SCHEMA", "claude native observation.evidence_refs contains duplicates");
  if (["running", "unknown"].includes(value.status) && (value.exit_code !== null || value.signal !== null || value.report_ref !== null)) fail("INVALID_SCHEMA", "nonterminal claude native observation has terminal fields");
  if (value.status === "completed" && (value.exit_code !== 0 || value.signal !== null || value.report_ref === null || value.evidence_refs.length === 0)) fail("INVALID_SCHEMA", "completed claude native observation lacks terminal receipt or Worker Report reference");
  if (value.status === "failed" && ((value.exit_code === null && value.signal === null) || value.exit_code === 0 || value.report_ref !== null || value.evidence_refs.length === 0)) fail("INVALID_SCHEMA", "failed claude native observation is not a non-success terminal receipt");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > CLAUDE_NATIVE_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "claude native observation exceeds projection limit");
  return {
    schema_version: CLAUDE_NATIVE_OBSERVATION_SCHEMA, executor_handle: structuredClone(value.handle),
    state: value.status, raw_status: value.status, report_ref: value.report_ref, evidence_refs: structuredClone(value.evidence_refs),
  };
}

export function projectClaudeNativeTimeoutObservation(input) {
  exact(input, ["handle"], "claude native timeout observation");
  claudeNativeHandle(input.handle, "claude native timeout observation.handle");
  return {
    schema_version: CLAUDE_NATIVE_OBSERVATION_SCHEMA, executor_handle: structuredClone(input.handle),
    state: "unknown", raw_status: "caller_timeout", report_ref: null, evidence_refs: [],
  };
}

const CLAUDE_NATIVE_CONSULT_STATUSES = new Set(["dispatched", "running", "unknown", "completed", "failed"]);

// Consultation lane (ADR 0045): same session-id resume as the worker lane, but no workspace
// on the Control record, all tools disabled, and request/observation schemas kept apart from
// the worker lane so consultation results can never enter worker projections.
function claudeNativeConsultRequest(operation_id, input) {
  exact(input, ["handle", "prompt", "cwd", "model", "effort"], `claude native consult ${operation_id} input`);
  claudeNativeHandle(input.handle, `claude native consult ${operation_id} input.handle`);
  nativeTask(input.prompt, `claude native consult ${operation_id} input.prompt`);
  sidecarProjectRoot(input.cwd, `claude native consult ${operation_id} input.cwd`);
  boundedString(input.model, `claude native consult ${operation_id} input.model`, 256);
  if (!["low", "medium", "high", "xhigh", "max"].includes(input.effort)) fail("INVALID_SCHEMA", `claude native consult ${operation_id} input.effort is invalid`);
  const operation = lookupOperation({ adapter_id: "claude-native", contract_version: "consult-v1", interface_id: "consultation-session", operation_id }).operation;
  const sessionFlag = operation_id === "start" ? "--session-id" : "--resume";
  const argv = [
    "--print", "--verbose", "--output-format", "stream-json", "--input-format", "text",
    sessionFlag, input.handle.session_id, "--model", input.model, "--effort", input.effort,
    "--permission-mode", "dontAsk", "--tools", "",
    "--disable-slash-commands", "--no-chrome",
  ];
  return {
    schema_version: CLAUDE_NATIVE_CONSULT_REQUEST_SCHEMA, operation_id, tool_name: operation.tool_name,
    arguments: { cwd: input.cwd, argv, stdin: input.prompt },
  };
}

export function claudeNativeConsultStartRequest(input) {
  return claudeNativeConsultRequest("start", input);
}

export function claudeNativeConsultResumeRequest(input) {
  return claudeNativeConsultRequest("resume", input);
}

export function projectClaudeNativeConsultObservation(value) {
  exactOptional(value, ["handle", "status"], ["result_receipt"], "claude native consult observation");
  claudeNativeHandle(value.handle, "claude native consult observation.handle");
  if (!CLAUDE_NATIVE_CONSULT_STATUSES.has(value.status)) fail("INVALID_SCHEMA", "claude native consult observation.status is invalid");
  // The stream-json type:result event is the completion signal (ADR 0045 §7); process exit is not.
  if (value.status === "completed") {
    if (value.result_receipt === undefined) fail("EVIDENCE_REQUIRED", "completed claude native consult observation requires the stream type:result receipt");
    boundedString(value.result_receipt, "claude native consult observation.result_receipt", 1024);
  } else if (value.result_receipt !== undefined) {
    fail("INVALID_SCHEMA", "only a completed claude native consult observation may carry a result receipt");
  }
  return {
    schema_version: CLAUDE_NATIVE_CONSULT_OBSERVATION_SCHEMA, consultation_handle: structuredClone(value.handle),
    state: value.status, raw_status: value.status, terminal: value.status === "completed" ? { result_receipt: value.result_receipt } : null,
  };
}

export function projectClaudeNativeConsultTimeoutObservation(input) {
  exact(input, ["handle"], "claude native consult timeout observation");
  claudeNativeHandle(input.handle, "claude native consult timeout observation.handle");
  return { schema_version: CLAUDE_NATIVE_CONSULT_OBSERVATION_SCHEMA, consultation_handle: structuredClone(input.handle), state: "unknown", raw_status: "caller_timeout", terminal: null };
}

// codex_opinion is synchronous and read-only by product contract: no durable handle exists,
// so the projection carries consultation_handle null and the request builder never emits
// write-capable arguments such as allowWork or preserveWorktree.
export function codexSidecarOpinionRequest(input) {
  exact(input, ["projectRoot", "prompt", "model", "effort"], "sidecar opinion input");
  sidecarProjectRoot(input.projectRoot, "sidecar opinion input.projectRoot");
  nativeTask(input.prompt, "sidecar opinion input.prompt");
  boundedString(input.model, "sidecar opinion input.model", 256);
  if (!SIDECAR_CONSULT_EFFORTS.has(input.effort)) fail("INVALID_SCHEMA", "sidecar opinion input.effort is not supported by codex_opinion");
  const operation = lookupOperation({ adapter_id: "codex-sidecar", contract_version: "consult-v1", interface_id: "consultation-opinion", operation_id: "consult" }).operation;
  return {
    schema_version: SIDECAR_CONSULT_REQUEST_SCHEMA, operation_id: "consult", tool_name: operation.tool_name,
    arguments: { projectRoot: input.projectRoot, prompt: input.prompt, model: input.model, modelReasoningEffort: input.effort },
  };
}

export function projectCodexSidecarOpinionDispatchObservation(input = {}) {
  exact(input, [], "sidecar opinion dispatch observation");
  return { schema_version: SIDECAR_CONSULT_OBSERVATION_SCHEMA, consultation_handle: null, state: "dispatched", raw_status: "caller_dispatch", terminal: null };
}

export function projectCodexSidecarOpinionObservation(value) {
  exact(value, ["provider"], "sidecar opinion observation");
  const projected = validateSidecarResult(value.provider, "opinion");
  if (value.provider.status === "dry-run") fail("INVALID_SCHEMA", "sidecar opinion projection must not be a dry run");
  // A read-only opinion must not report write artifacts; treat them as a product contract violation.
  if ((value.provider.changedFiles !== undefined && value.provider.changedFiles.length > 0) || value.provider.worktreePath !== undefined || value.provider.worktreePreserved !== undefined) fail("INVALID_SCHEMA", "sidecar opinion result carries write artifacts");
  const state = value.provider.status === "ok" ? "completed" : "failed";
  return { schema_version: SIDECAR_CONSULT_OBSERVATION_SCHEMA, consultation_handle: null, state, raw_status: value.provider.status, terminal: { result_digest: projected.digest } };
}

export function projectCodexSidecarOpinionErrorObservation(value) {
  exact(value, ["error"], "sidecar opinion error observation");
  exact(value.error, ["code", "message"], "sidecar opinion error observation.error");
  boundedString(value.error.code, "sidecar opinion error observation.error.code", 128);
  boundedString(value.error.message, "sidecar opinion error observation.error.message", 16 * 1024);
  return { schema_version: SIDECAR_CONSULT_OBSERVATION_SCHEMA, consultation_handle: null, state: "failed", raw_status: value.error.code, terminal: { error_code: value.error.code } };
}

export function projectCodexSidecarOpinionTimeoutObservation(input = {}) {
  exact(input, [], "sidecar opinion timeout observation");
  return { schema_version: SIDECAR_CONSULT_OBSERVATION_SCHEMA, consultation_handle: null, state: "unknown", raw_status: "caller_timeout", terminal: null };
}

function nativeAgentPath(value, name = "agent_path") {
  boundedString(value, name, 1024);
  if (!/^\/root(?:\/[a-z0-9_]+)+$/.test(value)) fail("INVALID_SCHEMA", `${name} is not a canonical native agent path`);
  return value;
}

function nativeTask(value, name) {
  boundedString(value, name, 16 * 1024);
  return value;
}

function routingField(value, name, maximum = 4096) {
  boundedString(value, name, maximum);
  return value;
}

function validateGreenRoutingReceipt(value, name = "routing_receipt") {
  exact(value, ["status", "verifier", "agent_path", "agent_role", "model", "effort", "developer_instructions", "verified_at", "verification_ref", "verification_digest"], name);
  if (value.status !== "green" || value.verifier !== "verify-codex-agent-routing" || value.developer_instructions !== "applied") fail("ROUTING_VERIFICATION_REQUIRED", `${name} is not a green verifier receipt`);
  nativeAgentPath(value.agent_path, `${name}.agent_path`); identifier(value.agent_role, `${name}.agent_role`);
  routingField(value.model, `${name}.model`, 256); routingField(value.effort, `${name}.effort`, 64);
  routingField(value.verification_ref, `${name}.verification_ref`, 1024);
  if (!/^[a-f0-9]{64}$/.test(value.verification_digest)) fail("INVALID_SCHEMA", `${name}.verification_digest is invalid`);
  boundedString(value.verified_at, `${name}.verified_at`, 64);
  if (Number.isNaN(Date.parse(value.verified_at)) || new Date(value.verified_at).toISOString() !== value.verified_at) fail("INVALID_SCHEMA", `${name}.verified_at is not canonical ISO UTC`);
  const payload = structuredClone(value); delete payload.verification_digest;
  if (createHash("sha256").update(canonicalJson(payload)).digest("hex") !== value.verification_digest) fail("ROUTING_VERIFICATION_MISMATCH", `${name} digest does not bind the verifier receipt`);
  return value;
}

function codexNativeRequest(operation_id, argumentsValue) {
  const operation = nativeOperation(operation_id);
  return { schema_version: CODEX_NATIVE_REQUEST_SCHEMA, operation_id, tool_name: operation.tool_name, arguments: structuredClone(argumentsValue) };
}

// These functions build invocation packets only. Calling the parent host tool remains the parent's responsibility.
export function codexNativeSpawnRequest(input) {
  exact(input, ["agent_type", "task_name"], "codex native spawn input");
  if (!["implementer", "refuter", "sorter"].includes(input.agent_type)) fail("INVALID_SCHEMA", "codex native spawn input.agent_type is not a registered role");
  identifier(input.task_name, "codex native spawn input.task_name");
  return codexNativeRequest("spawn", {
    agent_type: input.agent_type, fork_turns: "none", message: HANDSHAKE_ONLY_MESSAGE, task_name: input.task_name,
  });
}

export function codexNativeFollowupRequest(input) {
  exact(input, ["agent_path", "task", "routing_receipt"], "codex native followup input");
  nativeAgentPath(input.agent_path, "codex native followup input.agent_path"); nativeTask(input.task, "codex native followup input.task");
  validateGreenRoutingReceipt(input.routing_receipt, "codex native followup input.routing_receipt");
  if (input.routing_receipt.agent_path !== input.agent_path) fail("ROUTING_VERIFICATION_MISMATCH", "followup target differs from the verified agent path");
  return codexNativeRequest("followup", { target: input.agent_path, message: input.task });
}

export function codexNativeInterruptRequest(input) {
  exact(input, ["agent_path"], "codex native interrupt input"); nativeAgentPath(input.agent_path, "codex native interrupt input.agent_path");
  return codexNativeRequest("interrupt", { target: input.agent_path });
}

export function projectCodexNativeObservation(value) {
  exact(value, ["agent_path", "status", "routing_receipt", "report_ref", "evidence_refs"], "codex native observation");
  nativeAgentPath(value.agent_path, "codex native observation.agent_path");
  if (!CODEX_NATIVE_STATUSES.has(value.status)) fail("INVALID_SCHEMA", "codex native observation.status is invalid");
  if (value.routing_receipt !== null) validateGreenRoutingReceipt(value.routing_receipt, "codex native observation.routing_receipt");
  if (value.routing_receipt !== null && value.routing_receipt.agent_path !== value.agent_path) fail("ROUTING_VERIFICATION_MISMATCH", "observation target differs from the verified agent path");
  if (value.report_ref !== null) boundedString(value.report_ref, "codex native observation.report_ref", 1024);
  boundedArray(value.evidence_refs, "codex native observation.evidence_refs", 64, (entry, name) => boundedString(entry, name, 1024), 0);
  if (new Set(value.evidence_refs).size !== value.evidence_refs.length) fail("INVALID_SCHEMA", "codex native observation.evidence_refs contains duplicates");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > CODEX_NATIVE_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "codex native observation exceeds projection limit");
  return {
    schema_version: CODEX_NATIVE_OBSERVATION_SCHEMA, executor_handle: { agent_path: value.agent_path }, status: value.status,
    routing_receipt: value.routing_receipt === null ? null : structuredClone(value.routing_receipt),
    report_ref: value.report_ref, evidence_refs: structuredClone(value.evidence_refs),
  };
}

function requireEvidenceArray(value, name) {
  boundedArray(value, name, 64, (entry, entryName) => object(entry, entryName));
  return structuredClone(value);
}

function workerProjectionCore(projection) {
  object(projection, "worker control projection");
  if (projection.schema_version === SIDECAR_OBSERVATION_SCHEMA) {
    sidecarHandle(projection.executor_handle, "worker control projection.executor_handle");
    return { source: "codex-sidecar", executor_handle: projection.executor_handle, state: projection.state, raw_state: projection.raw_status };
  }
  if (projection.schema_version === CODEX_NATIVE_OBSERVATION_SCHEMA) {
    exact(projection.executor_handle, ["agent_path"], "worker control projection.executor_handle");
    nativeAgentPath(projection.executor_handle.agent_path, "worker control projection.executor_handle.agent_path");
    const state = projection.status === "created" ? "dispatched" : projection.status === "interrupted" ? "unknown" : projection.status;
    return { source: "codex-native", executor_handle: projection.executor_handle, state, raw_state: projection.status };
  }
  if (projection.schema_version === AITERM_OBSERVATION_SCHEMA) {
    aitermHandle(projection.executor_handle, "worker control projection.executor_handle");
    return { source: "aiterm", executor_handle: projection.executor_handle, state: projection.state, raw_state: projection.state };
  }
  if (projection.schema_version === CLAUDE_NATIVE_OBSERVATION_SCHEMA) {
    exact(projection, ["schema_version", "executor_handle", "state", "raw_status", "report_ref", "evidence_refs"], "worker control projection");
    claudeNativeHandle(projection.executor_handle, "worker control projection.executor_handle");
    if (!["running", "unknown", "completed", "failed"].includes(projection.state)) fail("INVALID_SCHEMA", "claude native projection state is invalid");
    boundedString(projection.raw_status, "worker control projection.raw_status", 128);
    return { source: "claude-native", executor_handle: projection.executor_handle, state: projection.state, raw_state: projection.raw_status };
  }
  fail("PROJECTION_UNSUPPORTED", "worker projection is not a Control Record executor projection");
}

// Produces the exact observation payload accepted by Control Record; it never executes an adapter operation.
export function buildWorkerControlObservation(input) {
  exactOptional(input, ["projection", "observed_version", "observed_at"], ["dispatch_evidence", "result", "terminal_evidence"], "worker control observation input");
  boundedString(input.observed_version, "worker control observation input.observed_version", 256);
  canonicalTimestamp(input.observed_at, "worker control observation input.observed_at");
  const core = workerProjectionCore(input.projection);
  if (!["dispatched", "running", "unknown", "completed", "failed", "cancelled"].includes(core.state)) fail("INVALID_SCHEMA", "worker projection state is not a Control Record state");
  const output = {
    state: core.state, source: core.source, observed_version: input.observed_version,
    observed_at: input.observed_at, raw_state: core.raw_state, executor_handle: structuredClone(core.executor_handle),
  };
  if (core.state === "dispatched") {
    if (!Object.hasOwn(input, "dispatch_evidence") || Object.hasOwn(input, "result") || Object.hasOwn(input, "terminal_evidence")) fail("EVIDENCE_REQUIRED", "dispatched worker projection requires dispatch evidence only");
    output.dispatch_evidence = requireEvidenceArray(input.dispatch_evidence, "worker control observation input.dispatch_evidence");
  } else if (core.state === "completed") {
    if (["codex-native", "aiterm", "claude-native"].includes(core.source)) {
      const projection = input.projection;
      const label = core.source === "codex-native" ? "completed codex native projection"
        : core.source === "aiterm" ? "completed aiterm projection" : "completed claude native projection";
      const keys = core.source === "codex-native"
        ? ["schema_version", "executor_handle", "status", "routing_receipt", "report_ref", "evidence_refs"]
        : core.source === "aiterm" ? ["schema_version", "executor_handle", "state", "report_ref", "evidence_refs"]
          : ["schema_version", "executor_handle", "state", "raw_status", "report_ref", "evidence_refs"];
      exact(projection, keys, label);
      if (projection.report_ref === null) fail("EVIDENCE_REQUIRED", `${label} requires Worker Report reference`);
      boundedString(projection.report_ref, `${label}.report_ref`, 1024);
      boundedArray(projection.evidence_refs, `${label}.evidence_refs`, 64, (entry, name) => boundedString(entry, name, 1024));
      if (new Set(projection.evidence_refs).size !== projection.evidence_refs.length) fail("INVALID_SCHEMA", `${label}.evidence_refs contains duplicates`);
      fail("WORKER_REPORT_IMPORT_REQUIRED", `${label} must be confirmed by strict Worker Report import`);
    }
    if (!Object.hasOwn(input, "result") || Object.hasOwn(input, "dispatch_evidence") || Object.hasOwn(input, "terminal_evidence")) fail("EVIDENCE_REQUIRED", "completed worker projection requires result only");
    object(input.result, "worker control observation input.result");
    if (input.projection.schema_version === SIDECAR_OBSERVATION_SCHEMA && input.projection.terminal?.result_digest !== input.result.result_digest) fail("PROJECTION_MISMATCH", "sidecar projection result digest differs from Control result");
    output.result = structuredClone(input.result);
  } else if (["failed", "cancelled"].includes(core.state)) {
    if (!Object.hasOwn(input, "terminal_evidence") || Object.hasOwn(input, "dispatch_evidence") || Object.hasOwn(input, "result")) fail("EVIDENCE_REQUIRED", "terminal worker projection requires terminal evidence only");
    output.terminal_evidence = requireEvidenceArray(input.terminal_evidence, "worker control observation input.terminal_evidence");
  } else if (["dispatch_evidence", "result", "terminal_evidence"].some((key) => Object.hasOwn(input, key))) {
    fail("INVALID_SCHEMA", "nonterminal worker projection cannot carry terminal or dispatch evidence");
  }
  return output;
}

function consultationProjectionCore(projection) {
  object(projection, "consultation control projection");
  if (projection.schema_version === GPT_CONNECTOR_OBSERVATION_SCHEMA) {
    exact(projection, ["schema_version", "consultation_handle", "state", "raw_status", "terminal"], "consultation control projection");
    exact(projection.consultation_handle, ["slug"], "consultation control projection.consultation_handle");
    gptConnectorSlug(projection.consultation_handle.slug, "consultation control projection.consultation_handle.slug");
    return { source: "gpt-connector", consultation_handle: projection.consultation_handle, state: projection.state, raw_state: projection.raw_status };
  }
  if (projection.schema_version === CLAUDE_NATIVE_CONSULT_OBSERVATION_SCHEMA) {
    exact(projection, ["schema_version", "consultation_handle", "state", "raw_status", "terminal"], "consultation control projection");
    claudeNativeHandle(projection.consultation_handle, "consultation control projection.consultation_handle");
    return { source: "claude-native", consultation_handle: projection.consultation_handle, state: projection.state, raw_state: projection.raw_status };
  }
  if (projection.schema_version === SIDECAR_CONSULT_OBSERVATION_SCHEMA) {
    exact(projection, ["schema_version", "consultation_handle", "state", "raw_status", "terminal"], "consultation control projection");
    if (projection.consultation_handle !== null) fail("INVALID_SCHEMA", "consultation control projection.consultation_handle must be null for codex-sidecar");
    return { source: "codex-sidecar", consultation_handle: null, state: projection.state, raw_state: projection.raw_status };
  }
  fail("PROJECTION_UNSUPPORTED", "consultation projection is not a Control Record consultation projection");
}

export function buildConsultationControlObservation(input) {
  exactOptional(input, ["projection", "observed_version", "observed_at"], ["decision_ref", "terminal_evidence"], "consultation control observation input");
  const core = consultationProjectionCore(input.projection);
  boundedString(input.observed_version, "consultation control observation input.observed_version", 256);
  canonicalTimestamp(input.observed_at, "consultation control observation input.observed_at");
  const state = core.state;
  if (!["dispatched", "running", "unknown", "completed", "failed"].includes(state)) fail("INVALID_SCHEMA", "consultation projection state is not a Control Record state");
  const output = { state, source: core.source, consultation_handle: structuredClone(core.consultation_handle), observed_version: input.observed_version, observed_at: input.observed_at, raw_state: core.raw_state };
  if (state === "completed") {
    if (!Object.hasOwn(input, "decision_ref") || Object.hasOwn(input, "terminal_evidence")) fail("EVIDENCE_REQUIRED", "completed consultation requires decision_ref only");
    boundedString(input.decision_ref, "consultation control observation input.decision_ref", 1024); output.decision_ref = input.decision_ref;
  } else if (state === "failed") {
    if (!Object.hasOwn(input, "terminal_evidence") || Object.hasOwn(input, "decision_ref")) fail("EVIDENCE_REQUIRED", "failed consultation requires terminal evidence only");
    output.terminal_evidence = requireEvidenceArray(input.terminal_evidence, "consultation control observation input.terminal_evidence");
  } else if (Object.hasOwn(input, "decision_ref") || Object.hasOwn(input, "terminal_evidence")) {
    fail("INVALID_SCHEMA", "nonterminal consultation projection cannot carry terminal fields");
  }
  return output;
}

function sidecarHandle(value, name = "handle") {
  exact(value, ["idempotency_key"], name); boundedString(value.idempotency_key, `${name}.idempotency_key`, 128);
  if (!/^(?:[A-Za-z0-9_-]{22,128}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value.idempotency_key)) fail("INVALID_SCHEMA", `${name}.idempotency_key is not accepted by codex-sidecar`);
  return value;
}

function sidecarProjectRoot(value, name) {
  boundedString(value, name);
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value)) fail("INVALID_SCHEMA", `${name} must be an absolute source workspace`);
}

function sidecarPath(value, name) {
  boundedString(value, name, 1024);
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) fail("INVALID_SCHEMA", `${name} is not a safe repo-relative path`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sidecarRequest(operation_id, argumentsValue) {
  const operation = sidecarOperation(operation_id);
  return { schema_version: SIDECAR_REQUEST_SCHEMA, operation_id, tool_name: operation.tool_name, arguments: structuredClone(argumentsValue) };
}

export function codexSidecarStartRequest(input) {
  exact(input, ["projectRoot", "handle", "baseRef", "prompt", "allowedPaths", "denyPaths", "turnTimeoutMs"], "sidecar start input");
  sidecarProjectRoot(input.projectRoot, "sidecar start input.projectRoot"); sidecarHandle(input.handle, "sidecar start input.handle");
  if (typeof input.baseRef !== "string" || !/^[0-9a-f]{40}$/.test(input.baseRef)) fail("INVALID_SCHEMA", "sidecar start input.baseRef must be a fixed commit SHA");
  boundedString(input.prompt, "sidecar start input.prompt", 16 * 1024);
  boundedArray(input.allowedPaths, "sidecar start input.allowedPaths", MAX_CHANGED_FILES, sidecarPath);
  boundedArray(input.denyPaths, "sidecar start input.denyPaths", MAX_CHANGED_FILES, sidecarPath, 0);
  if (!Number.isSafeInteger(input.turnTimeoutMs) || input.turnTimeoutMs < 1) fail("INVALID_SCHEMA", "sidecar start input.turnTimeoutMs must be positive");
  return sidecarRequest("start", {
    projectRoot: input.projectRoot, idempotencyKey: input.handle.idempotency_key, baseRef: input.baseRef,
    prompt: input.prompt, allowedPaths: structuredClone(input.allowedPaths), denyPaths: structuredClone(input.denyPaths),
    turnTimeoutMs: input.turnTimeoutMs, interruptOnTimeout: true, allowWork: true, preserveWorktree: true,
  });
}

export function codexSidecarResultRequest(input) {
  exact(input, ["projectRoot", "handle"], "sidecar result input"); sidecarProjectRoot(input.projectRoot, "sidecar result input.projectRoot"); sidecarHandle(input.handle);
  return sidecarRequest("result", { projectRoot: input.projectRoot, idempotencyKey: input.handle.idempotency_key });
}

export function codexSidecarCancelRequest(input) {
  exact(input, ["projectRoot", "handle"], "sidecar cancel input"); sidecarProjectRoot(input.projectRoot, "sidecar cancel input.projectRoot"); sidecarHandle(input.handle);
  return sidecarRequest("cancel", { projectRoot: input.projectRoot, idempotencyKey: input.handle.idempotency_key });
}

export function codexSidecarRecoveryInspectionRequest(input) {
  exact(input, ["projectRoot", "handle"], "sidecar recovery inspection input"); sidecarProjectRoot(input.projectRoot, "sidecar recovery inspection input.projectRoot"); sidecarHandle(input.handle);
  return sidecarRequest("inspect-recovery", { projectRoot: input.projectRoot, idempotencyKey: input.handle.idempotency_key });
}

export function codexSidecarQuarantineRequest(input) {
  exact(input, ["projectRoot", "handle", "confirmNoRunningProcesses"], "sidecar quarantine input"); sidecarProjectRoot(input.projectRoot, "sidecar quarantine input.projectRoot"); sidecarHandle(input.handle);
  if (input.confirmNoRunningProcesses !== true) fail("QUARANTINE_CONFIRMATION_REQUIRED", "sidecar quarantine requires explicit process confirmation");
  return sidecarRequest("quarantine", { projectRoot: input.projectRoot, idempotencyKey: input.handle.idempotency_key, action: "quarantine", confirmNoRunningProcesses: true });
}

function validateChangedFiles(value) {
  boundedArray(value, "sidecar observation.changedFiles", MAX_CHANGED_FILES, sidecarPath, 0);
  if (new Set(value).size !== value.length) fail("INVALID_SCHEMA", "sidecar observation.changedFiles contains duplicates");
}

function validateSidecarResult(value, workflow = "work") {
  const required = ["status", "workflow", "summary", "confidence", "recommendedNextAction"];
  const optional = ["findings", "risks", "pass", "missingTools", "openQuestions", "missingTests", "residualRisks", "fileReferences", "changedFiles", "tests", "worktreePath", "worktreePreserved", "sourceBoundaries", "costNotes", "recommendation", "objections", "assumptions", "failureModes", "generated", "normalizationNotes", "unvalidatedReport", "rawEventLogRef", "normalizedRequest", "modelPolicy", "error"];
  exactOptional(value, required, optional, "sidecar result");
  if (!["ok", "partial", "failed", "refused", "dry-run"].includes(value.status) || value.workflow !== workflow) fail("INVALID_SCHEMA", "sidecar result status or workflow is invalid");
  boundedString(value.summary, "sidecar result.summary", 16 * 1024); object(value.confidence, "sidecar result.confidence"); boundedString(value.recommendedNextAction, "sidecar result.recommendedNextAction", 16 * 1024);
  const changedFiles = value.changedFiles ?? []; validateChangedFiles(changedFiles);
  if (value.worktreePath !== undefined) sidecarProjectRoot(value.worktreePath, "sidecar result.worktreePath");
  if (value.worktreePreserved !== undefined && typeof value.worktreePreserved !== "boolean") fail("INVALID_SCHEMA", "sidecar result.worktreePreserved is invalid");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > SIDECAR_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "sidecar result exceeds projection limit");
  return { changedFiles, digest: createHash("sha256").update(canonicalJson(value)).digest("hex") };
}

export function projectCodexSidecarObservation(value) {
  exact(value, ["handle", "provider"], "sidecar observation"); sidecarHandle(value.handle); object(value.provider, "sidecar observation.provider");
  if (Buffer.byteLength(canonicalJson(value.provider), "utf8") > SIDECAR_OUTPUT_LIMIT) fail("LIMIT_EXCEEDED", "sidecar provider observation exceeds projection limit");
  const base = { schema_version: SIDECAR_OBSERVATION_SCHEMA, executor_handle: structuredClone(value.handle) };
  if (value.provider.kind === "run_handle") {
    exact(value.provider, ["kind", "workflow", "runId", "state", "createdAt", "pollAfterMs"], "sidecar run handle");
    if (value.provider.workflow !== "work" || !["starting", "queued", "running"].includes(value.provider.state)) fail("INVALID_SCHEMA", "sidecar run handle is invalid");
    identifier(value.provider.runId, "sidecar run handle.runId"); boundedString(value.provider.createdAt, "sidecar run handle.createdAt");
    if (!Number.isSafeInteger(value.provider.pollAfterMs) || value.provider.pollAfterMs < 0) fail("INVALID_SCHEMA", "sidecar run handle.pollAfterMs is invalid");
    return { ...base, provider_run_id: value.provider.runId, state: value.provider.state === "running" ? "running" : "dispatched", raw_status: value.provider.state, terminal: null };
  }
  if (value.provider.kind === "run_pending") {
    exactOptional(value.provider, ["kind", "runId", "state", "phase", "pollAfterMs"], ["heartbeatAt", "worktreePath"], "sidecar pending run");
    if (!["starting", "queued", "running"].includes(value.provider.state)) fail("INVALID_SCHEMA", "sidecar pending state is invalid");
    identifier(value.provider.runId, "sidecar pending run.runId"); boundedString(value.provider.phase, "sidecar pending run.phase");
    if (!Number.isSafeInteger(value.provider.pollAfterMs) || value.provider.pollAfterMs < 0) fail("INVALID_SCHEMA", "sidecar pending run.pollAfterMs is invalid");
    if (value.provider.heartbeatAt !== undefined) boundedString(value.provider.heartbeatAt, "sidecar pending run.heartbeatAt");
    if (value.provider.worktreePath !== undefined) sidecarProjectRoot(value.provider.worktreePath, "sidecar pending run.worktreePath");
    return { ...base, provider_run_id: value.provider.runId, state: value.provider.state === "running" ? "running" : "dispatched", raw_status: value.provider.state, terminal: null };
  }
  if (value.provider.kind === "run_interrupted") {
    exactOptional(value.provider, ["kind", "runId", "state", "error", "processGroup", "salvageAllowed", "terminal"], ["worktreePath", "pollAfterMs"], "sidecar interrupted run");
    if (!["interrupted", "orphaned"].includes(value.provider.state) || value.provider.terminal !== false || value.provider.salvageAllowed !== false || !["stopped", "alive", "unknown"].includes(value.provider.processGroup)) fail("INVALID_SCHEMA", "sidecar interrupted run is invalid");
    identifier(value.provider.runId, "sidecar interrupted run.runId"); exact(value.provider.error, ["code", "message"], "sidecar interrupted run.error"); boundedString(value.provider.error.code, "sidecar interrupted run.error.code"); boundedString(value.provider.error.message, "sidecar interrupted run.error.message", 16 * 1024);
    if (value.provider.worktreePath !== undefined) sidecarProjectRoot(value.provider.worktreePath, "sidecar interrupted run.worktreePath");
    if (value.provider.pollAfterMs !== undefined && (!Number.isSafeInteger(value.provider.pollAfterMs) || value.provider.pollAfterMs < 0)) fail("INVALID_SCHEMA", "sidecar interrupted run.pollAfterMs is invalid");
    return { ...base, provider_run_id: value.provider.runId, state: "unknown", raw_status: value.provider.state, terminal: null };
  }
  if (value.provider.kind === "run_error") {
    exactOptional(value.provider, ["kind", "error", "retryable"], ["runId"], "sidecar run error"); exact(value.provider.error, ["code", "message"], "sidecar run error.error"); boundedString(value.provider.error.code, "sidecar run error.error.code"); boundedString(value.provider.error.message, "sidecar run error.error.message", 16 * 1024);
    if (typeof value.provider.retryable !== "boolean") fail("INVALID_SCHEMA", "sidecar run error retryable is invalid");
    if (value.provider.runId !== undefined) identifier(value.provider.runId, "sidecar run error.runId");
    return { ...base, provider_run_id: value.provider.runId ?? null, state: "unknown", raw_status: "run_error", terminal: null };
  }
  if (value.provider.kind !== "run_terminal") fail("INVALID_SCHEMA", "sidecar observation kind is invalid");
  exact(value.provider, ["kind", "runId", "state", "result", "cleanup"], "sidecar terminal run"); identifier(value.provider.runId, "sidecar terminal run.runId");
  if (!["completed", "failed", "cancelled"].includes(value.provider.state) || !["not-requested", "pending", "completed", "failed"].includes(value.provider.cleanup)) fail("INVALID_SCHEMA", "sidecar terminal run is invalid");
  const projected = validateSidecarResult(value.provider.result); const result = value.provider.result;
  const success = value.provider.state === "completed" && result.status === "ok";
  if (success && (result.worktreePreserved !== true || result.worktreePath === undefined)) fail("INVALID_SCHEMA", "successful sidecar work requires a preserved worktree");
  const state = success ? "completed" : value.provider.state === "cancelled" ? "cancelled" : "failed";
  const terminal = result.worktreePath === undefined ? null : { worktree_path: result.worktreePath, changed_files: structuredClone(projected.changedFiles), result_digest: success ? projected.digest : null };
  const workspace_binding_candidate = success ? { schema_version: "dotagents.codex-sidecar.workspace-binding.v1", executor_handle: structuredClone(value.handle), provider_run_id: value.provider.runId, worktree_path: result.worktreePath, observed_state: "completed", result_digest: projected.digest } : null;
  return { ...base, provider_run_id: value.provider.runId, state, raw_status: result.status, terminal, workspace_binding_candidate };
}

export function projectCodexSidecarCancelObservation(value) {
  exact(value, ["handle", "provider"], "sidecar cancel observation"); sidecarHandle(value.handle, "sidecar cancel observation.handle");
  exact(value.provider, ["kind", "runId", "accepted", "terminal", "state", "mode", "pollAfterMs"], "sidecar cancel acknowledgement");
  if (value.provider.kind !== "run_cancel_ack") fail("INVALID_SCHEMA", "sidecar cancel acknowledgement kind is invalid");
  identifier(value.provider.runId, "sidecar cancel acknowledgement.runId");
  if (typeof value.provider.accepted !== "boolean" || typeof value.provider.terminal !== "boolean") fail("INVALID_SCHEMA", "sidecar cancel acknowledgement booleans are invalid");
  if (!["cancellation_requested", "already_requested", "already_terminal"].includes(value.provider.state)) fail("INVALID_SCHEMA", "sidecar cancel acknowledgement state is invalid");
  if (!["pre_start_fenced", "cooperative", "terminal"].includes(value.provider.mode)) fail("INVALID_SCHEMA", "sidecar cancel acknowledgement mode is invalid");
  if (!Number.isSafeInteger(value.provider.pollAfterMs) || value.provider.pollAfterMs < 0) fail("INVALID_SCHEMA", "sidecar cancel acknowledgement.pollAfterMs is invalid");
  return {
    schema_version: SIDECAR_OBSERVATION_SCHEMA, executor_handle: structuredClone(value.handle), provider_run_id: value.provider.runId,
    state: "unknown", raw_status: value.provider.state, terminal: null,
    cancel_acknowledgement: { accepted: value.provider.accepted, terminal_reported: value.provider.terminal, mode: value.provider.mode, poll_after_ms: value.provider.pollAfterMs },
  };
}

export function projectCodexSidecarRecoveryObservation(value) {
  exact(value, ["handle", "provider"], "sidecar recovery observation"); sidecarHandle(value.handle, "sidecar recovery observation.handle");
  exact(value.provider, ["kind", "runId", "runDirectory", "status", "quarantinePublished", "outcome"], "sidecar recovery inspection");
  if (value.provider.kind !== "work_recovery_inspection") fail("INVALID_SCHEMA", "sidecar recovery inspection kind is invalid");
  identifier(value.provider.runId, "sidecar recovery inspection.runId"); sidecarProjectRoot(value.provider.runDirectory, "sidecar recovery inspection.runDirectory");
  if (typeof value.provider.quarantinePublished !== "boolean") fail("INVALID_SCHEMA", "sidecar recovery inspection.quarantinePublished is invalid");
  if (!["inspection", "quarantined", "already-terminal", "result-preserved"].includes(value.provider.outcome)) fail("INVALID_SCHEMA", "sidecar recovery inspection.outcome is invalid");
  const projected = projectCodexSidecarObservation({ handle: value.handle, provider: value.provider.status });
  if (projected.provider_run_id !== null && projected.provider_run_id !== value.provider.runId) fail("PROJECTION_MISMATCH", "recovery wrapper run id differs from nested status");
  return {
    ...projected, provider_run_id: value.provider.runId,
    recovery: { outcome: value.provider.outcome, quarantine_published: value.provider.quarantinePublished },
  };
}
