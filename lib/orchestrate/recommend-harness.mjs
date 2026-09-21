// recommend-harness: one call returns a child candidate. It does not launch a child
// or change the parent. Jev may only choose a real candidate id. Code writes the
// short reason from that id and the quota observation. The rank table is not sent.
import { readFileSync } from "node:fs";

import { collectHarnessQuotas } from "./quota-collect.mjs";
import { explicitSupport } from "./recommendation-contract.mjs";

export const RECOMMEND_HARNESS_SCHEMA = "dotagents.recommend-harness.v1";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const NONE = "none";

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
    failure: fields.failure ?? null,
  };
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

export function jevQuestion(catalog, candidates, collection) {
  const criteria = { [NONE]: "No listed candidate fits the task." };
  for (const candidate of candidates) {
    criteria[candidate.candidate_id] = `${candidate.label}; ${candidate.harness}; ${candidate.family}; ${candidate.effort}; pool ${candidate.pool_id}`;
  }
  return {
    model: "jev-latest",
    state: {
      task: collection.task,
      observations: collection.pools.map((pool) => ({
        pool_id: pool.pool_id,
        status: pool.status,
        observed_at: pool.observed_at,
      })),
    },
    questions: {
      candidate: {
        type: "choice",
        instructions: "Choose the candidate id whose harness, family, and effort match the task. Choose none only when no option matches. Unavailable observations are not remaining capacity.",
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
  collection.task = input.task;
  if (input.explicit) {
    const support = explicitSupport(catalog, input.explicit);
    if (!support.ok) {
      return result({
        status: "explicit_unsupported",
        observed_at: observedAt,
        reason: support.code,
        failure: { code: support.code, detail: "explicit harness family effort is not a selectable candidate" },
      });
    }
    const observation = poolObservation(collection, support.candidate.pool_id);
    return result({
      status: "recommended",
      observed_at: observedAt,
      reason: reasonFor(support.candidate, observation, observedAt),
      quota_comparison: observation?.status === "measured" ? "established" : "not_established",
      recommendation: recommendationOf(support.candidate),
    });
  }
  const candidates = catalog.candidates.filter((candidate) => candidate.selectable);
  if (candidates.length === 0) {
    return result({ status: "no_candidate", observed_at: observedAt, reason: "no selectable candidate" });
  }
  const request = dependencies.request ?? fetch;
  const loadKey = dependencies.loadKey ?? (async () => {
    const { loadTypeSafeKey } = await import("../factory/typesafe-credentials.mjs");
    return loadTypeSafeKey();
  });
  const body = jevQuestion(catalog, candidates, collection);
  const jev = await callJev(body, request, loadKey);
  if (!jev.ok) {
    return result({ status: "jev_failed", observed_at: observedAt, failure: { code: jev.code, detail: jev.detail } });
  }
  const answer = jev.payload?.answers?.candidate;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    return result({ status: "jev_failed", observed_at: observedAt, failure: { code: "JEV_ANSWER_MALFORMED", detail: "choice answer is missing" } });
  }
  if (answer.choice === NONE) {
    return result({ status: "no_candidate", observed_at: observedAt, reason: "jev chose none" });
  }
  const candidate = candidates.find((item) => item.candidate_id === answer.choice);
  if (!candidate) {
    return result({ status: "jev_failed", observed_at: observedAt, failure: { code: "JEV_CHOICE_UNKNOWN", detail: "jev returned an id outside the candidate list" } });
  }
  const observation = poolObservation(collection, candidate.pool_id);
  return result({
    status: "recommended",
    observed_at: observedAt,
    reason: reasonFor(candidate, observation, observedAt),
    quota_comparison: observation?.status === "measured" ? "established" : "not_established",
    recommendation: recommendationOf(candidate),
  });
}
