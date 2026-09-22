// recommend-harness: one call returns a child candidate. It does not launch a child
// or change the parent.
// Division of judgment (plan 工程2): the owner's rank table in docs/02_models.md is the
// judgment basis and is handed to Jev as the role list. Jev classifies the task into one of
// those roles and grades its difficulty; code walks that role's ranks in order, applies the
// Cursor-first harness order, and excludes only pools that are measured empty or whose
// window expired. An unobserved pool stays eligible and the result says the quota
// comparison is not established. Jev never picks a model by its own general knowledge
// (2026-09-22 実測: 名前と effort だけ渡すと 4 任務すべてが Sonnet 5 に寄った).
import { readFileSync } from "node:fs";

import { collectHarnessQuotas } from "./quota-collect.mjs";
import { explicitSupport, orderMatchingCandidates, parseRankTable } from "./recommendation-contract.mjs";

export const RECOMMEND_HARNESS_SCHEMA = "dotagents.recommend-harness.v1";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const NONE = "none";
const DIFFICULTIES = Object.freeze({
  light: "a small local change or lookup that needs little reasoning",
  ordinary: "ordinary implementation, debugging, or investigation",
  hard: "difficult design, cross-repo change, or adversarial review",
});

const catalogUrl = new URL("./model-candidates.json", import.meta.url);
const modelsDocUrl = new URL("../../docs/02_models.md", import.meta.url);

export function loadRecommendationCatalog(read = readFileSync) {
  return JSON.parse(read(catalogUrl, "utf8"));
}

export function loadRankTable(read = readFileSync) {
  return parseRankTable(read(modelsDocUrl, "utf8"));
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

// Jev sees the task and the owner's role vocabulary from the rank table. Quota state is not
// sent: an unobserved pool must not read as "no capacity" (2026-09-22 実測: observations を
// 渡すと実任務4件すべてが none になった).
export function jevQuestion(task, rankTable) {
  const roleCriteria = { [NONE]: "The task fits none of the listed roles." };
  for (const { role, ranks } of rankTable) {
    roleCriteria[role] = `${role}: ${ranks.map((rank) => rank.family + (rank.efforts[0] === null ? "" : `×${rank.efforts.join("〜")}`)).join(", ")}`;
  }
  return {
    model: "jev-latest",
    state: { task },
    questions: {
      role: {
        type: "choice",
        instructions: "Classify the task into the role whose work it most resembles. The listed models are the owner's ranked picks for that role; use them only to understand what kind of work the role means. Choose none only when the task fits no role.",
        criteria: roleCriteria,
      },
      difficulty: {
        type: "choice",
        instructions: "Grade how much reasoning the task needs.",
        criteria: { ...DIFFICULTIES },
      },
    },
  };
}

// A rank entry lists one effort or a range (e.g. low〜medium). A range resolves by the graded
// difficulty: hard takes the upper end, anything else the lower end.
function effortFor(rank, difficulty) {
  return difficulty === "hard" ? rank.efforts.at(-1) : rank.efforts[0];
}

function choiceOf(payload, question) {
  const answer = payload?.answers?.[question];
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  return answer.choice;
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
  const rankTable = input.rank_table ?? loadRankTable();
  const request = dependencies.request ?? fetch;
  const loadKey = dependencies.loadKey ?? (async () => {
    const { loadTypeSafeKey } = await import("../factory/typesafe-credentials.mjs");
    return loadTypeSafeKey();
  });
  const body = jevQuestion(input.task, rankTable);
  const jev = await callJev(body, request, loadKey);
  if (!jev.ok) {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: jev.code, detail: jev.detail } });
  }
  const role = choiceOf(jev.payload, "role");
  const difficulty = choiceOf(jev.payload, "difficulty");
  if (role === null || difficulty === null) {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: "JEV_ANSWER_MALFORMED", detail: "role or difficulty answer is missing" } });
  }
  if (role === NONE) {
    return result({ status: "no_candidate", observed_at: observedAt, reason: "jev matched no role", observations, excluded_pools: excluded });
  }
  const entry = rankTable.find((item) => item.role === role);
  if (!entry || !Object.hasOwn(DIFFICULTIES, difficulty)) {
    return result({ status: "jev_failed", observed_at: observedAt, observations, excluded_pools: excluded, failure: { code: "JEV_CHOICE_UNKNOWN", detail: "jev returned a role or difficulty outside the offered list" } });
  }
  // Walk the owner's ranks in order; a rank is skipped only when every harness for it sits
  // on an excluded pool or the catalog has no selectable candidate for that family×effort.
  const skipped = [];
  for (const [index, rank] of entry.ranks.entries()) {
    const effort = effortFor(rank, difficulty);
    const ordered = orderMatchingCandidates(catalog, rank.family, effort);
    const chosen = ordered.find((candidate) => eligiblePool(candidate.pool_id));
    if (!chosen) {
      skipped.push(`${rank.family}×${effort ?? "unsupported"}`);
      continue;
    }
    const detail = [`role ${role} rank ${index + 1} ${difficulty}`];
    if (ordered[0].candidate_id !== chosen.candidate_id) detail.push(`skipped pool ${ordered[0].pool_id}`);
    if (skipped.length > 0) detail.push(`skipped rank ${skipped.join(", ")}`);
    return recommended(chosen, `; ${detail.join("; ")}`);
  }
  return result({
    status: excluded.length > 0 ? "quota_exhausted" : "no_candidate",
    observed_at: observedAt,
    reason: `role ${role}: no rank is selectable (${skipped.join(", ")})`,
    observations,
    excluded_pools: excluded,
  });
}
