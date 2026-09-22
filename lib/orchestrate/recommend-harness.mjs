// recommend-harness: one call returns a child candidate. It does not launch a child
// or change the parent.
// Division of judgment (plan 工程2): Jev judges task fit and the effort it needs, choosing a
// real family×effort pair. Code owns availability: Cursor-first harness order and quota
// exclusion. A pool is excluded only when it is measured and empty, or its window expired;
// an unobserved pool stays eligible and the result says the comparison is not established.
// The rank table is not sent to Jev.
import { readFileSync } from "node:fs";

import { collectHarnessQuotas } from "./quota-collect.mjs";
import { explicitSupport, orderMatchingCandidates } from "./recommendation-contract.mjs";

export const RECOMMEND_HARNESS_SCHEMA = "dotagents.recommend-harness.v1";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const NONE = "none";
const UNSUPPORTED_EFFORT = "unsupported";

const catalogUrl = new URL("./model-candidates.json", import.meta.url);

export function loadRecommendationCatalog(read = readFileSync) {
  return JSON.parse(read(catalogUrl, "utf8"));
}

function result(fields) {
  return {
    schema: RECOMMEND_HARNESS_SCHEMA,
    status: fields.status,
    parent_changed: false,
    observed_at: fields.observed_at,
    reason: fields.reason ?? null,
    quota_comparison: fields.quota_comparison ?? "not_established",
    recommendation: fields.recommendation ?? null,
    observations: fields.observations ?? [],
    excluded_pools: fields.excluded_pools ?? [],
    failure: fields.failure ?? null,
  };
}

function observationsOf(collection) {
  return collection.pools.map((pool) => ({ pool_id: pool.pool_id, status: pool.status }));
}

// Remaining basis points of a measured pool: the tightest window decides.
function remainingBp(record) {
  if (record?.status !== "measured") return null;
  return Math.min(...record.snapshot.windows.map((window) => window.remaining_bp));
}

function poolExhausted(record) {
  return record?.status === "expired" || remainingBp(record) === 0;
}

function excludedPools(collection) {
  return collection.pools
    .filter(poolExhausted)
    .map((pool) => ({ pool_id: pool.pool_id, reason: pool.status === "expired" ? "window_expired" : "remaining_bp_0" }));
}

export const pairKey = (candidate) => `${candidate.family}/${candidate.effort ?? UNSUPPORTED_EFFORT}`;

function parsePairKey(key) {
  const at = key.lastIndexOf("/");
  const effort = key.slice(at + 1);
  return { family: key.slice(0, at), effort: effort === UNSUPPORTED_EFFORT ? null : effort };
}

function recommendationOf(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    harness: candidate.harness,
    family: candidate.family,
    model_id: candidate.model_id,
    effort_binding: candidate.effort_binding,
    effort: candidate.effort,
    pool_id: candidate.pool_id,
  };
}

function reasonFor(candidate, observation, observedAt) {
  const status = observation?.status ?? "observation_unavailable";
  return `${candidate.candidate_id}; pool ${candidate.pool_id} ${status}; observed_at ${observedAt}`;
}

function poolObservation(collection, poolId) {
  return collection.pools.find((pool) => pool.pool_id === poolId) ?? null;
}

// Jev sees the task and the family×effort pairs that have at least one eligible harness.
// Quota state is not sent: an unobserved pool must not read as "no capacity" (2026-09-22
// 実測: observations を渡すと実任務4件すべてが none になった).
export function jevQuestion(task, candidates) {
  const criteria = { [NONE]: "No listed model could do this task." };
  for (const candidate of candidates) {
    const key = pairKey(candidate);
    if (Object.hasOwn(criteria, key)) continue;
    criteria[key] = candidate.effort === null
      ? `${candidate.label}, effort not selectable`
      : `${candidate.label}, effort ${candidate.effort}`;
  }
  return {
    model: "jev-latest",
    state: { task },
    questions: {
      candidate: {
        type: "choice",
        instructions: "Pick the model family and reasoning effort that best fit this task. Effort should be proportional to difficulty: low for small local edits, medium for ordinary implementation and debugging, high or above for hard design, cross-repo, or adversarial review work. Choose none only when no listed model could do the task.",
        criteria,
      },
    },
  };
}

async function callJev(body, request, loadKey) {
  let key;
  try {
    key = await loadKey();
  } catch {
    return { ok: false, code: "JEV_CREDENTIAL_MISSING", detail: "typesafe credential is unavailable" };
  }
  if (typeof key !== "string" || key.length === 0) return { ok: false, code: "JEV_CREDENTIAL_MISSING", detail: "typesafe credential is unavailable" };
  let response;
  try {
    response = await request(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return { ok: false, code: "JEV_UNREACHABLE", detail: "typesafe api unreachable" };
  }
  if (!response.ok) return { ok: false, code: `JEV_HTTP_${response.status}`, detail: "typesafe api rejected the request" };
  try {
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, code: "JEV_INVALID_JSON", detail: "typesafe api returned invalid json" };
  }
}

export async function recommendHarness(input, dependencies = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return result({ status: "invalid", observed_at: null, failure: { code: "INVALID_SCHEMA", detail: "input must be an object" } });
  }
  if (typeof input.task !== "string" || input.task.length === 0 || input.task.length > 2000) {
    return result({ status: "invalid", observed_at: input.observed_at ?? null, failure: { code: "INVALID_SCHEMA", detail: "task must be a short string" } });
  }
  const observedAt = input.observed_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    return result({ status: "invalid", observed_at: null, failure: { code: "INVALID_SCHEMA", detail: "observed_at is not canonical ISO UTC" } });
  }
  const catalog = input.catalog ?? loadRecommendationCatalog();
  const captures = input.captures ?? {};
  let collection;
  try {
    collection = collectHarnessQuotas({ catalog, observed_at: observedAt, captures });
  } catch (error) {
    return result({ status: "invalid", observed_at: observedAt, failure: { code: error.code ?? "INVALID_SCHEMA", detail: error.message } });
  }
  const observations = observationsOf(collection);
  const excluded = excludedPools(collection);
  const eligiblePool = (poolId) => !excluded.some((pool) => pool.pool_id === poolId);
  const recommended = (candidate, extra = "") => {
    const observation = poolObservation(collection, candidate.pool_id);
    return result({
      status: "recommended",
      observed_at: observedAt,
      reason: `${reasonFor(candidate, observation, observedAt)}${extra}`,
      quota_comparison: observation?.status === "measured" ? "established" : "not_established",
      recommendation: recommendationOf(candidate),
      observations,
      excluded_pools: excluded,
    });
  };
  if (input.explicit) {
    const support = explicitSupport(catalog, input.explicit);
    if (!support.ok) {
      return result({
        status: "explicit_unsupported",
        observed_at: observedAt,
        reason: support.code,
        observations,
        excluded_pools: excluded,
        failure: { code: support.code, detail: "explicit harness family effort is not a selectable candidate" },
      });
    }
    if (!eligiblePool(support.candidate.pool_id)) {
      return result({
        status: "quota_exhausted",
        observed_at: observedAt,
        reason: `pool ${support.candidate.pool_id} has no remaining capacity`,
        observations,
        excluded_pools: excluded,
      });
    }
    return recommended(support.candidate);
  }
  const candidates = catalog.candidates.filter((candidate) => candidate.selectable && eligiblePool(candidate.pool_id));
  if (candidates.length === 0) {
    return result({ status: "no_candidate", observed_at: observedAt, reason: "no selectable candidate with remaining capacity", observations, excluded_pools: excluded });
  }
  const request = dependencies.request ?? fetch;
  const loadKey = dependencies.loadKey ?? (async () => {
    const { loadTypeSafeKey } = await import("../factory/typesafe-credentials.mjs");
    return loadTypeSafeKey();
  });
  const body = jevQuestion(input.task, candidates);
  const jev = await callJev(body, request, loadKey);
  if (!jev.ok) {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: jev.code, detail: jev.detail } });
  }
  const answer = jev.payload?.answers?.candidate;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: "JEV_ANSWER_MALFORMED", detail: "choice answer is missing" } });
  }
  if (answer.choice === NONE) {
    return result({ status: "no_candidate", observed_at: observedAt, reason: "jev chose none", observations, excluded_pools: excluded });
  }
  if (!Object.hasOwn(body.questions.candidate.criteria, answer.choice)) {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: "JEV_CHOICE_UNKNOWN", detail: "jev returned a pair outside the offered list" } });
  }
  const { family, effort } = parsePairKey(answer.choice);
  const ordered = orderMatchingCandidates(catalog, family, effort);
  const chosen = ordered.find((candidate) => eligiblePool(candidate.pool_id));
  const skipped = ordered[0].candidate_id === chosen.candidate_id ? "" : `; skipped ${ordered[0].pool_id}`;
  return recommended(chosen, skipped);
}
