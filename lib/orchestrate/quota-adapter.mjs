// Provider quota observation adapter (ADR 0054 Wave A, request/projection pure functions).
// Live acquisition (reading account usage) is a separate H-gated entry; this module only
// builds observation request descriptors and projects already-captured provider events into
// dotagents.quota-snapshot.v1. No secrets, cookies, tokens, account identifiers, or raw
// provider payloads may pass through: a `raw` field on any event is rejected loudly.
// Source shapes are pinned by docs/archive/research/2026-07-15-provider-quota-and-claude-runtime.md:
//  - anthropic: Claude Agent SDK RateLimitEvent.rate_limit_info — utilization is a fraction
//    0.0..1.0 of the window consumed, resets_at is a Unix epoch in seconds (SDK reference).
//  - openai: Codex CLI product-owned token_count rate_limits — used_percent is a percentage
//    0..100, window_minutes, resets_at epoch seconds (measured on 0.144.3; schema drift must
//    fail loud, secondary: null is a valid observed shape).
import { validateExecutorEnvelope, validateQuotaSnapshot, QuotaSnapshotError, QUOTA_SNAPSHOT_SCHEMA } from "./quota-snapshot.mjs";

export const QUOTA_OBSERVATION_REQUEST_SCHEMA = "dotagents.quota-observation-request.v1";

// Provider -> product-owned observation entry that can actually yield a snapshot today
// (live-verified 2026-07-17, ADR 0058/0059). The live layer executes the entry with the
// product's own session; the adapter never sees or carries credentials.
// anthropic: the stream rate_limit_event carries no utilization on Claude Code 2.1.211,
// so the statusline rate_limits feed (used_percentage + resets_at) is the working entry.
// The event projection below is kept as the forward-compatible path should the CLI ship
// utilization. xAI stays out of scope per ADR 0054.
export const QUOTA_OBSERVATION_ENTRIES = Object.freeze({
  anthropic: "claude-statusline-rate-limits",
  openai: "codex-token-count-event",
});

// Fixed failure taxonomy: a transport/acquisition failure can only become a typed error,
// never a snapshot (ADR 0054: 取得失敗→typed error).
export const QUOTA_OBSERVATION_FAILURE_CODES = Object.freeze({
  "entry-unavailable": "OBSERVATION_UNAVAILABLE",
  "timeout": "OBSERVATION_TIMEOUT",
  "credential-missing": "CREDENTIAL_MISSING",
  "malformed-event": "EVENT_MALFORMED",
  "schema-drift": "SCHEMA_DRIFT",
});

const ANTHROPIC_WINDOWS = Object.freeze({
  five_hour: Object.freeze({ window_id: "5h", duration_seconds: 5 * 3600, model_family_scope: null }),
  seven_day: Object.freeze({ window_id: "7d", duration_seconds: 7 * 24 * 3600, model_family_scope: null }),
  seven_day_opus: Object.freeze({ window_id: "7d-opus", duration_seconds: 7 * 24 * 3600, model_family_scope: "opus" }),
  seven_day_sonnet: Object.freeze({ window_id: "7d-sonnet", duration_seconds: 7 * 24 * 3600, model_family_scope: "sonnet" }),
});

const RATE_LIMIT_STATUSES = Object.freeze(["allowed", "allowed_warning", "rejected"]);
const MAX_EVENTS = 16;
// Epoch-second sanity bounds: 2001-09-09..2100-01-01. Values outside are drift or unit bugs
// (milliseconds passed as seconds and vice versa), not observations.
const EPOCH_MIN = 1000000000;
const EPOCH_MAX = 4102444800;

export class QuotaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuotaAdapterError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new QuotaAdapterError(code, message); };

const object = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an object`);
};
const exact = (value, keys, name) => {
  object(value, name);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const exactOptional = (value, required, optional, name) => {
  object(value, name);
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key))) fail("INVALID_SCHEMA", `${name} has invalid fields`);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const identifier = (value, name) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail("INVALID_SCHEMA", `${name} is not a bounded identifier`);
};
const boundedString = (value, name, maximum = 256) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("INVALID_SCHEMA", `${name} is not a bounded string`);
};
const epochSecondsToIso = (value, name) => {
  if (!Number.isSafeInteger(value) || value < EPOCH_MIN || value > EPOCH_MAX) fail("EVENT_MALFORMED", `${name} is not a plausible Unix epoch in seconds`);
  return new Date(value * 1000).toISOString();
};
const rejectRawPayload = (value, name) => {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "raw")) fail("EVENT_MALFORMED", `${name} carries a raw provider payload; strip it before projection`);
};

function validateEnvelopeInput(input) {
  identifier(input.quota_pool_id, "input.quota_pool_id");
  identifier(input.host_instance_id, "input.host_instance_id");
  if (!Array.isArray(input.executor_scope) || input.executor_scope.length < 1 || input.executor_scope.length > 32) fail("INVALID_SCHEMA", "input.executor_scope has invalid length");
  try {
    input.executor_scope.forEach((entry, index) => validateExecutorEnvelope(entry, `input.executor_scope[${index}]`));
  } catch (error) {
    if (error instanceof QuotaSnapshotError) fail(error.code, error.message);
    throw error;
  }
}

// Pure request builder: describes what the H-gated live layer must observe. It carries no
// credentials and no account identifiers; the entry runs inside the product-owned session.
export function buildQuotaObservationRequest(input) {
  exact(input, ["provider", "quota_pool_id", "host_instance_id", "executor_scope"], "observation request input");
  if (!Object.hasOwn(QUOTA_OBSERVATION_ENTRIES, input.provider)) fail("INVALID_SCHEMA", "observation request provider is unsupported");
  validateEnvelopeInput(input);
  return {
    schema_version: QUOTA_OBSERVATION_REQUEST_SCHEMA,
    provider: input.provider,
    entry: QUOTA_OBSERVATION_ENTRIES[input.provider],
    credential_policy: "product-owned-session",
    quota_pool_id: input.quota_pool_id,
    host_instance_id: input.host_instance_id,
    executor_scope: structuredClone(input.executor_scope),
  };
}

function finishSnapshot(partial) {
  let snapshot;
  try {
    snapshot = validateQuotaSnapshot(partial);
  } catch (error) {
    if (error instanceof QuotaSnapshotError) fail(error.code, error.message);
    throw error;
  }
  return snapshot;
}

// Wire normalizer: Claude Code CLI stream `rate_limit_event.rate_limit_info` (camelCase)
// -> the SDK-normalized 7-key event shape that projectAnthropicRateLimitEvents consumes.
// Shape pinned by live observation on Claude Code 2.1.211 (2026-07-17): exact wire was
// { status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage }
// — note there is NO utilization on the wire today, so normalization yields utilization:
// null and projection fails loud with UTILIZATION_UNAVAILABLE instead of fabricating
// remaining_bp. utilization/overageResetsAt are accepted when a future CLI adds them.
// isUsingOverage is billing state: validated as boolean, never carried forward.
export function normalizeClaudeCliRateLimitEvent(wire) {
  rejectRawPayload(wire, "rate_limit_info");
  exactOptional(wire, ["status"], ["resetsAt", "rateLimitType", "utilization", "overageStatus", "overageResetsAt", "overageDisabledReason", "isUsingOverage"], "rate_limit_info");
  if (Object.hasOwn(wire, "isUsingOverage") && typeof wire.isUsingOverage !== "boolean") fail("EVENT_MALFORMED", "rate_limit_info.isUsingOverage must be a boolean");
  return {
    status: wire.status,
    resets_at: wire.resetsAt ?? null,
    rate_limit_type: wire.rateLimitType ?? null,
    utilization: wire.utilization ?? null,
    overage_status: wire.overageStatus ?? null,
    overage_resets_at: wire.overageResetsAt ?? null,
    overage_disabled_reason: wire.overageDisabledReason ?? null,
  };
}

// Projection: Claude Agent SDK RateLimitEvent.rate_limit_info entries -> quota snapshot.
// Each event contributes the window named by rate_limit_type. `overage` is billing state,
// not a quota window: it never becomes a window, and events made only of overage cannot
// produce a snapshot (NO_QUOTA_WINDOWS) — no fabricated capacity.
export function projectAnthropicRateLimitEvents(input) {
  exact(input, ["events", "quota_pool_id", "host_instance_id", "executor_scope", "observed_at"], "anthropic projection input");
  validateEnvelopeInput(input);
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > MAX_EVENTS) fail("INVALID_SCHEMA", "input.events has invalid length");
  const windows = []; const seenTypes = new Set();
  for (const [index, event] of input.events.entries()) {
    const name = `input.events[${index}]`;
    rejectRawPayload(event, name);
    exact(event, ["status", "resets_at", "rate_limit_type", "utilization", "overage_status", "overage_resets_at", "overage_disabled_reason"], name);
    if (!RATE_LIMIT_STATUSES.includes(event.status)) fail("EVENT_MALFORMED", `${name}.status is not a known rate limit status`);
    if (event.overage_status !== null && !RATE_LIMIT_STATUSES.includes(event.overage_status)) fail("EVENT_MALFORMED", `${name}.overage_status is not a known rate limit status`);
    if (event.overage_resets_at !== null) epochSecondsToIso(event.overage_resets_at, `${name}.overage_resets_at`);
    if (event.overage_disabled_reason !== null) boundedString(event.overage_disabled_reason, `${name}.overage_disabled_reason`, 256);
    if (event.rate_limit_type === null) fail("EVENT_MALFORMED", `${name}.rate_limit_type is missing; the event does not name a window`);
    if (seenTypes.has(event.rate_limit_type)) fail("EVENT_MALFORMED", `${name}.rate_limit_type is duplicated across events`);
    seenTypes.add(event.rate_limit_type);
    if (event.rate_limit_type === "overage") continue;
    const shape = ANTHROPIC_WINDOWS[event.rate_limit_type];
    if (shape === undefined) fail("SCHEMA_DRIFT", `${name}.rate_limit_type is not a known window type; characterize the new shape before projecting`);
    // SDK reference pins utilization as the consumed fraction 0.0..1.0 (not a percentage).
    // Live 2026-07-17 (Claude Code 2.1.211): the wire event carries no utilization at all,
    // so a null here is the current healthy reality — a window observation that cannot
    // yield remaining_bp. Fail loud with a dedicated code instead of fabricating capacity.
    if (event.utilization === null) fail("UTILIZATION_UNAVAILABLE", `${name} reports window ${event.rate_limit_type} without utilization; this entry cannot produce a snapshot`);
    if (typeof event.utilization !== "number" || !Number.isFinite(event.utilization) || event.utilization < 0 || event.utilization > 1) fail("EVENT_MALFORMED", `${name}.utilization is not a fraction between 0 and 1`);
    if (event.resets_at === null) fail("EVENT_MALFORMED", `${name}.resets_at is missing; a window without reset cannot be projected`);
    windows.push({
      window_id: shape.window_id,
      duration_seconds: shape.duration_seconds,
      reset_at: epochSecondsToIso(event.resets_at, `${name}.resets_at`),
      remaining_bp: 10000 - Math.round(event.utilization * 10000),
      model_family_scope: shape.model_family_scope,
    });
  }
  if (windows.length === 0) fail("NO_QUOTA_WINDOWS", "anthropic events carried no quota window; do not fabricate capacity");
  return finishSnapshot({
    schema_version: QUOTA_SNAPSHOT_SCHEMA,
    quota_pool_id: input.quota_pool_id,
    host_instance_id: input.host_instance_id,
    executor_scope: structuredClone(input.executor_scope),
    provider: "anthropic",
    windows,
    observed_at: input.observed_at,
    source: "provider-api",
    confidence: "reported",
  });
}

// Projection: Claude Code statusline input `rate_limits` -> quota snapshot. Live-verified
// on 2.1.211 (2026-07-17): { five_hour?, seven_day? }, each window is
// { used_percentage: 0..100 (float, may carry FP noise), resets_at: epoch seconds }, and
// each may be independently absent (official contract; both absent means the feed has not
// seen an API response yet — no window, no snapshot). This is the working Anthropic entry;
// unlike the stream event it carries a usable remaining percentage.
export function projectAnthropicStatuslineRateLimits(input) {
  exact(input, ["rate_limits", "quota_pool_id", "host_instance_id", "executor_scope", "observed_at"], "statusline projection input");
  validateEnvelopeInput(input);
  rejectRawPayload(input.rate_limits, "input.rate_limits");
  exactOptional(input.rate_limits, [], ["five_hour", "seven_day"], "input.rate_limits");
  const windows = [];
  for (const key of ["five_hour", "seven_day"]) {
    const value = input.rate_limits[key];
    if (value === undefined) continue;
    const name = `input.rate_limits.${key}`;
    rejectRawPayload(value, name);
    exact(value, ["used_percentage", "resets_at"], name);
    if (typeof value.used_percentage !== "number" || !Number.isFinite(value.used_percentage) || value.used_percentage < 0 || value.used_percentage > 100) fail("EVENT_MALFORMED", `${name}.used_percentage is not a percentage between 0 and 100`);
    const shape = ANTHROPIC_WINDOWS[key];
    windows.push({
      window_id: shape.window_id,
      duration_seconds: shape.duration_seconds,
      reset_at: epochSecondsToIso(value.resets_at, `${name}.resets_at`),
      remaining_bp: 10000 - Math.round(value.used_percentage * 100),
      model_family_scope: shape.model_family_scope,
    });
  }
  if (windows.length === 0) fail("NO_QUOTA_WINDOWS", "statusline carried no rate limit window; do not fabricate capacity");
  return finishSnapshot({
    schema_version: QUOTA_SNAPSHOT_SCHEMA,
    quota_pool_id: input.quota_pool_id,
    host_instance_id: input.host_instance_id,
    executor_scope: structuredClone(input.executor_scope),
    provider: "anthropic",
    windows,
    observed_at: input.observed_at,
    source: "app-ui",
    confidence: "reported",
  });
}

function projectCodexWindow(value, limitId, slot) {
  const name = `input.event.${slot}`;
  exact(value, ["used_percent", "window_minutes", "resets_at"], name);
  if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent) || value.used_percent < 0 || value.used_percent > 100) fail("EVENT_MALFORMED", `${name}.used_percent is not a percentage between 0 and 100`);
  if (!Number.isSafeInteger(value.window_minutes) || value.window_minutes <= 0) fail("EVENT_MALFORMED", `${name}.window_minutes is not a positive integer`);
  return {
    window_id: `${limitId}-${slot}`,
    duration_seconds: value.window_minutes * 60,
    reset_at: epochSecondsToIso(value.resets_at, `${name}.resets_at`),
    remaining_bp: 10000 - Math.round(value.used_percent * 100),
    model_family_scope: null,
  };
}

// Projection: Codex CLI product-owned token_count rate_limits -> quota snapshot.
// Shape pinned on 0.144.3 by two live observations: the 2026-07-15 excerpt
// { limit_id, primary, secondary } and the 2026-07-17 full event which adds
// { limit_name, credits, individual_limit, plan_type, rate_limit_reached_type }.
// Each slot is null or { used_percent, window_minutes, resets_at }; secondary: null is a
// valid observed shape. credits/plan_type are billing/account state: validated as bounded
// input but never projected into the snapshot. individual_limit has only been observed as
// null — a non-null value is an uncharacterized window source and fails loud as drift.
// Any other field is schema drift and fails loud.
export function projectCodexTokenCountEvent(input) {
  exact(input, ["event", "quota_pool_id", "host_instance_id", "executor_scope", "observed_at"], "codex projection input");
  validateEnvelopeInput(input);
  rejectRawPayload(input.event, "input.event");
  exactOptional(input.event, ["limit_id", "primary", "secondary"], ["limit_name", "credits", "individual_limit", "plan_type", "rate_limit_reached_type"], "input.event");
  identifier(input.event.limit_id, "input.event.limit_id");
  if (input.event.limit_name !== undefined && input.event.limit_name !== null) boundedString(input.event.limit_name, "input.event.limit_name", 128);
  if (input.event.plan_type !== undefined && input.event.plan_type !== null) boundedString(input.event.plan_type, "input.event.plan_type", 64);
  if (input.event.rate_limit_reached_type !== undefined && input.event.rate_limit_reached_type !== null) boundedString(input.event.rate_limit_reached_type, "input.event.rate_limit_reached_type", 64);
  if (input.event.credits !== undefined && input.event.credits !== null) {
    exact(input.event.credits, ["has_credits", "unlimited", "balance"], "input.event.credits");
    if (typeof input.event.credits.has_credits !== "boolean" || typeof input.event.credits.unlimited !== "boolean") fail("EVENT_MALFORMED", "input.event.credits flags must be booleans");
    boundedString(input.event.credits.balance, "input.event.credits.balance", 64);
  }
  if (input.event.individual_limit !== undefined && input.event.individual_limit !== null) fail("SCHEMA_DRIFT", "input.event.individual_limit is non-null and uncharacterized; characterize the new shape before projecting");
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const value = input.event[slot];
    if (value === null) continue;
    rejectRawPayload(value, `input.event.${slot}`);
    windows.push(projectCodexWindow(value, input.event.limit_id, slot));
  }
  if (windows.length === 0) fail("NO_QUOTA_WINDOWS", "codex event carried no quota window; do not fabricate capacity");
  return finishSnapshot({
    schema_version: QUOTA_SNAPSHOT_SCHEMA,
    quota_pool_id: input.quota_pool_id,
    host_instance_id: input.host_instance_id,
    executor_scope: structuredClone(input.executor_scope),
    provider: "openai",
    windows,
    observed_at: input.observed_at,
    source: "provider-api",
    confidence: "reported",
  });
}

// Acquisition failures become typed errors and nothing else. This function never returns:
// the live layer routes every non-success outcome through here so a failure can never be
// silently shaped into a snapshot or an implicit fallback placement.
export function projectQuotaObservationFailure(input) {
  exact(input, ["provider", "failure_kind", "detail"], "observation failure input");
  if (!Object.hasOwn(QUOTA_OBSERVATION_ENTRIES, input.provider)) fail("INVALID_SCHEMA", "observation failure provider is unsupported");
  if (!Object.hasOwn(QUOTA_OBSERVATION_FAILURE_CODES, input.failure_kind)) fail("INVALID_SCHEMA", "observation failure kind is unsupported");
  boundedString(input.detail, "input.detail", 512);
  fail(QUOTA_OBSERVATION_FAILURE_CODES[input.failure_kind], `${input.provider} quota observation failed: ${input.detail}`);
}
