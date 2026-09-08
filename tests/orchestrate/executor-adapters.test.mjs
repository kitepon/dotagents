import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import * as adapters from "../../lib/orchestrate/executor-adapters.mjs";
import { syntheticAdapterDescriptor } from "./fixtures/executor-contract.mjs";

const code = (expected) => (error) => {
  assert.ok(error instanceof adapters.ExecutorAdapterError); assert.equal(error.code, expected); return true;
};

const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const routingReceipt = (overrides = {}) => {
  const receipt = {
    status: "green", verifier: "verify-codex-agent-routing", agent_path: "/root/routing_smoke", agent_role: "implementer",
    model: "gpt-5.6-terra", effort: "medium", developer_instructions: "applied", verified_at: "2026-07-14T00:00:00.000Z",
    verification_ref: "verify-codex-agent-routing implementer /root/routing_smoke", ...overrides,
  };
  receipt.verification_digest = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
  return receipt;
};

test("default catalogは製品固有のoptional operationだけを公開する", () => {
  const catalog = adapters.defaultAdapterCatalog();
  assert.equal(catalog.length, 8);
  assert.deepEqual(adapters.lookupInterface({ adapter_id: "codex-sidecar", contract_version: "v1", interface_id: "durable-work" }).interface.operations.map((entry) => [entry.operation_id, entry.tool_name, entry.effect]), [
    ["start", "codex_work_start", "control"], ["result", "codex_work_result", "observe"], ["cancel", "codex_work_cancel", "control"],
    ["inspect-recovery", "codex_work_recover", "observe"], ["quarantine", "codex_work_recover", "control"],
  ]);
  assert.deepEqual(adapters.lookupInterface({ adapter_id: "codex-native", contract_version: "v1", interface_id: "native-agent" }).interface.operations.map((entry) => entry.tool_name), ["spawn_agent", "followup_task", "interrupt_agent"]);
  assert.deepEqual(adapters.lookupInterface({ adapter_id: "aiterm", contract_version: "v1", interface_id: "interactive-session" }).interface.operations.map((entry) => entry.tool_name), ["codex_agent", "grok_agent", "composer_agent", "pty_read", "pty_send", "pty_key", "pty_close", "pty_list"]);
  assert.deepEqual(adapters.lookupInterface({ adapter_id: "claude-native", contract_version: "v1", interface_id: "headless-session" }).interface.operations.map((entry) => [entry.operation_id, entry.tool_name]), [["start", "claude"], ["resume", "claude"]]);
  assert.equal(adapters.lookupOperation({ adapter_id: "gpt-connector", contract_version: "v1", interface_id: "consultation-job", operation_id: "consult" }).adapter.lane, "consultation");
  assert.deepEqual(adapters.lookupInterface({ adapter_id: "claude-internal", contract_version: "v1", interface_id: "appendix-projection" }).interface.operations.map((entry) => entry.effect), ["observe"]);
  const claudeConsult = adapters.lookupInterface({ adapter_id: "claude-native", contract_version: "consult-v1", interface_id: "consultation-session" });
  assert.equal(claudeConsult.adapter.lane, "consultation");
  assert.deepEqual(claudeConsult.interface.operations.map((entry) => [entry.operation_id, entry.tool_name]), [["start", "claude"], ["resume", "claude"]]);
  const sidecarConsult = adapters.lookupOperation({ adapter_id: "codex-sidecar", contract_version: "consult-v1", interface_id: "consultation-opinion", operation_id: "consult" });
  assert.equal(sidecarConsult.adapter.lane, "consultation");
  assert.equal(sidecarConsult.operation.tool_name, "codex_opinion");
});

test("catalog descriptorはexact shape、unique id、bounds、lane制約をfail closedにする", () => {
  const descriptor = adapters.defaultAdapterCatalog()[0];
  assert.throws(() => adapters.validateAdapterDescriptor({ ...descriptor, extra: true }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.validateAdapterDescriptor({ ...descriptor, interfaces: [descriptor.interfaces[0], descriptor.interfaces[0]] }), code("DUPLICATE_INTERFACE"));
  assert.throws(() => adapters.validateAdapterDescriptor({ ...descriptor, interfaces: [{ ...descriptor.interfaces[0], operations: [descriptor.interfaces[0].operations[0], descriptor.interfaces[0].operations[0]] }] }), code("DUPLICATE_OPERATION"));
  assert.throws(() => adapters.validateAdapterDescriptor({ ...descriptor, interfaces: Array.from({ length: 33 }, () => descriptor.interfaces[0]) }), code("INVALID_SCHEMA"));
  const gpt = adapters.defaultAdapterCatalog().find((entry) => entry.adapter_id === "gpt-connector");
  assert.throws(() => adapters.validateAdapterDescriptor({ ...gpt, lane: "worker" }), code("LANE_FORBIDDEN"));
  for (const consultAdapterId of ["claude-native", "codex-sidecar"]) {
    const consult = adapters.defaultAdapterCatalog().find((entry) => entry.adapter_id === consultAdapterId && entry.contract_version === "consult-v1");
    assert.throws(() => adapters.validateAdapterDescriptor({ ...consult, lane: "worker" }), code("LANE_FORBIDDEN"), `${consultAdapterId}@consult-v1 worker lane`);
    assert.throws(() => adapters.validateAdapterCatalog([...adapters.defaultAdapterCatalog().filter((entry) => entry !== consult), { ...consult, lane: "worker" }]), code("LANE_FORBIDDEN"));
  }
  const claude = adapters.defaultAdapterCatalog().find((entry) => entry.adapter_id === "claude-internal");
  assert.throws(() => adapters.validateAdapterDescriptor({ ...claude, interfaces: [{ ...claude.interfaces[0], operations: [{ ...claude.interfaces[0].operations[0], effect: "control" }] }] }), code("LANE_FORBIDDEN"));
  assert.throws(() => adapters.validateAdapterDescriptor({ ...claude, interfaces: [{ ...claude.interfaces[0], operations: [{ ...claude.interfaces[0].operations[0], operation_id: "dispatch" }] }] }), code("LANE_FORBIDDEN"));
});

test("lookupはunknown adapter/interface/operationをtyped errorで拒否し、catalogを実行しない", () => {
  assert.throws(() => adapters.lookupAdapter({ adapter_id: "unknown", contract_version: "v1" }), code("ADAPTER_UNKNOWN"));
  assert.throws(() => adapters.lookupInterface({ adapter_id: "aiterm", contract_version: "v1", interface_id: "missing" }), code("INTERFACE_UNKNOWN"));
  assert.throws(() => adapters.lookupOperation({ adapter_id: "aiterm", contract_version: "v1", interface_id: "interactive-session", operation_id: "missing" }), code("OPERATION_UNKNOWN"));
  const first = adapters.defaultAdapterCatalog(); first[0].interfaces[0].operations[0].tool_name = "tampered";
  assert.equal(adapters.defaultAdapterCatalog()[0].interfaces[0].operations[0].tool_name, "codex_work_start");
});

test("synthetic adapter descriptorもexact catalog validationとlookupを通る", () => {
  const catalog = [syntheticAdapterDescriptor];
  assert.equal(adapters.validateAdapterCatalog(catalog), catalog);
  assert.equal(adapters.lookupAdapter({ adapter_id: "synthetic", contract_version: "v1" }, catalog).lane, "worker");
  assert.deepEqual(adapters.lookupOperation({ adapter_id: "synthetic", contract_version: "v1", interface_id: "ticket-work", operation_id: "inspect" }, catalog).operation, { operation_id: "inspect", transport: "host-tool", tool_name: "synthetic_inspect", effect: "observe" });
});

test("codex-native requestはhost toolを実行せず、routing smokeとgreen照合後のfollowupだけを投影する", () => {
  const spawn = adapters.codexNativeSpawnRequest({ agent_type: "implementer", task_name: "routing_smoke" });
  assert.deepEqual(spawn, {
    schema_version: "dotagents.codex-native.request.v1", operation_id: "spawn", tool_name: "spawn_agent",
    arguments: { agent_type: "implementer", fork_turns: "none", message: "Routing smoke only. Do not perform work. Report your agent path, role recognition, and readiness to wait.", task_name: "routing_smoke" },
  });
  assert.equal(spawn.arguments.message.includes("implement the task"), false);
  const routing = routingReceipt();
  assert.deepEqual(adapters.codexNativeFollowupRequest({ agent_path: "/root/routing_smoke", task: "Implement the bounded adapter packet.", routing_receipt: routing }).arguments, { target: "/root/routing_smoke", message: "Implement the bounded adapter packet." });
  assert.deepEqual(adapters.codexNativeInterruptRequest({ agent_path: "/root/routing_smoke" }).arguments, { target: "/root/routing_smoke" });
  assert.throws(() => adapters.codexNativeFollowupRequest({ agent_path: "/root/routing_smoke", task: "must not dispatch", routing_receipt: routingReceipt({ status: "pending" }) }), code("ROUTING_VERIFICATION_REQUIRED"));
  assert.throws(() => adapters.codexNativeFollowupRequest({ agent_path: "/root/routing_smoke", task: "must not dispatch", routing_receipt: { ...routing, effort: "high" } }), code("ROUTING_VERIFICATION_MISMATCH"));
  assert.throws(() => adapters.codexNativeFollowupRequest({ agent_path: "/root/other", task: "must not dispatch", routing_receipt: routing }), code("ROUTING_VERIFICATION_MISMATCH"));
  assert.throws(() => adapters.codexNativeSpawnRequest({ agent_type: "implementer", task_name: "routing_smoke", message: "task" }), code("INVALID_SCHEMA"));
});

test("codex-native observationはboundedなagent状態とrouting/report/evidence参照だけを投影する", () => {
  const routing = routingReceipt();
  const projected = adapters.projectCodexNativeObservation({ agent_path: "/root/routing_smoke", status: "completed", routing_receipt: routing, report_ref: "reports/agent_001.md", evidence_refs: ["tests/orchestrate/executor-adapters.test.mjs"] });
  assert.deepEqual(projected, { schema_version: "dotagents.codex-native.observation.v1", executor_handle: { agent_path: "/root/routing_smoke" }, status: "completed", routing_receipt: routing, report_ref: "reports/agent_001.md", evidence_refs: ["tests/orchestrate/executor-adapters.test.mjs"] });
  assert.throws(() => adapters.projectCodexNativeObservation({ agent_path: "/root/routing_smoke", status: "running", routing_receipt: null, report_ref: null, evidence_refs: [], raw_prompt: "secret" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectCodexNativeObservation({ agent_path: "/root/routing_smoke", status: "running", routing_receipt: null, report_ref: null, evidence_refs: ["same", "same"] }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.buildWorkerControlObservation({ projection: projected, observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:00:00.000Z", result: { arbitrary: "caller supplied" } }), code("WORKER_REPORT_IMPORT_REQUIRED"));
  const withoutReport = adapters.projectCodexNativeObservation({ agent_path: "/root/routing_smoke", status: "completed", routing_receipt: routing, report_ref: null, evidence_refs: [] });
  assert.throws(() => adapters.buildWorkerControlObservation({ projection: withoutReport, observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:00:00.000Z", result: { arbitrary: "caller supplied" } }), code("EVIDENCE_REQUIRED"));
});

test("aiterm observationはsession相関とboundedな状態・参照だけを残しterminal成功を捏造しない", () => {
  const handle = { session_id: "aiterm_agent_001", agent_kind: "composer" };
  assert.deepEqual(adapters.projectAitermLaunchObservation({ ...handle, workspace_cwd: "/workspace/source" }), { schema_version: "dotagents.aiterm.observation.v1", executor_handle: handle, workspace_cwd: "/workspace/source", state: "running", terminal: null });
  assert.deepEqual(adapters.projectAitermObservation({ handle, status: "unknown", report_ref: null, evidence_refs: ["docs/aiterm-timeout.md"] }), { schema_version: "dotagents.aiterm.observation.v1", executor_handle: handle, state: "unknown", report_ref: null, evidence_refs: ["docs/aiterm-timeout.md"] });
  assert.deepEqual(adapters.projectAitermObservation({ handle, status: "running", report_ref: null, evidence_refs: [] }).state, "running");
  assert.deepEqual(adapters.projectAitermObservation({ handle, status: "failed", report_ref: null, evidence_refs: [] }).state, "failed");
  const completed = adapters.projectAitermObservation({ handle, status: "completed", report_ref: "reports/aiterm-worker.md", evidence_refs: ["aiterm:pty-read:terminal"] });
  assert.equal(completed.state, "completed");
  assert.throws(() => adapters.projectAitermObservation({ handle, status: "completed", report_ref: null, evidence_refs: ["aiterm:pty-read:terminal"] }), code("EVIDENCE_REQUIRED"));
  assert.throws(() => adapters.projectAitermObservation({ handle, status: "completed", report_ref: "reports/aiterm-worker.md", evidence_refs: [] }), code("EVIDENCE_REQUIRED"));
  assert.throws(() => adapters.buildWorkerControlObservation({ projection: completed, observed_version: "aiterm", observed_at: "2026-07-14T00:00:00.000Z", result: { arbitrary: "caller supplied" } }), code("WORKER_REPORT_IMPORT_REQUIRED"));
  assert.deepEqual(adapters.buildWorkerControlObservation({ projection: adapters.projectAitermObservation({ handle, status: "running", report_ref: null, evidence_refs: [] }), observed_version: "aiterm", observed_at: "2026-07-14T00:00:00.000Z" }).state, "running");
  assert.deepEqual(adapters.buildWorkerControlObservation({ projection: adapters.projectAitermObservation({ handle, status: "failed", report_ref: null, evidence_refs: [] }), observed_version: "aiterm", observed_at: "2026-07-14T00:00:00.000Z", terminal_evidence: [{ provider: "aiterm" }] }).state, "failed");
  assert.throws(() => adapters.projectAitermObservation({ handle, status: "completed", report_ref: null, evidence_refs: [], raw_terminal: "must not persist" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectAitermObservation({ handle, status: "timeout", report_ref: null, evidence_refs: [] }), code("INVALID_SCHEMA"));
});

test("claude-native Worker requestは隔離workspaceと同一UUIDを固定し暗黙fallback flagを作らない", () => {
  const handle = { session_id: "123e4567-e89b-42d3-a456-426614174000" };
  const common = {
    handle, prompt: "保存済みDelegation Packetに従って作業する。", workspace_cwd: "/workspace/claude-worker",
    model: "claude-sonnet-4-5", effort: "high",
    tool_policy: { permission_mode: "dontAsk", tools: ["Read", "Glob", "Grep"], allowed_tools: ["Read", "Glob", "Grep"] },
  };
  const start = adapters.claudeNativeStartRequest(common);
  assert.deepEqual(start, {
    schema_version: "dotagents.claude-native.request.v1", operation_id: "start", tool_name: "claude",
    arguments: {
      cwd: "/workspace/claude-worker",
      argv: ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "text", "--session-id", handle.session_id, "--model", "claude-sonnet-4-5", "--effort", "high", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep", "--disable-slash-commands", "--no-chrome"],
      stdin: common.prompt,
    },
  });
  const resume = adapters.claudeNativeResumeRequest(common);
  assert.deepEqual(resume.arguments.argv, ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "text", "--resume", handle.session_id, "--model", "claude-sonnet-4-5", "--effort", "high", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep", "--disable-slash-commands", "--no-chrome"]);
  for (const forbidden of ["--continue", "--fallback-model", "--bare", "--safe-mode", "--no-session-persistence"]) {
    assert.equal(start.arguments.argv.includes(forbidden), false, forbidden);
    assert.equal(resume.arguments.argv.includes(forbidden), false, forbidden);
  }
  assert.throws(() => adapters.claudeNativeStartRequest({ ...common, handle: { session_id: "not-a-uuid" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeStartRequest({ ...common, handle: { session_id: "123E4567-E89B-42D3-A456-426614174000" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeStartRequest({ ...common, fallback_model: "claude-haiku-4-5" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeStartRequest({ ...common, tool_policy: { ...common.tool_policy, tools: ["mcp__private"] } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeStartRequest({ ...common, tool_policy: { ...common.tool_policy, allowed_tools: ["Bash(git *)"] } }), code("INVALID_SCHEMA"));
});

test("claude-native observationはterminal receiptとcaller timeoutを分離しstrict Report前に成功を確定しない", () => {
  const handle = { session_id: "123e4567-e89b-42d3-a456-426614174000" };
  const running = adapters.projectClaudeNativeObservation({ handle, status: "running", exit_code: null, signal: null, report_ref: null, evidence_refs: [] });
  assert.deepEqual(running, { schema_version: "dotagents.claude-native.observation.v1", executor_handle: handle, state: "running", raw_status: "running", report_ref: null, evidence_refs: [] });
  const completed = adapters.projectClaudeNativeObservation({ handle, status: "completed", exit_code: 0, signal: null, report_ref: "reports/claude-worker.json", evidence_refs: ["claude:stream-result:end_turn"] });
  assert.equal(completed.state, "completed");
  assert.throws(() => adapters.buildWorkerControlObservation({ projection: completed, observed_version: "2.1.211", observed_at: "2026-07-16T11:30:00.000Z", result: { arbitrary: true } }), code("WORKER_REPORT_IMPORT_REQUIRED"));
  const failed = adapters.projectClaudeNativeObservation({ handle, status: "failed", exit_code: 1, signal: null, report_ref: null, evidence_refs: ["claude:process-exit:1"] });
  assert.equal(adapters.buildWorkerControlObservation({ projection: failed, observed_version: "2.1.211", observed_at: "2026-07-16T11:30:00.000Z", terminal_evidence: [{ provider: "claude", exit_code: 1 }] }).state, "failed");
  const timeout = adapters.projectClaudeNativeTimeoutObservation({ handle });
  assert.deepEqual(timeout, { schema_version: "dotagents.claude-native.observation.v1", executor_handle: handle, state: "unknown", raw_status: "caller_timeout", report_ref: null, evidence_refs: [] });
  assert.equal(adapters.buildWorkerControlObservation({ projection: timeout, observed_version: "2.1.211", observed_at: "2026-07-16T11:30:00.000Z" }).state, "unknown");
  assert.throws(() => adapters.projectClaudeNativeObservation({ handle, status: "completed", exit_code: null, signal: null, report_ref: "reports/claude-worker.json", evidence_refs: ["receipt"] }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectClaudeNativeObservation({ handle, status: "failed", exit_code: 0, signal: null, report_ref: null, evidence_refs: ["receipt"] }), code("INVALID_SCHEMA"));
});

test("gpt-connectorはConsultation専用のconsult/sessions packetをcaller既知slugへ純粋に投影する", () => {
  const consult = adapters.gptConnectorConsultRequest({ prompt: "Review this design.", model: "gpt-5.6", effort: "high", slug: "design-review-001" });
  assert.deepEqual(consult, { schema_version: "dotagents.gpt-connector.request.v1", operation_id: "consult", tool_name: "consult", arguments: { prompt: "Review this design.", model: "gpt-5.6", effort: "high", slug: "design-review-001", keepOpen: false, dryRun: false } });
  assert.deepEqual(adapters.gptConnectorSessionsRequest({ slug: "design-review-001" }).arguments, { slug: "design-review-001" });
  assert.deepEqual(adapters.gptConnectorTimeoutRecoveryRequest({ slug: "design-review-001" }).arguments, { slug: "design-review-001" });
  assert.throws(() => adapters.gptConnectorConsultRequest({ prompt: "Review this design.", model: "gpt-5.6", effort: "high", slug: "unknown slug" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.gptConnectorConsultRequest({ prompt: "Review this design.", model: "gpt-5.6", slug: "design-review-001" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.gptConnectorConsultRequest({ prompt: "Review this design.", model: "gpt-5.6", effort: "high", slug: "design-review-001", files: ["secret.txt"] }), code("INVALID_SCHEMA"));
});

test("gpt-connector observationはraw answerを保持せず、timeoutをunknownとして同一slugへ回収する", () => {
  const timestamps = { createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:01:00.000Z" };
  const queued = { slug: "design-review-001", state: "queued", ...timestamps, result: null, error: null };
  assert.equal(adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: queued }).state, "dispatched");
  const active = { slug: "design-review-001", state: "running", ...timestamps, result: null, error: null };
  assert.deepEqual(adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: active }), { schema_version: "dotagents.gpt-connector.observation.v1", consultation_handle: { slug: "design-review-001" }, state: "running", raw_status: "running", terminal: null });
  const succeeded = { slug: "design-review-001", state: "succeeded", ...timestamps, result: { text: "raw answer is accepted then discarded", status: "finished", endTurn: true, resolvedModel: "gpt-5.6", resolvedEffort: "high", sessionId: "123e4567-e89b-12d3-a456-426614174000", attachments: { count: 1, names: ["private.txt"], mimeTypes: ["text/plain"], readBack: "confirmed", retention: "unknown", cleanup: "deleted" }, archived: true }, error: null };
  assert.deepEqual(adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: succeeded }), { schema_version: "dotagents.gpt-connector.observation.v1", consultation_handle: { slug: "design-review-001" }, state: "completed", raw_status: "succeeded", terminal: { resolved_model: "gpt-5.6", resolved_effort: "high", session_id: "123e4567-e89b-12d3-a456-426614174000", archived: true } });
  const failed = { slug: "design-review-001", state: "failed", ...timestamps, result: null, error: { code: "AUTH_REQUIRED", message: "raw error message is discarded", retry: "after_auth", partialUpload: { count: 1, cleanup: "failed" } } };
  assert.deepEqual(adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: failed }), { schema_version: "dotagents.gpt-connector.observation.v1", consultation_handle: { slug: "design-review-001" }, state: "failed", raw_status: "failed", terminal: { error_code: "AUTH_REQUIRED", retry: "after_auth" } });
  assert.deepEqual(adapters.projectGptConnectorTimeoutObservation({ slug: "design-review-001" }), { schema_version: "dotagents.gpt-connector.observation.v1", consultation_handle: { slug: "design-review-001" }, state: "unknown", raw_status: "caller_timeout", terminal: null });
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "other-slug", provider: succeeded }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...succeeded, extra: "not in ConsultSnapshot" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...failed, error: { ...failed.error, extra: "not in ConsultFailure" } } }), code("INVALID_SCHEMA"));
});

test("gpt-connector成功result・失敗errorはConsultSnapshot/ConsultFailureの形状を厳格検証しfail closedする", () => {
  const timestamps = { createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:01:00.000Z" };
  const result = { text: "raw answer is accepted then discarded", status: "finished", endTurn: true, resolvedModel: "gpt-5.6", resolvedEffort: "high", sessionId: "123e4567-e89b-12d3-a456-426614174000", attachments: { count: 1, names: ["private.txt"], mimeTypes: ["text/plain"], readBack: "confirmed", retention: "unknown", cleanup: "deleted" }, archived: true };
  const succeeded = { slug: "design-review-001", state: "succeeded", ...timestamps, result, error: null };
  const errorValue = { code: "AUTH_REQUIRED", message: "raw error message is discarded", retry: "after_auth", partialUpload: { count: 1, cleanup: "failed" } };
  const failed = { slug: "design-review-001", state: "failed", ...timestamps, result: null, error: errorValue };

  // 1. sessionIdがUUID形式（v1〜v5）でない場合の拒否
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...succeeded, result: { ...result, sessionId: "not-a-uuid" } } }), code("INVALID_SCHEMA"));

  // 2. attachments.countとnames/mimeTypes配列長の不一致検出
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...succeeded, result: { ...result, attachments: { ...result.attachments, count: 2 } } } }), code("INVALID_SCHEMA"));

  // 3. attachments.cleanupの未知値拒否
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...succeeded, result: { ...result, attachments: { ...result.attachments, cleanup: "unknown_cleanup" } } } }), code("INVALID_SCHEMA"));

  // 4. error.retryの未知値拒否
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...failed, error: { ...errorValue, retry: "unknown_retry" } } }), code("INVALID_SCHEMA"));

  // 5. error.partialUpload.count/cleanupの不正値拒否
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...failed, error: { ...errorValue, partialUpload: { count: 0, cleanup: "failed" } } } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { ...failed, error: { ...errorValue, partialUpload: { count: 1, cleanup: "unknown_cleanup" } } } }), code("INVALID_SCHEMA"));
});

test("claude-internalはappendix由来のunknown projectionだけを提供し、未確認dispatchを発明しない", () => {
  assert.deepEqual(adapters.projectClaudeInternalAppendixObservation({ observed_at: "2026-07-14T00:00:00.000Z" }), {
    schema_version: "dotagents.claude-internal.observation.v1", adapter_id: "claude-internal",
    appendix_ref: "claude/skills/orchestrate/SKILL.md", observed_at: "2026-07-14T00:00:00.000Z",
    state: "unknown", executor_handle: null, terminal: null,
  });
  assert.throws(() => adapters.projectClaudeInternalAppendixObservation({ observed_at: "2026-07-14T00:00:00.000Z", raw_prompt: "secret" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectClaudeInternalAppendixObservation({ observed_at: "not-a-timestamp" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectClaudeInternalAppendixObservation({ observed_at: "2026-07-14" }), code("INVALID_SCHEMA"));
});

test("adapter×lane別failure matrixは実provider code・caller event・unknownを区別する", () => {
  const families = ["credential-missing", "rate-limited", "timeout", "non-zero-exit", "malformed-report", "workspace-missing", "unsupported-capability"];
  const laneMatrix = [
    ["codex-sidecar", ["worker", "consultation"]], ["codex-native", ["worker"]], ["aiterm", ["worker"]],
    ["claude-native", ["worker", "consultation"]], ["gpt-connector", ["consultation"]], ["claude-internal", ["host-projection"]],
  ];
  for (const [adapterId, lanes] of laneMatrix) for (const lane of lanes) for (const family of families) {
    const support = adapters.lookupAdapterFailureSupport({ adapter_id: adapterId, lane, failure_family: family });
    assert.ok(["mapped", "caller-event", "unknown", "not-applicable"].includes(support.status), `${adapterId}/${lane}/${family}`);
    assert.equal(typeof support.evidence_basis, "string");
    assert.equal(support.lane, lane);
  }
  assert.equal(adapters.lookupAdapterFailureSupport({ adapter_id: "gpt-connector", lane: "consultation", failure_family: "rate-limited" }).status, "unknown");
  assert.equal(adapters.lookupAdapterFailureSupport({ adapter_id: "codex-sidecar", lane: "worker", failure_family: "non-zero-exit" }).status, "unknown");
  assert.equal(adapters.lookupAdapterFailureSupport({ adapter_id: "claude-native", lane: "worker", failure_family: "timeout" }).status, "caller-event");
  assert.deepEqual(adapters.projectAdapterCallerTimeout({ adapter_id: "claude-native", lane: "worker" }), {
    schema_version: "dotagents.executor-adapter.failure.v1", adapter_id: "claude-native", lane: "worker", provider_code: null,
    failure_family: "timeout", state: "unknown", recovery_operation: null,
  });
  assert.deepEqual(adapters.projectAdapterFailure({ adapter_id: "gpt-connector", lane: "consultation", provider_code: "AUTH_REQUIRED" }), {
    schema_version: "dotagents.executor-adapter.failure.v1", adapter_id: "gpt-connector", lane: "consultation", provider_code: "AUTH_REQUIRED",
    failure_family: "credential-missing", state: "failed", recovery_operation: null,
  });
  assert.deepEqual(adapters.projectAdapterFailure({ adapter_id: "codex-sidecar", lane: "worker", provider_code: "RUN_READY_TIMEOUT" }), {
    schema_version: "dotagents.executor-adapter.failure.v1", adapter_id: "codex-sidecar", lane: "worker", provider_code: "RUN_READY_TIMEOUT",
    failure_family: "timeout", state: "unknown", recovery_operation: "result",
  });
  assert.deepEqual(adapters.projectAdapterCallerTimeout({ adapter_id: "aiterm", lane: "worker" }), {
    schema_version: "dotagents.executor-adapter.failure.v1", adapter_id: "aiterm", lane: "worker", provider_code: null,
    failure_family: "timeout", state: "unknown", recovery_operation: "pty_read",
  });
  // 同一adapter_idでもlaneで回収契約が分かれる（ADR 0045）: sidecar consultationはdurable回収opを返さない
  assert.deepEqual(adapters.projectAdapterCallerTimeout({ adapter_id: "codex-sidecar", lane: "consultation" }), {
    schema_version: "dotagents.executor-adapter.failure.v1", adapter_id: "codex-sidecar", lane: "consultation", provider_code: null,
    failure_family: "timeout", state: "unknown", recovery_operation: null,
  });
  assert.equal(adapters.lookupAdapterFailureSupport({ adapter_id: "claude-native", lane: "consultation", failure_family: "workspace-missing" }).status, "not-applicable");
  assert.equal(adapters.lookupAdapterFailureSupport({ adapter_id: "claude-native", lane: "worker", failure_family: "workspace-missing" }).status, "caller-event");
  assert.throws(() => adapters.lookupAdapterFailureSupport({ adapter_id: "gpt-connector", lane: "worker", failure_family: "timeout" }), code("ADAPTER_UNKNOWN"));
  assert.throws(() => adapters.lookupAdapterFailureSupport({ adapter_id: "codex-native", lane: "consultation", failure_family: "timeout" }), code("ADAPTER_UNKNOWN"));
  assert.throws(() => adapters.lookupAdapterFailureSupport({ adapter_id: "gpt-connector", lane: "consultation", failure_family: "nonzero" }), code("FAILURE_FAMILY_UNKNOWN"));
  assert.throws(() => adapters.lookupAdapterFailureSupport({ adapter_id: "gpt-connector", failure_family: "timeout" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectAdapterFailure({ adapter_id: "gpt-connector", lane: "consultation", provider_code: "RATE_LIMITED" }), code("FAILURE_UNMAPPED"));
  assert.throws(() => adapters.projectAdapterFailure({ adapter_id: "aiterm", lane: "worker", provider_code: "AUTH_REQUIRED" }), code("FAILURE_UNMAPPED"));
  assert.throws(() => adapters.projectAdapterFailure({ adapter_id: "codex-sidecar", lane: "consultation", provider_code: "RUN_READY_TIMEOUT" }), code("FAILURE_UNMAPPED"));
  assert.throws(() => adapters.projectAdapterFailure({ adapter_id: "gpt-connector", lane: "consultation", provider_code: "AUTH_REQUIRED", raw_message: "secret" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectAdapterCallerTimeout({ adapter_id: "claude-internal", lane: "host-projection" }), code("FAILURE_UNMAPPED"));
});

test("codex-sidecar requestは実tool schemaの固定値とcaller handleを純粋に投影する", () => {
  const handle = { idempotency_key: "A".repeat(22) };
  const start = adapters.codexSidecarStartRequest({ projectRoot: "/workspace/source", handle, baseRef: "a".repeat(40), prompt: "Delegation Packetに従って実装する", allowedPaths: ["lib/orchestrate"], denyPaths: [".env"], turnTimeoutMs: 60000 });
  assert.deepEqual(start, {
    schema_version: "dotagents.codex-sidecar.request.v1", operation_id: "start", tool_name: "codex_work_start",
    arguments: { projectRoot: "/workspace/source", idempotencyKey: "A".repeat(22), baseRef: "a".repeat(40), prompt: "Delegation Packetに従って実装する", allowedPaths: ["lib/orchestrate"], denyPaths: [".env"], turnTimeoutMs: 60000, interruptOnTimeout: true, allowWork: true, preserveWorktree: true },
  });
  assert.deepEqual(adapters.codexSidecarResultRequest({ projectRoot: "/workspace/source", handle }).arguments, { projectRoot: "/workspace/source", idempotencyKey: "A".repeat(22) });
  assert.deepEqual(adapters.codexSidecarCancelRequest({ projectRoot: "/workspace/source", handle }).arguments, { projectRoot: "/workspace/source", idempotencyKey: "A".repeat(22) });
  assert.deepEqual(adapters.codexSidecarRecoveryInspectionRequest({ projectRoot: "/workspace/source", handle }).arguments, { projectRoot: "/workspace/source", idempotencyKey: "A".repeat(22) });
  assert.throws(() => adapters.codexSidecarQuarantineRequest({ projectRoot: "/workspace/source", handle, confirmNoRunningProcesses: false }), code("QUARANTINE_CONFIRMATION_REQUIRED"));
  assert.deepEqual(adapters.codexSidecarQuarantineRequest({ projectRoot: "/workspace/source", handle, confirmNoRunningProcesses: true }).arguments, { projectRoot: "/workspace/source", idempotencyKey: "A".repeat(22), action: "quarantine", confirmNoRunningProcesses: true });
  assert.throws(() => adapters.codexSidecarStartRequest({ projectRoot: "relative", handle, baseRef: "a".repeat(40), prompt: "x", allowedPaths: ["lib"], denyPaths: [], turnTimeoutMs: 1 }), code("INVALID_SCHEMA"));
});

test("codex-sidecar observationはunknownと非成功terminalをcompletedへ昇格しない", () => {
  const handle = { idempotency_key: "A".repeat(22) }; const runId = "b".repeat(64);
  const result = (status, overrides = {}) => ({ status, workflow: "work", summary: "summary", confidence: { level: "high" }, recommendedNextAction: "review", changedFiles: ["lib/x.mjs"], worktreePath: "/workspace/worktree", worktreePreserved: true, ...overrides });
  const completed = adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_terminal", runId, state: "completed", result: result("ok"), cleanup: "not-requested" } });
  assert.equal(completed.state, "completed"); assert.match(completed.terminal.result_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(completed.workspace_binding_candidate, { schema_version: "dotagents.codex-sidecar.workspace-binding.v1", executor_handle: handle, provider_run_id: runId, worktree_path: "/workspace/worktree", observed_state: "completed", result_digest: completed.terminal.result_digest });
  assert.equal(adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_interrupted", runId, state: "orphaned", error: { code: "RUN_ORPHANED", message: "lost" }, processGroup: "unknown", salvageAllowed: false, terminal: false } }).state, "unknown");
  for (const status of ["partial", "failed", "refused", "dry-run"]) assert.equal(adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_terminal", runId, state: "completed", result: result(status), cleanup: "not-requested" } }).state, "failed");
  assert.equal(adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_pending", runId, state: "running", phase: "worker", pollAfterMs: 1000 } }).state, "running");
  assert.throws(() => adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_terminal", runId, state: "completed", result: result("ok", { worktreePreserved: false }), cleanup: "completed" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectCodexSidecarObservation({ handle, provider: { kind: "run_terminal", runId, state: "completed", result: result("ok", { changedFiles: ["../escape"] }), cleanup: "not-requested" } }), code("INVALID_SCHEMA"));
});

test("codex-sidecar cancel ackとrecovery inspectionは実unionを検証し、ackだけでcancelledにしない", () => {
  const handle = { idempotency_key: "A".repeat(22) }; const runId = "b".repeat(64);
  const acknowledgement = adapters.projectCodexSidecarCancelObservation({ handle, provider: {
    kind: "run_cancel_ack", runId, accepted: true, terminal: false, state: "cancellation_requested", mode: "cooperative", pollAfterMs: 1000,
  } });
  assert.equal(acknowledgement.state, "unknown"); assert.equal(acknowledgement.terminal, null);
  assert.equal(acknowledgement.cancel_acknowledgement.terminal_reported, false);
  const status = { kind: "run_interrupted", runId, state: "orphaned", error: { code: "RUN_ORPHANED", message: "lost" }, processGroup: "unknown", salvageAllowed: false, terminal: false };
  const recovered = adapters.projectCodexSidecarRecoveryObservation({ handle, provider: {
    kind: "work_recovery_inspection", runId, runDirectory: `/tmp/codex-sidecar/${runId}`, status, quarantinePublished: false, outcome: "inspection",
  } });
  assert.equal(recovered.state, "unknown"); assert.deepEqual(recovered.recovery, { outcome: "inspection", quarantine_published: false });
  assert.equal(Object.hasOwn(recovered, "runDirectory"), false);
  assert.throws(() => adapters.projectCodexSidecarRecoveryObservation({ handle, provider: {
    kind: "work_recovery_inspection", runId, runDirectory: `/tmp/codex-sidecar/${runId}`, status: { ...status, runId: "c".repeat(64) }, quarantinePublished: false, outcome: "inspection",
  } }), code("PROJECTION_MISMATCH"));
});

test("adapter projectionはControl RecordのWorker/Consultation observationへexact変換できる", () => {
  const dispatchEvidence = [{ type: "executor-receipt", ref: "native-routing-receipt", digest: "d".repeat(64), observed_at: "2026-07-14T00:00:00.000Z" }];
  const native = adapters.projectCodexNativeObservation({ agent_path: "/root/routing_smoke", status: "created", routing_receipt: routingReceipt(), report_ref: null, evidence_refs: [] });
  assert.deepEqual(adapters.buildWorkerControlObservation({ projection: native, observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:00:00.000Z", dispatch_evidence: dispatchEvidence }), {
    state: "dispatched", source: "codex-native", observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:00:00.000Z", raw_state: "created",
    executor_handle: { agent_path: "/root/routing_smoke" }, dispatch_evidence: dispatchEvidence,
  });
  const timestamps = { createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:01:00.000Z" };
  const consultation = adapters.projectGptConnectorObservation({ slug: "design-review-001", provider: { slug: "design-review-001", state: "queued", ...timestamps, result: null, error: null } });
  assert.deepEqual(adapters.buildConsultationControlObservation({ projection: consultation, observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z" }), {
    state: "dispatched", source: "gpt-connector", consultation_handle: { slug: "design-review-001" }, observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "queued",
  });
  assert.throws(() => adapters.buildWorkerControlObservation({ projection: native, observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:00:00.000Z" }), code("EVIDENCE_REQUIRED"));
});

test("claude-native consult requestは同一UUID・cwd必須・全tool無効を固定しworker schemaと分離する", () => {
  const handle = { session_id: "123e4567-e89b-42d3-a456-426614174000" };
  const common = { handle, prompt: "この設計への最強の反論を述べよ。", cwd: "/workspace/consult-project", model: "claude-opus-4-8", effort: "high" };
  const start = adapters.claudeNativeConsultStartRequest(common);
  assert.deepEqual(start, {
    schema_version: "dotagents.claude-native.consult-request.v1", operation_id: "start", tool_name: "claude",
    arguments: {
      cwd: "/workspace/consult-project",
      argv: ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "text", "--session-id", handle.session_id, "--model", "claude-opus-4-8", "--effort", "high", "--permission-mode", "dontAsk", "--tools", "", "--disable-slash-commands", "--no-chrome"],
      stdin: common.prompt,
    },
  });
  const resume = adapters.claudeNativeConsultResumeRequest(common);
  assert.equal(resume.arguments.argv.includes("--resume"), true);
  assert.equal(resume.arguments.argv.includes("--session-id"), false);
  for (const request of [start, resume]) {
    assert.deepEqual(request.arguments.argv.slice(request.arguments.argv.indexOf("--tools"), request.arguments.argv.indexOf("--tools") + 2), ["--tools", ""]);
    assert.equal(request.arguments.argv.includes("--allowedTools"), false);
    for (const forbidden of ["--continue", "--fallback-model", "--bare", "--safe-mode", "--no-session-persistence"]) assert.equal(request.arguments.argv.includes(forbidden), false, forbidden);
  }
  assert.throws(() => adapters.claudeNativeConsultStartRequest({ ...common, handle: { session_id: "123E4567-E89B-42D3-A456-426614174000" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeConsultStartRequest({ ...common, cwd: "relative/path" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.claudeNativeConsultStartRequest({ ...common, tool_policy: { permission_mode: "dontAsk", tools: ["Read"], allowed_tools: [] } }), code("INVALID_SCHEMA"));
});

test("claude-native consult observationはconsultation_handleを保ちworker projectionへ流入しない", () => {
  const handle = { session_id: "123e4567-e89b-42d3-a456-426614174000" };
  const running = adapters.projectClaudeNativeConsultObservation({ handle, status: "running" });
  assert.deepEqual(running, { schema_version: "dotagents.claude-native.consult-observation.v1", consultation_handle: handle, state: "running", raw_status: "running", terminal: null });
  const timeout = adapters.projectClaudeNativeConsultTimeoutObservation({ handle });
  assert.deepEqual(timeout, { schema_version: "dotagents.claude-native.consult-observation.v1", consultation_handle: handle, state: "unknown", raw_status: "caller_timeout", terminal: null });
  assert.throws(() => adapters.projectClaudeNativeConsultObservation({ handle, status: "cancelled" }), code("INVALID_SCHEMA"));
  // 完了信号はstream-jsonのtype:result receiptであり、process exitでcompletedを作れない（ADR 0045 §7）
  assert.throws(() => adapters.projectClaudeNativeConsultObservation({ handle, status: "completed" }), code("EVIDENCE_REQUIRED"));
  assert.throws(() => adapters.projectClaudeNativeConsultObservation({ handle, status: "running", result_receipt: "claude:stream-result:end_turn" }), code("INVALID_SCHEMA"));
  const completed = adapters.projectClaudeNativeConsultObservation({ handle, status: "completed", result_receipt: "claude:stream-result:end_turn" });
  assert.deepEqual(completed.terminal, { result_receipt: "claude:stream-result:end_turn" });
  assert.deepEqual(adapters.buildConsultationControlObservation({ projection: completed, observed_version: "2.1.211", observed_at: "2026-07-16T00:00:00.000Z", decision_ref: "docs/consult-decision.md" }), {
    state: "completed", source: "claude-native", consultation_handle: handle, observed_version: "2.1.211", observed_at: "2026-07-16T00:00:00.000Z", raw_state: "completed", decision_ref: "docs/consult-decision.md",
  });
  // consultation observationはWorker laneへ逆流しない（ADR 0045 §3）
  for (const projection of [completed, running, timeout]) {
    assert.throws(() => adapters.buildWorkerControlObservation({ projection, observed_version: "2.1.211", observed_at: "2026-07-16T00:00:00.000Z" }), code("PROJECTION_UNSUPPORTED"));
  }
  // Worker observationもconsultation laneへ入らない
  const workerObservation = adapters.projectClaudeNativeObservation({ handle, status: "running", exit_code: null, signal: null, report_ref: null, evidence_refs: [] });
  assert.throws(() => adapters.buildConsultationControlObservation({ projection: workerObservation, observed_version: "2.1.211", observed_at: "2026-07-16T00:00:00.000Z" }), code("PROJECTION_UNSUPPORTED"));
});

test("codex-sidecar opinion requestはread-only固定でwrite系引数もdurable handleも生成しない", () => {
  const request = adapters.codexSidecarOpinionRequest({ projectRoot: "/workspace/source", prompt: "この設計の最強の反論を述べよ。", model: "gpt-5.6-codex", effort: "xhigh" });
  assert.deepEqual(request, {
    schema_version: "dotagents.codex-sidecar.consult-request.v1", operation_id: "consult", tool_name: "codex_opinion",
    arguments: { projectRoot: "/workspace/source", prompt: "この設計の最強の反論を述べよ。", model: "gpt-5.6-codex", modelReasoningEffort: "xhigh" },
  });
  for (const forbidden of ["allowWork", "preserveWorktree", "idempotencyKey", "baseRef"]) assert.equal(Object.hasOwn(request.arguments, forbidden), false, forbidden);
  assert.throws(() => adapters.codexSidecarOpinionRequest({ projectRoot: "/workspace/source", prompt: "x", model: "gpt-5.6-codex", effort: "max" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.codexSidecarOpinionRequest({ projectRoot: "relative", prompt: "x", model: "gpt-5.6-codex", effort: "low" }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.codexSidecarOpinionRequest({ projectRoot: "/workspace/source", prompt: "x", model: "gpt-5.6-codex", effort: "low", allowWork: true }), code("INVALID_SCHEMA"));
});

test("codex-sidecar opinion observationはhandle nullを固定し、caller観測のerror/timeoutで終端できる", () => {
  const result = { status: "ok", workflow: "opinion", summary: "objections", confidence: { level: "high" }, recommendedNextAction: "revise" };
  const completed = adapters.projectCodexSidecarOpinionObservation({ provider: result });
  assert.equal(completed.state, "completed"); assert.equal(completed.consultation_handle, null); assert.match(completed.terminal.result_digest, /^[a-f0-9]{64}$/);
  assert.equal(adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, status: "refused" } }).state, "failed");
  assert.throws(() => adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, workflow: "work" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, status: "dry-run" } }), code("INVALID_SCHEMA"));
  // read-only opinionにwrite痕跡が載っていたら製品契約違反としてfail closed（空changedFilesだけは許容）
  assert.throws(() => adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, changedFiles: ["lib/x.mjs"] } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, worktreePath: "/workspace/worktree" } }), code("INVALID_SCHEMA"));
  assert.throws(() => adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, worktreePreserved: true } }), code("INVALID_SCHEMA"));
  assert.equal(adapters.projectCodexSidecarOpinionObservation({ provider: { ...result, changedFiles: [] } }).state, "completed");
  assert.deepEqual(adapters.projectCodexSidecarOpinionDispatchObservation(), { schema_version: "dotagents.codex-sidecar.consult-observation.v1", consultation_handle: null, state: "dispatched", raw_status: "caller_dispatch", terminal: null });
  const errored = adapters.projectCodexSidecarOpinionErrorObservation({ error: { code: "APP_SERVER_TIMEOUT", message: "raw text is discarded" } });
  assert.deepEqual(errored, { schema_version: "dotagents.codex-sidecar.consult-observation.v1", consultation_handle: null, state: "failed", raw_status: "APP_SERVER_TIMEOUT", terminal: { error_code: "APP_SERVER_TIMEOUT" } });
  const timeout = adapters.projectCodexSidecarOpinionTimeoutObservation();
  assert.deepEqual(timeout, { schema_version: "dotagents.codex-sidecar.consult-observation.v1", consultation_handle: null, state: "unknown", raw_status: "caller_timeout", terminal: null });
  const evidence = [{ type: "executor-receipt", ref: "mcp:codex_opinion:APP_SERVER_TIMEOUT", digest: "d".repeat(64), observed_at: "2026-07-16T00:00:00.000Z" }];
  assert.deepEqual(adapters.buildConsultationControlObservation({ projection: errored, observed_version: "codex-sidecar-mcp", observed_at: "2026-07-16T00:00:00.000Z", terminal_evidence: evidence }), {
    state: "failed", source: "codex-sidecar", consultation_handle: null, observed_version: "codex-sidecar-mcp", observed_at: "2026-07-16T00:00:00.000Z", raw_state: "APP_SERVER_TIMEOUT", terminal_evidence: evidence,
  });
  assert.throws(() => adapters.buildConsultationControlObservation({ projection: { ...completed, consultation_handle: { slug: "fabricated" } }, observed_version: "codex-sidecar-mcp", observed_at: "2026-07-16T00:00:00.000Z", decision_ref: "docs/decision.md" }), code("INVALID_SCHEMA"));
  for (const projection of [completed, timeout]) {
    assert.throws(() => adapters.buildWorkerControlObservation({ projection, observed_version: "codex-sidecar-mcp", observed_at: "2026-07-16T00:00:00.000Z" }), code("PROJECTION_UNSUPPORTED"));
  }
});
