// One-call quota collection for harness recommendation (hmer-004).
// Pool identity comes from the catalog's programmatic entry, not from the provider name.
// Dashboard-only pools stay observation_unavailable. This module never reads credentials,
// cookies, tokens, or account identifiers, and never turns a missing feed into remaining_bp.
import {
  QuotaAdapterError,
  QUOTA_OBSERVATION_FAILURE_CODES,
  projectAnthropicStatuslineRateLimits,
  projectCodexTokenCountEvent,
} from "./quota-adapter.mjs";

export const QUOTA_COLLECTION_SCHEMA = "dotagents.quota-collection.v1";

const PROGRAMMATIC = Object.freeze({
  "observation_unavailable": "observation_unavailable",
  "claude-statusline-rate-limits": "claude-statusline-rate-limits",
  "codex-token-count-event": "codex-token-count-event",
});

const RECORD_STATUSES = Object.freeze(["measured", "observation_unavailable", "stale", "expired", "error"]);

export class QuotaCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuotaCollectionError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new QuotaCollectionError(code, message); };

const object = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", `${name} must be an object`);
};
const exact = (value, keys, name) => {
  object(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("INVALID_SCHEMA", `${name} has invalid fields`);
};
const boundedString = (value, name, maximum = 512) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("INVALID_SCHEMA", `${name} is not a bounded string`);
};
const timestamp = (value, name) => {
  boundedString(value, name, 64);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail("INVALID_SCHEMA", `${name} is not canonical ISO UTC`);
};
const identifier = (value, name) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail("INVALID_SCHEMA", `${name} is not a bounded identifier`);
};

function rejectInjectedMeasurement(capture, poolId) {
  if (capture === undefined) return;
  object(capture, `captures.${poolId}`);
  if (Object.hasOwn(capture, "raw")) fail("INVALID_SCHEMA", `captures.${poolId} carries a raw payload`);
  for (const key of ["remaining_bp", "used_percent", "used_percentage", "rate_limits", "event"]) {
    if (Object.hasOwn(capture, key)) fail("INVALID_SCHEMA", `captures.${poolId} cannot supply a measurement for an unavailable pool`);
  }
}

function failureRecord(pool, observedAt, code, detail) {
  return {
    pool_id: pool.id,
    programmatic: pool.programmatic,
    status: "error",
    observed_at: observedAt,
    snapshot: null,
    failure: { code, detail },
  };
}

function projectCapture(pool, observedAt, capture) {
  const name = `captures.${pool.id}`;
  object(capture, name);
  if (Object.hasOwn(capture, "raw")) fail("INVALID_SCHEMA", `${name} carries a raw payload`);
  if (Object.hasOwn(capture, "failure_kind")) {
    exact(capture, ["failure_kind", "detail"], name);
    if (!Object.hasOwn(QUOTA_OBSERVATION_FAILURE_CODES, capture.failure_kind)) fail("INVALID_SCHEMA", `${name}.failure_kind is unsupported`);
    boundedString(capture.detail, `${name}.detail`);
    return failureRecord(pool, observedAt, QUOTA_OBSERVATION_FAILURE_CODES[capture.failure_kind], capture.detail);
  }
  if (capture.observed_at !== undefined) {
    timestamp(capture.observed_at, `${name}.observed_at`);
    if (capture.observed_at !== observedAt) {
      return {
        pool_id: pool.id,
        programmatic: pool.programmatic,
        status: "stale",
        observed_at: observedAt,
        snapshot: null,
        failure: { code: "STALE_OBSERVATION", detail: `${pool.id} capture is not the current collection time` },
      };
    }
  }
  const projectedInput = { ...capture, quota_pool_id: pool.id, observed_at: observedAt };
  delete projectedInput.observed_at;
  projectedInput.observed_at = observedAt;
  try {
    const snapshot = pool.programmatic === "claude-statusline-rate-limits"
      ? projectAnthropicStatuslineRateLimits(projectedInput)
      : projectCodexTokenCountEvent(projectedInput);
    return {
      pool_id: pool.id,
      programmatic: pool.programmatic,
      status: "measured",
      observed_at: observedAt,
      snapshot,
      failure: null,
    };
  } catch (error) {
    if (!(error instanceof QuotaAdapterError)) throw error;
    if (error.code === "INVALID_SCHEMA") throw new QuotaCollectionError(error.code, error.message);
    const status = error.code === "WINDOW_CONTRADICTION" ? "expired" : "error";
    return {
      pool_id: pool.id,
      programmatic: pool.programmatic,
      status,
      observed_at: observedAt,
      snapshot: null,
      failure: { code: error.code, detail: error.message },
    };
  }
}

function collectPool(pool, observedAt, captures) {
  if (!Object.hasOwn(PROGRAMMATIC, pool.programmatic)) fail("INVALID_SCHEMA", `pool ${pool.id} programmatic entry is unsupported`);
  const capture = captures[pool.id];
  if (pool.programmatic === "observation_unavailable") {
    rejectInjectedMeasurement(capture, pool.id);
    return {
      pool_id: pool.id,
      programmatic: pool.programmatic,
      status: "observation_unavailable",
      observed_at: observedAt,
      snapshot: null,
      failure: null,
    };
  }
  if (capture === undefined) {
    return failureRecord(pool, observedAt, "OBSERVATION_UNAVAILABLE", `${pool.id} has no product-owned capture in this call`);
  }
  return projectCapture(pool, observedAt, capture);
}

// catalog.pools is the recommendation catalog. One record per pool_id, never per member family.
export function collectHarnessQuotas(input) {
  exact(input, ["catalog", "observed_at", "captures"], "quota collection");
  object(input.catalog, "catalog");
  if (!Array.isArray(input.catalog.pools) || input.catalog.pools.length < 1 || input.catalog.pools.length > 64) fail("INVALID_SCHEMA", "catalog.pools has invalid length");
  timestamp(input.observed_at, "observed_at");
  object(input.captures, "captures");
  const seen = new Set();
  const pools = input.catalog.pools.map((pool) => {
    object(pool, "catalog.pools[]");
    identifier(pool.id, "catalog.pools[].id");
    boundedString(pool.programmatic, "catalog.pools[].programmatic", 128);
    if (seen.has(pool.id)) fail("INVALID_SCHEMA", `catalog.pools contains duplicate pool ${pool.id}`);
    seen.add(pool.id);
    return collectPool(pool, input.observed_at, input.captures);
  });
  for (const record of pools) {
    if (!RECORD_STATUSES.includes(record.status)) fail("INVALID_SCHEMA", "collection status is invalid");
  }
  return {
    schema_version: QUOTA_COLLECTION_SCHEMA,
    observed_at: input.observed_at,
    pools,
  };
}
