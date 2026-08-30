import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QuotaAdapterError, QUOTA_OBSERVATION_ENTRIES, QUOTA_OBSERVATION_FAILURE_CODES,
  QUOTA_OBSERVATION_REQUEST_SCHEMA, buildQuotaObservationRequest, normalizeClaudeCliRateLimitEvent,
  projectAnthropicRateLimitEvents, projectAnthropicStatuslineRateLimits, projectCodexTokenCountEvent,
  projectQuotaObservationFailure,
} from "../../lib/orchestrate/quota-adapter.mjs";
import { quotaSnapshotDigest } from "../../lib/orchestrate/quota-snapshot.mjs";
import { makeQuotaExecutor as makeExecutor } from "./helpers.mjs";

const code = (expected) => (error) => {
  assert.ok(error instanceof QuotaAdapterError, `QuotaAdapterError expected, got ${error?.constructor?.name}`);
  assert.equal(error.code, expected);
  return true;
};

// observed_at 2026-07-17T00:00:00.000Z = epoch 1784246400
const OBSERVED_AT = "2026-07-17T00:00:00.000Z";
const claudeExecutor = () => makeExecutor({ adapter_id: "claude-native", handle_schema_id: "claude-native.session.v1" });

const makeRateLimitInfo = (overrides = {}) => ({
  status: "allowed",
  resets_at: 1784260800, // 2026-07-17T04:00:00.000Z（5h窓の残り4h）
  rate_limit_type: "five_hour",
  utilization: 0.3,
  overage_status: null,
  overage_resets_at: null,
  overage_disabled_reason: null,
  ...overrides,
});

const anthropicInput = (overrides = {}) => ({
  events: [makeRateLimitInfo()],
  quota_pool_id: "anthropic-sub-main",
  host_instance_id: "host-mac-main",
  executor_scope: [claudeExecutor()],
  observed_at: OBSERVED_AT,
  ...overrides,
});

// Codex CLI 0.144.3 の実測token_count rate_limits（docs/archive/research/2026-07-15-provider-quota-and-claude-runtime.md）
const makeCodexEvent = (overrides = {}) => ({
  limit_id: "codex",
  primary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1784666224 },
  secondary: null,
  ...overrides,
});

const codexInput = (overrides = {}) => ({
  event: makeCodexEvent(),
  quota_pool_id: "openai-sub-main",
  host_instance_id: "host-mac-main",
  executor_scope: [makeExecutor()],
  observed_at: OBSERVED_AT,
  ...overrides,
});

test("観測requestは秘密なしのproduct-owned entry記述だけを返す", () => {
  const request = buildQuotaObservationRequest({
    provider: "anthropic", quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()],
  });
  assert.equal(request.schema_version, QUOTA_OBSERVATION_REQUEST_SCHEMA);
  // 2026-07-17 live実測: stream eventはutilization不在のため、成立する入口はstatusline（ADR 0059）
  assert.equal(request.entry, "claude-statusline-rate-limits");
  assert.equal(request.credential_policy, "product-owned-session");
  assert.deepEqual(Object.keys(request).sort(), ["credential_policy", "entry", "executor_scope", "host_instance_id", "provider", "quota_pool_id", "schema_version"]);
  const codexRequest = buildQuotaObservationRequest({
    provider: "openai", quota_pool_id: "openai-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [makeExecutor()],
  });
  assert.equal(codexRequest.entry, "codex-token-count-event");
  assert.deepEqual(QUOTA_OBSERVATION_ENTRIES, { anthropic: "claude-statusline-rate-limits", openai: "codex-token-count-event" });
  // xAI・不明providerはv1対象外（ADR 0054非目標）
  assert.throws(() => buildQuotaObservationRequest({ provider: "xai", quota_pool_id: "x", host_instance_id: "h", executor_scope: [makeExecutor()] }), code("INVALID_SCHEMA"));
  assert.throws(() => buildQuotaObservationRequest({ provider: "anthropic", quota_pool_id: "a", host_instance_id: "h", executor_scope: [] }), code("INVALID_SCHEMA"));
  assert.throws(() => buildQuotaObservationRequest({ provider: "anthropic", quota_pool_id: "a", host_instance_id: "h", executor_scope: [makeExecutor()], token: "secret" }), code("INVALID_SCHEMA"));
});

test("Anthropic RateLimitEventのprojectionはfraction utilizationとepoch resets_atをbp整数窓へ写す", () => {
  const snapshot = projectAnthropicRateLimitEvents(anthropicInput({
    events: [
      makeRateLimitInfo(),
      makeRateLimitInfo({ rate_limit_type: "seven_day", resets_at: 1784678400, utilization: 0.125 }),
      makeRateLimitInfo({ rate_limit_type: "seven_day_opus", resets_at: 1784678400, utilization: 1 }),
    ],
  }));
  assert.equal(snapshot.provider, "anthropic");
  assert.equal(snapshot.source, "provider-api");
  assert.equal(snapshot.confidence, "reported");
  assert.deepEqual(snapshot.windows, [
    { window_id: "5h", duration_seconds: 18000, reset_at: "2026-07-17T04:00:00.000Z", remaining_bp: 7000, model_family_scope: null },
    { window_id: "7d", duration_seconds: 604800, reset_at: "2026-07-22T00:00:00.000Z", remaining_bp: 8750, model_family_scope: null },
    { window_id: "7d-opus", duration_seconds: 604800, reset_at: "2026-07-22T00:00:00.000Z", remaining_bp: 0, model_family_scope: "opus" },
  ]);
  // projection結果はそのままcanonical digest可能な正当なsnapshot
  assert.match(quotaSnapshotDigest(snapshot), /^[a-f0-9]{64}$/);
});

test("Anthropic projectionは単位違い・raw同梱・未知shapeをfail loudにする", () => {
  // SDK正: utilizationは0.0..1.0のfraction。percent値(30)は単位バグとして拒否する
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ utilization: 30 })] })), code("EVENT_MALFORMED"));
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ utilization: -0.1 })] })), code("EVENT_MALFORMED"));
  // utilization不在は2.1.211実測の健全形＝専用codeで「snapshotを作れない」ことを名指しする
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ utilization: null })] })), code("UTILIZATION_UNAVAILABLE"));
  // epochミリ秒（単位バグ）と欠落resets_at
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ resets_at: 1784260800000 })] })), code("EVENT_MALFORMED"));
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ resets_at: null })] })), code("EVENT_MALFORMED"));
  // raw provider payloadはprojectionへ入れない（秘密・account state複製の遮断）
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [{ ...makeRateLimitInfo(), raw: { account: "secret" } }] })), code("EVENT_MALFORMED"));
  // windowを名指ししないevent・未知のwindow種はdriftとして落とす
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ rate_limit_type: null })] })), code("EVENT_MALFORMED"));
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ rate_limit_type: "five_minute" })] })), code("SCHEMA_DRIFT"));
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo(), makeRateLimitInfo()] })), code("EVENT_MALFORMED"));
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ status: "unknown" })] })), code("EVENT_MALFORMED"));
  // overageは課金状態でありquota窓ではない: 混在では除外、単独ではsnapshotを作らない
  const withOverage = projectAnthropicRateLimitEvents(anthropicInput({
    events: [makeRateLimitInfo(), makeRateLimitInfo({ rate_limit_type: "overage", resets_at: null, utilization: null, overage_status: "allowed", overage_resets_at: 1784260800 })],
  }));
  assert.deepEqual(withOverage.windows.map((window) => window.window_id), ["5h"]);
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({
    events: [makeRateLimitInfo({ rate_limit_type: "overage", resets_at: null, utilization: null, overage_status: "allowed" })],
  })), code("NO_QUOTA_WINDOWS"));
  // reset境界の矛盾はsnapshot検証からWINDOW_CONTRADICTIONとして伝播する
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({ events: [makeRateLimitInfo({ resets_at: 1784246400 })] })), code("WINDOW_CONTRADICTION"));
});

test("Codex token_countのprojectionは0.144.3実測shapeを固定しsecondary nullを正当形として受ける", () => {
  const snapshot = projectCodexTokenCountEvent(codexInput());
  assert.equal(snapshot.provider, "openai");
  assert.deepEqual(snapshot.windows, [
    { window_id: "codex-primary", duration_seconds: 604800, reset_at: "2026-07-21T20:37:04.000Z", remaining_bp: 9800, model_family_scope: null },
  ]);
  assert.match(quotaSnapshotDigest(snapshot), /^[a-f0-9]{64}$/);
  const both = projectCodexTokenCountEvent(codexInput({
    event: makeCodexEvent({ secondary: { used_percent: 50, window_minutes: 300, resets_at: 1784260800 } }),
  }));
  assert.deepEqual(both.windows.map((window) => [window.window_id, window.remaining_bp]), [["codex-primary", 9800], ["codex-secondary", 5000]]);
});

// 2026-07-17 live H実測（codex-cli 0.144.3・observed 2026-07-16T23:32:39.061Z）の完全event。
// 07-15抜粋（3 key）に対しlimit_name/credits/individual_limit/plan_type/rate_limit_reached_typeを
// 追加で持つ。ADR 0058受入fixture。
const liveCodexEvent = () => ({
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 24.0, window_minutes: 10080, resets_at: 1784780155 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
  individual_limit: null,
  plan_type: "pro",
  rate_limit_reached_type: null,
});

test("Codex 0.144.3のlive完全event（2026-07-17実測）をそのまま投影できる", () => {
  const snapshot = projectCodexTokenCountEvent(codexInput({
    event: liveCodexEvent(), observed_at: "2026-07-16T23:32:39.061Z",
  }));
  assert.deepEqual(snapshot.windows, [
    { window_id: "codex-primary", duration_seconds: 604800, reset_at: "2026-07-23T04:15:55.000Z", remaining_bp: 7600, model_family_scope: null },
  ]);
  assert.match(quotaSnapshotDigest(snapshot), /^[a-f0-9]{64}$/);
  // credits・plan_typeは検証のみでsnapshotへ複製されない（account stateの非複製）
  assert.equal(JSON.stringify(snapshot).includes("credits"), false);
  assert.equal(JSON.stringify(snapshot).includes("plan_type"), false);
  assert.equal(JSON.stringify(snapshot).includes("balance"), false);
  // 未特性化のindividual_limit非nullはdrift
  assert.throws(() => projectCodexTokenCountEvent(codexInput({
    event: { ...liveCodexEvent(), individual_limit: { used_percent: 1, window_minutes: 60, resets_at: 1784780155 } },
    observed_at: "2026-07-16T23:32:39.061Z",
  })), code("SCHEMA_DRIFT"));
  // credits shapeの逸脱はfail loud
  assert.throws(() => projectCodexTokenCountEvent(codexInput({
    event: { ...liveCodexEvent(), credits: { has_credits: false } }, observed_at: "2026-07-16T23:32:39.061Z",
  })), code("INVALID_SCHEMA"));
});

test("Codex projectionはschema driftと窓ゼロ・単位バグをfail loudにする", () => {
  // 両slot nullはquota観測ではない
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: null }) })), code("NO_QUOTA_WINDOWS"));
  // 未知fieldはdrift（0.144.3 shapeの characterization を破る）
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: { ...makeCodexEvent(), tokens_used: 123 } })), code("INVALID_SCHEMA"));
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: { used_percent: 2.0, window_minutes: 10080 } }) })), code("INVALID_SCHEMA"));
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: { ...makeCodexEvent(), raw: {} } })), code("EVENT_MALFORMED"));
  // 単位・値域バグ
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: { used_percent: 101, window_minutes: 10080, resets_at: 1784666224 } }) })), code("EVENT_MALFORMED"));
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: { used_percent: 2, window_minutes: 0, resets_at: 1784666224 } }) })), code("EVENT_MALFORMED"));
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: { used_percent: 2, window_minutes: 10080, resets_at: 1784666224000 } }) })), code("EVENT_MALFORMED"));
  // 窓の残り時間 > window長は矛盾（古いresets_atの転用を殺す）
  assert.throws(() => projectCodexTokenCountEvent(codexInput({ event: makeCodexEvent({ primary: { used_percent: 2, window_minutes: 60, resets_at: 1784666224 } }) })), code("WINDOW_CONTRADICTION"));
});

// 2026-07-17 live H実測（Claude Code 2.1.211・claude -p stream-json）のverbatim wire event。
// camelCase・utilization不在が現行の健全形。ADR 0058受入fixture。
const liveClaudeWireEvent = () => ({
  status: "allowed",
  resetsAt: 1784257800,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
});

test("Claude CLI 2.1.211のlive wire event（2026-07-17実測）は正規化されutilization不在をfail loudにする", () => {
  const normalized = normalizeClaudeCliRateLimitEvent(liveClaudeWireEvent());
  assert.deepEqual(normalized, {
    status: "allowed", resets_at: 1784257800, rate_limit_type: "five_hour", utilization: null,
    overage_status: "rejected", overage_resets_at: null, overage_disabled_reason: "org_level_disabled",
  });
  // 実wireそのままではsnapshotを作れない＝捏造せずUTILIZATION_UNAVAILABLE
  assert.throws(() => projectAnthropicRateLimitEvents(anthropicInput({
    events: [normalized], observed_at: "2026-07-16T23:35:00.000Z",
  })), code("UTILIZATION_UNAVAILABLE"));
  // 将来CLIがutilizationを載せたらそのままsnapshotへ通る（前方互換の固定）
  const withUtilization = normalizeClaudeCliRateLimitEvent({ ...liveClaudeWireEvent(), utilization: 0.24 });
  const snapshot = projectAnthropicRateLimitEvents(anthropicInput({
    events: [withUtilization], observed_at: "2026-07-16T23:35:00.000Z",
  }));
  assert.deepEqual(snapshot.windows, [
    { window_id: "5h", duration_seconds: 18000, reset_at: "2026-07-17T03:10:00.000Z", remaining_bp: 7600, model_family_scope: null },
  ]);
  // wireの未知keyはdrift（characterization破り）、isUsingOverageは非boolean拒否・非複製
  assert.throws(() => normalizeClaudeCliRateLimitEvent({ ...liveClaudeWireEvent(), quotaLeft: 1 }), code("INVALID_SCHEMA"));
  assert.throws(() => normalizeClaudeCliRateLimitEvent({ ...liveClaudeWireEvent(), isUsingOverage: "no" }), code("EVENT_MALFORMED"));
  assert.throws(() => normalizeClaudeCliRateLimitEvent({ ...liveClaudeWireEvent(), raw: {} }), code("EVENT_MALFORMED"));
  assert.equal(Object.hasOwn(normalized, "isUsingOverage"), false);
});

// 2026-07-17 live H実測（Claude Code 2.1.211・session限定--settings statusline capture）の
// verbatim rate_limits。seven_dayのFPノイズ（28.999999999999996）も実測のまま。ADR 0059受入fixture。
const liveStatuslineRateLimits = () => ({
  five_hour: { used_percentage: 31, resets_at: 1784257800 },
  seven_day: { used_percentage: 28.999999999999996, resets_at: 1784275200 },
});

test("Claude statusline rate_limits（2026-07-17実測）はused_percentageからsnapshotを作れる", () => {
  const snapshot = projectAnthropicStatuslineRateLimits({
    rate_limits: liveStatuslineRateLimits(),
    quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  });
  assert.equal(snapshot.provider, "anthropic");
  assert.equal(snapshot.source, "app-ui");
  // FPノイズはbp整数化で吸収される（28.999999999999996% → 2900bp使用 → 残7100bp）
  assert.deepEqual(snapshot.windows, [
    { window_id: "5h", duration_seconds: 18000, reset_at: "2026-07-17T03:10:00.000Z", remaining_bp: 6900, model_family_scope: null },
    { window_id: "7d", duration_seconds: 604800, reset_at: "2026-07-17T08:00:00.000Z", remaining_bp: 7100, model_family_scope: null },
  ]);
  assert.match(quotaSnapshotDigest(snapshot), /^[a-f0-9]{64}$/);
  // 各windowは独立に欠落しうる（公式契約）＝片方だけでもsnapshot成立
  const fiveOnly = projectAnthropicStatuslineRateLimits({
    rate_limits: { five_hour: { used_percentage: 31, resets_at: 1784257800 } },
    quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  });
  assert.deepEqual(fiveOnly.windows.map((window) => window.window_id), ["5h"]);
  // 両方欠落＝最初のAPI応答前＝snapshotを作らない
  assert.throws(() => projectAnthropicStatuslineRateLimits({
    rate_limits: {}, quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  }), code("NO_QUOTA_WINDOWS"));
  // 未知window・shape逸脱・単位/epochバグはfail loud
  assert.throws(() => projectAnthropicStatuslineRateLimits({
    rate_limits: { ...liveStatuslineRateLimits(), monthly: { used_percentage: 1, resets_at: 1784275200 } },
    quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  }), code("INVALID_SCHEMA"));
  assert.throws(() => projectAnthropicStatuslineRateLimits({
    rate_limits: { five_hour: { used_percentage: 101, resets_at: 1784257800 } },
    quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  }), code("EVENT_MALFORMED"));
  assert.throws(() => projectAnthropicStatuslineRateLimits({
    rate_limits: { five_hour: { used_percentage: 31, resets_at: 1784257800000 } },
    quota_pool_id: "anthropic-sub-main", host_instance_id: "host-mac-main",
    executor_scope: [claudeExecutor()], observed_at: "2026-07-16T23:54:00.000Z",
  }), code("EVENT_MALFORMED"));
});

test("取得失敗のprojectionは必ずtyped errorになりsnapshotを作らない", () => {
  const kinds = Object.keys(QUOTA_OBSERVATION_FAILURE_CODES);
  assert.deepEqual(kinds.sort(), ["credential-missing", "entry-unavailable", "malformed-event", "schema-drift", "timeout"]);
  for (const kind of kinds) {
    assert.throws(
      () => projectQuotaObservationFailure({ provider: "anthropic", failure_kind: kind, detail: `${kind} during observation` }),
      code(QUOTA_OBSERVATION_FAILURE_CODES[kind]),
    );
  }
  assert.throws(() => projectQuotaObservationFailure({ provider: "openai", failure_kind: "timeout", detail: "codex token_count event not observed within bound" }), code("OBSERVATION_TIMEOUT"));
  // 失敗語彙の外は受けない（成功へ丸める抜け道を作らない）
  assert.throws(() => projectQuotaObservationFailure({ provider: "openai", failure_kind: "retry-succeeded", detail: "x" }), code("INVALID_SCHEMA"));
  assert.throws(() => projectQuotaObservationFailure({ provider: "xai", failure_kind: "timeout", detail: "x" }), code("INVALID_SCHEMA"));
});
