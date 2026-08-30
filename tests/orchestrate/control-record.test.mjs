import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";

import {
  addLinkedWorktree, canonicalDigest, cleanupDir, controlStatePaths, createBareRepo, createFingerprintBoundaryFiles, createGitRepo, createOversizedFingerprintFile,
  createNonGitDir, createOwnerFixtures, evidence, installSentinelBin, loadControl, makeConsultation, makeConsultationV25, makeTask,
  makeApproval, makeBudget, makeBudgetReservation, makeLaneAdmission, makePlacementCandidate, makeRegistryObservation, makeTempDir, makeTransitionReceipt, makeWorkerRun, OWNER_SCHEMA, readPersistedManifest, runGit, spawnOrchestrate,
  taskAdmissionDigest, terminalWorkerObservation, completedWorkerObservation, workerObservation, writeJson,
} from "./helpers.mjs";

const api = await loadControl();
const adapters = await import("../../lib/orchestrate/executor-adapters.mjs");
const CONTROL = "control-record-contract";

function code(expected) {
  return (error) => {
    assert.ok(error instanceof api.ControlRecordError, `ControlRecordError expected, got ${error?.constructor?.name}`);
    assert.equal(error.code, expected);
    return true;
  };
}

function sidecarProviderBinding(worktreePath, overrides = {}) {
  return {
    schema_version: "dotagents.codex-sidecar.workspace-binding.v1",
    executor_handle: { idempotency_key: "A".repeat(22) }, provider_run_id: "b".repeat(64),
    worktree_path: worktreePath, observed_state: "completed", result_digest: "a".repeat(64), ...overrides,
  };
}

function nativeRoutingReceipt(agentPath) {
  const receipt = {
    status: "green", verifier: "verify-codex-agent-routing", agent_path: agentPath, agent_role: "implementer",
    model: "gpt-5.6-terra", effort: "medium", developer_instructions: "applied", verified_at: "2026-07-14T00:00:00.000Z",
    verification_ref: `verify-codex-agent-routing implementer ${agentPath}`,
  };
  return { ...receipt, verification_digest: canonicalDigest(receipt) };
}

async function withRepo(t, fn) {
  const base = await makeTempDir();
  t.after(() => cleanupDir(base));
  return fn(await createGitRepo(base));
}

async function withFault(point, fn) {
  const previousNodeEnv = process.env.NODE_ENV; const previousFault = process.env.DOTAGENTS_ORCHESTRATE_TEST_FAULT;
  process.env.NODE_ENV = "test"; process.env.DOTAGENTS_ORCHESTRATE_TEST_FAULT = point;
  try { return await fn(); }
  finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousFault === undefined) delete process.env.DOTAGENTS_ORCHESTRATE_TEST_FAULT; else process.env.DOTAGENTS_ORCHESTRATE_TEST_FAULT = previousFault;
  }
}

async function initialized(t, overrides = {}) {
  const base = await makeTempDir();
  t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const result = await api.init({ cwd: repo.root, control_id: CONTROL, objective_ref: "docs/control-record-plan.md", actor_id: "parent-001", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission(), ...overrides });
  assert.equal(result.revision, 0);
  assert.equal(result.manifest.record_revision, 0);
  assert.equal(result.manifest.control_id, overrides.control_id ?? CONTROL);
  assert.deepEqual(await readPersistedManifest(repo.commonDir, overrides.control_id ?? CONTROL), result.manifest);
  return { repo, result };
}

// phase gateがtaskRecordより前の段階で既にrecord済みの場合、advance部分だけを進める。
// completePhaseGateはrecord+advanceを1回で行う従来どおりの挙動を維持する。
async function advancePhaseGate(repo, controlId, revision, { risk = "standard", behaviorLane = "behavior-preserving" } = {}) {
  let result = { revision };
  for (const phase of ["baseline", "discovery", "design", "safety_net", "implementation", "behavior_change", "integration", "knowledge_return", "complete"]) {
    const decisionRequired = ["design", "complete"].includes(phase)
      || (phase === "safety_net" && risk === "standard")
      || phase === "behavior_change";
    const state = phase === "safety_net" && risk === "standard" ? "not-required"
      : phase === "behavior_change" && behaviorLane === "behavior-preserving" ? "not-applicable" : "completed";
    result = await api.phaseGateAdvance({
      cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: result.revision,
      phase, state, evidence: phase === "baseline" || phase === "knowledge_return" || (phase === "safety_net" && risk === "high") ? [evidence(`docs/phase-${phase}.md`)] : [],
      decision: decisionRequired ? evidence(`docs/phase-${phase}-decision.md`, "decision") : null,
    });
  }
  return result;
}

async function completePhaseGate(repo, controlId, revision, options = {}) {
  const recorded = await api.phaseGateRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: revision, risk: options.risk ?? "standard", behavior_lane: options.behaviorLane ?? "behavior-preserving" });
  return advancePhaseGate(repo, controlId, recorded.revision, options);
}

async function materializeDocumentEvidence(repo, descriptor) {
  if (!["file", "decision"].includes(descriptor.type)) return descriptor;
  const content = `# evidence for ${descriptor.ref}\n`;
  const path = join(repo.root, ...descriptor.ref.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return { ...descriptor, digest: createHash("sha256").update(content).digest("hex") };
}

async function materializeFinalizationInput(repo, input) {
  const result = structuredClone(input);
  for (const ref of [result.acceptance_matrix_ref, ...result.knowledge_return_refs]) {
    const path = join(repo.root, ...ref.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# finalization document ${ref}\n`);
  }
  result.final_audit_evidence = await Promise.all(result.final_audit_evidence.map((entry) => materializeDocumentEvidence(repo, entry)));
  result.regression_evidence = await Promise.all(result.regression_evidence.map((entry) => materializeDocumentEvidence(repo, entry)));
  result.parent_decision = await materializeDocumentEvidence(repo, result.parent_decision);
  return result;
}

async function materializeTaskDecision(repo, ref) {
  const path = join(repo.root, ...ref.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# task decision ${ref}\n`);
}

test("純粋APIは同期で厳格schema・scopeを検証し、unknown fieldを拒否する", () => {
  const manifest = {
    schema_version: "dotagents.orchestration-control.v25", record_revision: 0, control_id: CONTROL, status: "active",
    declaration: { objective_ref: "docs/control-record-plan.md", project_root_realpath: "/project", common_dir_realpath: "/project/.git", git_dir_realpath: "/project/.git", git_dir_file_id: "1:1", base_sha: "0".repeat(40), initial_dirty: false, initial_status_digest: "a".repeat(64), initial_workspace_digest: "b".repeat(64), created_at: "2026-07-14T00:00:00.000Z", created_by: "parent-001" },
    continuation: { predecessor_control_id: null, root_control_id: CONTROL, sequence: 0 },
    durability: { protocol_version: "fsync-rename-fsync.v1", file_sync: "required", directory_sync: "required", atomic_rename: "required" }, budget: makeBudget(),
    role_effect_policy: { policy_version: "dotagents.role-effect.v1", read_only_roles: ["refuter", "sorter", "verifier"], approval_required_write_roles: ["integrator"] },
    document_refs: ["docs/control-record-plan.md"], tasks: [], task_cancellations: [], worker_runs: [], consultations: [], campaigns: [], phase_gate: null, artifacts: [], family_governance: [], registry_observations: [], task_finalizations: [], control_finalization: null,
    transition_receipts: [makeTransitionReceipt()], last_update: { actor_id: "parent-001", updated_at: "2026-07-14T00:00:00.000Z" },
  };
  assert.deepEqual(api.validateManifest(manifest), manifest);
  assert.throws(() => api.validateManifest({ ...manifest, schema_version: "dotagents.orchestration-control.v21" }), code("INVALID_SCHEMA"));
  assert.throws(() => api.validateManifest({ ...manifest, prompt: "must never persist" }), code("INVALID_SCHEMA"));
  assert.deepEqual(api.normalizeScope({ kind: "directory", path: "lib/orchestrate" }), { kind: "directory", path: "lib/orchestrate" });
  assert.deepEqual(api.normalizeScope({ kind: "file", path: "app/[gameId]/page.tsx" }), { kind: "file", path: "app/[gameId]/page.tsx" });
  for (const path of ["../escape", "/absolute", "a\\b", ".", "a/*", "a/?", "a/{b}", "a/../b"]) assert.throws(() => api.normalizeScope({ kind: "directory", path }), code("INVALID_SCOPE"));
  assert.equal(api.scopesOverlap({ kind: "directory", path: "a/b" }, { kind: "file", path: "a/b/c.mjs" }), true);
  assert.equal(api.scopesOverlap({ kind: "directory", path: "a/b" }, { kind: "file", path: "a/bc.mjs" }), false);
});

test("すべてのI/O APIはcwdを必須にし、non-gitを拒否してbareをread-onlyとして初期化する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const nonGit = await createNonGitDir(base); const source = await createGitRepo(base, "bare-source");
  const bareArtifactDigest = createHash("sha256").update("# Control Record fixture plan\n").digest("hex"); const bareArtifactRef = `docs/control-record-plan.${bareArtifactDigest}.md`;
  await writeFile(join(source.root, bareArtifactRef), "# Control Record fixture plan\n");
  const bareLinkDigest = createHash("sha256").update("control-record-plan.md").digest("hex"); const bareLinkRef = `docs/bare-link.${bareLinkDigest}.md`;
  await symlink("control-record-plan.md", join(source.root, bareLinkRef)); runGit(source.root, ["add", bareArtifactRef, bareLinkRef]); runGit(source.root, ["commit", "-q", "-m", "add bare artifact fixtures"]);
  const bare = await createBareRepo(base, source);
  await assert.rejects(api.init({ control_id: CONTROL, objective_ref: "docs/x.md", actor_id: "parent", document_refs: ["docs/x.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("INVALID_INPUT"));
  await assert.rejects(api.init({ cwd: nonGit, control_id: CONTROL, objective_ref: "docs/x.md", actor_id: "parent", document_refs: ["docs/x.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("NOT_GIT_REPOSITORY"));
  const bareControl = await api.init({ cwd: bare.root, control_id: CONTROL, objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  assert.equal(bareControl.manifest.declaration.project_root_realpath, null);
  const barePhaseGate = await api.phaseGateRecord({ cwd: bare.root, control_id: CONTROL, actor_id: "parent", expected_revision: bareControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const read = await api.taskRecord({ cwd: bare.root, control_id: CONTROL, actor_id: "parent", expected_revision: barePhaseGate.revision, task: makeTask({ task_id: "bare-read", effect: "read", write_scope: [] }) });
  assert.equal(read.manifest.tasks[0].effect, "read");
  const bareArtifact = await api.artifactRecord({ cwd: bare.root, control_id: CONTROL, actor_id: "parent", expected_revision: read.revision, artifact: { artifact_id: "bare-artifact", artifact_kind: "decision", artifact_ref: bareArtifactRef, artifact_digest: bareArtifactDigest, status: "current" } });
  assert.equal(bareArtifact.manifest.artifacts[0].artifact_digest, bareArtifactDigest);
  await assert.rejects(api.artifactRecord({ cwd: bare.root, control_id: CONTROL, actor_id: "parent", expected_revision: bareArtifact.revision, artifact: { artifact_id: "bare-link", artifact_kind: "decision", artifact_ref: bareLinkRef, artifact_digest: bareLinkDigest, status: "current" } }), code("STATE_PATH_UNSAFE"));
  await assert.rejects(api.taskRecord({ cwd: bare.root, control_id: CONTROL, actor_id: "parent", expected_revision: bareArtifact.revision, task: makeTask() }), code("BARE_WRITE_FORBIDDEN"));
});

test("init/status はgit由来のdeclarationを保存し、重複controlとrevision競合を拒否する", async (t) => {
  const { repo, result } = await initialized(t);
  const status = await api.status({ cwd: repo.root, control_id: CONTROL });
  assert.deepEqual(status, result.manifest);
  assert.equal(status.declaration.base_sha, repo.baseSha);
  assert.equal(status.declaration.common_dir_realpath, repo.commonDir);
  assert.equal(status.transition_receipts.length, 1);
  assert.deepEqual(status.transition_receipts[0].subject, { kind: "control", id: CONTROL });
  assert.match(status.transition_receipts[0].receipt_digest, /^[0-9a-f]{64}$/);
  await assert.rejects(api.init({ cwd: repo.root, control_id: CONTROL, objective_ref: "docs/control-record-plan.md", actor_id: "parent-001", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("CONTROL_EXISTS"));
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: 1, task: makeTask() }), code("REVISION_CONFLICT"));
});

test("resume checkは同じpath・inodeのdevice番号変化だけならreview-requiredとして継続可能にする", async (t) => {
  const { repo } = await initialized(t, { control_id: "device-change-control" });
  const manifestPath = join(
    repo.commonDir,
    "dotagents",
    "orchestrate",
    "controls",
    "device-change-control",
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const [device, inode] = manifest.declaration.git_dir_file_id.split(":");
  manifest.declaration.git_dir_file_id = `${BigInt(device) + 1n}:${inode}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "device-change-control" });
  assert.equal(resumed.outcome, "review-required");
  assert.ok(resumed.review_reasons.some((entry) => (
    entry.code === "control-worktree-device-changed"
    && entry.subject_id === "device-change-control"
  )));
  assert.ok(!resumed.blocking_reasons.some((entry) => (
    entry.code === "control-worktree-generation-changed"
  )));
});

test("status briefとresume checkはopaque状態・workspace drift・evidence retentionを要約する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "brief-control" });
  const ready = await api.resumeCheck({ cwd: repo.root, control_id: "brief-control" });
  assert.equal(ready.schema_version, "dotagents.orchestration-resume-check.v7");
  assert.equal(ready.outcome, "ready");
  await writeFile(join(repo.root, "docs", "resume-dirty.md"), "dirty\n");
  const changed = await api.resumeCheck({ cwd: repo.root, control_id: "brief-control" });
  assert.equal(changed.outcome, "review-required");
  assert.ok(changed.review_reasons.some((entry) => entry.code === "control-dirty-state-changed"));

  const statusControl = await api.init({ cwd: repo.root, control_id: "brief-state-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent-001", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const statusPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: statusControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: statusPhaseGate.revision, task: makeTask({ task_id: "brief-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: task.revision, observation: makeRegistryObservation({ registry_observation_id: "brief-registry" }) });
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: registry.revision, worker_run: makeWorkerRun({ worker_run_id: "brief-worker", task_id: "brief-task", assignment_id: "brief-worker-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "brief-worker-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: worker.revision, worker_run_id: "brief-worker" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: admitted.revision, worker_run_id: "brief-worker", observation: workerObservation("dispatched") });
  const consultation = await api.consultationRecord({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: dispatched.revision, consultation: makeConsultation({ consultation_id: "brief-consultation", task_id: "brief-task", assignment_id: "brief-consultation-assignment" }) });
  const consultationDispatched = await api.observeConsultation({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: consultation.revision, consultation_id: "brief-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
  const unknown = await api.observeConsultation({ cwd: repo.root, control_id: "brief-state-control", actor_id: "parent-001", expected_revision: consultationDispatched.revision, consultation_id: "brief-consultation", observation: { state: "unknown", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "unknown" } });
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "brief-state-control" });
  assert.equal(brief.schema_version, "dotagents.orchestration-status-brief.v7");
  assert.equal(brief.active.worker_runs[0].executor_handle.idempotency_key, "A".repeat(22));
  assert.deepEqual(brief.active.consultations[0].consultation_handle, { slug: "known-session-slug" });
  assert.deepEqual(brief.unknown.consultation_ids, ["brief-consultation"]);
  assert.ok(brief.unknown.registry_observations[0].fields.includes("capacity:hard_inflight_limit"));
  assert.deepEqual(brief.uncollected.worker_run_ids, ["brief-worker"]);
  assert.deepEqual(brief.uncollected.consultation_ids, ["brief-consultation"]);
  assert.equal(unknown.revision, brief.record_revision);
});

test("advisory snapshotはControl不在を空として返し、active状態をmutationなしでcanonical投影する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const emptyRepo = await createGitRepo(base, "advisory-empty");
  assert.deepEqual(await api.advisorySnapshot({ cwd: emptyRepo.root, evaluated_at: "2026-07-14T00:30:00.000Z" }), {
    schema_version: "orchestrate.advisory-snapshot.v1", evaluated_at: "2026-07-14T00:30:00.000Z", active_control_ids: [],
    unknown: { worker_run_ids: [], consultation_ids: [] }, uncollected: { worker_run_ids: [], consultation_ids: [] }, write_conflicts: [], h_reference_gaps: [], capacity_warnings: [], truncated: false,
  });
  const repo = await createGitRepo(base, "advisory-active");
  const init = await api.init({ cwd: repo.root, control_id: "advisory-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "advisory-control", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const approval = makeApproval({ approved_at: "2019-01-01T00:00:00.000Z", expires_at: "2020-01-02T00:00:00.000Z" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "advisory-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "advisory-h-task", classification: "H", effect: "read", write_scope: [], approval }) });
  const hWorker = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "advisory-h-worker", task_id: "advisory-h-task", assignment_id: "advisory-h-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "advisory-h-assignment" } }) });
  const oldRegistry = await api.registryObservationRecord({ cwd: repo.root, control_id: "advisory-control", actor_id: "parent", expected_revision: hWorker.revision, observation: makeRegistryObservation({ registry_observation_id: "advisory-registry-old", expires_at: "2026-07-14T00:15:00.000Z" }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "advisory-control", actor_id: "parent", expected_revision: oldRegistry.revision, observation: makeRegistryObservation({ registry_observation_id: "advisory-registry", expires_at: "2026-07-14T00:15:00.000Z", verification: { ...makeRegistryObservation().verification, observed_at: "2026-07-14T00:10:00.000Z", evidence: { ...makeRegistryObservation().verification.evidence, observed_at: "2026-07-14T00:10:00.000Z" } } }) });
  const before = await api.status({ cwd: repo.root, control_id: "advisory-control" });
  const snapshot = await api.advisorySnapshot({ cwd: repo.root, evaluated_at: "2026-07-14T00:30:00.000Z" });
  assert.deepEqual(snapshot.active_control_ids, ["advisory-control"]);
  assert.deepEqual(snapshot.h_reference_gaps, [{ task_id: "advisory-h-task", reason: "approval-expired" }, { task_id: "advisory-h-task", reason: "operation-digest-missing" }]);
  assert.deepEqual(snapshot.capacity_warnings, [
    { registry_observation_id: "advisory-registry", reason: "admission-unknown" }, { registry_observation_id: "advisory-registry", reason: "expired" }, { registry_observation_id: "advisory-registry", reason: "limit-unknown" },
  ]);
  assert.equal(snapshot.truncated, false); assert.deepEqual(await api.status({ cwd: repo.root, control_id: "advisory-control" }), before); assert.equal(registry.revision, before.record_revision);
});

test("advisory snapshot CLIは外部providerを起動せずmanifestを更新しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "advisory-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const input = join(base, "advisory-input.json"); await writeJson(input, { cwd: repo.root, evaluated_at: "2026-07-14T00:30:00.000Z" });
  const output = spawnOrchestrate(["advisory-snapshot", "--input", input], { env: { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` } });
  assert.equal(output.status, 0); assert.deepEqual(JSON.parse(output.stdout).result.active_control_ids, ["advisory-cli"]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "advisory-cli" })).record_revision, init.revision); await assert.rejects(access(sentinel.log));
});

test("advisory snapshotはunknown/uncollectedをsortし、planned writerだけの競合とterminal Hを高精度に扱う", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "advisory-precision" });
  let revision = result.revision;
  const advisoryPrecisionPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = advisoryPrecisionPhaseGate.revision;
  const readTask = await api.taskRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "advisory-read", effect: "read", write_scope: [], isolation: "none" }) }); revision = readTask.revision;
  for (const worker_run_id of ["z-unknown-worker", "a-unknown-worker"]) {
    const assignment_id = `${worker_run_id}-assignment`;
    const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: revision, worker_run: makeWorkerRun({ worker_run_id, task_id: "advisory-read", assignment_id, write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: assignment_id } }) });
    const admitted = await api.admitWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: recorded.revision, worker_run_id });
    const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: admitted.revision, worker_run_id, observation: workerObservation("dispatched") });
    const unknown = await api.observeWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id, observation: workerObservation("unknown") }); revision = unknown.revision;
  }
  for (const consultation_id of ["z-unknown-consultation", "a-unknown-consultation"]) {
    const recorded = await api.consultationRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: revision, consultation: makeConsultation({ consultation_id, task_id: "advisory-read", assignment_id: `${consultation_id}-assignment` }) });
    const dispatched = await api.observeConsultation({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: recorded.revision, consultation_id, observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
    const unknown = await api.observeConsultation({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: dispatched.revision, consultation_id, observation: { state: "unknown", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "unknown" } }); revision = unknown.revision;
  }
  const writeTask = await api.taskRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "advisory-write-active" }) });
  const active = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: writeTask.revision, worker_run: makeWorkerRun({ worker_run_id: "advisory-write-active-worker", task_id: "advisory-write-active", assignment_id: "advisory-write-active-assignment", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "advisory-write-active-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: active.revision, worker_run_id: "advisory-write-active-worker" });
  const plannedTask = await api.taskRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: admitted.revision, task: makeTask({ task_id: "advisory-write-planned" }) });
  const planned = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: plannedTask.revision, worker_run: makeWorkerRun({ worker_run_id: "advisory-write-planned-worker", task_id: "advisory-write-planned", assignment_id: "advisory-write-planned-assignment", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "advisory-write-planned-assignment" } }) });
  const terminalApproval = makeApproval({ expires_at: "2027-07-14T00:00:00.000Z" });
  const hTask = await api.taskRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: planned.revision, task: makeTask({ task_id: "advisory-terminal-h", classification: "H", effect: "read", write_scope: [], approval: terminalApproval }) });
  const hWorker = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: hTask.revision, worker_run: makeWorkerRun({ worker_run_id: "advisory-terminal-h-worker", task_id: "advisory-terminal-h", assignment_id: "advisory-terminal-h-assignment", write_mode: "none", operation_digest: terminalApproval.operation_digest, workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "advisory-terminal-h-assignment" } }) });
  const hAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: hWorker.revision, worker_run_id: "advisory-terminal-h-worker" });
  const hDispatched = await api.observeWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: hAdmitted.revision, worker_run_id: "advisory-terminal-h-worker", observation: workerObservation("dispatched") });
  await api.observeWorker({ cwd: repo.root, control_id: "advisory-precision", actor_id: "parent", expected_revision: hDispatched.revision, worker_run_id: "advisory-terminal-h-worker", observation: terminalWorkerObservation("failed") });
  const snapshot = await api.advisorySnapshot({ cwd: repo.root, evaluated_at: "2028-07-14T00:30:00.000Z" });
  assert.deepEqual(snapshot.unknown, { worker_run_ids: ["a-unknown-worker", "z-unknown-worker"], consultation_ids: ["a-unknown-consultation", "z-unknown-consultation"] });
  assert.deepEqual(snapshot.uncollected, { worker_run_ids: ["a-unknown-worker", "z-unknown-worker"], consultation_ids: ["a-unknown-consultation", "z-unknown-consultation"] });
  assert.deepEqual(snapshot.write_conflicts, [{ control_id: "advisory-precision", worker_run_id: "advisory-write-planned-worker", reason: "same-worktree-writer" }]);
  assert.ok(!snapshot.h_reference_gaps.some((entry) => entry.task_id === "advisory-terminal-h" && entry.reason === "approval-expired"));
});

test("H TaskのConsultationはoperation digest契約不在をfail-closedする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "h-consultation-contract" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "h-consultation-contract", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "h-consultation-contract", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "h-consultation-task", classification: "H", effect: "read", write_scope: [], approval: makeApproval() }),
  });
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "h-consultation-contract", actor_id: "parent", expected_revision: task.revision,
    consultation: makeConsultation({ consultation_id: "h-consultation", task_id: "h-consultation-task", assignment_id: "h-consultation-assignment" }),
  }), code("CONSULTATION_OPERATION_CONTRACT_MISSING"));
});

test("advisory snapshotのlatest Registryはarchived Controlの新しいsnapshotでsupersedeする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "advisory-archived-registry" });
  const oldRegistry = await api.registryObservationRecord({
    cwd: repo.root, control_id: "advisory-archived-registry", actor_id: "parent", expected_revision: result.revision,
    observation: makeRegistryObservation({ registry_observation_id: "archived-newer-healthy", expires_at: "2027-07-14T00:00:00.000Z", capacity: { admission: { value: "true", evidence: evidence("docs/healthy-admission.md") }, hard_inflight_limit: { knowledge: "known", value: 10, evidence: evidence("docs/healthy-hard.md") }, soft_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/healthy-soft.md") }, observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/healthy-observed.md") } }, verification: { ...makeRegistryObservation().verification, observed_at: "2026-07-14T00:20:00.000Z", evidence: { ...makeRegistryObservation().verification.evidence, observed_at: "2026-07-14T00:20:00.000Z" } } }),
  });
  const archivedOnly = await api.registryObservationRecord({
    cwd: repo.root, control_id: "advisory-archived-registry", actor_id: "parent", expected_revision: oldRegistry.revision,
    observation: makeRegistryObservation({ registry_observation_id: "archived-only-unhealthy", workflow_id: "archived-only", expires_at: "2026-07-14T00:15:00.000Z" }),
  });
  const phase = await completePhaseGate(repo, "advisory-archived-registry", archivedOnly.revision);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "advisory-archived-registry", actor_id: "parent", expected_revision: phase.revision,
    acceptance_matrix_ref: "docs/acceptance.md", final_audit_evidence: [evidence("docs/audit.md")], regression_evidence: [evidence("docs/regression.md")], knowledge_return_refs: ["docs/knowledge.md"], parent_decision: evidence("docs/adr/control-decision.md", "decision"), finalized_by: "parent",
  }));
  const archived = await api.archive({ cwd: repo.root, control_id: "advisory-archived-registry", actor_id: "parent", expected_revision: finalized.revision });
  const successor = await api.init({ cwd: repo.root, control_id: "advisory-active-registry", predecessor_control_id: "advisory-archived-registry", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const stale = await api.registryObservationRecord({
    cwd: repo.root, control_id: "advisory-active-registry", actor_id: "parent", expected_revision: successor.revision,
    observation: makeRegistryObservation({ registry_observation_id: "active-old-expired", expires_at: "2026-07-14T00:15:00.000Z", verification: { ...makeRegistryObservation().verification, observed_at: "2026-07-14T00:10:00.000Z", evidence: { ...makeRegistryObservation().verification.evidence, observed_at: "2026-07-14T00:10:00.000Z" } } }),
  });
  const snapshot = await api.advisorySnapshot({ cwd: repo.root, evaluated_at: "2026-07-14T00:30:00.000Z" });
  assert.deepEqual(snapshot.active_control_ids, ["advisory-active-registry"]);
  assert.deepEqual(snapshot.capacity_warnings, []);
  assert.equal(stale.revision, 1); assert.equal(archived.manifest.status, "archived");
});

test("advisory snapshotは257 planned/reserved capacity fixtureを1.5秒未満で索引評価する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "advisory-density", budget: makeBudget({ max_worker_runs: 300, max_external_runs: 300, max_wall_time_seconds: 2_000_000, max_cost_microusd: 2_000_000_000, max_runs_per_approach_family: 300 }), lane_admission: makeLaneAdmission() });
  let revision = result.revision;
  const densityPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = densityPhaseGate.revision;
  const task = await api.taskRecord({ cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "density-write", isolation: "none", write_scope: [{ kind: "file", path: "README.md" }] }) }); revision = task.revision;
  const workerTemplate = makeWorkerRun();
  const capacityEvidence = evidence("docs/density-capacity.md", "command", { observed_at: "2026-07-14T00:00:00.000Z" });
  const registry = await api.registryObservationRecord({
    cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: revision,
    observation: makeRegistryObservation({ registry_observation_id: "density-registry", executor: workerTemplate.executor, workflow_id: workerTemplate.workflow_id, workflow_capabilities: workerTemplate.workflow_capabilities, capacity: { admission: { value: "true", evidence: capacityEvidence }, hard_inflight_limit: { knowledge: "known", value: 300, evidence: capacityEvidence }, soft_inflight_limit: { knowledge: "known", value: 250, evidence: capacityEvidence }, observed_inflight: { knowledge: "known", value: 0, evidence: capacityEvidence } } }),
  }); revision = registry.revision;
  const reserved = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: revision, worker_run: makeWorkerRun({ worker_run_id: "density-reserved", task_id: "density-write", assignment_id: "density-reserved-assignment", workspace_cwd: repo.root, lineage: { ...workerTemplate.lineage, root_assignment_id: "density-reserved-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: reserved.revision, worker_run_id: "density-reserved" }); revision = admitted.revision;
  // 1 controlは256 receiptsのうち閉鎖用133件を予約するため、実在fixtureを3 Controlへ分散する。
  for (let index = 0; index < 118; index++) {
    const id = `density-planned-${String(index).padStart(3, "0")}`;
    const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "advisory-density", actor_id: "parent", expected_revision: revision, worker_run: makeWorkerRun({ worker_run_id: id, task_id: "density-write", assignment_id: `${id}-assignment`, workspace_cwd: repo.root, lineage: { ...workerTemplate.lineage, root_assignment_id: `${id}-assignment` } }) });
    revision = recorded.revision;
  }
  const recordPlanned = async (control_id, task_id, count) => {
    const initializedControl = await api.init({ cwd: repo.root, control_id, objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget({ max_worker_runs: 300, max_external_runs: 300, max_wall_time_seconds: 2_000_000, max_cost_microusd: 2_000_000_000, max_runs_per_approach_family: 300 }), lane_admission: makeLaneAdmission() });
    const plannedPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id, actor_id: "parent", expected_revision: initializedControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    let current = (await api.taskRecord({ cwd: repo.root, control_id, actor_id: "parent", expected_revision: plannedPhaseGate.revision, task: makeTask({ task_id, isolation: "none", write_scope: [{ kind: "file", path: "README.md" }] }) })).revision;
    for (let index = 0; index < count; index++) {
      const id = `${control_id}-planned-${String(index).padStart(3, "0")}`;
      current = (await api.workerRunRecord({ cwd: repo.root, control_id, actor_id: "parent", expected_revision: current, worker_run: makeWorkerRun({ worker_run_id: id, task_id, assignment_id: `${id}-assignment`, workspace_cwd: repo.root, lineage: { ...workerTemplate.lineage, root_assignment_id: `${id}-assignment` } }) })).revision;
    }
  };
  await recordPlanned("advisory-density-two", "density-write-two", 120);
  await recordPlanned("advisory-density-three", "density-write-three", 19);
  const startedAt = performance.now();
  const snapshot = await api.advisorySnapshot({ cwd: repo.root, evaluated_at: "2026-07-14T00:30:00.000Z" });
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed < 1_500, `advisory snapshot took ${elapsed}ms`);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.write_conflicts.length, 256);
  assert.deepEqual(snapshot.capacity_warnings, [{ registry_observation_id: "density-registry", reason: "soft-reached" }]);
});

test("resume checkはfile evidenceのretentionを検証し、opaque evidenceを内容複製せず列挙する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base);
  const proofPath = join(repo.root, "docs", "retained-proof.md"); const proofBody = "retained evidence\n";
  await writeFile(proofPath, proofBody);
  const proof = { type: "file", ref: "docs/retained-proof.md", digest: createHash("sha256").update(proofBody).digest("hex"), observed_at: "2026-07-14T00:00:00.000Z" };
  const opaque = { type: "executor-receipt", ref: "connector:codex-sidecar:retention", digest: "f".repeat(64), observed_at: "2026-07-14T00:00:00.000Z" };
  const init = await api.init({ cwd: repo.root, control_id: "retention-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "retention-control", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "retention-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "retention-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const template = makeWorkerRun(); const capabilities = template.workflow_capabilities.map((entry) => ({ ...entry, evidence: proof }));
  const worker = await api.workerRunRecord({
    cwd: repo.root, control_id: "retention-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "retention-worker", task_id: "retention-task", assignment_id: "retention-assignment", write_mode: "none", workspace_cwd: repo.root, workflow_capabilities: capabilities, execution_verification: { ...template.execution_verification, evidence: opaque }, lineage: { ...template.lineage, root_assignment_id: "retention-assignment" } }),
  });
  const retained = await api.resumeCheck({ cwd: repo.root, control_id: "retention-control" });
  assert.equal(retained.outcome, "ready");
  const laneDecision = makeLaneAdmission().decision;
  assert.deepEqual(retained.evidence_retention.local, [
    // v29 initが束縛したlane admission decisionも他のdecision evidenceと同じretention検証に乗る
    { type: "decision", ref: laneDecision.ref, digest: laneDecision.digest, status: "retained", observed_digest: laneDecision.digest, error_code: null },
    { type: "file", ref: proof.ref, digest: proof.digest, status: "retained", observed_digest: proof.digest, error_code: null },
  ]);
  assert.deepEqual(retained.evidence_retention.opaque, [{ type: "executor-receipt", ref: opaque.ref, digest: opaque.digest }]);
  await writeFile(proofPath, "changed evidence\n");
  const mismatch = await api.resumeCheck({ cwd: repo.root, control_id: "retention-control" });
  assert.equal(mismatch.outcome, "blocked"); assert.ok(mismatch.blocking_reasons.some((entry) => entry.code === "evidence-digest-mismatch"));
  await rm(proofPath);
  const missing = await api.resumeCheck({ cwd: repo.root, control_id: "retention-control" });
  assert.equal(missing.outcome, "blocked"); assert.ok(missing.blocking_reasons.some((entry) => entry.code === "evidence-missing"));
  await symlink("../README.md", proofPath);
  const unsafe = await api.resumeCheck({ cwd: repo.root, control_id: "retention-control" });
  assert.equal(unsafe.outcome, "blocked"); assert.ok(unsafe.blocking_reasons.some((entry) => entry.code === "evidence-unsafe"));
  assert.equal(worker.revision, 3);
});

test("resume checkは旧decision digestをgit履歴で保持しlegacy provider decision refをreviewへ送る", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base, "retention-history");
  const decisionRef = "docs/versioned-decision.md"; const oldBody = "old immutable decision\n"; const newBody = "new immutable decision\n";
  await writeFile(join(repo.root, decisionRef), oldBody); runGit(repo.root, ["add", decisionRef]); runGit(repo.root, ["commit", "-q", "-m", "record old decision"]);
  const historical = { type: "decision", ref: decisionRef, digest: createHash("sha256").update(oldBody).digest("hex"), observed_at: "2026-07-14T00:00:00.000Z" };
  const legacy = { type: "decision", ref: "native:/root/legacy-agent:parent-review", digest: "f".repeat(64), observed_at: "2026-07-14T00:00:00.000Z" };
  const init = await api.init({ cwd: repo.root, control_id: "retention-history-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "retention-history-control", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "retention-history-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "retention-history-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const template = makeWorkerRun(); const capabilities = template.workflow_capabilities.map((entry) => ({ ...entry, evidence: historical }));
  await api.workerRunRecord({
    cwd: repo.root, control_id: "retention-history-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "retention-history-worker", task_id: "retention-history-task", assignment_id: "retention-history-assignment", write_mode: "none", workspace_cwd: repo.root, workflow_capabilities: capabilities, execution_verification: { ...template.execution_verification, evidence: legacy }, lineage: { ...template.lineage, root_assignment_id: "retention-history-assignment" } }),
  });
  await writeFile(join(repo.root, decisionRef), newBody);
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "retention-history-control" });
  assert.equal(resumed.outcome, "review-required");
  assert.ok(resumed.review_reasons.some((entry) => entry.code === "evidence-legacy-decision-ref" && entry.subject_id === legacy.ref));
  assert.deepEqual(resumed.evidence_retention.local.find((entry) => entry.ref === decisionRef), {
    type: "decision", ref: decisionRef, digest: historical.digest, status: "retained-history",
    observed_digest: createHash("sha256").update(newBody).digest("hex"), error_code: "RETAINED_IN_GIT_HISTORY",
  });
  assert.deepEqual(resumed.evidence_retention.opaque.find((entry) => entry.ref === legacy.ref), { type: "decision", ref: legacy.ref, digest: legacy.digest });
  assert.equal(resumed.blocking_reasons.some((entry) => entry.subject_id === decisionRef || entry.subject_id === legacy.ref), false);
});

test("resume checkは予約中writerのHEAD移動をblockedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "resume-writer-head" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "resume-writer-head", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "resume-writer-head", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "resume-writer-task", isolation: "none", write_scope: [{ kind: "file", path: "README.md" }] }),
  });
  const run = await api.workerRunRecord({
    cwd: repo.root, control_id: "resume-writer-head", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ task_id: "resume-writer-task", workspace_cwd: repo.root }),
  });
  await api.admitWorker({ cwd: repo.root, control_id: "resume-writer-head", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  await writeFile(join(repo.root, "README.md"), "writer moved HEAD\n");
  runGit(repo.root, ["add", "README.md"]); runGit(repo.root, ["commit", "-q", "-m", "move writer head"]);
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "resume-writer-head" });
  assert.equal(resumed.outcome, "blocked");
  assert.ok(resumed.blocking_reasons.some((entry) => entry.code === "writer-head-changed" && entry.subject_id === "run-001"));
});

test("resume checkは予約中writerのignored成果物driftをblockedにする", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base);
  await writeFile(join(repo.root, ".gitignore"), "build/\n");
  runGit(repo.root, ["add", ".gitignore"]); runGit(repo.root, ["commit", "-q", "-m", "ignore build"]);
  const init = await api.init({ cwd: repo.root, control_id: "resume-writer-ignored", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "resume-writer-ignored", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "resume-writer-ignored", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "resume-writer-ignored-task", isolation: "none", write_scope: [{ kind: "directory", path: "build" }] }),
  });
  const run = await api.workerRunRecord({
    cwd: repo.root, control_id: "resume-writer-ignored", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ task_id: "resume-writer-ignored-task", workspace_cwd: repo.root }),
  });
  await api.admitWorker({ cwd: repo.root, control_id: "resume-writer-ignored", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  await mkdir(join(repo.root, "build")); await writeFile(join(repo.root, "build", "out.txt"), "ignored output\n");
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "resume-writer-ignored" });
  assert.equal(resumed.outcome, "blocked");
  assert.ok(resumed.blocking_reasons.some((entry) => entry.code === "writer-workspace-drift" && entry.subject_id === "run-001"));
});

test("resume checkはplanned writerのignored成果物差をreviewへ送る", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base);
  await writeFile(join(repo.root, ".gitignore"), "build/\n");
  runGit(repo.root, ["add", ".gitignore"]); runGit(repo.root, ["commit", "-q", "-m", "ignore planned build"]);
  const init = await api.init({ cwd: repo.root, control_id: "resume-planned-ignored", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "resume-planned-ignored", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "resume-planned-ignored", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "resume-planned-ignored-task", isolation: "none", write_scope: [{ kind: "directory", path: "build" }] }) });
  const template = makeWorkerRun(); const opaque = evidence("resume-planned-ignored", "executor-receipt");
  await api.workerRunRecord({ cwd: repo.root, control_id: "resume-planned-ignored", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "resume-planned-ignored-task", workspace_cwd: repo.root, workflow_capabilities: template.workflow_capabilities.map((entry) => ({ ...entry, evidence: opaque })), execution_verification: { ...template.execution_verification, evidence: opaque } }) });
  await mkdir(join(repo.root, "build")); await writeFile(join(repo.root, "build", "out.txt"), "planned ignored output\n");
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "resume-planned-ignored" });
  assert.equal(resumed.outcome, "review-required");
  assert.ok(resumed.review_reasons.some((entry) => entry.code === "worker-workspace-content-changed" && entry.subject_id === "run-001"));
});

test("resume checkはlinked worktree上のplanned Worker内容変更をreviewへ送る", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base);
  const proofBody = "worker evidence\n"; await writeFile(join(repo.root, "docs", "execution-proof.md"), proofBody);
  runGit(repo.root, ["add", "docs/execution-proof.md"]); runGit(repo.root, ["commit", "-q", "-m", "add worker evidence"]);
  const linked = await addLinkedWorktree(repo, "resume-read-worker");
  const proof = { type: "file", ref: "docs/execution-proof.md", digest: createHash("sha256").update(proofBody).digest("hex"), observed_at: "2026-07-14T00:00:00.000Z" };
  const init = await api.init({ cwd: repo.root, control_id: "resume-read-worker", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "resume-read-worker", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "resume-read-worker", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "resume-read-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }) });
  const template = makeWorkerRun();
  await api.workerRunRecord({
    cwd: repo.root, control_id: "resume-read-worker", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "resume-read-run", task_id: "resume-read-task", assignment_id: "resume-read-assignment",
      workspace_cwd: linked.root, write_mode: "none",
      workflow_capabilities: template.workflow_capabilities.map((entry) => ({ ...entry, evidence: proof })),
      execution_verification: { ...template.execution_verification, evidence: proof },
      lineage: { ...template.lineage, root_assignment_id: "resume-read-assignment" },
    }),
  });
  assert.equal((await api.resumeCheck({ cwd: repo.root, control_id: "resume-read-worker" })).outcome, "ready");
  await writeFile(join(linked.root, "README.md"), "linked worker changed\n");
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "resume-read-worker" });
  assert.equal(resumed.outcome, "review-required");
  assert.ok(resumed.review_reasons.some((entry) => entry.code === "worker-workspace-content-changed" && entry.subject_id === "resume-read-run"));
});

test("Control stateはPOSIX owner-only modeをread時にも強制する", async (t) => {
  if (process.platform === "win32") return;
  const { repo } = await initialized(t, { control_id: "mode-control" });
  const controlDir = join(repo.commonDir, "dotagents", "orchestrate", "controls", "mode-control");
  const manifestPath = join(controlDir, "manifest.json");
  await chmod(manifestPath, 0o644);
  await assert.rejects(api.status({ cwd: repo.root, control_id: "mode-control" }), code("STATE_PATH_UNSAFE"));
  await chmod(manifestPath, 0o600); await chmod(controlDir, 0o755);
  await assert.rejects(api.status({ cwd: repo.root, control_id: "mode-control" }), code("STATE_PATH_UNSAFE"));
});

test("receipt capacityは閉鎖用slotを予約し、archive済みControlからだけ後継へ継続する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "capacity-root" });
  const buildSaturatedManifest = (base, targetRevision = 253) => {
    const manifest = structuredClone(base);
    for (let revision = manifest.record_revision + 1; revision <= targetRevision; revision++) {
      const previous = manifest.transition_receipts.at(-1);
      manifest.transition_receipts.push(makeTransitionReceipt({
        revision, operation: "task-record", subject: { kind: "task", id: `synthetic-${revision}` },
        previous_state: null, next_state: "recorded", previous_receipt_digest: previous.receipt_digest,
      }));
    }
    manifest.record_revision = targetRevision;
    manifest.last_update = { actor_id: "parent-001", updated_at: "2026-07-14T00:00:00.000Z" };
    return manifest;
  };
  // CONTROL_CAPACITY_RESERVEDはtaskRecordのmutateコールバック内で新設されたPHASE_GATE_NOT_RECORDEDより後に評価されるため、
  // taskRecord経由の検証にはphase gate設定済みの別synthetic controlを要する（phaseGateRecord自体の検証は未設定のcapacity-rootを使う）。
  const manifest = buildSaturatedManifest(result.manifest);
  await writeJson(join(repo.commonDir, "dotagents", "orchestrate", "controls", "capacity-root", "manifest.json"), manifest);
  const gatedInit = await api.init({ cwd: repo.root, control_id: "capacity-root-gated", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const gatedPhase = await api.phaseGateRecord({ cwd: repo.root, control_id: "capacity-root-gated", actor_id: "parent", expected_revision: gatedInit.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const gatedManifest = buildSaturatedManifest(gatedPhase.manifest);
  await writeJson(join(repo.commonDir, "dotagents", "orchestrate", "controls", "capacity-root-gated", "manifest.json"), gatedManifest);
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "capacity-root-gated", actor_id: "parent", expected_revision: 253, task: makeTask({ task_id: "would-poison" }) }), code("CONTROL_CAPACITY_RESERVED"));
  await assert.rejects(api.phaseGateRecord({ cwd: repo.root, control_id: "capacity-root", actor_id: "parent", expected_revision: 253, risk: "standard", behavior_lane: "behavior-preserving" }), code("CONTROL_CAPACITY_RESERVED"));
  await assert.rejects(api.init({ cwd: repo.root, control_id: "too-early", predecessor_control_id: "capacity-root", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("CONTINUATION_NOT_READY"));
  await assert.rejects(api.finalizeControl({
    cwd: repo.root, control_id: "capacity-root", actor_id: "parent", expected_revision: 253,
    acceptance_matrix_ref: "docs/acceptance.md", final_audit_evidence: [evidence("docs/audit.md")],
    regression_evidence: [evidence("docs/regression.md")], knowledge_return_refs: ["docs/knowledge.md"],
    parent_decision: evidence("docs/adr/control-decision.md", "decision"), finalized_by: "parent",
  }), code("FINALIZATION_NOT_READY"));
  const archivalRoot = await api.init({ cwd: repo.root, control_id: "capacity-archival-root", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseComplete = await completePhaseGate(repo, "capacity-archival-root", archivalRoot.revision);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "capacity-archival-root", actor_id: "parent", expected_revision: phaseComplete.revision,
    acceptance_matrix_ref: "docs/acceptance.md", final_audit_evidence: [evidence("docs/audit.md")],
    regression_evidence: [evidence("docs/regression.md")], knowledge_return_refs: ["docs/knowledge.md"],
    parent_decision: evidence("docs/adr/control-decision.md", "decision"), finalized_by: "parent",
  }));
  const archived = await api.archive({ cwd: repo.root, control_id: "capacity-archival-root", actor_id: "parent", expected_revision: finalized.revision });
  const successor = await api.init({ cwd: repo.root, control_id: "capacity-successor", predecessor_control_id: "capacity-archival-root", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  assert.deepEqual(successor.manifest.continuation, { predecessor_control_id: "capacity-archival-root", root_control_id: "capacity-archival-root", sequence: 1 });
  await assert.rejects(api.init({ cwd: repo.root, control_id: "capacity-root", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("CONTROL_EXISTS"));
});

test("257件目のControlはcommit前に拒否し既存Controlをpoisonしない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "control-000" });
  const controls = join(repo.commonDir, "dotagents", "orchestrate", "controls");
  for (let index = 1; index < 256; index++) {
    const controlId = `control-${String(index).padStart(3, "0")}`;
    const manifest = structuredClone(result.manifest);
    manifest.control_id = controlId;
    manifest.continuation = { predecessor_control_id: null, root_control_id: controlId, sequence: 0 };
    manifest.transition_receipts = [makeTransitionReceipt({
      actor_id: manifest.last_update.actor_id,
      recorded_at: manifest.last_update.updated_at,
      subject: { kind: "control", id: controlId },
    })];
    await mkdir(join(controls, controlId), { mode: 0o700 });
    await writeJson(join(controls, controlId, "manifest.json"), manifest);
  }
  const input = { cwd: repo.root, control_id: "control-256", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() };
  await assert.rejects(api.init(input), code("CONTROL_CAPACITY_REACHED"));
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "control-000", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const existing = await api.taskRecord({ cwd: repo.root, control_id: "control-000", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "still-operational" }) });
  assert.equal(existing.revision, 2);
  await assert.rejects(access(join(controls, "control-256")));
});

test("TaskはF/A/H、scope、approval、global task_id一意性を正しく記録する", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const a = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: phaseGate.revision, task: makeTask() });
  assert.equal(a.revision, 2); assert.deepEqual((await readPersistedManifest(repo.commonDir, CONTROL)).tasks[0].doc_ref, makeTask().doc_ref); assert.match((await readPersistedManifest(repo.commonDir, CONTROL)).tasks[0].admission_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readdir(join(repo.commonDir, "dotagents", "orchestrate", "controls", CONTROL)), ["manifest.json"]);
  const f = makeTask({ task_id: "task-f", classification: "F", effect: "read", write_scope: [] });
  const fRecorded = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: a.revision, task: f });
  assert.equal(fRecorded.manifest.tasks.at(-1).classification, "F");
  const h = makeTask({ task_id: "task-h", classification: "H", effect: "read", write_scope: [], approval: makeApproval() });
  const hRecorded = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: fRecorded.revision, task: h });
  assert.equal(hRecorded.manifest.tasks.at(-1).approval.approval_ref, "docs/approval.md");
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: hRecorded.revision, task: makeTask({ task_id: "bad-h", classification: "H", approval: null }) }), code("INVALID_SCHEMA"));
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: hRecorded.revision, task: makeTask() }), code("DUPLICATE_ID"));
});

test("Task documentが未作成ならgit障害へ誤分類しない", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  await assert.rejects(
    api.taskRecord({
      cwd: repo.root,
      control_id: CONTROL,
      actor_id: "parent-001",
      expected_revision: phaseGate.revision,
      task: makeTask({ task_id: "missing-task-document", doc_ref: "docs/not-created.md" }),
    }),
    (error) => {
      assert.ok(error instanceof api.ControlRecordError);
      assert.equal(error.code, "IO_FAILURE");
      assert.equal(error.message, "task document is unavailable");
      return true;
    },
  );
});

test("H Task admissionはapproval snapshotのoperation digestと有効期限を照合する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "approval-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const approval = makeApproval();
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "h-task", classification: "H", effect: "read", write_scope: [], approval }),
  });
  const wrong = await api.workerRunRecord({
    cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "h-wrong", assignment_id: "h-wrong", task_id: "h-task", write_mode: "none", operation_digest: "f".repeat(64), workspace_cwd: repo.root }),
  });
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: wrong.revision, worker_run_id: "h-wrong" }), code("APPROVAL_MISMATCH"));
  const right = await api.workerRunRecord({
    cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: wrong.revision,
    worker_run: makeWorkerRun({ worker_run_id: "h-right", assignment_id: "h-right", task_id: "h-task", write_mode: "none", operation_digest: approval.operation_digest, workspace_cwd: repo.root }),
  });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: right.revision, worker_run_id: "h-right" });
  assert.equal(admitted.manifest.worker_runs.find((run) => run.worker_run_id === "h-right").state, "admitted");

  const expiredTask = await api.taskRecord({
    cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: admitted.revision,
    task: makeTask({ task_id: "h-expired-task", classification: "H", effect: "read", write_scope: [], approval: makeApproval({ approved_at: "2020-01-01T00:00:00.000Z", expires_at: "2020-01-02T00:00:00.000Z" }) }),
  });
  const expiredRun = await api.workerRunRecord({
    cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: expiredTask.revision,
    worker_run: makeWorkerRun({ worker_run_id: "h-expired", assignment_id: "h-expired", task_id: "h-expired-task", write_mode: "none", operation_digest: "d".repeat(64), workspace_cwd: repo.root }),
  });
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "approval-control", actor_id: "parent", expected_revision: expiredRun.revision, worker_run_id: "h-expired" }), code("APPROVAL_EXPIRED"));
});

test("role/effect policy snapshotはread-only roleと未承認integrator writeを拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "role-effect-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "role-effect-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  for (const role of ["sorter", "refuter", "verifier"]) {
    await assert.rejects(api.taskRecord({
      cwd: repo.root, control_id: "role-effect-control", actor_id: "parent", expected_revision: phaseGate.revision,
      task: makeTask({ task_id: `${role}-write`, role }),
    }), code("ROLE_EFFECT_FORBIDDEN"));
  }
  await assert.rejects(api.taskRecord({
    cwd: repo.root, control_id: "role-effect-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "integrator-write", role: "integrator" }),
  }), code("ROLE_EFFECT_FORBIDDEN"));
  const allowed = await api.taskRecord({
    cwd: repo.root, control_id: "role-effect-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "integrator-h-write", role: "integrator", classification: "H", approval: makeApproval() }),
  });
  assert.equal(allowed.manifest.tasks[0].role, "integrator");
  assert.deepEqual(allowed.manifest.role_effect_policy.read_only_roles, ["refuter", "sorter", "verifier"]);
});

test("Registry observationは根拠付きtri-stateとcapacityを保存し、将来adapterをdispatch許可へ昇格させない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "registry-primary" });
  const codexNative = makeRegistryObservation({ registry_observation_id: "registry-codex-native" });
  const nativeRecorded = await api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: result.revision, observation: codexNative,
  });
  assert.deepEqual(nativeRecorded.manifest.registry_observations, [codexNative]);
  assert.deepEqual(nativeRecorded.manifest.transition_receipts.at(-1).subject, { kind: "registry-observation", id: "registry-codex-native" });
  assert.equal(nativeRecorded.manifest.transition_receipts.at(-1).operation, "registry-observation-record");

  const sidecar = makeRegistryObservation({
    registry_observation_id: "registry-sidecar", executor: {
      adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default", handle_schema_id: "codex-sidecar.idempotency-key.v1",
    },
    workflow_id: "work",
    enabled: { value: "false", evidence: evidence("docs/sidecar-disabled.md") },
    capacity: {
      admission: { value: "false", evidence: evidence("docs/sidecar-admission.md") },
      hard_inflight_limit: { knowledge: "known", value: 3, evidence: evidence("docs/sidecar-hard-limit.md") },
      soft_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/sidecar-soft-limit.md") },
      observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/sidecar-observed.md") },
    },
  });
  const sidecarRecorded = await api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: nativeRecorded.revision, observation: sidecar,
  });
  assert.equal(sidecarRecorded.manifest.registry_observations[1].capacity.soft_inflight_limit.value, 2);

  const aiterm = makeRegistryObservation({
    registry_observation_id: "registry-aiterm", executor: {
      adapter_id: "aiterm", contract_version: "v1", instance_id: "local-default", handle_schema_id: "aiterm.session.v1",
    },
    workflow_id: "interactive-session",
  });
  const aitermRecorded = await api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: sidecarRecorded.revision, observation: aiterm,
  });
  assert.equal(aitermRecorded.manifest.registry_observations.length, 3);

  const future = makeRegistryObservation({
    registry_observation_id: "registry-future", executor: {
      adapter_id: "future-adapter", contract_version: "v9", instance_id: "future-instance", handle_schema_id: "future.handle.v1",
    },
    workflow_id: "future-workflow", enabled: { value: "unknown", evidence: null },
    capacity: {
      ...codexNative.capacity,
      hard_inflight_limit: { knowledge: "unknown", value: null, evidence: evidence("docs/future-capacity-unknown.md") },
    },
  });
  let futureRecorded = await api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: aitermRecorded.revision, observation: future,
  });
  assert.equal(futureRecorded.manifest.registry_observations.at(-1).executor.adapter_id, "future-adapter");
  const futureRefresh = makeRegistryObservation({ ...future, registry_observation_id: "registry-future-refresh", expires_at: "2026-07-14T02:00:00.000Z" });
  futureRecorded = await api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: futureRecorded.revision, observation: futureRefresh,
  });
  assert.equal(futureRecorded.manifest.registry_observations.at(-1).registry_observation_id, "registry-future-refresh");
  await assert.rejects(api.workerRunRecord({
    cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: futureRecorded.revision,
    worker_run: makeWorkerRun({ executor: future.executor, workflow_id: future.workflow_id }),
  }), code("ADAPTER_UNKNOWN"));

  const invalid = async (registry_observation_id, overrides, expected = "INVALID_SCHEMA") => {
    await assert.rejects(api.registryObservationRecord({
      cwd: repo.root, control_id: "registry-primary", actor_id: "parent-001", expected_revision: futureRecorded.revision,
      observation: makeRegistryObservation({ registry_observation_id, ...overrides }),
    }), code(expected));
  };
  await invalid("registry-missing-known-evidence", { enabled: { value: "true", evidence: null } });
  await invalid("registry-unknown-with-value", { capacity: { ...codexNative.capacity, observed_inflight: { knowledge: "unknown", value: 0, evidence: null } } });
  await invalid("registry-soft-over-hard", { capacity: { ...sidecar.capacity, soft_inflight_limit: { knowledge: "known", value: 4, evidence: evidence("docs/too-soft.md") } } });
  await invalid("registry-expiry-before-verification", { expires_at: "2026-07-13T23:59:59.000Z" });
  await invalid("registry-future-evidence", { enabled: { value: "true", evidence: evidence("docs/future-evidence.md", "file", { observed_at: "2026-07-14T00:00:01.000Z" }) } });
  await invalid("registry-gpt-connector", { executor: { adapter_id: "gpt-connector", contract_version: "v1", instance_id: "chat", handle_schema_id: "gpt-connector.slug.v1" } }, "EXECUTOR_FORBIDDEN");
  await invalid("registry-unknown-field", { unexpected: true });

  const second = await api.init({ cwd: repo.root, control_id: "registry-secondary", objective_ref: "docs/control-record-plan.md", actor_id: "parent-001", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  await assert.rejects(api.registryObservationRecord({
    cwd: repo.root, control_id: "registry-secondary", actor_id: "parent-001", expected_revision: second.revision,
    observation: makeRegistryObservation({ registry_observation_id: "registry-codex-native" }),
  }), code("DUPLICATE_ID"));
});

test("Placement dry-runはRegistry由来の候補をcanonical順で評価し、状態を変更しない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-control", budget: makeBudget({ max_wall_time_seconds: 3600, max_cost_microusd: 1000000 }) });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-control", actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-control", actor_id: "parent-001", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "placement-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const observedAt = "2026-07-14T00:00:00.000Z";
  const capacity = (overrides = {}) => ({
    admission: { value: "true", evidence: evidence("docs/placement-admission.md") },
    hard_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/placement-hard.md") },
    soft_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/placement-soft.md") },
    observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/placement-observed.md") },
    ...overrides,
  });
  const observation = (registry_observation_id, overrides = {}) => makeRegistryObservation({
    registry_observation_id,
    executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: registry_observation_id, handle_schema_id: "codex-native.agent-path.v1" },
    capacity: capacity(), ...overrides,
  });
  const inputs = [
    observation("placement-eligible"),
    observation("placement-admission-unknown", { capacity: capacity({ admission: { value: "unknown", evidence: null } }) }),
    observation("placement-soft-unknown", { capacity: capacity({ soft_inflight_limit: { knowledge: "unknown", value: null, evidence: null } }) }),
    observation("placement-soft-exhausted", { capacity: capacity({ soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/placement-soft-low.md") }, observed_inflight: { knowledge: "known", value: 1, evidence: evidence("docs/placement-observed-one.md") } }) }),
    observation("placement-disabled", { enabled: { value: "false", evidence: evidence("docs/placement-disabled.md") } }),
    observation("placement-enabled-unknown", { enabled: { value: "unknown", evidence: null } }),
    observation("placement-expired", { expires_at: "2026-07-14T00:15:00.000Z" }),
    observation("placement-adapter-unknown", { executor: { adapter_id: "future-adapter", contract_version: "v1", instance_id: "future", handle_schema_id: "future.handle.v1" }, workflow_id: "future-workflow" }),
    observation("placement-verification-insufficient", { verification: { stage: "installed", observed_version: "test-version", observed_at: observedAt, evidence: evidence("docs/placement-installed.md") } }),
    observation("placement-capability-missing", { workflow_capabilities: [{ capability_id: "workspace.read", value: "true", evidence: evidence("docs/placement-read.md") }] }),
    observation("placement-hard-exhausted", { capacity: capacity({ observed_inflight: { knowledge: "known", value: 2, evidence: evidence("docs/placement-observed-full.md") } }) }),
  ];
  let revision = task.revision;
  for (const entry of inputs) {
    const recorded = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-control", actor_id: "parent-001", expected_revision: revision, observation: entry });
    revision = recorded.revision;
  }
  const candidate = (candidate_id, registry_observation_id, overrides = {}) => makePlacementCandidate({ candidate_id, registry_observation_id, workspace_cwd: repo.root, ...overrides });
  const output = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-control", task_id: "placement-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [
      candidate("z-budget-unknown", "placement-eligible", { budget_reservation: makeBudgetReservation({ wall_time_seconds: null }) }),
      candidate("y-budget-exceeded", "placement-eligible", { budget_reservation: makeBudgetReservation({ wall_time_seconds: 3601 }) }),
      candidate("x-hard-exhausted", "placement-hard-exhausted"), candidate("w-capability", "placement-capability-missing"),
      candidate("v-verification", "placement-verification-insufficient"), candidate("u-adapter", "placement-adapter-unknown"),
      candidate("t-expired", "placement-expired"), candidate("s-enabled-unknown", "placement-enabled-unknown"),
      candidate("r-disabled", "placement-disabled"), candidate("q-soft-review", "placement-soft-exhausted"),
      candidate("p-soft-unknown-review", "placement-soft-unknown"), candidate("n-admission-review", "placement-admission-unknown"), candidate("o-registry-missing", "placement-missing"),
      candidate("a-eligible", "placement-eligible"),
    ],
  });
  assert.deepEqual(output, {
    control_id: "placement-control", control_revision: revision, task_id: "placement-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: output.candidates,
  });
  assert.deepEqual(output.candidates.map((entry) => entry.candidate_id), [...output.candidates.map((entry) => entry.candidate_id)].sort());
  const resultById = new Map(output.candidates.map((entry) => [entry.candidate_id, entry]));
  assert.deepEqual(resultById.get("a-eligible"), { candidate_id: "a-eligible", registry_observation_id: "placement-eligible", eligibility: "eligible", reasons: [] });
  for (const [candidateId, eligibility, reason] of [
    ["n-admission-review", "review-required", "capacity-review-required"], ["p-soft-unknown-review", "review-required", "capacity-review-required"], ["q-soft-review", "review-required", "capacity-review-required"],
    ["r-disabled", "ineligible", "enabled-false"], ["s-enabled-unknown", "ineligible", "enabled-unknown"],
    ["t-expired", "ineligible", "registry-expired"], ["u-adapter", "ineligible", "adapter-unknown"], ["o-registry-missing", "ineligible", "registry-missing"],
    ["v-verification", "ineligible", "verification-insufficient"], ["w-capability", "ineligible", "capability-mismatch"],
    ["x-hard-exhausted", "ineligible", "capacity-hard-exhausted"], ["y-budget-exceeded", "ineligible", "budget-exceeded"], ["z-budget-unknown", "ineligible", "budget-unknown"],
  ]) {
    assert.equal(resultById.get(candidateId).eligibility, eligibility);
    assert.ok(resultById.get(candidateId).reasons.includes(reason));
  }
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-control" })).record_revision, revision);
  const foundation = await api.taskRecord({
    cwd: repo.root, control_id: "placement-control", actor_id: "parent-001", expected_revision: revision,
    task: makeTask({ task_id: "placement-foundation", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const blocked = await api.taskRecord({
    cwd: repo.root, control_id: "placement-control", actor_id: "parent-001", expected_revision: foundation.revision,
    task: makeTask({ task_id: "placement-blocked", effect: "read", write_scope: [], isolation: "none", depends_on: ["placement-foundation"], required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const blockedPlacement = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-control", task_id: "placement-blocked", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [candidate("blocked-dependency", "placement-eligible")],
  });
  assert.deepEqual(blockedPlacement.candidates, [{ candidate_id: "blocked-dependency", registry_observation_id: "placement-eligible", eligibility: "ineligible", reasons: ["dependency-not-ready"] }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-control" })).record_revision, blocked.revision);
  await assert.rejects(api.placementDryRun({
    cwd: repo.root, control_id: "placement-control", task_id: "placement-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [candidate("duplicate", "placement-eligible"), candidate("duplicate", "placement-eligible")],
  }), code("INVALID_INPUT"));
  await assert.rejects(api.placementDryRun({
    cwd: repo.root, control_id: "placement-control", task_id: "placement-task", evaluated_at: "2026-07-14T00:30:00Z",
    candidates: [candidate("malformed-time", "placement-eligible")],
  }), code("INVALID_SCHEMA"));
  await assert.rejects(api.placementDryRun({
    cwd: repo.root, control_id: "placement-control", task_id: "placement-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [{ ...candidate("unknown-field", "placement-eligible"), unexpected: true }],
  }), code("INVALID_SCHEMA"));
});

test("Placement dry-runは同一executor/workflowのadmitted予約をRegistry observed_inflightへ合成する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-capacity-reservation" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "capacity-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const workerCapabilities = makeWorkerRun().workflow_capabilities;
  const observation = makeRegistryObservation({
    registry_observation_id: "capacity-registry", workflow_capabilities: workerCapabilities,
    capacity: {
      admission: { value: "true", evidence: evidence("docs/capacity-admission.md") },
      hard_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/capacity-hard.md") },
      soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/capacity-soft.md") },
      observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/capacity-observed.md") },
    },
  });
  const observed = await api.registryObservationRecord({
    cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: task.revision, observation,
  });
  const recorded = await api.workerRunRecord({
    cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: observed.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "capacity-existing-run", task_id: "capacity-task", assignment_id: "capacity-existing-assignment",
      executor: observation.executor, workflow_id: observation.workflow_id, workflow_capabilities: workerCapabilities,
      write_mode: "none", workspace_cwd: repo.root, executor_handle: { agent_path: "/root/capacity_existing_agent" },
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "capacity-existing-assignment" },
    }),
  });
  const admitted = await api.admitWorker({
    cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: recorded.revision, worker_run_id: "capacity-existing-run",
  });
  const placement = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-capacity-reservation", task_id: "capacity-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [makePlacementCandidate({
      candidate_id: "capacity-new-candidate", registry_observation_id: "capacity-registry", workspace_cwd: repo.root,
      executor_handle: { agent_path: "/root/capacity_new_agent" },
    })],
  });
  assert.deepEqual(placement.candidates, [{
    candidate_id: "capacity-new-candidate", registry_observation_id: "capacity-registry", eligibility: "ineligible", reasons: ["capacity-hard-exhausted"],
  }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-capacity-reservation" })).record_revision, admitted.revision);
  const sameTimestamp = await api.observeWorker({
    cwd: repo.root, control_id: "placement-capacity-reservation", actor_id: "parent-001", expected_revision: admitted.revision,
    worker_run_id: "capacity-existing-run", observation: workerObservation("dispatched", {
      source: "codex-native", observed_at: "2026-07-14T00:00:00.000Z",
    }),
  });
  const ambiguousPlacement = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-capacity-reservation", task_id: "capacity-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [makePlacementCandidate({
      candidate_id: "capacity-ambiguous-candidate", registry_observation_id: "capacity-registry", workspace_cwd: repo.root,
      executor_handle: { agent_path: "/root/capacity_ambiguous_agent" },
    })],
  });
  assert.deepEqual(ambiguousPlacement.candidates, [{
    candidate_id: "capacity-ambiguous-candidate", registry_observation_id: "capacity-registry", eligibility: "review-required", reasons: ["capacity-review-required"],
  }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-capacity-reservation" })).record_revision, sameTimestamp.revision);
});

test("Placement dry-runはF/H・workspace・global write conflictを実行せずに拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-policy-control" });
  const capabilities = makeWorkerRun().workflow_capabilities;
  const capacity = {
    admission: { value: "true", evidence: evidence("docs/policy-admission.md") },
    hard_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/policy-hard.md") },
    soft_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/policy-soft.md") },
    observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/policy-observed.md") },
  };
  const nativeRegistry = makeRegistryObservation({ registry_observation_id: "policy-native", workflow_capabilities: capabilities, capacity });
  const parentRegistry = makeRegistryObservation({
    registry_observation_id: "policy-parent", workflow_capabilities: capabilities, capacity,
    executor: { adapter_id: "parent", contract_version: "v1", instance_id: "parent-session", handle_schema_id: "parent.correlation.v1" }, workflow_id: "direct",
  });
  let revision = result.revision;
  const policyPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent-001", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = policyPhaseGate.revision;
  for (const observation of [nativeRegistry, parentRegistry]) {
    const recorded = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent-001", expected_revision: revision, observation });
    revision = recorded.revision;
  }
  const writeTask = (task_id, overrides = {}) => makeTask({
    task_id, effect: "write", isolation: "none", required_capabilities: ["report.structured", "workspace.write"],
    write_scope: [{ kind: "directory", path: "docs" }], ...overrides,
  });
  for (const entry of [
    writeTask("placement-f-write", { classification: "F" }),
    writeTask("placement-h-write", { classification: "H", approval: makeApproval({ expires_at: "2099-07-14T00:00:00.000Z" }) }),
    writeTask("placement-dedicated-write", { isolation: "dedicated-worktree" }),
    writeTask("placement-conflict-write"),
  ]) {
    const recorded = await api.taskRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent-001", expected_revision: revision, task: entry });
    revision = recorded.revision;
  }
  const candidate = (candidate_id, registry_observation_id, overrides = {}) => makePlacementCandidate({
    candidate_id, registry_observation_id, workspace_cwd: repo.root, write_mode: "direct", ...overrides,
  });
  const evaluate = (task_id, candidates) => api.placementDryRun({
    cwd: repo.root, control_id: "placement-policy-control", task_id, evaluated_at: "2026-07-14T00:30:00.000Z", candidates,
  });
  const f = await evaluate("placement-f-write", [
    candidate("f-external", "policy-native", { executor_handle: { agent_path: "/root/f_external_agent" } }),
    candidate("f-parent", "policy-parent", { executor_handle: { correlation_id: "f-parent-correlation" } }),
  ]);
  assert.deepEqual(f.candidates, [
    { candidate_id: "f-external", registry_observation_id: "policy-native", eligibility: "ineligible", reasons: ["policy-forbidden"] },
    { candidate_id: "f-parent", registry_observation_id: "policy-parent", eligibility: "eligible", reasons: [] },
  ]);
  const h = await evaluate("placement-h-write", [candidate("h-mismatch", "policy-native", { executor_handle: { agent_path: "/root/h_agent" } })]);
  assert.deepEqual(h.candidates, [{ candidate_id: "h-mismatch", registry_observation_id: "policy-native", eligibility: "ineligible", reasons: ["policy-forbidden"] }]);
  const dedicated = await evaluate("placement-dedicated-write", [candidate("dedicated-main", "policy-native", { executor_handle: { agent_path: "/root/dedicated_agent" } })]);
  assert.deepEqual(dedicated.candidates, [{ candidate_id: "dedicated-main", registry_observation_id: "policy-native", eligibility: "ineligible", reasons: ["workspace-invalid"] }]);
  const existing = await api.workerRunRecord({
    cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent-001", expected_revision: revision,
    worker_run: makeWorkerRun({
      worker_run_id: "placement-conflict-existing", task_id: "placement-conflict-write", assignment_id: "placement-conflict-existing-assignment",
      executor: nativeRegistry.executor, workflow_id: nativeRegistry.workflow_id, workflow_capabilities: capabilities,
      workspace_cwd: repo.root, executor_handle: { agent_path: "/root/placement_conflict_existing_agent" },
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "placement-conflict-existing-assignment" },
    }),
  });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent-001", expected_revision: existing.revision, worker_run_id: "placement-conflict-existing" });
  const conflict = await evaluate("placement-conflict-write", [candidate("conflict-new", "policy-native", { executor_handle: { agent_path: "/root/conflict_new_agent" } })]);
  assert.deepEqual(conflict.candidates, [{ candidate_id: "conflict-new", registry_observation_id: "policy-native", eligibility: "ineligible", reasons: ["write-conflict"] }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-policy-control" })).record_revision, admitted.revision);
});

test("Placement dry-runは古いRegistry snapshotをsupersedeし、同時刻の競合snapshotをreviewへ送る", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-refresh-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-refresh-control", actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-refresh-control", actor_id: "parent-001", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "refresh-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const capacity = {
    admission: { value: "true", evidence: evidence("docs/refresh-admission.md") },
    hard_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/refresh-hard.md") },
    soft_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/refresh-soft.md") },
    observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/refresh-observed.md") },
  };
  const old = makeRegistryObservation({ registry_observation_id: "refresh-old", capacity, verification: { stage: "execution-verified", observed_version: "old", observed_at: "2026-07-14T00:00:00.000Z", evidence: evidence("docs/refresh-old.md") }, expires_at: "2026-07-14T02:00:00.000Z" });
  const freshDisabled = makeRegistryObservation({ registry_observation_id: "refresh-disabled", capacity, enabled: { value: "false", evidence: evidence("docs/refresh-disabled.md") }, verification: { stage: "execution-verified", observed_version: "fresh", observed_at: "2026-07-14T00:10:00.000Z", evidence: evidence("docs/refresh-fresh.md") }, expires_at: "2026-07-14T02:00:00.000Z" });
  const oldRecorded = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-refresh-control", actor_id: "parent-001", expected_revision: task.revision, observation: old });
  const freshRecorded = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-refresh-control", actor_id: "parent-001", expected_revision: oldRecorded.revision, observation: freshDisabled });
  const candidate = (candidate_id, registry_observation_id) => makePlacementCandidate({ candidate_id, registry_observation_id, workspace_cwd: repo.root });
  const output = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-refresh-control", task_id: "refresh-task", evaluated_at: "2026-07-14T00:20:00.000Z",
    candidates: [candidate("old-candidate", "refresh-old"), candidate("fresh-candidate", "refresh-disabled")],
  });
  assert.deepEqual(output.candidates, [
    { candidate_id: "fresh-candidate", registry_observation_id: "refresh-disabled", eligibility: "ineligible", reasons: ["enabled-false"] },
    { candidate_id: "old-candidate", registry_observation_id: "refresh-old", eligibility: "ineligible", reasons: ["registry-superseded"] },
  ]);
  const tied = makeRegistryObservation({ registry_observation_id: "refresh-tied", capacity: { ...capacity, hard_inflight_limit: { knowledge: "known", value: 3, evidence: evidence("docs/refresh-tied-hard.md") } }, verification: { stage: "execution-verified", observed_version: "tied", observed_at: "2026-07-14T00:10:00.000Z", evidence: evidence("docs/refresh-tied.md") }, expires_at: "2026-07-14T02:00:00.000Z" });
  const tiedRecorded = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-refresh-control", actor_id: "parent-001", expected_revision: freshRecorded.revision, observation: tied });
  const ambiguous = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-refresh-control", task_id: "refresh-task", evaluated_at: "2026-07-14T00:20:00.000Z", candidates: [candidate("tied-candidate", "refresh-tied")],
  });
  assert.deepEqual(ambiguous.candidates, [{ candidate_id: "tied-candidate", registry_observation_id: "refresh-tied", eligibility: "review-required", reasons: ["registry-refresh-ambiguous"] }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-refresh-control" })).record_revision, tiedRecorded.revision);
});

test("Placement dry-runはRegistry観測済みのRun heartbeatをcapacityへ二重加算しない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-heartbeat-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "heartbeat-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const capabilities = makeWorkerRun().workflow_capabilities;
  const recorded = await api.workerRunRecord({
    cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "heartbeat-run", task_id: "heartbeat-task", assignment_id: "heartbeat-assignment", workflow_capabilities: capabilities, write_mode: "none", workspace_cwd: repo.root, executor_handle: { idempotency_key: "H".repeat(22) }, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "heartbeat-assignment" } }),
  });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: recorded.revision, worker_run_id: "heartbeat-run" });
  const dispatched = await api.observeWorker({
    cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: admitted.revision, worker_run_id: "heartbeat-run",
    observation: workerObservation("dispatched", { observed_at: "2026-07-14T00:00:00.000Z", dispatch_evidence: [evidence("docs/heartbeat-dispatch.md", "file", { observed_at: "2026-07-14T00:00:00.000Z" })] }),
  });
  const registry = makeRegistryObservation({
    registry_observation_id: "heartbeat-registry", executor: makeWorkerRun().executor, workflow_id: makeWorkerRun().workflow_id, workflow_capabilities: capabilities,
    capacity: {
      admission: { value: "true", evidence: evidence("docs/heartbeat-admission.md", "file", { observed_at: "2026-07-14T00:10:00.000Z" }) },
      hard_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/heartbeat-hard.md", "file", { observed_at: "2026-07-14T00:10:00.000Z" }) },
      soft_inflight_limit: { knowledge: "known", value: 2, evidence: evidence("docs/heartbeat-soft.md", "file", { observed_at: "2026-07-14T00:10:00.000Z" }) },
      observed_inflight: { knowledge: "known", value: 1, evidence: evidence("docs/heartbeat-observed.md", "file", { observed_at: "2026-07-14T00:10:00.000Z" }) },
    }, verification: { stage: "execution-verified", observed_version: "test-version", observed_at: "2026-07-14T00:10:00.000Z", evidence: evidence("docs/heartbeat-verification.md", "file", { observed_at: "2026-07-14T00:10:00.000Z" }) }, expires_at: "2026-07-14T02:00:00.000Z",
  });
  const observed = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: dispatched.revision, observation: registry });
  const running = await api.observeWorker({
    cwd: repo.root, control_id: "placement-heartbeat-control", actor_id: "parent-001", expected_revision: observed.revision, worker_run_id: "heartbeat-run",
    observation: workerObservation("running", { observed_at: "2026-07-14T00:20:00.000Z", source: "codex-sidecar" }),
  });
  const output = await api.placementDryRun({
    cwd: repo.root, control_id: "placement-heartbeat-control", task_id: "heartbeat-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [makePlacementCandidate({ candidate_id: "heartbeat-candidate", registry_observation_id: "heartbeat-registry", workspace_cwd: repo.root, executor_handle: { idempotency_key: "C".repeat(22) } })],
  });
  assert.deepEqual(output.candidates, [{ candidate_id: "heartbeat-candidate", registry_observation_id: "heartbeat-registry", eligibility: "eligible", reasons: [] }]);
  assert.equal((await api.status({ cwd: repo.root, control_id: "placement-heartbeat-control" })).record_revision, running.revision);
});

test("Placement dry-runはapproach family・retry・integration上限を決定論的理由で拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-policy-control", budget: makeBudget({ max_runs_per_approach_family: 1, max_retries_per_assignment: 0, max_integration_runs: 0 }) });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "placement-policy-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: task.revision, observation: makeRegistryObservation({ registry_observation_id: "placement-policy-registry", capacity: {
    admission: { value: "true", evidence: evidence("docs/policy-admission.md") }, hard_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/policy-hard.md") }, soft_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/policy-soft.md") }, observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/policy-inflight.md") },
  } }) });
  const existingRun = makeWorkerRun({ worker_run_id: "placement-policy-existing", task_id: "placement-policy-task", assignment_id: "placement-policy-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "placement-policy-assignment", approach_family_ref: "placement-primary" } });
  const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: registry.revision, worker_run: existingRun });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "placement-policy-existing" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "placement-policy-existing", observation: workerObservation("dispatched") });
  const failed = await api.observeWorker({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "placement-policy-existing", observation: terminalWorkerObservation() });
  const candidate = makePlacementCandidate({ candidate_id: "placement-policy-retry", registry_observation_id: "placement-policy-registry", assignment_id: "placement-policy-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "placement-policy-assignment", approach_family_ref: "placement-primary" }, executor_handle: { agent_path: "/root/placement_policy_retry" } });
  const evaluation = await api.placementDryRun({ cwd: repo.root, control_id: "placement-policy-control", task_id: "placement-policy-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [candidate] });
  assert.deepEqual(evaluation.candidates[0].reasons, ["approach-family-limit", "retry-limit"]);
  const unknown = makePlacementCandidate({ candidate_id: "placement-policy-unknown", registry_observation_id: "placement-policy-registry", assignment_id: "placement-policy-unknown-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "placement-policy-unknown-assignment", approach_family_ref: null }, executor_handle: { agent_path: "/root/placement_policy_unknown" } });
  assert.deepEqual((await api.placementDryRun({ cwd: repo.root, control_id: "placement-policy-control", task_id: "placement-policy-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [unknown] })).candidates[0].reasons, ["approach-family-unknown"]);

  const integrationTask = await api.taskRecord({ cwd: repo.root, control_id: "placement-policy-control", actor_id: "parent", expected_revision: failed.revision, task: makeTask({ task_id: "placement-integration-task", role: "integrator", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const integration = makePlacementCandidate({ candidate_id: "placement-integration-candidate", registry_observation_id: "placement-policy-registry", assignment_id: "placement-integration-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "placement-integration-assignment", approach_family_ref: "integration-primary" }, executor_handle: { agent_path: "/root/placement_integration_candidate" } });
  assert.deepEqual((await api.placementDryRun({ cwd: repo.root, control_id: "placement-policy-control", task_id: "placement-integration-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [integration] })).candidates[0].reasons, ["integration-capacity-exhausted"]);
});

test("Placement件数上限は所有Control内だけを数え別Controlの履歴を消費しない", async (t) => {
  const firstControl = "placement-budget-scope-a"; const secondControl = "placement-budget-scope-b";
  const { repo, result } = await initialized(t, { control_id: firstControl, budget: makeBudget({ max_runs_per_approach_family: 1 }) });
  const firstPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: firstControl, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const firstTask = await api.taskRecord({
    cwd: repo.root, control_id: firstControl, actor_id: "parent", expected_revision: firstPhaseGate.revision,
    task: makeTask({ task_id: "placement-budget-task-a", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }),
  });
  await api.workerRunRecord({
    cwd: repo.root, control_id: firstControl, actor_id: "parent", expected_revision: firstTask.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "placement-budget-run-a", task_id: "placement-budget-task-a", assignment_id: "placement-budget-assignment-a",
      executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "native-subagent", handle_schema_id: "codex-native.agent-path.v1" },
      workflow_id: "native-subagent", workflow_capabilities: [
        { capability_id: "report.structured", value: "true", evidence: evidence("docs/budget-scope-report.md") },
        { capability_id: "workspace.read", value: "true", evidence: evidence("docs/budget-scope-read.md") },
      ], write_mode: "none", workspace_cwd: repo.root, executor_handle: { agent_path: "/root/placement_budget_a" },
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "placement-budget-assignment-a", approach_family_ref: "shared-approach-family" },
    }),
  });
  const second = await api.init({
    cwd: repo.root, control_id: secondControl, objective_ref: "docs/control-record-plan.md", actor_id: "parent",
    document_refs: ["docs/control-record-plan.md"], budget: makeBudget({ max_runs_per_approach_family: 1 }), lane_admission: makeLaneAdmission(),
  });
  const secondPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: secondControl, actor_id: "parent", expected_revision: second.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const secondTask = await api.taskRecord({
    cwd: repo.root, control_id: secondControl, actor_id: "parent", expected_revision: secondPhaseGate.revision,
    task: makeTask({ task_id: "placement-budget-task-b", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const registry = await api.registryObservationRecord({
    cwd: repo.root, control_id: secondControl, actor_id: "parent", expected_revision: secondTask.revision,
    observation: makeRegistryObservation({ registry_observation_id: "placement-budget-registry-b", capacity: {
      admission: { value: "true", evidence: evidence("docs/budget-scope-admission.md") },
      hard_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/budget-scope-hard.md") },
      soft_inflight_limit: { knowledge: "known", value: 8, evidence: evidence("docs/budget-scope-soft.md") },
      observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/budget-scope-inflight.md") },
    } }),
  });
  const candidate = makePlacementCandidate({
    candidate_id: "placement-budget-candidate-b", registry_observation_id: "placement-budget-registry-b",
    assignment_id: "placement-budget-assignment-b", workspace_cwd: repo.root,
    lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "placement-budget-assignment-b", approach_family_ref: "shared-approach-family" },
    executor_handle: { agent_path: "/root/placement_budget_b" },
  });
  assert.deepEqual((await api.placementDryRun({
    cwd: repo.root, control_id: secondControl, task_id: "placement-budget-task-b", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [candidate],
  })).candidates, [{ candidate_id: "placement-budget-candidate-b", registry_observation_id: "placement-budget-registry-b", eligibility: "eligible", reasons: [] }]);
});

test("Placement reservationは同一revisionの配置判断をplanned Workerへ原子的に固定する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-reserve-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "reserve-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const registry = makeRegistryObservation({
    registry_observation_id: "reserve-registry", executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "reserve-instance", handle_schema_id: "codex-native.agent-path.v1" },
    expires_at: "2099-07-14T00:00:00.000Z",
    capacity: {
      admission: { value: "true", evidence: evidence("docs/reserve-admission.md") },
      hard_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/reserve-hard.md") },
      soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/reserve-soft.md") },
      observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/reserve-observed.md") },
    },
  });
  const observed = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: task.revision, observation: registry });
  const candidate = (candidate_id) => makePlacementCandidate({ candidate_id, registry_observation_id: "reserve-registry", workspace_cwd: repo.root, executor_handle: { agent_path: `/root/${candidate_id.replaceAll("-", "_")}_agent` } });
  const first = await api.reservePlacement({
    cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: observed.revision,
    task_id: "reserve-task", candidate: candidate("reserve-first"), review_decision: null,
  });
  const run = first.manifest.worker_runs.at(-1);
  assert.equal(run.worker_run_id, "reserve-first");
  assert.equal(run.state, "planned");
  assert.deepEqual(run.placement_reservation, {
    registry_observation_id: "reserve-registry", candidate_digest: run.placement_reservation.candidate_digest,
    selected_from_revision: observed.revision, eligibility: "eligible", review_reasons: [], review_decision: null,
    selected_by: "parent-001", selected_at: run.placement_reservation.selected_at,
  });
  const materializedCandidate = {
    candidate_id: run.worker_run_id, registry_observation_id: run.placement_reservation.registry_observation_id,
    assignment_id: run.assignment_id, workspace_cwd: run.workspace.worktree_root_realpath ?? run.workspace.git_dir_realpath,
    workspace_binding: run.workspace_binding.mode,
    write_mode: run.write_mode, operation_digest: run.operation_digest, budget_reservation: run.budget_reservation,
    lineage: run.lineage, fallback: run.fallback, executor_handle: run.executor_handle,
    recorded_workspace_fingerprint: run.recorded_workspace_fingerprint,
  };
  assert.equal(run.placement_reservation.candidate_digest, canonicalDigest(materializedCandidate));
  const receipt = first.manifest.transition_receipts.at(-1);
  assert.deepEqual(receipt.subject, { kind: "worker-run", id: "reserve-first" });
  assert.equal(receipt.subject_digest, canonicalDigest(run.placement_reservation));
  const forgedCandidate = structuredClone(first.manifest); forgedCandidate.worker_runs.at(-1).placement_reservation.candidate_digest = "0".repeat(64);
  assert.throws(() => api.validateManifest(forgedCandidate), code("INVALID_SCHEMA"));
  const forgedReceipt = structuredClone(first.manifest); const forgedLastReceipt = forgedReceipt.transition_receipts.at(-1);
  forgedLastReceipt.subject_digest = "0".repeat(64); const digestPayload = structuredClone(forgedLastReceipt); delete digestPayload.receipt_digest;
  forgedLastReceipt.receipt_digest = canonicalDigest(digestPayload);
  assert.throws(() => api.validateManifest(forgedReceipt), code("INVALID_SCHEMA"));
  const forgedInstance = structuredClone(first.manifest); forgedInstance.worker_runs.at(-1).executor.instance_id = "forged-instance";
  assert.throws(() => api.validateManifest(forgedInstance), code("INVALID_SCHEMA"));
  const forgedVerification = structuredClone(first.manifest); forgedVerification.worker_runs.at(-1).execution_verification.observed_version = "forged-version";
  assert.throws(() => api.validateManifest(forgedVerification), code("INVALID_SCHEMA"));
  const forgedCapabilityEvidence = structuredClone(first.manifest); forgedCapabilityEvidence.worker_runs.at(-1).workflow_capabilities[0].evidence.ref = "docs/forged-capability.md";
  assert.throws(() => api.validateManifest(forgedCapabilityEvidence), code("INVALID_SCHEMA"));
  const forgedRole = structuredClone(first.manifest); forgedRole.worker_runs.at(-1).role_ref = "refuter";
  assert.throws(() => api.validateManifest(forgedRole), code("INVALID_SCHEMA"));
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: observed.revision,
    task_id: "reserve-task", candidate: candidate("reserve-stale"), review_decision: null,
  }), code("REVISION_CONFLICT"));
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "placement-reserve-control", actor_id: "parent-001", expected_revision: first.revision,
    task_id: "reserve-task", candidate: candidate("reserve-second"), review_decision: null,
  }), code("PLACEMENT_INELIGIBLE"));

  const reviewInit = await api.init({ cwd: repo.root, control_id: "placement-reserve-review", objective_ref: "docs/control-record-plan.md", actor_id: "parent-001", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const reviewPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-reserve-review", actor_id: "parent-001", expected_revision: reviewInit.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const reviewTask = await api.taskRecord({
    cwd: repo.root, control_id: "placement-reserve-review", actor_id: "parent-001", expected_revision: reviewPhaseGate.revision,
    task: makeTask({ task_id: "reserve-review-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const reviewObservedAt = "2020-07-14T00:00:00.000Z";
  const reviewRegistry = makeRegistryObservation({
    registry_observation_id: "reserve-review-registry", executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "reserve-review-instance", handle_schema_id: "codex-native.agent-path.v1" },
    enabled: { value: "true", evidence: evidence("docs/reserve-review-enabled.md", "file", { observed_at: reviewObservedAt }) },
    workflow_capabilities: makeRegistryObservation().workflow_capabilities.map((entry) => ({ ...entry, evidence: evidence("docs/reserve-review-capabilities.md", "file", { observed_at: reviewObservedAt }) })),
    verification: { stage: "execution-verified", observed_version: "test-version", observed_at: reviewObservedAt, evidence: evidence("docs/reserve-review-verification.md", "file", { observed_at: reviewObservedAt }) }, expires_at: "2099-07-14T00:00:00.000Z",
  });
  const reviewObserved = await api.registryObservationRecord({ cwd: repo.root, control_id: "placement-reserve-review", actor_id: "parent-001", expected_revision: reviewTask.revision, observation: reviewRegistry });
  const reviewCandidate = makePlacementCandidate({ candidate_id: "reserve-review", registry_observation_id: "reserve-review-registry", assignment_id: "reserve-review-assignment", workspace_cwd: repo.root, executor_handle: { agent_path: "/root/reserve_review_agent" } });
  const reviewDryRun = await api.placementDryRun({ cwd: repo.root, control_id: "placement-reserve-review", task_id: "reserve-review-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [reviewCandidate] });
  assert.deepEqual(reviewDryRun.candidates[0], { candidate_id: "reserve-review", registry_observation_id: "reserve-review-registry", eligibility: "review-required", reasons: ["capacity-review-required"] });
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "placement-reserve-review", actor_id: "parent-001", expected_revision: reviewObserved.revision,
    task_id: "reserve-review-task", candidate: reviewCandidate, review_decision: null,
  }), code("PLACEMENT_REVIEW_REQUIRED"));
  const reviewed = await api.reservePlacement({
    cwd: repo.root, control_id: "placement-reserve-review", actor_id: "parent-001", expected_revision: reviewObserved.revision,
    task_id: "reserve-review-task", candidate: reviewCandidate, review_decision: evidence("docs/reserve-review-decision.md", "decision"),
  });
  assert.equal(reviewed.manifest.worker_runs.at(-1).placement_reservation.eligibility, "review-required");
  assert.equal(reviewed.manifest.worker_runs.at(-1).placement_reservation.review_decision.type, "decision");
});

test("Placement予約後に確定したnative handleをdispatch receiptへ相関してControlを継続できる", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "placement-late-handle-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "placement-late-handle-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const registry = await api.registryObservationRecord({
    cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: task.revision,
    observation: makeRegistryObservation({
      registry_observation_id: "placement-late-handle-registry", expires_at: "2099-07-14T00:00:00.000Z",
      capacity: {
        admission: { value: "true", evidence: evidence("docs/placement-late-handle-admission.md") },
        hard_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/placement-late-handle-hard.md") },
        soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/placement-late-handle-soft.md") },
        observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/placement-late-handle-inflight.md") },
      },
    }),
  });
  const reserved = await api.reservePlacement({
    cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: registry.revision,
    task_id: "placement-late-handle-task",
    candidate: makePlacementCandidate({
      candidate_id: "placement-late-handle-run", registry_observation_id: "placement-late-handle-registry",
      assignment_id: "placement-late-handle-assignment", workspace_cwd: repo.root, executor_handle: null,
      lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "placement-late-handle-assignment" },
    }),
    review_decision: null,
  });
  const admitted = await api.admitWorker({
    cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: reserved.revision,
    worker_run_id: "placement-late-handle-run",
  });
  const agentPath = "/root/placement_late_handle_agent";
  const dispatched = await api.observeWorker({
    cwd: repo.root, control_id: "placement-late-handle-control", actor_id: "parent", expected_revision: admitted.revision,
    worker_run_id: "placement-late-handle-run",
    observation: workerObservation("dispatched", { source: "codex-native", executor_handle: { agent_path: agentPath } }),
  });
  assert.equal(dispatched.manifest.worker_runs[0].state, "dispatched");
  assert.deepEqual(dispatched.manifest.worker_runs[0].executor_handle, { agent_path: agentPath });
  assert.deepEqual((await api.status({ cwd: repo.root, control_id: "placement-late-handle-control" })).worker_runs[0].executor_handle, { agent_path: agentPath });

  const forgedHandle = structuredClone(dispatched.manifest);
  forgedHandle.worker_runs[0].executor_handle = { agent_path: "/root/placement_late_handle_forged" };
  assert.throws(() => api.validateManifest(forgedHandle), code("INVALID_SCHEMA"));
  const forgedReceipt = structuredClone(dispatched.manifest);
  const receipt = forgedReceipt.transition_receipts.at(-1);
  receipt.subject_digest = "0".repeat(64);
  const receiptPayload = structuredClone(receipt); delete receiptPayload.receipt_digest;
  receipt.receipt_digest = canonicalDigest(receiptPayload);
  assert.throws(() => api.validateManifest(forgedReceipt), code("INVALID_SCHEMA"));
});

test("手動Worker記録もdedicated-worktree isolationを回避できない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "manual-isolation-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "manual-isolation-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "manual-isolation-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "manual-isolation-task", isolation: "dedicated-worktree", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const run = (workspace_cwd) => makeWorkerRun({ worker_run_id: "manual-isolation-worker", task_id: "manual-isolation-task", assignment_id: "manual-isolation-assignment", workspace_cwd, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "manual-isolation-assignment" } });
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "manual-isolation-control", actor_id: "parent", expected_revision: task.revision, worker_run: run(repo.root) }), code("WORKSPACE_DRIFT"));
  const linked = await addLinkedWorktree(repo, "manual-isolation-linked");
  const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "manual-isolation-control", actor_id: "parent", expected_revision: task.revision, worker_run: run(linked.root) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "manual-isolation-control", actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "manual-isolation-worker" });
  assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
});

test("sidecar durable workはsource予約と実行worktree bindingを分離してreportとacceptを検証する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "sidecar-binding-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "sidecar-binding-task", isolation: "dedicated-worktree", write_scope: [{ kind: "file", path: "README.md" }] }),
  });
  await writeFile(join(repo.root, "LOCAL.md"), "source-only dirty state\n");
  const recorded = await api.workerRunRecord({
    cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ task_id: "sidecar-binding-task", workspace_cwd: repo.root, workspace_binding: "executor-isolated" }),
  });
  let run = recorded.manifest.worker_runs[0];
  assert.equal(run.workspace.worktree_root_realpath, repo.root);
  assert.deepEqual(run.workspace_binding, {
    mode: "executor-isolated", schema_version: "codex-sidecar.delayed-worktree.v1", base_sha: repo.baseSha, preserve_worktree: true,
    execution_workspace: null, provider_binding: null, bound_from_revision: null, binding_evidence: [], bound_by: null, bound_at: null,
  });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "run-001" });
  assert.equal(admitted.manifest.worker_runs[0].baseline_workspace_fingerprint, null);
  const packet = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "sidecar-binding-control", worker_run_id: "run-001" });
  assert.equal(packet.workspace.worktree_root_realpath, repo.root); assert.equal(packet.workspace_binding.mode, "executor-isolated");
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("INVALID_TRANSITION"));
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "sidecar-binding-control" });
  assert.notEqual(resumed.outcome, "ready");
  assert.ok(resumed.review_reasons.some((entry) => entry.code === "worker-execution-workspace-unbound"));

  const otherBase = await makeTempDir("sidecar-other-"); t.after(() => cleanupDir(otherBase)); const other = await createGitRepo(otherBase);
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: other.root, provider_binding: sidecarProviderBinding(other.root), binding_evidence: [evidence("sidecar-result-other", "executor-receipt")] }), code("WORKSPACE_DRIFT"));
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: repo.root, provider_binding: sidecarProviderBinding(repo.root), binding_evidence: [evidence("sidecar-result-source", "executor-receipt")] }), code("WORKSPACE_DRIFT"));
  const wrongHead = await addLinkedWorktree(repo, "sidecar-wrong-head"); await writeFile(join(wrongHead.root, "README.md"), "wrong head\n"); runGit(wrongHead.root, ["add", "README.md"]); runGit(wrongHead.root, ["commit", "-q", "-m", "wrong head"]);
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: wrongHead.root, provider_binding: sidecarProviderBinding(wrongHead.root), binding_evidence: [evidence("sidecar-result-wrong-head", "executor-receipt")] }), code("WORKSPACE_DRIFT"));
  const missing = await addLinkedWorktree(repo, "sidecar-missing"); runGit(repo.root, ["worktree", "remove", "--force", missing.root]);
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: missing.root, provider_binding: sidecarProviderBinding(missing.root), binding_evidence: [evidence("sidecar-result-missing", "executor-receipt")] }), code("IO_FAILURE"));
  const good = await addLinkedWorktree(repo, "sidecar-good"); const linkPath = join((await makeTempDir("sidecar-link-")), "workspace-link"); t.after(() => cleanupDir(join(linkPath, ".."))); await symlink(good.root, linkPath);
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: linkPath, provider_binding: sidecarProviderBinding(linkPath), binding_evidence: [evidence("sidecar-result-link", "executor-receipt")] }), code("STATE_PATH_UNSAFE"));
  const bindingEvidence = [evidence("sidecar-result-good", "executor-receipt")];
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: good.root, provider_binding: sidecarProviderBinding(repo.root), binding_evidence: bindingEvidence }), code("REPORT_CORRELATION_MISMATCH"));
  await assert.rejects(api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: good.root, provider_binding: sidecarProviderBinding(good.root, { executor_handle: { idempotency_key: "B".repeat(22) } }), binding_evidence: bindingEvidence }), code("REPORT_CORRELATION_MISMATCH"));
  const providerBinding = sidecarProviderBinding(good.root);
  const bound = await api.bindWorkerWorkspace({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: good.root, provider_binding: providerBinding, binding_evidence: bindingEvidence });
  run = bound.manifest.worker_runs[0];
  assert.equal(run.state, "dispatched"); assert.equal(run.workspace_binding.execution_workspace.worktree_root_realpath, good.root);
  assert.deepEqual(run.workspace_binding.provider_binding, providerBinding);
  assert.equal(bound.manifest.transition_receipts.at(-1).operation, "worker-workspace-bind");
  const forged = structuredClone(bound.manifest); forged.worker_runs[0].workspace_binding.binding_evidence[0].ref = "tampered";
  assert.throws(() => api.validateManifest(forged), code("INVALID_SCHEMA"));
  const forgedProvider = structuredClone(bound.manifest); forgedProvider.worker_runs[0].workspace_binding.provider_binding.result_digest = "d".repeat(64);
  assert.throws(() => api.validateManifest(forgedProvider), code("INVALID_SCHEMA"));

  await writeFile(join(good.root, "README.md"), "sidecar output\n");
  const report = {
    schema_version: "dotagents.worker-report.v1", control_id: "sidecar-binding-control", task_id: "sidecar-binding-task", worker_run_id: "run-001", assignment_id: "assignment-001", packet_digest: packet.packet_digest,
    executor_handle: { idempotency_key: "A".repeat(22) }, observed_state: "completed", status: "completed", result_digest: "a".repeat(64), evidence: [evidence("docs/sidecar-result.md")],
    validation_results: [{ validation_ref: "node --test tests/orchestrate/*.test.mjs", outcome: "passed", evidence: evidence("tests/orchestrate/control-record.test.mjs", "command") }], changed_paths: ["README.md"], claims: ["sidecar-binding"],
  };
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: bound.revision, worker_run_id: "run-001", report: { ...report, result_digest: "c".repeat(64) } }), code("REPORT_CORRELATION_MISMATCH"));
  const imported = await api.importWorkerReport({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: bound.revision, worker_run_id: "run-001", report });
  assert.equal(imported.manifest.worker_runs[0].state, "completed");
  const accepted = await api.accept({ cwd: repo.root, control_id: "sidecar-binding-control", actor_id: "parent", expected_revision: imported.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/sidecar-accept.md", "decision")], decision_note: "bound workspace verified", decided_by: "parent" });
  assert.equal(accepted.manifest.worker_runs[0].acceptance.decision, "accepted");
});

test("worker-workspace-bind CLIはrecordだけを行い外部providerやcancel commandを実行しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "sidecar-bind-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "sidecar-bind-cli-task", isolation: "dedicated-worktree", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "sidecar-bind-cli-task", workspace_cwd: repo.root, workspace_binding: "executor-isolated" }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const linked = await addLinkedWorktree(repo, "sidecar-bind-cli-worktree"); const input = join(base, "sidecar-bind.json");
  await writeJson(input, { cwd: repo.root, control_id: "sidecar-bind-cli", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", workspace_cwd: linked.root, provider_binding: sidecarProviderBinding(linked.root), binding_evidence: [evidence("sidecar-cli-result", "executor-receipt")] });
  const invoked = spawnOrchestrate(["worker-workspace-bind", "--input", input], { env: { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` } });
  assert.equal(invoked.status, 0, invoked.stderr); assert.equal(JSON.parse(invoked.stdout).result.manifest.worker_runs[0].workspace_binding.execution_workspace.worktree_root_realpath, linked.root);
  await assert.rejects(access(sentinel.log));
});

test("未bind sidecar writerもscope予約を保持し、failed terminalはbindingなしで観測できる", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "sidecar-unbound-reservation" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const firstTask = await api.taskRecord({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "sidecar-unbound-first", isolation: "dedicated-worktree", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const firstRun = await api.workerRunRecord({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: firstTask.revision, worker_run: makeWorkerRun({ task_id: "sidecar-unbound-first", workspace_cwd: repo.root, workspace_binding: "executor-isolated" }) });
  const firstAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: firstRun.revision, worker_run_id: "run-001" });
  const overlappingTask = await api.taskRecord({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: firstAdmitted.revision, task: makeTask({ task_id: "sidecar-unbound-overlap", isolation: "none", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const overlappingRun = await api.workerRunRecord({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: overlappingTask.revision, worker_run: makeWorkerRun({ worker_run_id: "sidecar-overlap-run", task_id: "sidecar-unbound-overlap", assignment_id: "sidecar-overlap-assignment", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "sidecar-overlap-assignment" } }) });
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: overlappingRun.revision, worker_run_id: "sidecar-overlap-run" }), code("WRITE_CONFLICT"));
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: overlappingRun.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const failed = await api.observeWorker({ cwd: repo.root, control_id: "sidecar-unbound-reservation", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: terminalWorkerObservation("failed") });
  assert.equal(failed.manifest.worker_runs.find((entry) => entry.worker_run_id === "run-001").state, "failed");
  assert.equal(failed.manifest.worker_runs.find((entry) => entry.worker_run_id === "run-001").workspace_binding.execution_workspace, null);
});

test("WorkerとConsultationは分離され、同一read Taskを参照でき、gpt executorを拒否する", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const ctask = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: phaseGate.revision, task: makeTask({ task_id: "consultation-task", effect: "read", write_scope: [] }) });
  const consultation = makeConsultation();
  const recorded = await api.consultationRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: ctask.revision, consultation });
  assert.deepEqual(recorded.manifest.consultations, [consultation]);
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: recorded.revision, worker_run: makeWorkerRun({ task_id: "consultation-task", write_mode: "none", workspace_cwd: repo.root }) });
  assert.equal(worker.manifest.worker_runs[0].task_id, consultation.task_id);
  const dispatched = await api.observeConsultation({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: worker.revision, consultation_id: "consultation-001", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
  const completed = await api.observeConsultation({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: dispatched.revision, consultation_id: "consultation-001", observation: { state: "completed", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "completed", decision_ref: "docs/consultation-decision.md" } });
  assert.equal(completed.manifest.consultations[0].decision_ref, "docs/consultation-decision.md");
  const second = await api.consultationRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: completed.revision, consultation: makeConsultation({ consultation_id: "consultation-failed", assignment_id: "consultation-failed-assignment" }) });
  const secondDispatched = await api.observeConsultation({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: second.revision, consultation_id: "consultation-failed", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:03:00.000Z", raw_state: "dispatched" } });
  const failedEvidence = [evidence("connector:gpt-connector:consultation-failed", "executor-receipt")];
  const failed = await api.observeConsultation({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: secondDispatched.revision, consultation_id: "consultation-failed", observation: { state: "failed", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:04:00.000Z", raw_state: "failed", terminal_evidence: failedEvidence } });
  assert.deepEqual(failed.manifest.consultations[1].terminal_evidence, failedEvidence);
  await assert.rejects(api.consultationRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: failed.revision, consultation: makeConsultation({ consultation_id: "bad-consultation", workspace: { kind: "worktree" } }) }), code("INVALID_SCHEMA"));
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: failed.revision, worker_run: makeWorkerRun({ executor: { adapter_id: "gpt-connector", contract_version: "v1", instance_id: "chat", handle_schema_id: "gpt-connector.slug.v1" } }) }), code("EXECUTOR_FORBIDDEN"));
});

test("Task取消とWorker cancel requestは既存実行を変えず、証拠付きの終端だけを許す", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "cancel-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "cancel-task", effect: "read", write_scope: [] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "cancel-run", task_id: "cancel-task", assignment_id: "cancel-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "cancel-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "cancel-run" });
  const decision = evidence("docs/cancel-decision.md", "decision");
  const cancelledTask = await api.taskCancelRecord({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: admitted.revision, task_id: "cancel-task", decision });
  assert.equal(cancelledTask.manifest.worker_runs[0].state, "admitted");
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: cancelledTask.revision, worker_run_id: "cancel-run" }), code("INVALID_TRANSITION"));
  const requested = await api.requestWorkerCancel({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: cancelledTask.revision, worker_run_id: "cancel-run", decision });
  assert.equal(requested.manifest.worker_runs[0].state, "admitted");
  assert.deepEqual(requested.manifest.worker_runs[0].cancel_request.executor_handle, { idempotency_key: "A".repeat(22) });
  await assert.rejects(api.requestWorkerCancel({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: requested.revision, worker_run_id: "cancel-run", decision }), code("DUPLICATE_ID"));
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: requested.revision, worker_run_id: "cancel-run", observation: workerObservation("cancelled") }), code("EVIDENCE_REQUIRED"));
  const terminal = await api.observeWorker({ cwd: repo.root, control_id: "cancel-control", actor_id: "parent", expected_revision: requested.revision, worker_run_id: "cancel-run", observation: terminalWorkerObservation("cancelled") });
  assert.equal(terminal.manifest.worker_runs[0].state, "cancelled");
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "cancel-control" });
  assert.equal(brief.active.worker_runs.length, 0);
});

test("Task取消は既存Consultationを変えず新規dispatchだけを拒否し、active Runのterminal観測を許す", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "cancel-active-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "cancel-active-task", effect: "read", write_scope: [] }) });
  const plannedConsultation = await api.consultationRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: task.revision, consultation: makeConsultation({ consultation_id: "cancel-planned-consultation", task_id: "cancel-active-task", assignment_id: "cancel-planned-consultation-assignment" }) });
  const activeConsultation = await api.consultationRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: plannedConsultation.revision, consultation: makeConsultation({ consultation_id: "cancel-active-consultation", task_id: "cancel-active-task", assignment_id: "cancel-active-consultation-assignment", consultation_handle: { slug: "cancel-active-slug" } }) });
  const consultationDispatched = await api.observeConsultation({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: activeConsultation.revision, consultation_id: "cancel-active-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: consultationDispatched.revision, worker_run: makeWorkerRun({ worker_run_id: "cancel-active-run", task_id: "cancel-active-task", assignment_id: "cancel-active-worker-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "cancel-active-worker-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "cancel-active-run" });
  const workerDispatched = await api.observeWorker({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "cancel-active-run", observation: workerObservation("dispatched") });
  const cancelled = await api.taskCancelRecord({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: workerDispatched.revision, task_id: "cancel-active-task", decision: evidence("docs/cancel-active-decision.md", "decision") });
  assert.equal(cancelled.manifest.consultations.find((entry) => entry.consultation_id === "cancel-planned-consultation").state, "planned");
  assert.equal(cancelled.manifest.consultations.find((entry) => entry.consultation_id === "cancel-active-consultation").state, "dispatched");
  assert.equal(cancelled.manifest.worker_runs[0].state, "dispatched");
  await assert.rejects(api.observeConsultation({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: cancelled.revision, consultation_id: "cancel-planned-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "dispatched" } }), code("TASK_CANCELLED"));
  const consultationTerminal = await api.observeConsultation({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: cancelled.revision, consultation_id: "cancel-active-consultation", observation: { state: "failed", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:03:00.000Z", raw_state: "failed", terminal_evidence: [evidence("docs/cancel-active-consultation-terminal.md", "executor-receipt")] } });
  const workerTerminal = await api.observeWorker({ cwd: repo.root, control_id: "cancel-active-control", actor_id: "parent", expected_revision: consultationTerminal.revision, worker_run_id: "cancel-active-run", observation: terminalWorkerObservation("failed") });
  assert.equal(workerTerminal.manifest.consultations.find((entry) => entry.consultation_id === "cancel-active-consultation").state, "failed");
  assert.equal(workerTerminal.manifest.worker_runs[0].state, "failed");
});

test("Worker cancel requestはplannedとterminalを拒否し、取消record相関の改竄をfail closedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "cancel-schema-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "cancel-schema-task", effect: "read", write_scope: [] }) });
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "cancel-schema-run", task_id: "cancel-schema-task", assignment_id: "cancel-schema-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "cancel-schema-assignment" } }) });
  const decision = evidence("docs/cancel-schema-decision.md", "decision");
  await assert.rejects(api.requestWorkerCancel({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "cancel-schema-run", decision }), code("INVALID_TRANSITION"));
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "cancel-schema-run" });
  const cancelledTask = await api.taskCancelRecord({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: admitted.revision, task_id: "cancel-schema-task", decision });
  for (const mutate of [
    (manifest) => { manifest.task_cancellations[0].cancelled_from_revision += 1; },
    (manifest) => { manifest.task_cancellations[0].cancelled_by = "attacker"; },
    (manifest) => { manifest.task_cancellations[0].decision = evidence("docs/forged-decision.md", "decision"); },
  ]) {
    const tampered = structuredClone(cancelledTask.manifest); mutate(tampered);
    assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  }
  const requested = await api.requestWorkerCancel({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: cancelledTask.revision, worker_run_id: "cancel-schema-run", decision });
  const strayReceipt = structuredClone(requested.manifest); strayReceipt.worker_runs[0].cancel_request = null;
  assert.throws(() => api.validateManifest(strayReceipt), code("INVALID_SCHEMA"));
  const handleMismatch = structuredClone(requested.manifest); handleMismatch.worker_runs[0].cancel_request.executor_handle = { idempotency_key: "F".repeat(22) };
  assert.throws(() => api.validateManifest(handleMismatch), code("INVALID_SCHEMA"));
  const terminal = await api.observeWorker({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: requested.revision, worker_run_id: "cancel-schema-run", observation: terminalWorkerObservation("cancelled") });
  await assert.rejects(api.requestWorkerCancel({ cwd: repo.root, control_id: "cancel-schema-control", actor_id: "parent", expected_revision: terminal.revision, worker_run_id: "cancel-schema-run", decision }), code("INVALID_TRANSITION"));
});

test("Executor envelopeはworkflowとhandle schemaを分離し、未知adapterをstatus限定で保持する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "executor-envelope-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "executor-envelope-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "executor-envelope-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "executor-task", effect: "read", write_scope: [], required_capabilities: ["workspace.read", "report.structured"] }) });
  const known = await api.workerRunRecord({
    cwd: repo.root, control_id: "executor-envelope-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({
      task_id: "executor-task", write_mode: "none", workspace_cwd: repo.root, workflow_id: "review", executor_handle: null,
      executor: { adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default", handle_schema_id: "codex-sidecar.synchronous.v1" },
      workflow_capabilities: [
        { capability_id: "readonly.enforceable", value: "true", evidence: evidence("docs/execution-proof.md") },
        { capability_id: "report.structured", value: "true", evidence: evidence("docs/execution-proof.md") },
        { capability_id: "workspace.read", value: "true", evidence: evidence("docs/execution-proof.md") },
        { capability_id: "workspace.write", value: "false", evidence: evidence("docs/execution-proof.md") },
      ],
    }),
  });
  assert.deepEqual(known.manifest.worker_runs[0].executor, {
    adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default",
    handle_schema_id: "codex-sidecar.synchronous.v1",
  });
  assert.equal(known.manifest.worker_runs[0].workflow_id, "review");

  const persisted = await readPersistedManifest(repo.commonDir, "executor-envelope-control");
  persisted.worker_runs[0].executor = {
    adapter_id: "future-adapter", contract_version: "v9", instance_id: "future-instance",
    handle_schema_id: "future.handle.v3",
  };
  persisted.worker_runs[0].workflow_id = "future-workflow";
  persisted.worker_runs[0].executor_handle = { opaque_id: "future-handle", generation: 3 };
  const statePath = join(repo.commonDir, "dotagents", "orchestrate", "controls", "executor-envelope-control", "manifest.json");
  await writeFile(statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const readable = await api.status({ cwd: repo.root, control_id: "executor-envelope-control" });
  assert.equal(readable.worker_runs[0].executor.adapter_id, "future-adapter");
  assert.deepEqual(readable.worker_runs[0].executor_handle, { opaque_id: "future-handle", generation: 3 });
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "executor-envelope-control", actor_id: "parent", expected_revision: readable.record_revision, task: makeTask({ task_id: "must-not-mutate" }) }), code("ADAPTER_UNKNOWN"));
});

test("同期sidecarはdurable handleを捏造せずdispatchからstrict report importまで相関する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "sidecar-synchronous-report" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "sidecar-synchronous-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const capabilities = [
    { capability_id: "readonly.enforceable", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "report.structured", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "workspace.read", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "workspace.write", value: "false", evidence: evidence("docs/execution-proof.md") },
  ];
  const recorded = await api.workerRunRecord({
    cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "sidecar-synchronous-run", task_id: "sidecar-synchronous-task", assignment_id: "sidecar-synchronous-assignment",
      write_mode: "none", workspace_cwd: repo.root, workflow_id: "review", executor_handle: null,
      executor: { adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default", handle_schema_id: "codex-sidecar.synchronous.v1" },
      workflow_capabilities: capabilities,
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "sidecar-synchronous-assignment" },
    }),
  });
  const packet = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "sidecar-synchronous-report", worker_run_id: "sidecar-synchronous-run" });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "sidecar-synchronous-run" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "sidecar-synchronous-run", observation: workerObservation("dispatched", { executor_handle: null }) });
  assert.equal(dispatched.manifest.worker_runs[0].executor_handle, null);
  const report = {
    schema_version: "dotagents.worker-report.v1", control_id: "sidecar-synchronous-report", task_id: "sidecar-synchronous-task",
    worker_run_id: "sidecar-synchronous-run", assignment_id: "sidecar-synchronous-assignment", packet_digest: packet.packet_digest,
    executor_handle: null, observed_state: "completed", status: "completed", result_digest: "c".repeat(64),
    evidence: [evidence("docs/sidecar-synchronous-result.md")],
    validation_results: [{ validation_ref: "node --test tests/orchestrate/*.test.mjs", outcome: "passed", evidence: evidence("tests/orchestrate/control-record.test.mjs", "command") }],
    changed_paths: [], claims: ["同期workflowの結果をpacket digestで相関した"],
  };
  const imported = await api.importWorkerReport({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "sidecar-synchronous-run", report });
  assert.equal(imported.manifest.worker_runs[0].state, "completed");
  assert.equal(imported.manifest.worker_runs[0].executor_handle, null);
  const accepted = await api.accept({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: imported.revision, worker_run_id: "sidecar-synchronous-run", result_digest: report.result_digest, verification_evidence: [evidence("docs/sidecar-synchronous-accept.md", "decision")], decision_note: "packetとassignmentの相関を確認", decided_by: "parent" });
  assert.equal(accepted.manifest.worker_runs[0].acceptance.decision, "accepted");

  const nativeRecorded = await api.workerRunRecord({
    cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: accepted.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "native-handle-required-run", task_id: "sidecar-synchronous-task", assignment_id: "native-handle-required-assignment",
      write_mode: "none", workspace_cwd: repo.root, workflow_id: "native-subagent", executor_handle: null,
      executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "native", handle_schema_id: "codex-native.agent-path.v1" },
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "native-handle-required-assignment" },
    }),
  });
  const nativeAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: nativeRecorded.revision, worker_run_id: "native-handle-required-run" });
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "sidecar-synchronous-report", actor_id: "parent", expected_revision: nativeAdmitted.revision, worker_run_id: "native-handle-required-run", observation: workerObservation("dispatched") }), code("EVIDENCE_REQUIRED"));
});

test("未知または矛盾したExecutor契約は新規Runへ使えない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "executor-rejection-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "executor-rejection-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "executor-rejection-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "executor-task", effect: "read", write_scope: [] }) });
  const unknown = makeWorkerRun({
    task_id: "executor-task", write_mode: "none", workspace_cwd: repo.root, workflow_id: "future-workflow", executor_handle: null,
    executor: { adapter_id: "future-adapter", contract_version: "v1", instance_id: "future", handle_schema_id: "future.handle.v1" },
  });
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "executor-rejection-control", actor_id: "parent", expected_revision: task.revision, worker_run: unknown }), code("ADAPTER_UNKNOWN"));
  const mismatch = makeWorkerRun({
    task_id: "executor-task", write_mode: "none", workspace_cwd: repo.root, workflow_id: "review", executor_handle: null,
    executor: { adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default", handle_schema_id: "codex-sidecar.idempotency-key.v1" },
  });
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "executor-rejection-control", actor_id: "parent", expected_revision: task.revision, worker_run: mismatch }), code("ADAPTER_UNKNOWN"));
});

test("workflow capability snapshotはTask要件とsidecarのread/write境界をfail-closedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "workflow-capability-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "review-task", effect: "read", write_scope: [], required_capabilities: ["workspace.read", "report.structured"] }),
  });
  const reviewCapabilities = [
    { capability_id: "readonly.enforceable", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "report.structured", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "workspace.read", value: "true", evidence: evidence("docs/execution-proof.md") },
    { capability_id: "workspace.write", value: "false", evidence: evidence("docs/execution-proof.md") },
  ];
  const review = makeWorkerRun({
    task_id: "review-task", write_mode: "none", workspace_cwd: repo.root, workflow_id: "review", executor_handle: null,
    executor: { adapter_id: "codex-sidecar", contract_version: "v1", instance_id: "local-default", handle_schema_id: "codex-sidecar.synchronous.v1" },
    workflow_capabilities: reviewCapabilities,
  });
  const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: task.revision, worker_run: review });
  assert.equal(recorded.manifest.worker_runs[0].workflow_capabilities.find((entry) => entry.capability_id === "workspace.write").value, "false");

  const forgedWrite = structuredClone(review);
  forgedWrite.worker_run_id = "forged-write"; forgedWrite.assignment_id = "forged-write";
  forgedWrite.lineage.root_assignment_id = "forged-write";
  forgedWrite.workflow_capabilities.find((entry) => entry.capability_id === "workspace.write").value = "true";
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: recorded.revision, worker_run: forgedWrite }), code("CAPABILITY_MISMATCH"));

  const unknownRequired = structuredClone(review);
  unknownRequired.worker_run_id = "unknown-required"; unknownRequired.assignment_id = "unknown-required";
  unknownRequired.lineage.root_assignment_id = "unknown-required";
  unknownRequired.workflow_capabilities.find((entry) => entry.capability_id === "report.structured").value = "unknown";
  unknownRequired.workflow_capabilities.find((entry) => entry.capability_id === "report.structured").evidence = null;
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: recorded.revision, worker_run: unknownRequired }), code("CAPABILITY_MISMATCH"));

  const missingEvidence = structuredClone(review);
  missingEvidence.worker_run_id = "missing-evidence"; missingEvidence.assignment_id = "missing-evidence";
  missingEvidence.lineage.root_assignment_id = "missing-evidence";
  missingEvidence.workflow_capabilities[0].evidence = null;
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "workflow-capability-control", actor_id: "parent", expected_revision: recorded.revision, worker_run: missingEvidence }), code("INVALID_SCHEMA"));
});

test("Budget Envelopeは件数・外部Run・wall time・costとunknownを予約時に検査する", async (t) => {
  const { repo, result } = await initialized(t, {
    control_id: "budget-control",
    budget: makeBudget({ max_worker_runs: 3, max_consultations: 1, max_external_runs: 1, max_wall_time_seconds: 1000, max_cost_microusd: 1000 }),
  });
  assert.deepEqual(result.manifest.budget, makeBudget({ max_worker_runs: 3, max_consultations: 1, max_external_runs: 1, max_wall_time_seconds: 1000, max_cost_microusd: 1000 }));
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "budget-task", effect: "read", write_scope: [] }) });
  const external = await api.workerRunRecord({
    cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ task_id: "budget-task", write_mode: "none", workspace_cwd: repo.root, budget_reservation: makeBudgetReservation({ wall_time_seconds: 400, cost_microusd: 400 }) }),
  });

  const secondExternal = makeWorkerRun({
    worker_run_id: "external-two", assignment_id: "external-two", task_id: "budget-task", write_mode: "none", workspace_cwd: repo.root,
    budget_reservation: makeBudgetReservation({ wall_time_seconds: 100, cost_microusd: 100 }),
  });
  secondExternal.lineage.root_assignment_id = "external-two";
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: external.revision, worker_run: secondExternal }), code("BUDGET_EXCEEDED"));

  const parentRun = makeWorkerRun({
    worker_run_id: "parent-run", assignment_id: "parent-run", task_id: "budget-task", write_mode: "none", workspace_cwd: repo.root,
    executor: { adapter_id: "parent", contract_version: "v1", instance_id: "parent-session", handle_schema_id: "parent.correlation.v1" },
    workflow_id: "direct", executor_handle: { correlation_id: "parent-run" },
    budget_reservation: makeBudgetReservation({ wall_time_seconds: 500, cost_microusd: 500 }),
  });
  parentRun.lineage.root_assignment_id = "parent-run";
  const parentRecorded = await api.workerRunRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: external.revision, worker_run: parentRun });

  const consultation = makeConsultation({ task_id: "budget-task", budget_reservation: makeBudgetReservation({ wall_time_seconds: 100, cost_microusd: 100 }) });
  const consulted = await api.consultationRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: parentRecorded.revision, consultation });
  const secondConsultation = makeConsultation({ consultation_id: "consultation-two", assignment_id: "consultation-two", task_id: "budget-task", budget_reservation: makeBudgetReservation({ wall_time_seconds: 1, cost_microusd: 1 }) });
  await assert.rejects(api.consultationRecord({ cwd: repo.root, control_id: "budget-control", actor_id: "parent", expected_revision: consulted.revision, consultation: secondConsultation }), code("BUDGET_EXCEEDED"));

  const unknownControl = await api.init({
    cwd: repo.root, control_id: "budget-unknown-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent",
    document_refs: ["docs/control-record-plan.md"], budget: makeBudget({ max_wall_time_seconds: 1000, max_cost_microusd: 1000 }), lane_admission: makeLaneAdmission(),
  });
  const unknownPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "budget-unknown-control", actor_id: "parent", expected_revision: unknownControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const unknownTask = await api.taskRecord({ cwd: repo.root, control_id: "budget-unknown-control", actor_id: "parent", expected_revision: unknownPhaseGate.revision, task: makeTask({ task_id: "budget-unknown-task", effect: "read", write_scope: [] }) });
  const unknownRun = makeWorkerRun({ worker_run_id: "budget-unknown-run", assignment_id: "budget-unknown-assignment", task_id: "budget-unknown-task", write_mode: "none", workspace_cwd: repo.root, budget_reservation: makeBudgetReservation({ wall_time_seconds: null }) });
  unknownRun.lineage.root_assignment_id = "budget-unknown-assignment";
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "budget-unknown-control", actor_id: "parent", expected_revision: unknownTask.revision, worker_run: unknownRun }), code("BUDGET_UNKNOWN"));

  const unknownLimitControl = await api.init({
    cwd: repo.root, control_id: "budget-unknown-limit-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent",
    document_refs: ["docs/control-record-plan.md"], budget: makeBudget({ max_cost_microusd: null }), lane_admission: makeLaneAdmission(),
  });
  const unknownLimitPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "budget-unknown-limit-control", actor_id: "parent", expected_revision: unknownLimitControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const unknownLimitTask = await api.taskRecord({ cwd: repo.root, control_id: "budget-unknown-limit-control", actor_id: "parent", expected_revision: unknownLimitPhaseGate.revision, task: makeTask({ task_id: "budget-unknown-limit-task", effect: "read", write_scope: [] }) });
  const knownReservation = makeWorkerRun({ worker_run_id: "budget-known-run", assignment_id: "budget-known-assignment", task_id: "budget-unknown-limit-task", write_mode: "none", workspace_cwd: repo.root });
  knownReservation.lineage.root_assignment_id = "budget-known-assignment";
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "budget-unknown-limit-control", actor_id: "parent", expected_revision: unknownLimitTask.revision, worker_run: knownReservation }), code("BUDGET_UNKNOWN"));
});

test("Worker state遷移・evidence・retry reservationをrevision連鎖で保存する", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: phaseGate.revision, task: makeTask() });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: task.revision, worker_run: makeWorkerRun({ workspace_cwd: repo.root }) });
  assert.equal(run.manifest.worker_runs[0].state, "planned");
  assert.deepEqual(Object.keys(run.manifest.worker_runs[0].workspace).sort(), ["common_dir_realpath", "git_dir_file_id", "git_dir_realpath", "head_at_record", "head_at_reservation", "kind", "worktree_root_realpath"]);
  assert.equal(run.manifest.worker_runs[0].workspace.worktree_root_realpath, repo.root);
  assert.equal("workspace_cwd" in run.manifest.worker_runs[0], false);
  const taskDocument = join(repo.root, "docs", "control-record-plan.md");
  const originalDocument = await readFile(taskDocument, "utf8");
  await writeFile(taskDocument, `${originalDocument}changed after admission\n`);
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: run.revision, worker_run_id: "run-001" });
  assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
  assert.equal(admitted.manifest.tasks[0].admission_digest, taskAdmissionDigest(admitted.manifest.tasks[0]));
  await writeFile(taskDocument, originalDocument);
  assert.equal(admitted.manifest.worker_runs[0].admission.write_reservation, true);
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  assert.equal(dispatched.manifest.worker_runs[0].state, "dispatched");
  assert.deepEqual(dispatched.manifest.worker_runs[0].dispatch_evidence, [evidence("docs/dispatch-proof.md")]);
  await assert.rejects(
    api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: workerObservation("running", { dispatch_evidence: [] }) }),
    (error) => {
      assert.equal(error.code, "INVALID_SCHEMA");
      assert.equal(error.message, "observation.dispatch_evidence must contain at least 1 entries");
      return true;
    },
  );
  const failed = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: terminalWorkerObservation() });
  assert.equal(failed.manifest.worker_runs[0].state, "failed");
  assert.deepEqual(failed.manifest.worker_runs[0].terminal_evidence, [evidence("docs/executor-terminal-proof.md")]);
  assert.deepEqual(failed.manifest.transition_receipts.map((entry) => entry.operation), ["control-init", "phase-gate-record", "task-record", "worker-run-record", "worker-admit", "worker-observe", "worker-observe"]);
  assert.deepEqual(failed.manifest.transition_receipts.at(-2).evidence, [evidence("docs/dispatch-proof.md")]);
  assert.deepEqual(failed.manifest.transition_receipts.at(-1).evidence, [evidence("docs/executor-terminal-proof.md")]);
  const tampered = structuredClone(failed.manifest);
  tampered.transition_receipts[1] = makeTransitionReceipt({ ...tampered.transition_receipts[1], actor_id: "attacker" });
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  const missingReceipt = structuredClone(failed.manifest); missingReceipt.transition_receipts.pop();
  assert.throws(() => api.validateManifest(missingReceipt), code("INVALID_SCHEMA"));
  const retry = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: failed.revision, worker_run: makeWorkerRun({ worker_run_id: "run-002", workspace_cwd: repo.root }) });
  assert.equal(retry.manifest.worker_runs.at(-1).assignment_id, "assignment-001");
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: retry.revision, worker_run_id: "run-001", observation: workerObservation("running") }), code("INVALID_TRANSITION"));
  const fallbackRun = makeWorkerRun({ worker_run_id: "run-fallback", assignment_id: "assignment-fallback", workspace_cwd: repo.root, fallback: { from_worker_run_id: "run-001", decision_ref: "docs/fallback-decision.md" }, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "assignment-fallback", approach_family_ref: "fallback-provider" } });
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: retry.revision, worker_run: fallbackRun }), code("IO_FAILURE"));
  await writeFile(join(repo.root, "docs", "fallback-decision.md"), "# Fallback decision\n");
  const fallback = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent-001", expected_revision: retry.revision, worker_run: fallbackRun });
  assert.deepEqual(fallback.manifest.worker_runs.at(-1).fallback, { from_worker_run_id: "run-001", decision_ref: "docs/fallback-decision.md" });
  assert.equal(fallback.manifest.worker_runs.find((entry) => entry.worker_run_id === "run-001").state, "failed");
  const swappedDecision = structuredClone(fallback.manifest); swappedDecision.worker_runs.at(-1).fallback.decision_ref = "docs/control-record-plan.md";
  assert.throws(() => api.validateManifest(swappedDecision), code("INVALID_SCHEMA"));
  const tamperedFallback = structuredClone(fallback.manifest); tamperedFallback.worker_runs.at(-1).fallback.from_worker_run_id = "run-002";
  assert.throws(() => api.validateManifest(tamperedFallback), code("INVALID_SCHEMA"));
});

test("実adapter projectionをControl RecordのWorkerとConsultationへ往復できる", async (t) => {
  const controlId = "adapter-roundtrip-control"; const agentPath = "/root/adapter_roundtrip_agent";
  const { repo, result } = await initialized(t, { control_id: controlId });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "adapter-roundtrip-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const workerRun = makeWorkerRun({
    worker_run_id: "adapter-roundtrip-worker", task_id: "adapter-roundtrip-task", assignment_id: "adapter-roundtrip-worker-assignment",
    executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "native-subagent", handle_schema_id: "codex-native.agent-path.v1" },
    workflow_id: "native-subagent", write_mode: "none", workspace_cwd: repo.root, executor_handle: { agent_path: agentPath },
    lineage: { ...makeWorkerRun().lineage, root_assignment_id: "adapter-roundtrip-worker-assignment" },
  });
  const recorded = await api.workerRunRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: task.revision, worker_run: workerRun });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: recorded.revision, worker_run_id: "adapter-roundtrip-worker" });
  const nativeProjection = adapters.projectCodexNativeObservation({ agent_path: agentPath, status: "created", routing_receipt: nativeRoutingReceipt(agentPath), report_ref: null, evidence_refs: [] });
  const dispatchEvidence = [evidence("native-routing-receipt", "executor-receipt")];
  const workerObservationValue = adapters.buildWorkerControlObservation({ projection: nativeProjection, observed_version: "gpt-5.6-terra", observed_at: "2026-07-14T00:01:00.000Z", dispatch_evidence: dispatchEvidence });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "adapter-roundtrip-worker", observation: workerObservationValue });
  assert.equal(dispatched.manifest.worker_runs[0].state, "dispatched"); assert.deepEqual(dispatched.manifest.worker_runs[0].executor_handle, { agent_path: agentPath });

  const consultation = await api.consultationRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: dispatched.revision, consultation: makeConsultation({ consultation_id: "adapter-roundtrip-consultation", task_id: "adapter-roundtrip-task", assignment_id: "adapter-roundtrip-consultation-assignment", consultation_handle: { slug: "adapter-roundtrip-consultation" } }) });
  const timestamps = { createdAt: "2026-07-14T00:01:00.000Z", updatedAt: "2026-07-14T00:02:00.000Z" };
  const consultProjection = adapters.projectGptConnectorObservation({ slug: "adapter-roundtrip-consultation", provider: { slug: "adapter-roundtrip-consultation", state: "queued", ...timestamps, result: null, error: null } });
  const consultationObservation = adapters.buildConsultationControlObservation({ projection: consultProjection, observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z" });
  const consultationDispatched = await api.observeConsultation({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: consultation.revision, consultation_id: "adapter-roundtrip-consultation", observation: consultationObservation });
  assert.equal(consultationDispatched.manifest.consultations[0].state, "dispatched");
});

test("Task snapshotは文書全体OIDから独立し、同一Control依存のready gateとcycle検査を持つ", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "dependency-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const foundation = await api.taskRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "foundation-task" }) });
  const dependentTask = makeTask({ task_id: "dependent-task", depends_on: ["foundation-task"] });
  const dependent = await api.taskRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: foundation.revision, task: dependentTask });
  assert.equal(dependent.manifest.tasks[1].admission_digest, taskAdmissionDigest(dependent.manifest.tasks[1]));
  const tampered = structuredClone(dependent.manifest); tampered.tasks[1].title = "digestを更新していない改ざん";
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: dependent.revision, task: makeTask({ task_id: "unknown-dependency", depends_on: ["missing-task"] }) }), code("INVALID_SCHEMA"));
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: dependent.revision, worker_run: makeWorkerRun({ worker_run_id: "wrong-role-run", task_id: "dependent-task", assignment_id: "wrong-role-assignment", role_ref: "refuter", workspace_cwd: repo.root }) }), code("INVALID_SCHEMA"));
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: dependent.revision, worker_run: makeWorkerRun({ task_id: "dependent-task", workspace_cwd: repo.root }) });
  const consultation = await api.consultationRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: run.revision, consultation: makeConsultation({ task_id: "dependent-task" }) });
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: consultation.revision, worker_run_id: "run-001" }), code("DEPENDENCY_NOT_READY"));
  await assert.rejects(api.observeConsultation({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: consultation.revision, consultation_id: "consultation-001", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } }), code("DEPENDENCY_NOT_READY"));
  await materializeTaskDecision(repo, "docs/adr/foundation-decision.md");
  const finalized = await api.taskFinalizeRecord({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: consultation.revision, task_id: "foundation-task", finalization_ref: "docs/adr/foundation-decision.md", recorded_by: "parent" });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: finalized.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeConsultation({ cwd: repo.root, control_id: "dependency-control", actor_id: "parent", expected_revision: admitted.revision, consultation_id: "consultation-001", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "dispatched" } });
  assert.equal(dispatched.manifest.consultations[0].state, "dispatched");
  const cycle = structuredClone(dependent.manifest);
  cycle.tasks[0].depends_on = ["dependent-task"];
  cycle.tasks[0].admission_digest = taskAdmissionDigest(cycle.tasks[0]);
  cycle.tasks[1].admission_digest = taskAdmissionDigest(cycle.tasks[1]);
  assert.throws(() => api.validateManifest(cycle), code("INVALID_SCHEMA"));
});

test("Worker lineageは親子・root assignment・context・入力digestを事実として保存する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "lineage-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "lineage-task" }) });
  const root = await api.workerRunRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "lineage-task", workspace_cwd: repo.root }) });
  assert.equal(root.manifest.worker_runs[0].lineage.root_assignment_id, "assignment-001");
  const childLineage = {
    ...structuredClone(root.manifest.worker_runs[0].lineage),
    parent_worker_run_id: "run-001", root_assignment_id: "assignment-001",
    prompt_family: "refutation-v1", independence_group: "independent-refutation",
    input_digest: "c".repeat(64), approach_family_ref: "minimal-change",
    shared_artifact_ids: [],
  };
  const child = await api.workerRunRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: root.revision, worker_run: makeWorkerRun({ worker_run_id: "run-child", task_id: "lineage-task", assignment_id: "assignment-child", workspace_cwd: repo.root, lineage: childLineage }) });
  assert.deepEqual(child.manifest.worker_runs[1].lineage, childLineage);
  const unknownParent = { ...childLineage, parent_worker_run_id: "missing-run" };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: child.revision, worker_run: makeWorkerRun({ worker_run_id: "unknown-parent-run", task_id: "lineage-task", assignment_id: "unknown-parent-assignment", workspace_cwd: repo.root, lineage: unknownParent }) }), code("INVALID_SCHEMA"));
  const wrongContext = structuredClone(childLineage); wrongContext.parent_worker_run_id = null; wrongContext.root_assignment_id = "wrong-context-assignment"; wrongContext.context_policy.share_existing_findings = true;
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "lineage-control", actor_id: "parent", expected_revision: child.revision, worker_run: makeWorkerRun({ worker_run_id: "wrong-context-run", task_id: "lineage-task", assignment_id: "wrong-context-assignment", workspace_cwd: repo.root, lineage: wrongContext }) }), code("INVALID_SCHEMA"));
  const cycle = structuredClone(child.manifest);
  cycle.worker_runs[0].lineage.parent_worker_run_id = "run-child";
  assert.throws(() => api.validateManifest(cycle), code("INVALID_SCHEMA"));
});

test("docs artifactは4種別のdigest付き投影だけを記録し、親status更新と改竄検出を行う", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "artifact-control" });
  const digest = createHash("sha256").update("# artifact\n").digest("hex"); const ref = `docs/artifact.${digest}.md`; await writeFile(join(repo.root, ref), "# artifact\n");
  let revision = result.revision;
  const artifactControlPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = artifactControlPhaseGate.revision;
  for (const artifact_kind of ["finding", "approach", "gap", "decision"]) {
    const recorded = await api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: `artifact-${artifact_kind}`, artifact_kind, artifact_ref: ref, artifact_digest: digest, status: "current" } });
    revision = recorded.revision;
  }
  await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: "artifact-outside-docs", artifact_kind: "finding", artifact_ref: "README.md", artifact_digest: digest, status: "current" } }), code("INVALID_SCHEMA"));
  await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: "artifact-mutable-ref", artifact_kind: "finding", artifact_ref: "docs/artifact-mutable.md", artifact_digest: digest, status: "current" } }), code("INVALID_SCHEMA"));
  await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: "artifact-forged-metadata", artifact_kind: "finding", artifact_ref: ref, artifact_digest: digest, status: "current", recorded_by: "forged" } }), code("INVALID_SCHEMA"));
  await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: "artifact-missing", artifact_kind: "finding", artifact_ref: `docs/missing-artifact.${digest}.md`, artifact_digest: digest, status: "current" } }), code("ARTIFACT_UNAVAILABLE"));
  const linkRef = `docs/artifact-link.${digest}.md`; await symlink(`artifact.${digest}.md`, join(repo.root, linkRef));
  await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, artifact: { artifact_id: "artifact-link", artifact_kind: "finding", artifact_ref: linkRef, artifact_digest: digest, status: "current" } }), code("STATE_PATH_UNSAFE"));
  await rm(join(repo.root, linkRef));
  const sharingPolicy = { ...makeWorkerRun().lineage.context_policy, share_existing_findings: true };
  const task = await api.taskRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "artifact-task", effect: "read", write_scope: [], context_policy: sharingPolicy }) });
  const nonFindingLineage = { ...makeWorkerRun().lineage, root_assignment_id: "artifact-worker-invalid-assignment", context_policy: sharingPolicy, shared_artifact_ids: ["artifact-approach"] };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "artifact-worker-invalid", task_id: "artifact-task", assignment_id: "artifact-worker-invalid-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: nonFindingLineage }) }), code("INVALID_SCHEMA"));
  const findingLineage = { ...makeWorkerRun().lineage, root_assignment_id: "artifact-worker-assignment", context_policy: sharingPolicy, shared_artifact_ids: ["artifact-finding"] };
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "artifact-worker", task_id: "artifact-task", assignment_id: "artifact-worker-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: findingLineage }) });
  const closed = await api.artifactStatusRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: worker.revision, artifact_id: "artifact-finding", status: "closed" });
  assert.equal((await api.artifactStatus({ cwd: repo.root, control_id: "artifact-control", artifact_id: "artifact-finding" })).status, "closed");
  assert.equal((await api.statusBrief({ cwd: repo.root, control_id: "artifact-control" })).artifacts.length, 4);
  const tampered = structuredClone(closed.manifest); tampered.artifacts[0].artifact_digest = "a".repeat(64); assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  await writeFile(join(repo.root, ref), "# changed\n");
  await assert.rejects(api.artifactStatusRecord({ cwd: repo.root, control_id: "artifact-control", actor_id: "parent", expected_revision: closed.revision, artifact_id: "artifact-approach", status: "closed" }), code("ARTIFACT_DIGEST_MISMATCH"));
  assert.equal((await api.resumeCheck({ cwd: repo.root, control_id: "artifact-control" })).outcome, "blocked");
});

test("artifact世代交代はdigest版付きpathの旧版を保持しcurrentを原子的に切り替える", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "artifact-generation" });
  await downgradeControlToV28(repo, "artifact-generation");
  const oldBody = "# finding generation 1\n"; const oldDigest = createHash("sha256").update(oldBody).digest("hex");
  const oldRef = `docs/findings/release-audit.${oldDigest}.md`; await mkdir(join(repo.root, "docs/findings"), { recursive: true }); await writeFile(join(repo.root, oldRef), oldBody);
  const recorded = await api.artifactRecord({ cwd: repo.root, control_id: "artifact-generation", actor_id: "parent", expected_revision: result.revision, artifact: { artifact_id: "release-audit-v1", artifact_kind: "finding", artifact_ref: oldRef, artifact_digest: oldDigest, status: "current" } });
  const newBody = "# finding generation 2\n"; const newDigest = createHash("sha256").update(newBody).digest("hex");
  const newRef = `docs/findings/release-audit.${newDigest}.md`; await writeFile(join(repo.root, newRef), newBody);
  const generated = await api.artifactGenerationRecord({ cwd: repo.root, control_id: "artifact-generation", actor_id: "parent", expected_revision: recorded.revision, superseded_artifact_id: "release-audit-v1", artifact: { artifact_id: "release-audit-v2", artifact_kind: "finding", artifact_ref: newRef, artifact_digest: newDigest, status: "current" } });
  assert.equal(generated.revision, recorded.revision + 1);
  assert.equal(generated.manifest.artifacts.find((entry) => entry.artifact_id === "release-audit-v1").status, "superseded");
  assert.equal(generated.manifest.artifacts.find((entry) => entry.artifact_id === "release-audit-v2").status, "current");
  assert.deepEqual(generated.manifest.transition_receipts.slice(-1).map((entry) => [entry.operation, entry.subject.id]), [["artifact-generation-record", "release-audit-v1"]]);
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "artifact-generation" });
  assert.deepEqual(resumed.artifact_retention.map((entry) => [entry.artifact_id, entry.status]), [["release-audit-v1", "retained"], ["release-audit-v2", "retained"]]);
  const tamperedReceipt = structuredClone(generated.manifest); tamperedReceipt.transition_receipts.at(-1).subject_digest = "a".repeat(64); assert.throws(() => api.validateManifest(tamperedReceipt), code("INVALID_SCHEMA"));
  const tamperedSuccessor = structuredClone(generated.manifest); tamperedSuccessor.artifacts.find((entry) => entry.artifact_id === "release-audit-v2").artifact_ref = `docs/findings/forged.${newDigest}.md`; assert.throws(() => api.validateManifest(tamperedSuccessor), code("INVALID_SCHEMA"));
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "artifact-generation", actor_id: "parent", expected_revision: generated.revision, target_schema_version: "dotagents.orchestration-control.v27" }), code("ROLLBACK_UNSUPPORTED"));
});

test("artifact世代交代はmutable pathと旧版上書きを拒否しexact byte復元後だけ再試行できる", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "artifact-generation-recovery" });
  await downgradeControlToV28(repo, "artifact-generation-recovery");
  const legacySchema = await api.controlMigrate({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: result.revision, target_schema_version: "dotagents.orchestration-control.v27" });
  const legacyBody = "# legacy\n"; const legacyDigest = createHash("sha256").update(legacyBody).digest("hex"); const legacyRef = "docs/legacy.md"; await writeFile(join(repo.root, legacyRef), legacyBody);
  const legacy = await api.artifactRecord({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: legacySchema.revision, artifact: { artifact_id: "legacy-v1", artifact_kind: "finding", artifact_ref: legacyRef, artifact_digest: legacyDigest, status: "current" } });
  const nextBody = "# next\n"; const nextDigest = createHash("sha256").update(nextBody).digest("hex"); const nextRef = `docs/next.${nextDigest}.md`; await writeFile(join(repo.root, nextRef), nextBody);
  await assert.rejects(api.artifactGenerationRecord({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: legacy.revision, superseded_artifact_id: "legacy-v1", artifact: { artifact_id: "legacy-v2", artifact_kind: "finding", artifact_ref: nextRef, artifact_digest: nextDigest, status: "current" } }), code("SCHEMA_UPGRADE_REQUIRED"));
  const currentSchema = await api.controlMigrate({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: legacy.revision, target_schema_version: "dotagents.orchestration-control.v28" });
  await assert.rejects(api.artifactGenerationRecord({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: currentSchema.revision, superseded_artifact_id: "legacy-v1", artifact: { artifact_id: "legacy-v2", artifact_kind: "finding", artifact_ref: nextRef, artifact_digest: nextDigest, status: "current" } }), code("INVALID_SCHEMA"));

  const oldBody = "# immutable generation 1\n"; const oldDigest = createHash("sha256").update(oldBody).digest("hex"); const oldRef = `docs/immutable.${oldDigest}.md`; await writeFile(join(repo.root, oldRef), oldBody);
  const old = await api.artifactRecord({ cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: currentSchema.revision, artifact: { artifact_id: "immutable-v1", artifact_kind: "finding", artifact_ref: oldRef, artifact_digest: oldDigest, status: "current" } });
  await writeFile(join(repo.root, oldRef), "# overwritten\n");
  const generationInput = { cwd: repo.root, control_id: "artifact-generation-recovery", actor_id: "parent", expected_revision: old.revision, superseded_artifact_id: "immutable-v1", artifact: { artifact_id: "immutable-v2", artifact_kind: "finding", artifact_ref: nextRef, artifact_digest: nextDigest, status: "current" } };
  await assert.rejects(api.artifactGenerationRecord(generationInput), code("ARTIFACT_DIGEST_MISMATCH"));
  assert.equal((await api.artifactStatus({ cwd: repo.root, control_id: "artifact-generation-recovery", artifact_id: "immutable-v1" })).status, "current");
  await writeFile(join(repo.root, oldRef), oldBody);
  const recovered = await api.artifactGenerationRecord(generationInput);
  assert.equal(recovered.manifest.artifacts.find((entry) => entry.artifact_id === "immutable-v1").status, "superseded");
});

test("Finding共有はcontext policyと現行digestを実行境界で検査しlineageをreceiptへ束縛する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "finding-share-boundary" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const body = "# shared finding\n"; const digest = createHash("sha256").update(body).digest("hex"); const ref = `docs/shared-finding.${digest}.md`; await writeFile(join(repo.root, ref), body);
  const first = await api.artifactRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: phaseGate.revision, artifact: { artifact_id: "shared-finding-a", artifact_kind: "finding", artifact_ref: ref, artifact_digest: digest, status: "current" } });
  const second = await api.artifactRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: first.revision, artifact: { artifact_id: "shared-finding-b", artifact_kind: "finding", artifact_ref: ref, artifact_digest: digest, status: "current" } });
  const sharingPolicy = { ...makeWorkerRun().lineage.context_policy, share_existing_findings: true };
  const sharingTask = await api.taskRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: second.revision, task: makeTask({ task_id: "finding-share-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"], context_policy: sharingPolicy }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: sharingTask.revision, observation: makeRegistryObservation({ registry_observation_id: "finding-share-registry" }) });
  const sharedLineage = { ...makeWorkerRun().lineage, root_assignment_id: "finding-share-assignment", context_policy: sharingPolicy, shared_artifact_ids: ["shared-finding-a"] };
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: registry.revision, worker_run: makeWorkerRun({ worker_run_id: "finding-share-worker", task_id: "finding-share-task", assignment_id: "finding-share-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: sharedLineage }) });
  const noShareTask = await api.taskRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: worker.revision, task: makeTask({ task_id: "finding-no-share-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const forbiddenLineage = { ...makeWorkerRun().lineage, root_assignment_id: "finding-no-share-assignment", shared_artifact_ids: ["shared-finding-a"] };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: noShareTask.revision, worker_run: makeWorkerRun({ worker_run_id: "finding-no-share-worker", task_id: "finding-no-share-task", assignment_id: "finding-no-share-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: forbiddenLineage }) }), code("INVALID_SCHEMA"));
  const forbiddenPlacement = await api.placementDryRun({ cwd: repo.root, control_id: "finding-share-boundary", task_id: "finding-no-share-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [makePlacementCandidate({ candidate_id: "finding-no-share-placement", registry_observation_id: "finding-share-registry", assignment_id: "finding-no-share-placement-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "finding-no-share-placement-assignment", shared_artifact_ids: ["shared-finding-a"] } })] });
  assert.deepEqual(forbiddenPlacement.candidates[0].reasons, ["candidate-invalid"]);
  const tampered = structuredClone(noShareTask.manifest); tampered.worker_runs[0].lineage.shared_artifact_ids = ["shared-finding-b"]; assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  await writeFile(join(repo.root, ref), "# changed finding\n");
  const staleLineage = { ...sharedLineage, root_assignment_id: "finding-stale-assignment" };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: noShareTask.revision, worker_run: makeWorkerRun({ worker_run_id: "finding-stale-worker", task_id: "finding-share-task", assignment_id: "finding-stale-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: staleLineage }) }), code("ARTIFACT_DIGEST_MISMATCH"));
  const stalePlacement = await api.placementDryRun({ cwd: repo.root, control_id: "finding-share-boundary", task_id: "finding-share-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [makePlacementCandidate({ candidate_id: "finding-stale-placement", registry_observation_id: "finding-share-registry", assignment_id: "finding-stale-placement-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "finding-stale-placement-assignment", context_policy: sharingPolicy, shared_artifact_ids: ["shared-finding-a"] } })] });
  assert.ok(stalePlacement.candidates[0].reasons.includes("artifact-digest-mismatch"));
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "finding-share-boundary", actor_id: "parent", expected_revision: noShareTask.revision, worker_run_id: "finding-share-worker" }), code("ARTIFACT_DIGEST_MISMATCH"));
  await assert.rejects(api.delegationPacketForWorker({ cwd: repo.root, control_id: "finding-share-boundary", worker_run_id: "finding-share-worker" }), code("ARTIFACT_DIGEST_MISMATCH"));
});

test("artifact CLIはrecord/status更新/参照だけを行い外部providerを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "artifact-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const body = "# CLI artifact\n"; const digest = createHash("sha256").update(body).digest("hex"); const ref = `docs/cli-artifact.${digest}.md`; await writeFile(join(repo.root, ref), body);
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` };
  const recordInput = join(base, "artifact-record.json"); await writeJson(recordInput, { cwd: repo.root, control_id: "artifact-cli", actor_id: "parent", expected_revision: init.revision, artifact: { artifact_id: "cli-artifact", artifact_kind: "finding", artifact_ref: ref, artifact_digest: digest, status: "current" } });
  const recorded = spawnOrchestrate(["artifact-record", "--input", recordInput], { env }); assert.equal(recorded.status, 0); const recordResult = JSON.parse(recorded.stdout).result;
  const updateInput = join(base, "artifact-update.json"); await writeJson(updateInput, { cwd: repo.root, control_id: "artifact-cli", actor_id: "parent", expected_revision: recordResult.revision, artifact_id: "cli-artifact", status: "closed" });
  const updated = spawnOrchestrate(["artifact-status-record", "--input", updateInput], { env }); assert.equal(updated.status, 0);
  const statusInput = join(base, "artifact-status.json"); await writeJson(statusInput, { cwd: repo.root, control_id: "artifact-cli", artifact_id: "cli-artifact" });
  const status = spawnOrchestrate(["artifact-status", "--input", statusInput], { env }); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).result.status, "closed");
  await assert.rejects(access(sentinel.log));
});

test("artifact generation CLIは1 revisionのcomposite receiptだけを記録し外部providerを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "artifact-generation-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const oldBody = "# cli generation 1\n"; const oldDigest = createHash("sha256").update(oldBody).digest("hex"); const oldRef = `docs/cli-generation.${oldDigest}.md`; await writeFile(join(repo.root, oldRef), oldBody);
  const old = await api.artifactRecord({ cwd: repo.root, control_id: "artifact-generation-cli", actor_id: "parent", expected_revision: init.revision, artifact: { artifact_id: "cli-generation-v1", artifact_kind: "finding", artifact_ref: oldRef, artifact_digest: oldDigest, status: "current" } });
  const newBody = "# cli generation 2\n"; const newDigest = createHash("sha256").update(newBody).digest("hex"); const newRef = `docs/cli-generation.${newDigest}.md`; await writeFile(join(repo.root, newRef), newBody);
  const input = join(base, "artifact-generation.json"); await writeJson(input, { cwd: repo.root, control_id: "artifact-generation-cli", actor_id: "parent", expected_revision: old.revision, superseded_artifact_id: "cli-generation-v1", artifact: { artifact_id: "cli-generation-v2", artifact_kind: "finding", artifact_ref: newRef, artifact_digest: newDigest, status: "current" } });
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` }; const generated = spawnOrchestrate(["artifact-generation-record", "--input", input], { env }); assert.equal(generated.status, 0);
  const result = JSON.parse(generated.stdout).result; assert.equal(result.revision, old.revision + 1); assert.equal(result.manifest.transition_receipts.at(-1).operation, "artifact-generation-record");
  await assert.rejects(access(sentinel.log));
});

test("governed approach familyはblock/reopenで新規入口だけを止め、artifact根拠とcontext policyを検査する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "family-governance" });
  const artifacts = [
    ["family-decision-block", "decision", "# block\n"], ["family-basis-approach", "approach", "# approach\n"],
    ["family-decision-reopen", "decision", "# reopen\n"], ["family-basis-gap", "gap", "# gap\n"],
  ];
  let revision = result.revision;
  const familyGovernancePhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = familyGovernancePhaseGate.revision;
  for (const [artifact_id, artifact_kind, body] of artifacts) {
    const artifact_digest = createHash("sha256").update(body).digest("hex"); const artifact_ref = `docs/${artifact_id}.${artifact_digest}.md`; await writeFile(join(repo.root, artifact_ref), body);
    const recorded = await api.artifactRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: revision, artifact: { artifact_id, artifact_kind, artifact_ref, artifact_digest, status: "current" } });
    revision = recorded.revision;
  }
  const policy = makeWorkerRun().lineage.context_policy;
  const governed = await api.approachFamilyGovernanceRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: revision, approach_family_ref: "implementation-primary", context_policy: policy });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: governed.revision, task: makeTask({ task_id: "family-task", effect: "read", write_scope: [], isolation: "none" }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: task.revision, observation: makeRegistryObservation({ registry_observation_id: "family-registry" }) });
  const existing = await api.workerRunRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: registry.revision, worker_run: makeWorkerRun({ worker_run_id: "family-existing", task_id: "family-task", assignment_id: "family-existing-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "family-existing-assignment", approach_family_ref: "implementation-primary" } }) });
  const admittedRun = await api.workerRunRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: existing.revision, worker_run: makeWorkerRun({ worker_run_id: "family-admitted", task_id: "family-task", assignment_id: "family-admitted-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "family-admitted-assignment", approach_family_ref: "implementation-primary" } }) });
  const admittedExisting = await api.admitWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: admittedRun.revision, worker_run_id: "family-admitted" });
  const runningRun = await api.workerRunRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: admittedExisting.revision, worker_run: makeWorkerRun({ worker_run_id: "family-running", task_id: "family-task", assignment_id: "family-running-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "family-running-assignment", approach_family_ref: "implementation-primary" } }) });
  const runningAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: runningRun.revision, worker_run_id: "family-running" });
  const runningDispatched = await api.observeWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: runningAdmitted.revision, worker_run_id: "family-running", observation: workerObservation("dispatched") });
  const runningExisting = await api.observeWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: runningDispatched.revision, worker_run_id: "family-running", observation: workerObservation("running") });
  const blocked = await api.approachFamilyBlock({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: runningExisting.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "family-decision-block", basis_artifact_ids: ["family-basis-approach"] });
  assert.deepEqual(blocked.manifest.worker_runs.map((run) => run.state), ["planned", "admitted", "running"]);
  assert.ok(blocked.manifest.worker_runs.every((run) => run.cancel_request === null));
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: blocked.revision, worker_run_id: "family-existing" }), code("APPROACH_FAMILY_BLOCKED"));
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: blocked.revision, worker_run: makeWorkerRun({ worker_run_id: "family-blocked", task_id: "family-task", assignment_id: "family-blocked-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "family-blocked-assignment", approach_family_ref: "implementation-primary" } }) }), code("APPROACH_FAMILY_BLOCKED"));
  const placement = await api.placementDryRun({ cwd: repo.root, control_id: "family-governance", task_id: "family-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [makePlacementCandidate({ candidate_id: "family-placement", registry_observation_id: "family-registry", assignment_id: "family-placement-assignment", workspace_cwd: repo.root, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "family-placement-assignment", approach_family_ref: "implementation-primary" } })] });
  assert.ok(placement.candidates[0].reasons.includes("approach-family-blocked"));
  await assert.rejects(api.approachFamilyReopen({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: blocked.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "family-decision-reopen", basis_artifact_ids: ["family-basis-approach"] }), code("REOPEN_BASIS_NOT_NEW"));
  const reopened = await api.approachFamilyReopen({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: blocked.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "family-decision-reopen", basis_artifact_ids: ["family-basis-gap"] });
  const status = await api.approachFamilyStatus({ cwd: repo.root, control_id: "family-governance", approach_family_ref: "implementation-primary" }); assert.equal(status.state, "reopened");
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: reopened.revision, worker_run_id: "family-existing" }); assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
  await assert.rejects(api.approachFamilyBlock({ cwd: repo.root, control_id: "family-governance", actor_id: "parent", expected_revision: admitted.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "family-decision-block", basis_artifact_ids: ["family-basis-approach"] }), code("FAMILY_CYCLE_EXHAUSTED"));
  const tampered = structuredClone(admitted.manifest); tampered.family_governance[0].block.basis_artifact_ids = ["family-basis-gap"]; assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
});

test("approach family governanceのcontext mismatchとartifact kind不足をfail closedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "family-negative" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const body = "# finding\n"; const artifact_digest = createHash("sha256").update(body).digest("hex"); const artifact_ref = `docs/family-finding.${artifact_digest}.md`; await writeFile(join(repo.root, artifact_ref), body);
  const artifact = await api.artifactRecord({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: phaseGate.revision, artifact: { artifact_id: "family-finding", artifact_kind: "finding", artifact_ref, artifact_digest, status: "current" } });
  const governedPolicy = makeWorkerRun().lineage.context_policy;
  const family = await api.approachFamilyGovernanceRecord({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: artifact.revision, approach_family_ref: "implementation-primary", context_policy: governedPolicy });
  await assert.rejects(api.approachFamilyBlock({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: family.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "family-finding", basis_artifact_ids: ["family-finding"] }), code("ARTIFACT_INVALID"));
  const mismatchedPolicy = { ...governedPolicy, share_existing_findings: !governedPolicy.share_existing_findings };
  const task = await api.taskRecord({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: family.revision, task: makeTask({ task_id: "family-negative-task", effect: "read", write_scope: [], isolation: "none", context_policy: mismatchedPolicy }) });
  const mismatch = { ...makeWorkerRun().lineage, root_assignment_id: "family-negative-assignment", approach_family_ref: "implementation-primary", context_policy: mismatchedPolicy };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "family-negative", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "family-negative-worker", task_id: "family-negative-task", assignment_id: "family-negative-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: mismatch }) }), code("CONTEXT_POLICY_MISMATCH"));
});

test("approach family CLIはrecord/block/reopen/statusだけを行い外部providerを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "family-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const artifactSpecs = [
    ["cli-family-block-decision", "decision", "# block decision\n"], ["cli-family-approach", "approach", "# approach\n"],
    ["cli-family-reopen-decision", "decision", "# reopen decision\n"], ["cli-family-gap", "gap", "# gap\n"],
  ];
  let revision = init.revision;
  for (const [artifact_id, artifact_kind, body] of artifactSpecs) {
    const artifact_digest = createHash("sha256").update(body).digest("hex"); const artifact_ref = `docs/${artifact_id}.${artifact_digest}.md`; await writeFile(join(repo.root, artifact_ref), body);
    const recordedArtifact = await api.artifactRecord({ cwd: repo.root, control_id: "family-cli", actor_id: "parent", expected_revision: revision, artifact: { artifact_id, artifact_kind, artifact_ref, artifact_digest, status: "current" } });
    revision = recordedArtifact.revision;
  }
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` }; const policy = makeWorkerRun().lineage.context_policy;
  const recordInput = join(base, "family-record.json"); await writeJson(recordInput, { cwd: repo.root, control_id: "family-cli", actor_id: "parent", expected_revision: revision, approach_family_ref: "implementation-primary", context_policy: policy });
  const recorded = spawnOrchestrate(["approach-family-record", "--input", recordInput], { env }); assert.equal(recorded.status, 0);
  const recordResult = JSON.parse(recorded.stdout).result;
  const blockInput = join(base, "family-block.json"); await writeJson(blockInput, { cwd: repo.root, control_id: "family-cli", actor_id: "parent", expected_revision: recordResult.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "cli-family-block-decision", basis_artifact_ids: ["cli-family-approach"] });
  const blocked = spawnOrchestrate(["approach-family-block", "--input", blockInput], { env }); assert.equal(blocked.status, 0);
  const blockResult = JSON.parse(blocked.stdout).result;
  const reopenInput = join(base, "family-reopen.json"); await writeJson(reopenInput, { cwd: repo.root, control_id: "family-cli", actor_id: "parent", expected_revision: blockResult.revision, approach_family_ref: "implementation-primary", decision_artifact_id: "cli-family-reopen-decision", basis_artifact_ids: ["cli-family-gap"] });
  const reopened = spawnOrchestrate(["approach-family-reopen", "--input", reopenInput], { env }); assert.equal(reopened.status, 0);
  const statusInput = join(base, "family-status.json"); await writeJson(statusInput, { cwd: repo.root, control_id: "family-cli", approach_family_ref: "implementation-primary" });
  const status = spawnOrchestrate(["approach-family-status", "--input", statusInput], { env }); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).result.state, "reopened");
  await assert.rejects(access(sentinel.log));
});

test("DedupとFinding価値は親が裁定し票数・severity・独立性scoreをschemaへ持ち込めない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "parent-semantic-verdict" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "parent-semantic-verdict", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const body = "# semantic finding\n"; const artifact_digest = createHash("sha256").update(body).digest("hex"); const artifact_ref = `docs/semantic-finding.${artifact_digest}.md`; await writeFile(join(repo.root, artifact_ref), body);
  const baseArtifact = { artifact_id: "semantic-finding", artifact_kind: "finding", artifact_ref, artifact_digest, status: "current" };
  for (const forbidden of [{ severity: "critical" }, { votes: 3 }, { quorum: 2 }, { semantic_dedup_score: 0.95 }]) {
    await assert.rejects(api.artifactRecord({ cwd: repo.root, control_id: "parent-semantic-verdict", actor_id: "parent", expected_revision: phaseGate.revision, artifact: { ...baseArtifact, ...forbidden } }), code("INVALID_SCHEMA"));
  }
  const task = await api.taskRecord({ cwd: repo.root, control_id: "parent-semantic-verdict", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "semantic-task", effect: "read", write_scope: [] }) });
  const scoredLineage = { ...makeWorkerRun().lineage, root_assignment_id: "semantic-assignment", independence_score: 1 };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "parent-semantic-verdict", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "semantic-worker", task_id: "semantic-task", assignment_id: "semantic-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: scoredLineage }) }), code("INVALID_SCHEMA"));
  for (const forbidden of [{ quorum: 2 }, { semantic_dedup_score: 0.95 }]) {
    await assert.rejects(api.approachFamilyGovernanceRecord({ cwd: repo.root, control_id: "parent-semantic-verdict", actor_id: "parent", expected_revision: task.revision, approach_family_ref: "semantic-family", context_policy: makeWorkerRun().lineage.context_policy, ...forbidden }), code("INVALID_INPUT"));
  }
});

test("read-only Workerも正式admissionを通り、証拠つき結果と親検証を保存する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "read-admission-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "read-task", effect: "read", write_scope: [] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "read-task", write_mode: "none", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
  assert.deepEqual(admitted.manifest.worker_runs[0].admission.write_reservation, false);
  assert.equal(admitted.manifest.worker_runs[0].baseline_workspace_fingerprint, null);
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const completed = await api.observeWorker({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() });
  assert.deepEqual(completed.manifest.worker_runs[0].result.evidence, [evidence("docs/worker-result.md")]);
  const accepted = await api.accept({ cwd: repo.root, control_id: "read-admission-control", actor_id: "parent", expected_revision: completed.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/verify.md")], decision_note: "read evidence verified", decided_by: "parent" });
  assert.deepEqual(accepted.manifest.worker_runs[0].acceptance.verification_evidence, [evidence("docs/verify.md")]);
});

test("manifest truth tableとtyped evidenceは欠損・矛盾・黙殺をfail-closedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "truth-table-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "truth-task", effect: "read", write_scope: [] }) });
  const badEvidenceRun = makeWorkerRun({ worker_run_id: "bad-evidence-run", task_id: "truth-task", assignment_id: "bad-evidence-assignment", write_mode: "none", workspace_cwd: repo.root });
  badEvidenceRun.execution_verification.evidence = { ...badEvidenceRun.execution_verification.evidence, digest: "not-sha256" };
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: task.revision, worker_run: badEvidenceRun }), code("INVALID_SCHEMA"));
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "truth-task", write_mode: "none", workspace_cwd: repo.root }) });
  const forgedAdmission = structuredClone(run.manifest);
  forgedAdmission.worker_runs[0].state = "admitted";
  assert.throws(() => api.validateManifest(forgedAdmission), code("INVALID_SCHEMA"));
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001", observation: workerObservation("cancelled", { terminal_evidence: [evidence("docs/must-not-be-ignored.md")] }) }), code("INVALID_SCHEMA"));
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const forgedDispatch = structuredClone(admitted.manifest);
  forgedDispatch.worker_runs[0].state = "dispatched";
  assert.throws(() => api.validateManifest(forgedDispatch), code("INVALID_SCHEMA"));
  const cancelled = await api.observeWorker({ cwd: repo.root, control_id: "truth-table-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("cancelled", { dispatch_attempt_evidence: [evidence("connector:codex-sidecar:dispatch-attempt", "executor-receipt")] }) });
  assert.deepEqual(cancelled.manifest.worker_runs[0].dispatch_attempt_evidence, [evidence("connector:codex-sidecar:dispatch-attempt", "executor-receipt")]);
});

test("linked worktree共通dirでglobal lockとwrite競合を直列化し、non-overlapを許可する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const main = await createGitRepo(base); const linked = await addLinkedWorktree(main);
  const one = await api.init({ cwd: main.root, control_id: "main-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const two = await api.init({ cwd: linked.root, control_id: "linked-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  assert.equal(one.manifest.declaration.common_dir_realpath, two.manifest.declaration.common_dir_realpath);
  const onePhaseGate = await api.phaseGateRecord({ cwd: main.root, control_id: "main-control", actor_id: "parent", expected_revision: one.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const twoPhaseGate = await api.phaseGateRecord({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: two.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const global = await api.taskRecord({ cwd: main.root, control_id: "main-control", actor_id: "parent", expected_revision: onePhaseGate.revision, task: makeTask({ task_id: "global-unique" }) });
  await assert.rejects(api.taskRecord({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: twoPhaseGate.revision, task: makeTask({ task_id: "global-unique" }) }), code("DUPLICATE_ID"));
  const mainTask = await api.taskRecord({ cwd: main.root, control_id: "main-control", actor_id: "parent", expected_revision: global.revision, task: makeTask({ task_id: "race-a" }) });
  const linkedTask = await api.taskRecord({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: twoPhaseGate.revision, task: makeTask({ task_id: "race-b" }) });
  const mainRun = await api.workerRunRecord({ cwd: main.root, control_id: "main-control", actor_id: "parent", expected_revision: mainTask.revision, worker_run: makeWorkerRun({ worker_run_id: "race-run-a", task_id: "race-a", assignment_id: "race-assignment-a", workspace_cwd: main.root }) });
  const linkedRun = await api.workerRunRecord({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: linkedTask.revision, worker_run: makeWorkerRun({ worker_run_id: "race-run-b", task_id: "race-b", assignment_id: "race-assignment-b", workspace_cwd: linked.root }) });
  assert.deepEqual(await api.conflictCheck({ cwd: main.root, control_id: "main-control" }), { conflicts: [] });
  const [a, b] = await Promise.allSettled([
    api.admitWorker({ cwd: main.root, control_id: "main-control", actor_id: "parent", expected_revision: mainRun.revision, worker_run_id: "race-run-a" }),
    api.admitWorker({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: linkedRun.revision, worker_run_id: "race-run-b" }),
  ]);
  const fulfilled = [a, b].filter((x) => x.status === "fulfilled");
  const rejected = [a, b].filter((x) => x.status === "rejected");
  assert.ok(
    (fulfilled.length === 1 && rejected.length === 1 && ["LOCK_CONTENDED", "WRITE_CONFLICT"].includes(rejected[0].reason.code))
      || (fulfilled.length === 0 && rejected.length === 2 && rejected.every((x) => x.reason.code === "LOCK_CONTENDED")),
    `unexpected race result: ${JSON.stringify([a, b].map((result) => result.status === "fulfilled"
      ? { status: result.status }
      : { status: result.status, code: result.reason?.code, details: result.reason?.details }))}`,
  );
  const linkedRevision = b.status === "fulfilled" ? b.value.revision : linkedRun.revision;
  const later = await api.taskRecord({ cwd: linked.root, control_id: "linked-control", actor_id: "parent", expected_revision: linkedRevision, task: makeTask({ task_id: "non-overlap", write_scope: [{ kind: "directory", path: "tests/orchestrate" }] }) });
  assert.equal(later.manifest.tasks.at(-1).task_id, "non-overlap");
});

test("全manifest scanはassignment immutable tupleをControl横断で再検証する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base); const linked = await addLinkedWorktree(repo, "assignment-linked");
  const first = await api.init({ cwd: repo.root, control_id: "assignment-one", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const second = await api.init({ cwd: linked.root, control_id: "assignment-two", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const firstPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: first.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const secondPhaseGate = await api.phaseGateRecord({ cwd: linked.root, control_id: "assignment-two", actor_id: "parent", expected_revision: second.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const taskOne = await api.taskRecord({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: firstPhaseGate.revision, task: makeTask({ task_id: "assignment-task-one", effect: "read", write_scope: [] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: taskOne.revision, worker_run: makeWorkerRun({ worker_run_id: "assignment-run-one", assignment_id: "shared-assignment", task_id: "assignment-task-one", write_mode: "none", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: run.revision, worker_run_id: "assignment-run-one" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "assignment-run-one", observation: workerObservation("dispatched") });
  await api.observeWorker({ cwd: repo.root, control_id: "assignment-one", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "assignment-run-one", observation: terminalWorkerObservation() });
  const taskTwo = await api.taskRecord({ cwd: linked.root, control_id: "assignment-two", actor_id: "parent", expected_revision: secondPhaseGate.revision, task: makeTask({ task_id: "assignment-task-two", effect: "read", write_scope: [] }) });
  await assert.rejects(api.workerRunRecord({
    cwd: linked.root, control_id: "assignment-two", actor_id: "parent", expected_revision: taskTwo.revision,
    worker_run: makeWorkerRun({ worker_run_id: "assignment-run-two", assignment_id: "shared-assignment", task_id: "assignment-task-two", write_mode: "none", workspace_cwd: linked.root }),
  }), code("INVALID_SCHEMA"));
});

test("同一worktreeはscopeが非交差でも予約済みwrite Runを一件だけにする", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const firstTask = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "same-wt-a", write_scope: [{ kind: "directory", path: "lib" }] }) });
  const secondTask = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: firstTask.revision, task: makeTask({ task_id: "same-wt-b", write_scope: [{ kind: "directory", path: "tests" }] }) });
  const firstRun = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: secondTask.revision, worker_run: makeWorkerRun({ worker_run_id: "same-wt-run-a", task_id: "same-wt-a", assignment_id: "same-wt-assignment-a", workspace_cwd: repo.root }) });
  const secondRun = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: firstRun.revision, worker_run: makeWorkerRun({ worker_run_id: "same-wt-run-b", task_id: "same-wt-b", assignment_id: "same-wt-assignment-b", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: secondRun.revision, worker_run_id: "same-wt-run-a" });
  assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "same-wt-run-b" }), code("WRITE_CONFLICT"));
});

test("linked worktreeの同一scopeは同一alternative_groupのisolated-alternativeだけ両方予約できる", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const main = await createGitRepo(base); const linked = await addLinkedWorktree(main, "alternative-linked");
  const left = await api.init({ cwd: main.root, control_id: "alternative-left", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const right = await api.init({ cwd: linked.root, control_id: "alternative-right", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const leftPhaseGate = await api.phaseGateRecord({ cwd: main.root, control_id: "alternative-left", actor_id: "parent", expected_revision: left.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const rightPhaseGate = await api.phaseGateRecord({ cwd: linked.root, control_id: "alternative-right", actor_id: "parent", expected_revision: right.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const leftTask = await api.taskRecord({ cwd: main.root, control_id: "alternative-left", actor_id: "parent", expected_revision: leftPhaseGate.revision, task: makeTask({ task_id: "alternative-task-left", alternative_group: "choice-a" }) });
  const rightTask = await api.taskRecord({ cwd: linked.root, control_id: "alternative-right", actor_id: "parent", expected_revision: rightPhaseGate.revision, task: makeTask({ task_id: "alternative-task-right", alternative_group: "choice-a" }) });
  const leftRun = await api.workerRunRecord({ cwd: main.root, control_id: "alternative-left", actor_id: "parent", expected_revision: leftTask.revision, worker_run: makeWorkerRun({ worker_run_id: "alternative-run-left", task_id: "alternative-task-left", assignment_id: "alternative-assignment-left", workspace_cwd: main.root, write_mode: "isolated-alternative" }) });
  const rightRun = await api.workerRunRecord({ cwd: linked.root, control_id: "alternative-right", actor_id: "parent", expected_revision: rightTask.revision, worker_run: makeWorkerRun({ worker_run_id: "alternative-run-right", task_id: "alternative-task-right", assignment_id: "alternative-assignment-right", workspace_cwd: linked.root, write_mode: "isolated-alternative" }) });
  const leftReserved = await api.admitWorker({ cwd: main.root, control_id: "alternative-left", actor_id: "parent", expected_revision: leftRun.revision, worker_run_id: "alternative-run-left" });
  const rightReserved = await api.admitWorker({ cwd: linked.root, control_id: "alternative-right", actor_id: "parent", expected_revision: rightRun.revision, worker_run_id: "alternative-run-right" });
  assert.equal(leftReserved.manifest.worker_runs[0].state, "admitted");
  assert.equal(rightReserved.manifest.worker_runs[0].state, "admitted");
});

test("別linked worktreeでalternative_group不一致は同一scopeを予約できない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const main = await createGitRepo(base); const linked = await addLinkedWorktree(main, "negative-alternative-linked");
  const left = await api.init({ cwd: main.root, control_id: "negative-left", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const right = await api.init({ cwd: linked.root, control_id: "negative-right", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const leftPhaseGate = await api.phaseGateRecord({ cwd: main.root, control_id: "negative-left", actor_id: "parent", expected_revision: left.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const rightPhaseGate = await api.phaseGateRecord({ cwd: linked.root, control_id: "negative-right", actor_id: "parent", expected_revision: right.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const leftTask = await api.taskRecord({ cwd: main.root, control_id: "negative-left", actor_id: "parent", expected_revision: leftPhaseGate.revision, task: makeTask({ task_id: "negative-left-task", alternative_group: "choice-a" }) });
  const rightTask = await api.taskRecord({ cwd: linked.root, control_id: "negative-right", actor_id: "parent", expected_revision: rightPhaseGate.revision, task: makeTask({ task_id: "negative-right-task", alternative_group: "choice-b" }) });
  const leftRun = await api.workerRunRecord({ cwd: main.root, control_id: "negative-left", actor_id: "parent", expected_revision: leftTask.revision, worker_run: makeWorkerRun({ worker_run_id: "negative-left-run", task_id: "negative-left-task", assignment_id: "negative-left-assignment", workspace_cwd: main.root, write_mode: "isolated-alternative" }) });
  const rightRun = await api.workerRunRecord({ cwd: linked.root, control_id: "negative-right", actor_id: "parent", expected_revision: rightTask.revision, worker_run: makeWorkerRun({ worker_run_id: "negative-right-run", task_id: "negative-right-task", assignment_id: "negative-right-assignment", workspace_cwd: linked.root, write_mode: "isolated-alternative" }) });
  const admitted = await api.admitWorker({ cwd: main.root, control_id: "negative-left", actor_id: "parent", expected_revision: leftRun.revision, worker_run_id: "negative-left-run" });
  assert.equal(admitted.manifest.worker_runs[0].state, "admitted");
  await assert.rejects(api.admitWorker({ cwd: linked.root, control_id: "negative-right", actor_id: "parent", expected_revision: rightRun.revision, worker_run_id: "negative-right-run" }), code("WRITE_CONFLICT"));
});

test("linked worktreeをremove/re-addした実identity driftはadmission時に拒否する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const main = await createGitRepo(base); const linked = await addLinkedWorktree(main, "identity-linked");
  const init = await api.init({ cwd: main.root, control_id: "identity-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: main.root, control_id: "identity-control", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: main.root, control_id: "identity-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "identity-task" }) });
  const run = await api.workerRunRecord({ cwd: main.root, control_id: "identity-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "identity-task", workspace_cwd: linked.root }) });
  const recordedFileId = run.manifest.worker_runs[0].workspace.git_dir_file_id;
  assert.match(recordedFileId, /^\d+:\d+$/);
  runGit(main.root, ["worktree", "remove", "--force", linked.root]);
  runGit(main.root, ["worktree", "add", "-q", "-b", "identity-readded", linked.root]);
  const readdedGitDir = runGit(linked.root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const readdedStat = await (await import("node:fs/promises")).stat(readdedGitDir);
  assert.notEqual(`${readdedStat.dev}:${readdedStat.ino}`, recordedFileId);
  const resume = await api.resumeCheck({ cwd: main.root, control_id: "identity-control" });
  assert.equal(resume.outcome, "blocked");
  assert.ok(resume.blocking_reasons.some((entry) => entry.code === "worker-worktree-generation-changed" && entry.subject_id === "run-001"));
  await assert.rejects(api.admitWorker({ cwd: main.root, control_id: "identity-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" }), code("WORKSPACE_DRIFT"));
});

test("atomic manifest更新中も並行readerは完全JSONと旧または新revisionだけを観測する", { skip: process.platform === "win32" }, async (t) => {
  const { repo, result } = await initialized(t);
  const manifestPath = join(repo.commonDir, "dotagents", "orchestrate", "controls", CONTROL, "manifest.json");
  const observations = []; let reading = true;
  const reader = (async () => { while (reading) { const value = JSON.parse(await readFile(manifestPath, "utf8")); observations.push(value.record_revision); } })();
  let revision = result.revision;
  const atomicPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: revision, risk: "standard", behavior_lane: "behavior-preserving" }); revision = atomicPhaseGate.revision;
  for (const number of [1, 2, 3]) {
    const mutation = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: `atomic-task-${number}` }) });
    revision = mutation.revision;
  }
  reading = false; await reader;
  assert.ok(observations.length > 0);
  assert.ok(observations.every((value) => Number.isInteger(value) && value >= result.revision && value <= revision));
  assert.deepEqual(await readdir(join(repo.commonDir, "dotagents", "orchestrate", "controls", CONTROL)), ["manifest.json"]);
});

test("durability faultはlock残留や偽成功を作らずunknown outcomeを明示する", async (t) => {
  await withRepo(t, async (repo) => {
    const init = await api.init({ cwd: repo.root, control_id: "manifest-fault", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "manifest-fault", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    await withFault("manifest-after-rename", () => assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "manifest-fault", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "committed-but-unknown" }) }), code("COMMIT_OUTCOME_UNKNOWN")));
    const observed = await api.status({ cwd: repo.root, control_id: "manifest-fault" });
    assert.equal(observed.record_revision, 2); assert.equal(observed.tasks[0].task_id, "committed-but-unknown");
  });
  await withRepo(t, async (repo) => {
    const init = await api.init({ cwd: repo.root, control_id: "owner-fault", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "owner-fault", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    await withFault("owner-publish-after-rename", () => assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "owner-fault", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "never-recorded" }) }), code("IO_FAILURE")));
    assert.deepEqual(await readdir(join(repo.commonDir, "dotagents", "orchestrate", "lock-owners")), []);
    await withFault("owner-release-after-unlink", () => assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "owner-fault", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "release-unknown" }) }), code("LOCK_OUTCOME_UNKNOWN")));
    assert.equal((await api.status({ cwd: repo.root, control_id: "owner-fault" })).tasks[0].task_id, "release-unknown");
    assert.deepEqual(await readdir(join(repo.commonDir, "dotagents", "orchestrate", "lock-owners")), []);
  });
  await withRepo(t, async (repo) => {
    const input = { cwd: repo.root, control_id: "parent-sync-fault", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() };
    await withFault("new-control-before-parent-sync", () => assert.rejects(api.init(input), code("IO_FAILURE")));
    await assert.rejects(access(join(repo.commonDir, "dotagents", "orchestrate", "controls", "parent-sync-fault")));
    assert.equal((await api.init(input)).manifest.control_id, "parent-sync-fault");
  });
});

test("baseline後のscope内変更はcompletedとacceptを通過する", { skip: process.platform === "win32" }, async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "fingerprint-task", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "fingerprint-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  await writeFile(join(repo.root, "README.md"), "scope-in-change\n");
  await chmod(join(repo.root, "README.md"), 0o755);
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const completed = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() });
  assert.equal(typeof completed.manifest.worker_runs[0].result.workspace_fingerprint.digest, "string");
  const accepted = await api.accept({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: completed.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/verify.md")], decision_note: "scope only", decided_by: "parent" });
  assert.equal(accepted.manifest.worker_runs[0].acceptance.decision, "accepted");
  assert.equal(accepted.manifest.worker_runs[0].result.workspace_fingerprint.files.find((entry) => entry.path === "README.md").file_mode & 0o777, 0o755);
});

test("active fixed writer中のTask非交差fast-forward commitはcompletedを通過する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "safe-head-advance" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({
    task_id: "safe-head-task", read_scope: [{ kind: "file", path: "docs/control-record-plan.md" }], write_scope: [{ kind: "file", path: "README.md" }],
  }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "safe-head-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  await writeFile(join(repo.root, "README.md"), "worker scope change\n");
  await writeFile(join(repo.root, "docs", "parent-note.md"), "parent-only note\n");
  runGit(repo.root, ["add", "docs/parent-note.md"]); runGit(repo.root, ["commit", "-q", "-m", "parent non-overlap note", "--", "docs/parent-note.md"]);
  const resumed = await api.resumeCheck({ cwd: repo.root, control_id: "safe-head-advance" });
  assert.equal(resumed.blocking_reasons.some((entry) => entry.code === "writer-head-changed"), false);
  assert.equal(resumed.review_reasons.some((entry) => entry.code === "writer-head-advanced-outside-task-scope"), true);
  const completed = await api.observeWorker({ cwd: repo.root, control_id: "safe-head-advance", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() });
  assert.equal(completed.manifest.worker_runs[0].result.workspace_fingerprint.files.some((entry) => entry.path === "README.md"), true);
});

test("active fixed writer中にTask read scopeをcommitするとWORKSPACE_DRIFTで拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "unsafe-head-advance" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({
    task_id: "unsafe-head-task", read_scope: [{ kind: "file", path: "docs/control-record-plan.md" }], write_scope: [{ kind: "file", path: "README.md" }],
  }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "unsafe-head-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  await writeFile(join(repo.root, "README.md"), "worker scope change\n");
  await writeFile(join(repo.root, "docs", "control-record-plan.md"), "# parent changed task input\n");
  runGit(repo.root, ["add", "docs/control-record-plan.md"]); runGit(repo.root, ["commit", "-q", "-m", "parent overlaps task read scope", "--", "docs/control-record-plan.md"]);
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "unsafe-head-advance", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
});

test("active fixed writer中のfast-forwardでも特殊index flagはWORKSPACE_DRIFTで拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "flagged-head-advance" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({
    task_id: "flagged-head-task", read_scope: [{ kind: "file", path: "docs/control-record-plan.md" }], write_scope: [{ kind: "file", path: "README.md" }],
  }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "flagged-head-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  await writeFile(join(repo.root, "docs", "parent-note.md"), "parent-only note\n");
  runGit(repo.root, ["add", "docs/parent-note.md"]); runGit(repo.root, ["commit", "-q", "-m", "parent non-overlap note", "--", "docs/parent-note.md"]);
  runGit(repo.root, ["update-index", "--assume-unchanged", "README.md"]);
  await writeFile(join(repo.root, "README.md"), "hidden worker change\n");
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "flagged-head-advance", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
});

test("admission後のscope外変更はcompleted観測をWORKSPACE_DRIFTで拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "scope-outside-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "scope-outside-task", write_scope: [{ kind: "directory", path: "lib/orchestrate" }] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "scope-outside-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  await writeFile(join(repo.root, "README.md"), "outside scope change\n");
  await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "scope-outside-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
});

test("admission後の既存dirty scope外file mode変更をWORKSPACE_DRIFTで拒否する", { skip: process.platform === "win32" }, async (t) => {
  await withRepo(t, async (repo) => {
    const outside = join(repo.root, "docs", "control-record-plan.md");
    await writeFile(outside, "# dirty control record fixture plan\n");
    const init = await api.init({ cwd: repo.root, control_id: "mode-drift-control", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    const task = await api.taskRecord({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "mode-drift-task", write_scope: [{ kind: "file", path: "README.md" }] }) });
    const run = await api.workerRunRecord({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "mode-drift-task", workspace_cwd: repo.root }) });
    const admitted = await api.admitWorker({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
    const baseline = admitted.manifest.worker_runs[0].baseline_workspace_fingerprint.files.find((entry) => entry.path === "docs/control-record-plan.md");
    const baselineMode = (await stat(outside)).mode & 0o777;
    await chmod(outside, 0o755);
    const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
    await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "mode-drift-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
    assert.equal(baseline.file_mode & 0o777, baselineMode);
    assert.notEqual(baselineMode, (await stat(outside)).mode & 0o777);
  });
});

test("completed後accept前のworkspace変更はacceptをWORKSPACE_DRIFTで拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "accept-drift-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "accept-drift-task", write_scope: [{ kind: "file", path: "README.md" }] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "accept-drift-task", workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  await writeFile(join(repo.root, "README.md"), "first scoped change\n");
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const completed = await api.observeWorker({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() });
  assert.equal(typeof completed.manifest.worker_runs[0].result.workspace_fingerprint.digest, "string");
  await writeFile(join(repo.root, "README.md"), "second scoped change before accept\n");
  await assert.rejects(api.accept({ cwd: repo.root, control_id: "accept-drift-control", actor_id: "parent", expected_revision: completed.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/verify.md")], decision_note: "changed after complete", decided_by: "parent" }), code("WORKSPACE_DRIFT"));
});

test("writer fingerprintはindex変更と宣言scope内のignored成果物を拒否する", async (t) => {
  await withRepo(t, async (repo) => {
    await writeFile(join(repo.root, ".gitignore"), "ignored-output.log\n");
    runGit(repo.root, ["add", ".gitignore"]); runGit(repo.root, ["commit", "-q", "-m", "ignore fixture"]);
    const init = await api.init({ cwd: repo.root, control_id: "ignored-guard", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    const task = await api.taskRecord({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "ignored-task", write_scope: [{ kind: "file", path: "ignored-output.log" }] }) });
    const run = await api.workerRunRecord({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "ignored-task", workspace_cwd: repo.root }) });
    const admitted = await api.admitWorker({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
    const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
    await writeFile(join(repo.root, "ignored-output.log"), "must be observed\n");
    await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "ignored-guard", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
  });
  await withRepo(t, async (repo) => {
    const init = await api.init({ cwd: repo.root, control_id: "index-guard", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
    const task = await api.taskRecord({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "index-task", write_scope: [{ kind: "file", path: "README.md" }] }) });
    const run = await api.workerRunRecord({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ task_id: "index-task", workspace_cwd: repo.root }) });
    const admitted = await api.admitWorker({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
    const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
    runGit(repo.root, ["update-index", "--assume-unchanged", "README.md"]);
    await assert.rejects(api.observeWorker({ cwd: repo.root, control_id: "index-guard", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() }), code("WORKSPACE_DRIFT"));
  });
});

test("lock owner recoveryはexact JSON、live/dead/malformed/link/token mismatchを区別する", async (t) => {
  const { repo } = await initialized(t);
  const owners = await createOwnerFixtures(repo.commonDir);
  for (const [name, token, expected] of [["live", "22222222-2222-4222-8222-222222222222", "LOCK_LIVE"], ["malformed", "33333333-3333-4333-8333-333333333333", "LOCK_MALFORMED"], ["symlink", "66666666-6666-4666-8666-666666666666", "STATE_PATH_UNSAFE"], ["hardlink", "77777777-7777-4777-8777-777777777777", "STATE_PATH_UNSAFE"], ["tokenMismatch", "44444444-4444-4444-8444-444444444444", "LOCK_TOKEN_MISMATCH"]]) {
    await assert.rejects(api.recoverLock({ cwd: repo.root, expected_token: token }), code(expected));
  }
  const deadToken = "11111111-1111-4111-8111-111111111111";
  const recovered = await api.recoverLock({ cwd: repo.root, expected_token: deadToken });
  assert.deepEqual(recovered, { recovered: true, token: deadToken });
  await assert.rejects(access(owners.dead));
  assert.equal(OWNER_SCHEMA, "dotagents.orchestration-lock-owner.v1");
});

test("fingerprintは実64MiBを受理し64MiB超過と非regularを拒否する", async (t) => {
  await withRepo(t, async (repo) => {
    const files = await createFingerprintBoundaryFiles(repo.root);
    assert.equal(files.acceptedStat.size, 64 * 1024 * 1024);
    runGit(repo.root, ["add", "exactly-64MiB.bin"]);
    const previousGitDir = process.env.GIT_DIR;
    const previousOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_DIR = join(repo.root, "must-not-be-used-as-git-dir");
    process.env.GIT_OPTIONAL_LOCKS = "1";
    process.env.GIT_CONFIG_GLOBAL = join(repo.root, "must-not-be-used-as-git-config");
    t.after(() => {
      if (previousGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousGitDir;
      if (previousOptionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = previousOptionalLocks;
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    });
    const accepted = await api.fingerprintWorkspace({ cwd: repo.root });
    if (previousGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousGitDir;
    if (previousOptionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = previousOptionalLocks;
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    assert.equal(typeof accepted.digest, "string");
    await rm(files.accepted); runGit(repo.root, ["reset", "--", "exactly-64MiB.bin"]);
    const oversized = await createOversizedFingerprintFile(repo.root);
    assert.equal(oversized.rejectedStat.size, (64 * 1024 * 1024) + 1);
    await assert.rejects(api.fingerprintWorkspace({ cwd: repo.root }), code("LIMIT_EXCEEDED"));
    await rm(oversized.rejected);
    await symlink("README.md", join(repo.root, "tracked-symlink"));
    runGit(repo.root, ["add", "tracked-symlink"]);
    await assert.rejects(api.fingerprintWorkspace({ cwd: repo.root }), code("STATE_PATH_UNSAFE"));
  });
});

test("malformed manifestまたはcontrols未知entryが次mutationをfail-closedにする", async (t) => {
  const { repo, result } = await initialized(t);
  const paths = join(repo.commonDir, "dotagents", "orchestrate", "controls", "poison-control");
  await writeFile(join(repo.commonDir, "dotagents", "orchestrate", "controls", "unknown-file"), "poison");
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, task: makeTask({ task_id: "blocked-by-entry" }) }), code("STATE_PATH_UNSAFE"));
  await rm(join(repo.commonDir, "dotagents", "orchestrate", "controls", "unknown-file"));
  await mkdir(paths, { recursive: true });
  await chmod(paths, 0o700);
  await writeFile(join(paths, "manifest.json"), "{not json");
  await chmod(join(paths, "manifest.json"), 0o600);
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, task: makeTask({ task_id: "blocked-by-manifest" }) }), code("INVALID_SCHEMA"));
});

test("Task finalizationはactive child・未裁定・取消を拒否しdecision receiptへ完全拘束する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "task-finalization-boundary" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "finalization-task", effect: "read", write_scope: [] }) });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "finalization-run", task_id: "finalization-task", assignment_id: "finalization-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "finalization-assignment" } }) });
  const finalize = (expected_revision) => api.taskFinalizeRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision, task_id: "finalization-task", finalization_ref: "docs/adr/task-finalization-decision.md", recorded_by: "parent" });
  await assert.rejects(finalize(run.revision), code("FINALIZATION_NOT_READY"));
  const workerCancelled = await api.observeWorker({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: run.revision, worker_run_id: "finalization-run", observation: workerObservation("cancelled") });
  const consultation = await api.consultationRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: workerCancelled.revision, consultation: makeConsultation({ consultation_id: "finalization-consultation", task_id: "finalization-task", assignment_id: "finalization-consultation-assignment" }) });
  await assert.rejects(finalize(consultation.revision), code("FINALIZATION_NOT_READY"));
  const consultationDispatched = await api.observeConsultation({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: consultation.revision, consultation_id: "finalization-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "test", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
  const consultationFailed = await api.observeConsultation({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: consultationDispatched.revision, consultation_id: "finalization-consultation", observation: { state: "failed", source: "gpt-connector", observed_version: "test", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "failed", terminal_evidence: [evidence("consultation-terminal", "executor-receipt")] } });
  const pendingRun = await api.workerRunRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: consultationFailed.revision, worker_run: makeWorkerRun({ worker_run_id: "pending-acceptance-run", task_id: "finalization-task", assignment_id: "pending-acceptance-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "pending-acceptance-assignment" } }) });
  const pendingAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: pendingRun.revision, worker_run_id: "pending-acceptance-run" });
  const pendingDispatched = await api.observeWorker({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: pendingAdmitted.revision, worker_run_id: "pending-acceptance-run", observation: workerObservation("dispatched") });
  const pendingCompleted = await api.observeWorker({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: pendingDispatched.revision, worker_run_id: "pending-acceptance-run", observation: completedWorkerObservation() });
  await assert.rejects(finalize(pendingCompleted.revision), code("FINALIZATION_NOT_READY"));
  const pendingAccepted = await api.accept({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: pendingCompleted.revision, worker_run_id: "pending-acceptance-run", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/pending-acceptance-decision.md", "decision")], decision_note: "parent decided", decided_by: "parent" });
  await assert.rejects(api.taskFinalizeRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: pendingAccepted.revision, task_id: "finalization-task", finalization_ref: "docs/control-record-plan.md", recorded_by: "parent" }), code("DECISION_EVIDENCE_NOT_IMMUTABLE"));
  await assert.rejects(finalize(pendingAccepted.revision), code("EVIDENCE_UNAVAILABLE"));
  await materializeTaskDecision(repo, "docs/adr/task-finalization-decision.md");
  const finalized = await finalize(pendingAccepted.revision);
  const receipt = finalized.manifest.transition_receipts.at(-1);
  assert.equal(receipt.operation, "task-finalize"); assert.equal(receipt.subject_digest.length, 64);
  assert.equal(receipt.evidence[0].ref, "docs/adr/task-finalization-decision.md");
  await assert.rejects(api.workerRunRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: finalized.revision, worker_run: makeWorkerRun({ worker_run_id: "late-finalized-run", task_id: "finalization-task", assignment_id: "late-finalized-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "late-finalized-assignment" } }) }), code("TASK_FINALIZED"));
  await assert.rejects(api.consultationRecord({ cwd: repo.root, control_id: "task-finalization-boundary", actor_id: "parent", expected_revision: finalized.revision, consultation: makeConsultation({ consultation_id: "late-finalized-consultation", task_id: "finalization-task", assignment_id: "late-finalized-consultation-assignment" }) }), code("TASK_FINALIZED"));
  const tamperedRecord = structuredClone(finalized.manifest); tamperedRecord.task_finalizations[0].finalization_ref = "docs/other.md";
  assert.throws(() => api.validateManifest(tamperedRecord), code("INVALID_SCHEMA"));
  const stray = structuredClone(finalized.manifest); const previous = stray.transition_receipts.at(-1);
  const strayReceipt = makeTransitionReceipt({ revision: stray.record_revision + 1, actor_id: "parent", operation: "task-finalize", subject: { kind: "task-finalization", id: "stray-task" }, subject_digest: "f".repeat(64), previous_state: "unfinalized", next_state: "finalized", evidence: [evidence("docs/stray.md", "decision")], recorded_at: "2026-07-14T01:00:00.000Z", previous_receipt_digest: previous.receipt_digest });
  stray.transition_receipts.push(strayReceipt); stray.record_revision += 1; stray.last_update = { actor_id: "parent", updated_at: strayReceipt.recorded_at };
  assert.throws(() => api.validateManifest(stray), code("INVALID_SCHEMA"));

  const cancelledControl = await api.init({ cwd: repo.root, control_id: "cancelled-task-finalization", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const cancelledControlPhaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "cancelled-task-finalization", actor_id: "parent", expected_revision: cancelledControl.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const cancelledTask = await api.taskRecord({ cwd: repo.root, control_id: "cancelled-task-finalization", actor_id: "parent", expected_revision: cancelledControlPhaseGate.revision, task: makeTask({ task_id: "cancelled-finalization-task", effect: "read", write_scope: [] }) });
  const cancelled = await api.taskCancelRecord({ cwd: repo.root, control_id: "cancelled-task-finalization", actor_id: "parent", expected_revision: cancelledTask.revision, task_id: "cancelled-finalization-task", decision: evidence("docs/cancelled-task.md", "decision") });
  await assert.rejects(api.taskFinalizeRecord({ cwd: repo.root, control_id: "cancelled-task-finalization", actor_id: "parent", expected_revision: cancelled.revision, task_id: "cancelled-finalization-task", finalization_ref: "docs/adr/task-finalization-decision.md", recorded_by: "parent" }), code("INVALID_TRANSITION"));
});

test("Taskはcancelledなら未finalizeでもControl finalizationとarchiveを阻害しない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "cancelled-task-control-close" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "cancelled-task-control-close", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "cancelled-task-control-close", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "cancelled-control-task", effect: "read", write_scope: [] }),
  });
  const cancelDecision = await materializeDocumentEvidence(repo, evidence("docs/cancelled-control-task.md", "decision"));
  const cancelled = await api.taskCancelRecord({
    cwd: repo.root, control_id: "cancelled-task-control-close", actor_id: "parent", expected_revision: task.revision,
    task_id: "cancelled-control-task", decision: cancelDecision,
  });
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "cancelled-task-control-close" });
  assert.deepEqual(brief.cancellations.task_ids, ["cancelled-control-task"]);
  assert.deepEqual(brief.unresolved.task_ids, []);

  const phaseComplete = await advancePhaseGate(repo, "cancelled-task-control-close", cancelled.revision);
  const padded = structuredClone(phaseComplete.manifest);
  for (let revision = padded.record_revision + 1; revision <= 253; revision++) {
    const previous = padded.transition_receipts.at(-1);
    padded.transition_receipts.push(makeTransitionReceipt({
      revision, actor_id: "parent", operation: "task-record",
      subject: { kind: "task", id: `cancelled-close-padding-${revision}` },
      previous_state: null, next_state: "recorded", previous_receipt_digest: previous.receipt_digest,
    }));
  }
  padded.record_revision = 253;
  padded.last_update = { actor_id: "parent", updated_at: padded.transition_receipts.at(-1).recorded_at };
  await writeJson(join(repo.commonDir, "dotagents", "orchestrate", "controls", "cancelled-task-control-close", "manifest.json"), padded);

  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "cancelled-task-control-close", actor_id: "parent", expected_revision: 253,
    acceptance_matrix_ref: "docs/cancelled-close-acceptance.md",
    final_audit_evidence: [evidence("docs/cancelled-close-audit.md")],
    regression_evidence: [evidence("docs/cancelled-close-regression.md")],
    knowledge_return_refs: ["docs/cancelled-close-knowledge.md"],
    parent_decision: evidence("docs/adr/cancelled-close-decision.md", "decision"), finalized_by: "parent",
  }));
  assert.equal(finalized.revision, 254);
  const archived = await api.archive({
    cwd: repo.root, control_id: "cancelled-task-control-close", actor_id: "parent", expected_revision: finalized.revision,
  });
  assert.equal(archived.revision, 255);
  assert.equal(archived.manifest.status, "archived");
});

test("accept/reject/task finalization/control finalization/archiveは状態・証拠・atomic manifestを検査する", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask() });
  const run = await api.workerRunRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ workspace_cwd: repo.root }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: run.revision, worker_run_id: "run-001" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "run-001", observation: workerObservation("dispatched") });
  const completed = await api.observeWorker({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "run-001", observation: completedWorkerObservation() });
  const accepted = await api.accept({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: completed.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/verify.md")], decision_note: "accepted", decided_by: "parent" });
  assert.equal(accepted.manifest.worker_runs[0].acceptance.decision, "accepted");
  assert.equal(accepted.manifest.transition_receipts.at(-1).operation, "worker-accept");
  assert.deepEqual(accepted.manifest.transition_receipts.at(-1).evidence, [evidence("docs/verify.md")]);
  await materializeTaskDecision(repo, "docs/adr/task-decision.md");
  const decided = await api.taskFinalizeRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: accepted.revision, task_id: "task-001", finalization_ref: "docs/adr/task-decision.md", recorded_by: "parent" });
  await assert.rejects(api.archive({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: decided.revision }), code("ARCHIVE_NOT_READY"));
  const phaseComplete = await advancePhaseGate(repo, CONTROL, decided.revision);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: phaseComplete.revision,
    acceptance_matrix_ref: "docs/acceptance-matrix.md",
    final_audit_evidence: [evidence("docs/final-audit.md")],
    regression_evidence: [evidence("docs/regression.md")],
    knowledge_return_refs: ["docs/knowledge-return.md"],
    parent_decision: evidence("docs/adr/final-decision.md", "decision"),
    finalized_by: "parent",
  }));
  assert.equal(finalized.manifest.control_finalization.objective_ref, "docs/control-record-plan.md");
  const finalReceipt = finalized.manifest.transition_receipts.at(-1);
  assert.equal(finalReceipt.operation, "control-finalize"); assert.equal(finalReceipt.subject_digest.length, 64);
  assert.equal(finalReceipt.evidence[0].ref, "docs/acceptance-matrix.md");
  assert.ok(finalReceipt.evidence.some((entry) => entry.ref === "docs/knowledge-return.md"));
  const tamperedFinalization = structuredClone(finalized.manifest); tamperedFinalization.control_finalization.knowledge_return_refs[0] = "docs/other-knowledge.md";
  assert.throws(() => api.validateManifest(tamperedFinalization), code("INVALID_SCHEMA"));
  const tamperedReceipt = structuredClone(finalized.manifest); tamperedReceipt.transition_receipts[tamperedReceipt.transition_receipts.length - 1] = makeTransitionReceipt({ ...tamperedReceipt.transition_receipts.at(-1), subject_digest: "f".repeat(64) });
  assert.throws(() => api.validateManifest(tamperedReceipt), code("INVALID_SCHEMA"));
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: finalized.revision, task: makeTask({ task_id: "late-task" }) }), code("CONTROL_FINALIZED"));
  const knowledgePath = join(repo.root, "docs", "knowledge-return.md"); const originalKnowledge = await readFile(knowledgePath, "utf8");
  await writeFile(knowledgePath, `${originalKnowledge}tampered\n`);
  await assert.rejects(api.archive({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: finalized.revision }), code("EVIDENCE_DIGEST_MISMATCH"));
  await writeFile(knowledgePath, originalKnowledge);
  const archived = await api.archive({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: finalized.revision });
  assert.equal(archived.manifest.status, "archived");
  assert.equal(archived.manifest.transition_receipts.at(-1).operation, "control-archive");
  assert.deepEqual(await readPersistedManifest(repo.commonDir, CONTROL), archived.manifest);
  await assert.rejects(api.reject({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: archived.revision, worker_run_id: "run-001", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/verify.md")], decision_note: "late", decided_by: "parent" }), code("RECORD_ARCHIVED"));
});

test("rejectはcompleted writer後のworkspace進行を採用せず棄却Decisionだけを記録する", async (t) => {
  const controlId = "reject-after-workspace-drift";
  const { repo, result } = await initialized(t, { control_id: controlId });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "drifted-result-task" }),
  });
  const run = await api.workerRunRecord({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({
      worker_run_id: "drifted-result-run", task_id: "drifted-result-task",
      assignment_id: "drifted-result-assignment", workspace_cwd: repo.root,
      lineage: { ...makeWorkerRun().lineage, root_assignment_id: "drifted-result-assignment" },
    }),
  });
  const admitted = await api.admitWorker({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: run.revision,
    worker_run_id: "drifted-result-run",
  });
  const dispatched = await api.observeWorker({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: admitted.revision,
    worker_run_id: "drifted-result-run", observation: workerObservation("dispatched"),
  });
  const completed = await api.observeWorker({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: dispatched.revision,
    worker_run_id: "drifted-result-run", observation: completedWorkerObservation(),
  });
  const progressed = join(repo.root, "lib", "orchestrate", "newer-parent-work.mjs");
  await mkdir(dirname(progressed), { recursive: true });
  await writeFile(progressed, "export const newerParentWork = true;\n");
  const decision = {
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: completed.revision,
    worker_run_id: "drifted-result-run", result_digest: "a".repeat(64),
    verification_evidence: [evidence("docs/reject-after-drift.md")],
    decision_note: "workspace進行後の旧resultを採用せず棄却する", decided_by: "parent",
  };
  await assert.rejects(api.accept(decision), code("WORKSPACE_DRIFT"));
  const rejected = await api.reject(decision);
  assert.equal(rejected.manifest.worker_runs[0].acceptance.decision, "rejected");
  assert.equal(await readFile(progressed, "utf8"), "export const newerParentWork = true;\n");
  await materializeTaskDecision(repo, "docs/adr/reject-after-drift-decision.md");
  const finalized = await api.taskFinalizeRecord({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: rejected.revision,
    task_id: "drifted-result-task", finalization_ref: "docs/adr/reject-after-drift-decision.md", recorded_by: "parent",
  });
  assert.equal(finalized.manifest.task_finalizations[0].task_id, "drifted-result-task");
});

test("archiveはfinalization Decisionの同一path旧digestだけをgit履歴から保持する (history retention)", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "finalization-history-retention" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "history-retention-task", effect: "read", write_scope: [] }),
  });
  const decisionRef = "docs/adr/history-retention-decision.md";
  await materializeTaskDecision(repo, decisionRef);
  runGit(repo.root, ["add", decisionRef]);
  runGit(repo.root, ["commit", "-q", "-m", "record original finalization decision"]);
  const taskFinalized = await api.taskFinalizeRecord({
    cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: task.revision,
    task_id: "history-retention-task", finalization_ref: decisionRef, recorded_by: "parent",
  });
  const phaseComplete = await advancePhaseGate(repo, "finalization-history-retention", taskFinalized.revision);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: phaseComplete.revision,
    acceptance_matrix_ref: "docs/history-retention-matrix.md",
    final_audit_evidence: [evidence("docs/history-retention-audit.md")],
    regression_evidence: [evidence("docs/history-retention-regression.md")],
    knowledge_return_refs: ["docs/history-retention-knowledge.md"],
    parent_decision: evidence("docs/adr/history-retention-final-decision.md", "decision"), finalized_by: "parent",
  }));

  const knowledgePath = join(repo.root, "docs", "history-retention-knowledge.md");
  const originalKnowledge = await readFile(knowledgePath, "utf8");
  runGit(repo.root, ["add", "docs/history-retention-knowledge.md"]);
  runGit(repo.root, ["commit", "-q", "-m", "record original file evidence"]);
  await writeFile(join(repo.root, decisionRef), "new decision at the same path\n");
  await writeFile(knowledgePath, "new file evidence at the same path\n");
  runGit(repo.root, ["add", decisionRef, "docs/history-retention-knowledge.md"]);
  runGit(repo.root, ["commit", "-q", "-m", "replace retained evidence"]);

  await assert.rejects(api.archive({
    cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: finalized.revision,
  }), code("EVIDENCE_DIGEST_MISMATCH"));
  await writeFile(knowledgePath, originalKnowledge);
  const archived = await api.archive({
    cwd: repo.root, control_id: "finalization-history-retention", actor_id: "parent", expected_revision: finalized.revision,
  });
  assert.equal(archived.manifest.status, "archived");
});

test("control finalizationはTask完了と監査・回帰・knowledge return・親Decisionを必須にする", async (t) => {
  const { repo, result } = await initialized(t);
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ effect: "read", write_scope: [] }) });
  const base = {
    cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: task.revision,
    acceptance_matrix_ref: "docs/acceptance-matrix.md", final_audit_evidence: [evidence("docs/final-audit.md")],
    regression_evidence: [evidence("npm-test", "command")], knowledge_return_refs: ["docs/knowledge-return.md"],
    parent_decision: evidence("docs/adr/final-decision.md", "decision"), finalized_by: "parent",
  };
  await assert.rejects(api.finalizeControl(base), code("FINALIZATION_NOT_READY"));
  await materializeTaskDecision(repo, "docs/adr/task-decision.md");
  const decided = await api.taskFinalizeRecord({ cwd: repo.root, control_id: CONTROL, actor_id: "parent", expected_revision: task.revision, task_id: "task-001", finalization_ref: "docs/adr/task-decision.md", recorded_by: "parent" });
  await assert.rejects(api.finalizeControl({ ...base, expected_revision: decided.revision, final_audit_evidence: [] }), code("INVALID_SCHEMA"));
  await assert.rejects(api.finalizeControl({ ...base, expected_revision: decided.revision, regression_evidence: [] }), code("INVALID_SCHEMA"));
  await assert.rejects(api.finalizeControl({ ...base, expected_revision: decided.revision, knowledge_return_refs: [] }), code("INVALID_SCHEMA"));
  await assert.rejects(api.finalizeControl({ ...base, expected_revision: decided.revision, parent_decision: evidence("docs/not-a-decision.md") }), code("INVALID_SCHEMA"));
  await assert.rejects(api.finalizeControl({ ...base, expected_revision: decided.revision, parent_decision: evidence("docs/control-record-plan.md", "decision") }), code("DECISION_EVIDENCE_NOT_IMMUTABLE"));
});

test("control finalizationはmatrix・監査・回帰・knowledgeの実在とdigestをfinalize境界で検査する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "finalization-evidence-boundary" });
  const phaseComplete = await completePhaseGate(repo, "finalization-evidence-boundary", result.revision);
  const input = {
    cwd: repo.root, control_id: "finalization-evidence-boundary", actor_id: "parent", expected_revision: phaseComplete.revision,
    acceptance_matrix_ref: "docs/matrix-evidence.md", final_audit_evidence: [evidence("docs/audit-evidence.md")],
    regression_evidence: [evidence("docs/regression-evidence.md")], knowledge_return_refs: ["docs/knowledge-evidence.md"],
    parent_decision: evidence("docs/adr/finalization-parent-decision.md", "decision"), finalized_by: "parent",
  };
  await assert.rejects(api.finalizeControl(input), code("EVIDENCE_UNAVAILABLE"));
  const prepared = await materializeFinalizationInput(repo, input);
  await assert.rejects(api.finalizeControl({ ...prepared, final_audit_evidence: [{ ...prepared.final_audit_evidence[0], digest: "f".repeat(64) }] }), code("EVIDENCE_DIGEST_MISMATCH"));
  await assert.rejects(api.finalizeControl({ ...prepared, regression_evidence: [evidence("node --test", "command")] }), code("EVIDENCE_REQUIRED"));
});

test("control finalizationは全campaignの明示的な親releaseを必須にする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "campaign-finalization" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "campaign-finalization-task", effect: "read", write_scope: [], isolation: "none" }) });
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-finalization-worker", task_id: "campaign-finalization-task", assignment_id: "campaign-finalization-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-finalization-assignment" } }) });
  const cancelled = await api.observeWorker({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "campaign-finalization-worker", observation: workerObservation("cancelled") });
  const campaign = await api.campaignRecord({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: cancelled.revision, campaign: { campaign_id: "campaign-finalization-gate", campaign_type: "final-audit", members: [{ kind: "worker-run", id: "campaign-finalization-worker" }], gated_task_ids: ["campaign-finalization-task"], audit_required: false } });
  await materializeTaskDecision(repo, "docs/adr/campaign-finalization-decision.md");
  const decided = await api.taskFinalizeRecord({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: campaign.revision, task_id: "campaign-finalization-task", finalization_ref: "docs/adr/campaign-finalization-decision.md", recorded_by: "parent" });
  const finalization = (expected_revision) => ({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision, acceptance_matrix_ref: "docs/campaign-acceptance.md", final_audit_evidence: [evidence("docs/campaign-final-audit.md")], regression_evidence: [evidence("docs/campaign-regression.md")], knowledge_return_refs: ["docs/campaign-knowledge.md"], parent_decision: evidence("docs/adr/campaign-final-decision.md", "decision"), finalized_by: "parent" });
  await assert.rejects(api.finalizeControl(finalization(decided.revision)), code("FINALIZATION_NOT_READY"));
  const released = await api.releaseCampaign({ cwd: repo.root, control_id: "campaign-finalization", actor_id: "parent", expected_revision: decided.revision, campaign_id: "campaign-finalization-gate", audit_evidence: [], decision: evidence("docs/campaign-release-decision.md", "decision") });
  const phaseComplete = await advancePhaseGate(repo, "campaign-finalization", released.revision);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, finalization(phaseComplete.revision)));
  assert.equal(finalized.manifest.control_finalization.finalized_by, "parent");
});

test("campaign_typeは5つの親宣言phaseだけを受理し、改竄・未知種別・未release gateを拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "campaign-phase-types" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const memberTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "campaign-phase-member", effect: "read", write_scope: [] }) });
  const gatedTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: memberTask.revision, task: makeTask({ task_id: "campaign-phase-gated", effect: "read", write_scope: [] }) });
  const member = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: gatedTask.revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-phase-member-worker", task_id: "campaign-phase-member", assignment_id: "campaign-phase-member-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-phase-member-assignment" } }) });
  const terminal = await api.observeWorker({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: member.revision, worker_run_id: "campaign-phase-member-worker", observation: workerObservation("cancelled") });
  const phaseTypes = ["discovery", "refutation", "design", "implementation", "final-audit"];
  let revision = terminal.revision;
  for (const campaignType of phaseTypes) {
    const recorded = await api.campaignRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: revision, campaign: {
      campaign_id: `campaign-phase-${campaignType}`, campaign_type: campaignType, members: [{ kind: "worker-run", id: "campaign-phase-member-worker" }],
      gated_task_ids: ["campaign-phase-gated"], audit_required: campaignType === "final-audit",
    } });
    const status = await api.campaignStatus({ cwd: repo.root, control_id: "campaign-phase-types", campaign_id: `campaign-phase-${campaignType}` });
    assert.equal(status.campaign_type, campaignType); assert.equal(status.all_terminal, true); assert.equal(status.released, false);
    revision = recorded.revision;
  }
  await assert.rejects(api.campaignRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: revision, campaign: {
    campaign_id: "campaign-phase-unknown", campaign_type: "generic", members: [{ kind: "worker-run", id: "campaign-phase-member-worker" }], gated_task_ids: ["campaign-phase-gated"], audit_required: false,
  } }), code("INVALID_SCHEMA"));
  const gatedWorker = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-phase-gated-worker", task_id: "campaign-phase-gated", assignment_id: "campaign-phase-gated-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-phase-gated-assignment" } }) });
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "campaign-phase-types", actor_id: "parent", expected_revision: gatedWorker.revision, worker_run_id: "campaign-phase-gated-worker" }), code("CAMPAIGN_NOT_RELEASED"));
  const tampered = structuredClone(gatedWorker.manifest); tampered.campaigns[0].campaign_type = "generic";
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  const validToValidTamper = structuredClone(gatedWorker.manifest); validToValidTamper.campaigns[0].audit_required = true;
  assert.throws(() => api.validateManifest(validToValidTamper), code("INVALID_SCHEMA"));
});

test("Delegation Packetとstrict Worker Report importは相関・scope・親accept分離を強制する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "packet-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "packet-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const worker = await api.workerRunRecord({
    cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "packet-worker", task_id: "packet-task", assignment_id: "packet-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "packet-assignment" } }),
  });
  const plannedPacket = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" });
  assert.equal(plannedPacket.schema_version, "dotagents.delegation-packet.v1"); assert.equal(plannedPacket.report_template.schema_id, "dotagents.worker-report.v1");
  await assert.rejects(api.recoverDelegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" }), code("INVALID_TRANSITION"));
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "packet-worker" });
  const admittedPacket = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" });
  assert.equal(admittedPacket.packet_digest, plannedPacket.packet_digest);
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "packet-worker", observation: workerObservation("dispatched") });
  const recoveredPacket = await api.recoverDelegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" });
  assert.equal(recoveredPacket.packet_digest, plannedPacket.packet_digest);
  assert.equal(recoveredPacket.worker.state, "dispatched");
  assert.equal(recoveredPacket.record_revision, dispatched.revision);
  await assert.rejects(api.delegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" }), code("INVALID_TRANSITION"));
  const report = {
    schema_version: "dotagents.worker-report.v1", control_id: "packet-control", task_id: "packet-task", worker_run_id: "packet-worker", assignment_id: "packet-assignment", packet_digest: plannedPacket.packet_digest,
    executor_handle: { idempotency_key: "A".repeat(22) }, observed_state: "completed", status: "completed", result_digest: "d".repeat(64),
    evidence: [evidence("docs/packet-result.md")], validation_results: [{ validation_ref: "node --test tests/orchestrate/*.test.mjs", outcome: "passed", evidence: evidence("tests/orchestrate/control-record.test.mjs", "command") }], changed_paths: [], claims: ["packet-report-import"],
  };
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, packet_digest: "a".repeat(64) } }), code("REPORT_CORRELATION_MISMATCH"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, executor_handle: { idempotency_key: "W".repeat(22) } } }), code("REPORT_CORRELATION_MISMATCH"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, validation_results: [] } }), code("VALIDATION_INCOMPLETE"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, validation_results: [{ ...report.validation_results[0], outcome: "unknown" }] } }), code("VALIDATION_INCOMPLETE"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, validation_results: [{ ...report.validation_results[0], outcome: "failed" }] } }), code("REPORT_NONZERO"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, status: "failed" } }), code("INVALID_SCHEMA"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, changed_paths: ["app/[gameId]/page.tsx"] } }), code("WORKSPACE_DRIFT"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, changed_paths: ["app/*/page.tsx"] } }), code("INVALID_SCHEMA"));
  const beyondClockSkew = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, evidence: [{ ...report.evidence[0], observed_at: beyondClockSkew }] } }), code("EVIDENCE_FROM_FUTURE"));
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-worker", report: { ...report, validation_results: [{ ...report.validation_results[0], evidence: { ...report.validation_results[0].evidence, observed_at: beyondClockSkew } }] } }), code("EVIDENCE_FROM_FUTURE"));
  const cancelled = await api.taskCancelRecord({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: dispatched.revision, task_id: "packet-task", decision: evidence("docs/packet-cancel.md", "decision") });
  await assert.rejects(api.delegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" }), code("TASK_CANCELLED"));
  const cancelledTaskRecovery = await api.recoverDelegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" });
  assert.equal(cancelledTaskRecovery.packet_digest, plannedPacket.packet_digest);
  const withinClockSkew = new Date(Date.now() + 4 * 60 * 1000).toISOString();
  const skewedReport = { ...report, evidence: [{ ...report.evidence[0], observed_at: withinClockSkew }], validation_results: [{ ...report.validation_results[0], evidence: { ...report.validation_results[0].evidence, observed_at: withinClockSkew } }] };
  const imported = await api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: cancelled.revision, worker_run_id: "packet-worker", report: skewedReport });
  assert.equal(imported.manifest.worker_runs[0].state, "completed"); assert.equal(imported.manifest.worker_runs[0].acceptance, null);
  assert.equal(imported.manifest.transition_receipts.at(-1).operation, "worker-report-import");
  await assert.rejects(api.importWorkerReport({ cwd: repo.root, control_id: "packet-control", actor_id: "parent", expected_revision: imported.revision, worker_run_id: "packet-worker", report: { ...skewedReport, raw_log: "forbidden" } }), code("INVALID_SCHEMA"));
  await assert.rejects(api.delegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" }), code("TASK_CANCELLED"));
  await assert.rejects(api.recoverDelegationPacketForWorker({ cwd: repo.root, control_id: "packet-control", worker_run_id: "packet-worker" }), code("INVALID_TRANSITION"));
});

test("Delegation Packet/report import CLIは外部Executorを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "packet-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "packet-cli-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const worker = await api.workerRunRecord({ cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: task.revision, worker_run: makeWorkerRun({ worker_run_id: "packet-cli-worker", task_id: "packet-cli-task", assignment_id: "packet-cli-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "packet-cli-assignment" } }) });
  const input = join(base, "packet-cli-input.json"); await writeJson(input, { cwd: repo.root, control_id: "packet-cli", worker_run_id: "packet-cli-worker" });
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` }; const packetOutput = spawnOrchestrate(["delegation-packet", "--input", input], { env });
  assert.equal(packetOutput.status, 0); const packet = JSON.parse(packetOutput.stdout).result;
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: worker.revision, worker_run_id: "packet-cli-worker" });
  const dispatched = await api.observeWorker({ cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "packet-cli-worker", observation: workerObservation("dispatched") });
  const recoveredOutput = spawnOrchestrate(["delegation-packet-recover", "--input", input], { env });
  assert.equal(recoveredOutput.status, 0);
  assert.equal(JSON.parse(recoveredOutput.stdout).result.packet_digest, packet.packet_digest);
  const reportInput = join(base, "packet-report-input.json"); await writeJson(reportInput, { cwd: repo.root, control_id: "packet-cli", actor_id: "parent", expected_revision: dispatched.revision, worker_run_id: "packet-cli-worker", report: {
    schema_version: "dotagents.worker-report.v1", control_id: "packet-cli", task_id: "packet-cli-task", worker_run_id: "packet-cli-worker", assignment_id: "packet-cli-assignment", packet_digest: packet.packet_digest,
    executor_handle: { idempotency_key: "A".repeat(22) }, observed_state: "completed", status: "completed", result_digest: "e".repeat(64), evidence: [evidence("docs/packet-cli-result.md")], validation_results: [{ validation_ref: "node --test tests/orchestrate/*.test.mjs", outcome: "passed", evidence: evidence("tests/orchestrate/control-record.test.mjs", "command") }], changed_paths: [], claims: [],
  } });
  const imported = spawnOrchestrate(["worker-report-import", "--input", reportInput], { env });
  assert.equal(imported.status, 0); assert.equal(JSON.parse(imported.stdout).result.manifest.worker_runs[0].acceptance, null);
  await assert.rejects(access(sentinel.log));
});

test("parent-declared campaign gateは全member terminal・audit・親releaseまで後続reservationを拒否する", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "campaign-control" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const memberTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "campaign-member-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const gatedTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberTask.revision, task: makeTask({ task_id: "campaign-gated-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }) });
  const memberWorker = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: gatedTask.revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-member-worker", task_id: "campaign-member-task", assignment_id: "campaign-member-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-member-assignment" } }) });
  const memberAdmitted = await api.admitWorker({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberWorker.revision, worker_run_id: "campaign-member-worker" });
  const memberDispatched = await api.observeWorker({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberAdmitted.revision, worker_run_id: "campaign-member-worker", observation: workerObservation("dispatched") });
  const memberConsultation = await api.consultationRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberDispatched.revision, consultation: makeConsultation({ consultation_id: "campaign-member-consultation", task_id: "campaign-member-task", assignment_id: "campaign-member-consultation-assignment" }) });
  const consultationDispatched = await api.observeConsultation({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberConsultation.revision, consultation_id: "campaign-member-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:01:00.000Z", raw_state: "dispatched" } });
  const gatedWorker = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: consultationDispatched.revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-gated-worker", task_id: "campaign-gated-task", assignment_id: "campaign-gated-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-gated-assignment" } }) });
  const gatedConsultation = await api.consultationRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: gatedWorker.revision, consultation: makeConsultation({ consultation_id: "campaign-gated-consultation", task_id: "campaign-gated-task", assignment_id: "campaign-gated-consultation-assignment" }) });
  const registry = await api.registryObservationRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: gatedConsultation.revision, observation: makeRegistryObservation({ registry_observation_id: "campaign-registry", capacity: {
    admission: { value: "true", evidence: evidence("docs/campaign-admission.md") },
    hard_inflight_limit: { knowledge: "known", value: 4, evidence: evidence("docs/campaign-hard.md") },
    soft_inflight_limit: { knowledge: "known", value: 4, evidence: evidence("docs/campaign-soft.md") },
    observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/campaign-inflight.md") },
  } }) });
  const declared = await api.campaignRecord({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: registry.revision, campaign: {
    campaign_id: "campaign-gate", campaign_type: "implementation", audit_required: true,
    members: [{ kind: "worker-run", id: "campaign-member-worker" }, { kind: "consultation", id: "campaign-member-consultation" }],
    gated_task_ids: ["campaign-gated-task"],
  } });
  const blockedPlacement = await api.placementDryRun({ cwd: repo.root, control_id: "campaign-control", task_id: "campaign-gated-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [makePlacementCandidate({ candidate_id: "campaign-placement", registry_observation_id: "campaign-registry", workspace_cwd: repo.root })] });
  assert.deepEqual(blockedPlacement.candidates[0].reasons, ["campaign-not-released"]);
  await assert.rejects(api.reservePlacement({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: declared.revision, task_id: "campaign-gated-task", candidate: makePlacementCandidate({ candidate_id: "campaign-reservation", registry_observation_id: "campaign-registry", workspace_cwd: repo.root, assignment_id: "campaign-reservation-assignment", executor_handle: { idempotency_key: "R".repeat(22) }, lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "campaign-reservation-assignment" } }), review_decision: null }), code("PLACEMENT_INELIGIBLE"));
  await assert.rejects(api.admitWorker({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: declared.revision, worker_run_id: "campaign-gated-worker" }), code("CAMPAIGN_NOT_RELEASED"));
  await assert.rejects(api.observeConsultation({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: declared.revision, consultation_id: "campaign-gated-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:02:00.000Z", raw_state: "dispatched" } }), code("CAMPAIGN_NOT_RELEASED"));
  await assert.rejects(api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: declared.revision, campaign_id: "campaign-gate", audit_evidence: [evidence("docs/campaign-audit.md")], decision: evidence("docs/campaign-release.md", "decision") }), code("CAMPAIGN_NOT_READY"));
  const workerCompleted = await api.observeWorker({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: declared.revision, worker_run_id: "campaign-member-worker", observation: completedWorkerObservation() });
  await assert.rejects(api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: workerCompleted.revision, campaign_id: "campaign-gate", audit_evidence: [evidence("docs/campaign-audit.md")], decision: evidence("docs/campaign-release.md", "decision") }), code("CAMPAIGN_NOT_READY"));
  const consultationFailed = await api.observeConsultation({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: workerCompleted.revision, consultation_id: "campaign-member-consultation", observation: { state: "failed", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:03:00.000Z", raw_state: "failed", terminal_evidence: [evidence("docs/campaign-consultation-terminal.md", "executor-receipt")] } });
  await assert.rejects(api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: consultationFailed.revision, campaign_id: "campaign-gate", audit_evidence: [evidence("docs/campaign-audit.md")], decision: evidence("docs/campaign-release.md", "decision") }), code("CAMPAIGN_NOT_READY"));
  const memberAccepted = await api.accept({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: consultationFailed.revision, worker_run_id: "campaign-member-worker", result_digest: "a".repeat(64), verification_evidence: [evidence("docs/campaign-worker-accept.md", "decision")], decision_note: "campaign member result verified", decided_by: "parent" });
  await assert.rejects(api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberAccepted.revision, campaign_id: "campaign-gate", audit_evidence: [], decision: evidence("docs/campaign-release.md", "decision") }), code("EVIDENCE_REQUIRED"));
  await assert.rejects(api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberAccepted.revision, campaign_id: "campaign-gate", audit_evidence: Array.from({ length: 256 }, (_, index) => evidence(`docs/campaign-audit-${index}.md`)), decision: evidence("docs/campaign-release.md", "decision") }), code("LIMIT_EXCEEDED"));
  const released = await api.releaseCampaign({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: memberAccepted.revision, campaign_id: "campaign-gate", audit_evidence: [evidence("docs/campaign-audit.md")], decision: evidence("docs/campaign-release.md", "decision") });
  assert.equal(released.manifest.worker_runs.find((entry) => entry.worker_run_id === "campaign-gated-worker").state, "planned");
  assert.equal(released.manifest.consultations.find((entry) => entry.consultation_id === "campaign-gated-consultation").state, "planned");
  const status = await api.campaignStatus({ cwd: repo.root, control_id: "campaign-control", campaign_id: "campaign-gate" });
  assert.equal(status.all_terminal, true); assert.equal(status.released, true); assert.equal(status.members.length, 2);
  const eligiblePlacement = await api.placementDryRun({ cwd: repo.root, control_id: "campaign-control", task_id: "campaign-gated-task", evaluated_at: "2026-07-14T00:30:00.000Z", candidates: [makePlacementCandidate({ candidate_id: "campaign-placement", registry_observation_id: "campaign-registry", workspace_cwd: repo.root })] });
  assert.equal(eligiblePlacement.candidates[0].eligibility, "eligible");
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: released.revision, worker_run_id: "campaign-gated-worker" });
  const dispatched = await api.observeConsultation({ cwd: repo.root, control_id: "campaign-control", actor_id: "parent", expected_revision: admitted.revision, consultation_id: "campaign-gated-consultation", observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-14T00:04:00.000Z", raw_state: "dispatched" } });
  assert.equal(dispatched.manifest.consultations.find((entry) => entry.consultation_id === "campaign-gated-consultation").state, "dispatched");
  const tampered = structuredClone(released.manifest); tampered.campaigns[0].release.released_by = "attacker";
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
});

test("campaign CLIはrecord/status/releaseだけを行い外部Executorを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "campaign-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const memberTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "campaign-cli-member", effect: "read", write_scope: [] }) });
  const gatedTask = await api.taskRecord({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: memberTask.revision, task: makeTask({ task_id: "campaign-cli-gated", effect: "read", write_scope: [] }) });
  const member = await api.workerRunRecord({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: gatedTask.revision, worker_run: makeWorkerRun({ worker_run_id: "campaign-cli-worker", task_id: "campaign-cli-member", assignment_id: "campaign-cli-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "campaign-cli-assignment" } }) });
  const admitted = await api.admitWorker({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: member.revision, worker_run_id: "campaign-cli-worker" });
  const terminal = await api.observeWorker({ cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: admitted.revision, worker_run_id: "campaign-cli-worker", observation: workerObservation("cancelled", { dispatch_attempt_evidence: [evidence("docs/campaign-cli-no-dispatch.md", "executor-receipt")] }) });
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` };
  const recordInput = join(base, "campaign-record.json"); await writeJson(recordInput, { cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: terminal.revision, campaign: { campaign_id: "campaign-cli-gate", campaign_type: "discovery", members: [{ kind: "worker-run", id: "campaign-cli-worker" }], gated_task_ids: ["campaign-cli-gated"], audit_required: false } });
  const recorded = spawnOrchestrate(["campaign-record", "--input", recordInput], { env }); assert.equal(recorded.status, 0); const recordedResult = JSON.parse(recorded.stdout).result;
  const statusInput = join(base, "campaign-status.json"); await writeJson(statusInput, { cwd: repo.root, control_id: "campaign-cli", campaign_id: "campaign-cli-gate" });
  const status = spawnOrchestrate(["campaign-status", "--input", statusInput], { env }); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).result.all_terminal, true);
  const releaseInput = join(base, "campaign-release.json"); await writeJson(releaseInput, { cwd: repo.root, control_id: "campaign-cli", actor_id: "parent", expected_revision: recordedResult.revision, campaign_id: "campaign-cli-gate", audit_evidence: [], decision: evidence("docs/campaign-cli-release.md", "decision") });
  const released = spawnOrchestrate(["campaign-release", "--input", releaseInput], { env }); assert.equal(released.status, 0); assert.equal(JSON.parse(released.stdout).result.manifest.campaigns[0].release.released_by, "parent");
  await assert.rejects(access(sentinel.log));
});

test("record-only layerはprovider/network/dispatch/cancelを実行せず、CLIはstrict input JSONだけを受理する", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: CONTROL, objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const input = join(base, "status.json"); await writeJson(input, { cwd: repo.root, control_id: CONTROL });
  const protectedEnv = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` };
  const ok = spawnOrchestrate(["status", "--input", input], { env: protectedEnv });
  assert.equal(ok.status, 0); assert.deepEqual(JSON.parse(ok.stdout), { ok: true, command: "status", result: await api.status({ cwd: repo.root, control_id: CONTROL }) });
  const brief = spawnOrchestrate(["status", "--brief", "--input", input], { env: protectedEnv });
  assert.equal(brief.status, 0); assert.equal(JSON.parse(brief.stdout).command, "status --brief");
  const resume = spawnOrchestrate(["resume-check", "--input", input], { env: protectedEnv });
  assert.equal(resume.status, 0); assert.equal(JSON.parse(resume.stdout).command, "resume-check");
  const resumeParsed = JSON.parse(resume.stdout);
  assert.equal(resumeParsed.summary.outcome, resumeParsed.result.outcome);
  assert.equal(resumeParsed.summary.blocking_count, resumeParsed.result.blocking_reasons.length);
  assert.equal(resumeParsed.summary.review_count, resumeParsed.result.review_reasons.length);
  assert.deepEqual(Object.keys(resumeParsed), ["ok", "command", "summary", "result"]);
  const cliControl = "cli-record-only";
  const cliInitInput = join(base, "cli-init.json"); await writeJson(cliInitInput, { cwd: repo.root, control_id: cliControl, objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const cliInit = spawnOrchestrate(["init", "--input", cliInitInput], { env: protectedEnv });
  assert.equal(cliInit.status, 0); const cliInitResult = JSON.parse(cliInit.stdout).result;
  const cliTaskInput = join(base, "cli-task.json"); await writeJson(cliTaskInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliInitResult.revision, task: makeTask({ task_id: "cli-task" }) });
  const prematureTask = spawnOrchestrate(["task-record", "--input", cliTaskInput], { env: protectedEnv });
  assert.equal(prematureTask.status, 1); assert.equal(JSON.parse(prematureTask.stderr).code, "PHASE_GATE_NOT_RECORDED");
  const cliPhaseInput = join(base, "cli-phase.json"); await writeJson(cliPhaseInput, {
    cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliInitResult.revision,
    risk: "standard", behavior_lane: "behavior-change",
  });
  const cliPhase = spawnOrchestrate(["phase-gate-record", "--input", cliPhaseInput], { env: protectedEnv });
  assert.equal(cliPhase.status, 0); const cliPhaseResult = JSON.parse(cliPhase.stdout).result;
  await writeJson(cliTaskInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliPhaseResult.revision, task: makeTask({ task_id: "cli-task" }) });
  const cliTask = spawnOrchestrate(["task-record", "--input", cliTaskInput], { env: protectedEnv });
  assert.equal(cliTask.status, 0); const cliTaskResult = JSON.parse(cliTask.stdout).result;
  const cliRunInput = join(base, "cli-run.json"); await writeJson(cliRunInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliTaskResult.revision, worker_run: makeWorkerRun({ task_id: "cli-task", worker_run_id: "cli-run", assignment_id: "cli-assignment", workspace_cwd: repo.root }) });
  const cliRun = spawnOrchestrate(["worker-run-record", "--input", cliRunInput], { env: protectedEnv });
  assert.equal(cliRun.status, 0); const cliRunResult = JSON.parse(cliRun.stdout).result;
  const cliAdmitInput = join(base, "cli-admit.json"); await writeJson(cliAdmitInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliRunResult.revision, worker_run_id: "cli-run" });
  const cliAdmit = spawnOrchestrate(["admit-worker", "--input", cliAdmitInput], { env: protectedEnv });
  assert.equal(cliAdmit.status, 0); const cliAdmitResult = JSON.parse(cliAdmit.stdout).result;
  assert.equal(cliAdmitResult.manifest.worker_runs[0].state, "admitted");
  const cliRegistryInput = join(base, "cli-registry-observation.json"); await writeJson(cliRegistryInput, {
    cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliAdmitResult.revision,
    observation: makeRegistryObservation({ registry_observation_id: "registry-cli" }),
  });
  const cliRegistry = spawnOrchestrate(["registry-observation-record", "--input", cliRegistryInput], { env: protectedEnv });
  assert.equal(cliRegistry.status, 0); const cliRegistryResult = JSON.parse(cliRegistry.stdout).result;
  assert.equal(cliRegistryResult.manifest.registry_observations.at(-1).registry_observation_id, "registry-cli");
  const cliPlacementInput = join(base, "cli-placement.json"); await writeJson(cliPlacementInput, {
    cwd: repo.root, control_id: cliControl, task_id: "cli-task", evaluated_at: "2026-07-14T00:30:00.000Z",
    candidates: [makePlacementCandidate({ candidate_id: "cli-placement", registry_observation_id: "registry-cli", workspace_cwd: repo.root, write_mode: "direct" })],
  });
  const cliPlacement = spawnOrchestrate(["placement-dry-run", "--input", cliPlacementInput], { env: protectedEnv });
  assert.equal(cliPlacement.status, 0); assert.equal(JSON.parse(cliPlacement.stdout).command, "placement-dry-run");
  const cliReserveInput = join(base, "cli-placement-reserve.json"); await writeJson(cliReserveInput, {
    cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliRegistryResult.revision,
    task_id: "cli-task", candidate: makePlacementCandidate({ candidate_id: "cli-reserve", registry_observation_id: "registry-cli", workspace_cwd: repo.root, write_mode: "direct" }), review_decision: null,
  });
  const cliReserve = spawnOrchestrate(["placement-reserve", "--input", cliReserveInput], { env: protectedEnv });
  assert.equal(cliReserve.status, 1); assert.equal(JSON.parse(cliReserve.stderr).code, "PLACEMENT_INELIGIBLE");
  const cliWorkerCancelInput = join(base, "cli-worker-cancel.json"); await writeJson(cliWorkerCancelInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliRegistryResult.revision, worker_run_id: "cli-run", decision: evidence("docs/cli-worker-cancel.md", "decision") });
  const cliWorkerCancel = spawnOrchestrate(["worker-cancel-request", "--input", cliWorkerCancelInput], { env: protectedEnv });
  assert.equal(cliWorkerCancel.status, 0); const cliWorkerCancelResult = JSON.parse(cliWorkerCancel.stdout).result;
  assert.equal(cliWorkerCancelResult.manifest.worker_runs[0].state, "admitted");
  const cliTaskCancelInput = join(base, "cli-task-cancel.json"); await writeJson(cliTaskCancelInput, { cwd: repo.root, control_id: cliControl, actor_id: "parent", expected_revision: cliWorkerCancelResult.revision, task_id: "cli-task", decision: evidence("docs/cli-task-cancel.md", "decision") });
  const cliTaskCancel = spawnOrchestrate(["task-cancel-record", "--input", cliTaskCancelInput], { env: protectedEnv });
  assert.equal(cliTaskCancel.status, 0); const cliTaskCancelResult = JSON.parse(cliTaskCancel.stdout).result;
  assert.deepEqual(cliTaskCancelResult.manifest.task_cancellations.map((entry) => entry.task_id), ["cli-task"]);
  await assert.rejects(access(sentinel.log));
  for (const args of [["unknown", "--input", input], ["status", "--input", input, "--input", input], ["status", "extra", "--input", input], ["status", "--brief", "--bogus", input]]) {
    const output = spawnOrchestrate(args); assert.equal(output.status, 2); assert.equal(JSON.parse(output.stderr).code, "INVALID_INPUT");
  }
  const linkedInput = join(base, "linked-input.json"); await symlink(input, linkedInput);
  const unsafe = spawnOrchestrate(["status", "--input", linkedInput]);
  assert.equal(unsafe.status, 2); assert.equal(JSON.parse(unsafe.stderr).code, "INPUT_PATH_UNSAFE");
  const tooLarge = join(base, "too-large.json"); await writeFile(tooLarge, `${" ".repeat((64 * 1024) + 1)}{}`);
  const oversized = spawnOrchestrate(["status", "--input", tooLarge]);
  assert.equal(oversized.status, 2); assert.equal(JSON.parse(oversized.stderr).code, "LIMIT_EXCEEDED");
  const invalidUtf8 = join(base, "invalid-utf8.json"); await writeFile(invalidUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
  const invalidEncoding = spawnOrchestrate(["status", "--input", invalidUtf8]);
  assert.equal(invalidEncoding.status, 2); assert.equal(JSON.parse(invalidEncoding.stderr).code, "INVALID_INPUT");
  assert.equal(init.manifest.control_id, CONTROL);
});

test("固定phase gateはhigh risk behavior-changeとbehavior-preservingを明示順で閉じる", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "phase-high" });
  const high = await completePhaseGate(repo, "phase-high", result.revision, { risk: "high", behaviorLane: "behavior-change" });
  assert.equal(high.manifest.phase_gate.phases.find((entry) => entry.phase === "safety_net").state, "completed");
  assert.equal(high.manifest.phase_gate.phases.find((entry) => entry.phase === "behavior_change").state, "completed");
  assert.equal(high.manifest.transition_receipts.filter((entry) => entry.operation === "phase-gate-advance").length, 9);
  const status = await api.phaseGateStatus({ cwd: repo.root, control_id: "phase-high" });
  assert.equal(status.complete, true); assert.equal(status.current_phase, null);
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "phase-high" });
  assert.deepEqual(brief.phase_gate, { configured: true, risk: "high", behavior_lane: "behavior-change", current_phase: null, complete: true });
  const preserving = await api.init({ cwd: repo.root, control_id: "phase-preserving", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const preserved = await completePhaseGate(repo, "phase-preserving", preserving.revision);
  assert.equal(preserved.manifest.phase_gate.phases.find((entry) => entry.phase === "safety_net").state, "not-required");
  assert.equal(preserved.manifest.phase_gate.phases.find((entry) => entry.phase === "behavior_change").state, "not-applicable");
  const knowledgeBoundary = await api.init({ cwd: repo.root, control_id: "phase-knowledge-evidence", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  let boundary = await api.phaseGateRecord({ cwd: repo.root, control_id: "phase-knowledge-evidence", actor_id: "parent", expected_revision: knowledgeBoundary.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  for (const phase of ["baseline", "discovery", "design", "safety_net", "implementation", "behavior_change", "integration"]) {
    const state = phase === "safety_net" ? "not-required" : phase === "behavior_change" ? "not-applicable" : "completed";
    const decision = ["design", "safety_net", "behavior_change"].includes(phase) ? evidence(`docs/${phase}-decision.md`, "decision") : null;
    boundary = await api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-knowledge-evidence", actor_id: "parent", expected_revision: boundary.revision, phase, state, evidence: phase === "baseline" ? [evidence("docs/baseline-evidence.md")] : [], decision });
  }
  await assert.rejects(api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-knowledge-evidence", actor_id: "parent", expected_revision: boundary.revision, phase: "knowledge_return", state: "completed", evidence: [], decision: null }), code("INVALID_SCHEMA"));
});

test("phase gateは不足・順序逸脱・receipt改竄・未complete finalizationをfail closedにする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "phase-negative" });
  await assert.rejects(api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: result.revision, phase: "baseline", state: "completed", evidence: [evidence("docs/baseline.md")], decision: null }), code("PHASE_GATE_NOT_RECORDED"));
  const recorded = await api.phaseGateRecord({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: result.revision, risk: "high", behavior_lane: "behavior-preserving" });
  const tamperedDeclaration = structuredClone(recorded.manifest); tamperedDeclaration.phase_gate.risk = "standard";
  assert.throws(() => api.validateManifest(tamperedDeclaration), code("INVALID_SCHEMA"));
  await assert.rejects(api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: recorded.revision, phase: "discovery", state: "completed", evidence: [], decision: null }), code("PHASE_ORDER_INVALID"));
  await assert.rejects(api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: recorded.revision, phase: "baseline", state: "completed", evidence: [], decision: null }), code("INVALID_SCHEMA"));
  const baseline = await api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: recorded.revision, phase: "baseline", state: "completed", evidence: [evidence("docs/baseline.md")], decision: null });
  const discovery = await api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: baseline.revision, phase: "discovery", state: "completed", evidence: [], decision: null });
  await assert.rejects(api.phaseGateAdvance({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: discovery.revision, phase: "design", state: "completed", evidence: [], decision: null }), code("INVALID_SCHEMA"));
  await assert.rejects(api.finalizeControl({ cwd: repo.root, control_id: "phase-negative", actor_id: "parent", expected_revision: discovery.revision, acceptance_matrix_ref: "docs/a.md", final_audit_evidence: [evidence("docs/audit.md")], regression_evidence: [evidence("test", "command")], knowledge_return_refs: ["docs/knowledge.md"], parent_decision: evidence("docs/adr/final.md", "decision"), finalized_by: "parent" }), code("FINALIZATION_NOT_READY"));
  const tampered = structuredClone(discovery.manifest); tampered.transition_receipts.at(-1).next_state = "not-required";
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
});

test("phase gate CLIはrecord/advance/statusだけを行い外部providerを起動しない", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base)); const repo = await createGitRepo(base); const sentinel = await installSentinelBin(base);
  const init = await api.init({ cwd: repo.root, control_id: "phase-cli", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const env = { ...process.env, PATH: `${sentinel.bin}:${process.env.PATH}` };
  const recordInput = join(base, "phase-record.json"); await writeJson(recordInput, { cwd: repo.root, control_id: "phase-cli", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const recorded = spawnOrchestrate(["phase-gate-record", "--input", recordInput], { env }); assert.equal(recorded.status, 0); const recordResult = JSON.parse(recorded.stdout).result;
  const advanceInput = join(base, "phase-advance.json"); await writeJson(advanceInput, { cwd: repo.root, control_id: "phase-cli", actor_id: "parent", expected_revision: recordResult.revision, phase: "baseline", state: "completed", evidence: [evidence("docs/phase-cli-baseline.md")], decision: null });
  const advanced = spawnOrchestrate(["phase-gate-advance", "--input", advanceInput], { env }); assert.equal(advanced.status, 0);
  const statusInput = join(base, "phase-status.json"); await writeJson(statusInput, { cwd: repo.root, control_id: "phase-cli" });
  const status = spawnOrchestrate(["phase-gate-status", "--input", statusInput], { env }); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).result.current_phase, "discovery");
  await assert.rejects(access(sentinel.log));
});

const V25 = "dotagents.orchestration-control.v25";
const V26 = "dotagents.orchestration-control.v26";
const V27 = "dotagents.orchestration-control.v27";
const V28 = "dotagents.orchestration-control.v28";
const V29 = "dotagents.orchestration-control.v29";

/** v28 Control（v28世代init産物）を再現する: v29との差はlane_admission keyの不在だけ（ADR 0114 Decision 4）。 */
async function downgradeControlToV28(repo, controlId) {
  const manifest = await readPersistedManifest(repo.commonDir, controlId);
  manifest.schema_version = V28;
  delete manifest.lane_admission;
  await writeJson((await controlStatePaths(repo.commonDir, controlId)).manifest, manifest);
}

/** v26 Control（v26世代init産物）を再現する: cancelled不在のconsultation shapeはv27と同一で、schema定数だけが異なる。 */
async function downgradeControlToV26(repo, controlId) {
  const manifest = await readPersistedManifest(repo.commonDir, controlId);
  manifest.schema_version = V26;
  delete manifest.lane_admission;
  await writeJson((await controlStatePaths(repo.commonDir, controlId)).manifest, manifest);
}

/** 実在するv25 Control（v23→v25世代のinit産物）を再現する: schema定数とconsultation shapeだけがv26と異なる。 */
async function downgradeControlToV25(repo, controlId) {
  const manifest = await readPersistedManifest(repo.commonDir, controlId);
  manifest.schema_version = V25;
  delete manifest.lane_admission;
  for (const consultation of manifest.consultations) {
    consultation.slug = consultation.consultation_handle.slug;
    delete consultation.consultation_handle;
  }
  const paths = await controlStatePaths(repo.commonDir, controlId);
  await writeJson(paths.manifest, manifest);
}

async function consultationTaskRecorded(t, controlId) {
  const { repo, result } = await initialized(t, { control_id: controlId });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "consultation-task", effect: "read", write_scope: [] }) });
  return { repo, revision: task.revision };
}

test("typed schema initはtyped consultation_handleの多provider consultationを固定しshape違反をfail closedにする", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "v26-multiprovider");
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await api.status({ cwd: repo.root, control_id: "v26-multiprovider" })).schema_version, V29);
  const claude = await api.consultationRecord({
    cwd: repo.root, control_id: "v26-multiprovider", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "claude-consult", assignment_id: "claude-consult-assignment", connector: "claude-native", consultation_handle: { session_id: sessionId } }),
  });
  assert.deepEqual(claude.manifest.consultations[0].consultation_handle, { session_id: sessionId });
  const dispatched = await api.observeConsultation({
    cwd: repo.root, control_id: "v26-multiprovider", actor_id: "parent", expected_revision: claude.revision, consultation_id: "claude-consult",
    observation: { state: "dispatched", source: "claude-native", observed_version: "2.1.211", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched" },
  });
  const completedObservation = adapters.buildConsultationControlObservation({
    projection: adapters.projectClaudeNativeConsultObservation({ handle: { session_id: sessionId }, status: "completed", result_receipt: "claude:stream-result:end_turn" }),
    observed_version: "2.1.211", observed_at: "2026-07-17T00:01:00.000Z", decision_ref: "docs/consult-decision.md",
  });
  const completed = await api.observeConsultation({ cwd: repo.root, control_id: "v26-multiprovider", actor_id: "parent", expected_revision: dispatched.revision, consultation_id: "claude-consult", observation: completedObservation });
  assert.equal(completed.manifest.consultations[0].decision_ref, "docs/consult-decision.md");
  const sidecar = await api.consultationRecord({
    cwd: repo.root, control_id: "v26-multiprovider", actor_id: "parent", expected_revision: completed.revision,
    consultation: makeConsultation({ consultation_id: "sidecar-consult", assignment_id: "sidecar-consult-assignment", connector: "codex-sidecar", consultation_handle: null }),
  });
  assert.equal(sidecar.manifest.consultations[1].consultation_handle, null);
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "v26-multiprovider" });
  assert.equal(brief.schema_version, "dotagents.orchestration-status-brief.v7");
  assert.deepEqual(brief.active.consultations, [{
    consultation_id: "sidecar-consult", task_id: "consultation-task", state: "planned",
    connector: "codex-sidecar", consultation_handle: null, model: "gpt-5.6", effort: "low", executor_observation: null,
  }]);
  const reject = async (consultation, expected) => assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "v26-multiprovider", actor_id: "parent", expected_revision: sidecar.revision, consultation,
  }), code(expected));
  await reject(makeConsultation({ consultation_id: "unknown-connector", assignment_id: "unknown-connector-assignment", connector: "aiterm", consultation_handle: null }), "INVALID_SCHEMA");
  await reject(makeConsultation({ consultation_id: "shape-violation", assignment_id: "shape-violation-assignment", connector: "claude-native", consultation_handle: { slug: "not-a-session" } }), "INVALID_SCHEMA");
  await reject(makeConsultation({ consultation_id: "uppercase-uuid", assignment_id: "uppercase-uuid-assignment", connector: "claude-native", consultation_handle: { session_id: sessionId.toUpperCase() } }), "INVALID_SCHEMA");
  await reject(makeConsultation({ consultation_id: "null-gpt", assignment_id: "null-gpt-assignment", consultation_handle: null }), "INVALID_SCHEMA");
  await reject(makeConsultationV25({ consultation_id: "slug-stuffing", assignment_id: "slug-stuffing-assignment", connector: "claude-native", slug: sessionId }), "INVALID_SCHEMA");
  await reject(makeConsultationV25({ consultation_id: "v25-shape-on-v26", assignment_id: "v25-shape-on-v26-assignment" }), "INVALID_SCHEMA");
});

test("v25 active Controlは読取もmutationも従来契約で継続しv26専用recordはSCHEMA_UPGRADE_REQUIREDになる", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "v25-continuity");
  await downgradeControlToV25(repo, "v25-continuity");
  assert.equal((await api.status({ cwd: repo.root, control_id: "v25-continuity" })).schema_version, V25);
  const recorded = await api.consultationRecord({ cwd: repo.root, control_id: "v25-continuity", actor_id: "parent", expected_revision: revision, consultation: makeConsultationV25() });
  assert.equal(recorded.manifest.consultations[0].slug, "known-session-slug");
  const dispatched = await api.observeConsultation({
    cwd: repo.root, control_id: "v25-continuity", actor_id: "parent", expected_revision: recorded.revision, consultation_id: "consultation-001",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched" },
  });
  const brief = await api.statusBrief({ cwd: repo.root, control_id: "v25-continuity" });
  assert.equal(brief.schema_version, "dotagents.orchestration-status-brief.v7");
  assert.deepEqual(brief.active.consultations[0].consultation_handle, { slug: "known-session-slug" });
  assert.equal((await api.resumeCheck({ cwd: repo.root, control_id: "v25-continuity" })).schema_version, "dotagents.orchestration-resume-check.v7");
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "v25-continuity", actor_id: "parent", expected_revision: dispatched.revision,
    consultation: makeConsultation({ consultation_id: "needs-v26", assignment_id: "needs-v26-assignment", connector: "claude-native", consultation_handle: { session_id: "123e4567-e89b-42d3-a456-426614174000" } }),
  }), code("SCHEMA_UPGRADE_REQUIRED"));
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "v25-continuity", actor_id: "parent", expected_revision: dispatched.revision,
    consultation: makeConsultation({ consultation_id: "gpt-typed-handle", assignment_id: "gpt-typed-handle-assignment" }),
  }), code("SCHEMA_UPGRADE_REQUIRED"));
});

test("control-migrateはv25→v26を決定的に一回で行い非gpt consultationが居るv26をv25へ戻さない", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "migrate-control");
  await downgradeControlToV25(repo, "migrate-control");
  const recorded = await api.consultationRecord({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: revision, consultation: makeConsultationV25() });
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: recorded.revision, target_schema_version: V25 }), code("INVALID_TRANSITION"));
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: recorded.revision, target_schema_version: "dotagents.orchestration-control.v99" }), code("INVALID_SCHEMA"));
  // v25→v27の直行migrationは存在しない（隣接version限定・ADR 0054）
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: recorded.revision, target_schema_version: V27 }), code("INVALID_TRANSITION"));
  const migrated = await api.controlMigrate({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: recorded.revision, target_schema_version: V26 });
  assert.equal(migrated.manifest.schema_version, V26);
  assert.equal(migrated.revision, recorded.revision + 1);
  assert.deepEqual(migrated.manifest.consultations[0].consultation_handle, { slug: "known-session-slug" });
  assert.equal(Object.hasOwn(migrated.manifest.consultations[0], "slug"), false);
  const receipt = migrated.manifest.transition_receipts.at(-1);
  assert.equal(receipt.operation, "control-migrate");
  assert.deepEqual(receipt.subject, { kind: "control", id: "migrate-control" });
  assert.equal(receipt.previous_state, V25);
  assert.equal(receipt.next_state, V26);
  const claude = await api.consultationRecord({
    cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: migrated.revision,
    consultation: makeConsultation({ consultation_id: "claude-consult", assignment_id: "claude-consult-assignment", connector: "claude-native", consultation_handle: { session_id: "123e4567-e89b-42d3-a456-426614174000" } }),
  });
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "migrate-control", actor_id: "parent", expected_revision: claude.revision, target_schema_version: V25 }), code("ROLLBACK_UNSUPPORTED"));
});

test("rollbackはgpt-connectorのみのv26をv25へ戻しmigrate receiptは両versionで有効に残る", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "rollback-control");
  await downgradeControlToV26(repo, "rollback-control");
  const recorded = await api.consultationRecord({ cwd: repo.root, control_id: "rollback-control", actor_id: "parent", expected_revision: revision, consultation: makeConsultation() });
  const rolledBack = await api.controlMigrate({ cwd: repo.root, control_id: "rollback-control", actor_id: "parent", expected_revision: recorded.revision, target_schema_version: V25 });
  assert.equal(rolledBack.manifest.schema_version, V25);
  assert.equal(rolledBack.manifest.consultations[0].slug, "known-session-slug");
  assert.equal(Object.hasOwn(rolledBack.manifest.consultations[0], "consultation_handle"), false);
  assert.equal(rolledBack.manifest.transition_receipts.at(-1).operation, "control-migrate");
  const v25Mutation = await api.consultationRecord({
    cwd: repo.root, control_id: "rollback-control", actor_id: "parent", expected_revision: rolledBack.revision,
    consultation: makeConsultationV25({ consultation_id: "post-rollback", assignment_id: "post-rollback-assignment" }),
  });
  assert.equal(v25Mutation.manifest.consultations[1].slug, "known-session-slug");
  const remigrated = await api.controlMigrate({ cwd: repo.root, control_id: "rollback-control", actor_id: "parent", expected_revision: v25Mutation.revision, target_schema_version: V26 });
  assert.equal(remigrated.manifest.schema_version, V26);
  assert.equal(remigrated.manifest.transition_receipts.filter((entry) => entry.operation === "control-migrate").length, 2);
});

test("receipt容量際のcontrol-migrateは架空の空きを作らずCONTROL_CAPACITY_RESERVEDで拒否される", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "migrate-capacity" });
  const manifest = structuredClone(result.manifest);
  for (let revision = 1; revision <= 253; revision++) {
    const previous = manifest.transition_receipts.at(-1);
    manifest.transition_receipts.push(makeTransitionReceipt({
      revision, operation: "task-record", subject: { kind: "task", id: `synthetic-${revision}` },
      previous_state: null, next_state: "recorded", previous_receipt_digest: previous.receipt_digest,
    }));
  }
  manifest.record_revision = 253;
  manifest.last_update = { actor_id: "parent-001", updated_at: "2026-07-14T00:00:00.000Z" };
  manifest.schema_version = V28;
  delete manifest.lane_admission;
  await writeJson((await controlStatePaths(repo.commonDir, "migrate-capacity")).manifest, manifest);
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "migrate-capacity", actor_id: "parent", expected_revision: 253, target_schema_version: V29 }), code("CONTROL_CAPACITY_RESERVED"));
});

test("consult-v1契約はWorker laneの実行者としてoperationally knownにならない", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "consult-worker-forbidden");
  await assert.rejects(api.workerRunRecord({
    cwd: repo.root, control_id: "consult-worker-forbidden", actor_id: "parent", expected_revision: revision,
    worker_run: makeWorkerRun({
      task_id: "consultation-task", write_mode: "none", workspace_cwd: repo.root,
      executor: { adapter_id: "claude-native", contract_version: "consult-v1", instance_id: "local", handle_schema_id: "claude-native.session.v1" },
      executor_handle: { session_id: "123e4567-e89b-42d3-a456-426614174000" },
    }),
  }), code("ADAPTER_UNKNOWN"));
});

test("provider障害時の切替は元Consultationのfailed終端後の新recordであり元の成功へ丸めない", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "provider-switch");
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const gpt = await api.consultationRecord({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "gpt-attempt", assignment_id: "switch-assignment" }),
  });
  const dispatched = await api.observeConsultation({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: gpt.revision, consultation_id: "gpt-attempt",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched" },
  });
  const claudeSwitch = () => makeConsultation({ consultation_id: "claude-switch", assignment_id: "switch-assignment", connector: "claude-native", consultation_handle: { session_id: sessionId } });
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: dispatched.revision, consultation: claudeSwitch(),
  }), code("ASSIGNMENT_ACTIVE"));
  const failedEvidence = [evidence("connector:gpt-connector:gpt-attempt", "executor-receipt")];
  const failed = await api.observeConsultation({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: dispatched.revision, consultation_id: "gpt-attempt",
    observation: { state: "failed", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:01:00.000Z", raw_state: "failed", terminal_evidence: failedEvidence },
  });
  const switched = await api.consultationRecord({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: failed.revision, consultation: claudeSwitch(),
  });
  const original = switched.manifest.consultations.find((entry) => entry.consultation_id === "gpt-attempt");
  assert.equal(original.state, "failed");
  assert.deepEqual(original.consultation_handle, { slug: "known-session-slug" });
  assert.deepEqual(original.terminal_evidence, failedEvidence);
  const replacement = switched.manifest.consultations.find((entry) => entry.consultation_id === "claude-switch");
  assert.equal(replacement.connector, "claude-native");
  assert.equal(replacement.state, "planned");
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: switched.revision,
    consultation: makeConsultation({ consultation_id: "gpt-attempt", assignment_id: "duplicate-id-assignment" }),
  }), code("DUPLICATE_ID"));
  const completedSwitch = await api.observeConsultation({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: switched.revision, consultation_id: "claude-switch",
    observation: { state: "dispatched", source: "claude-native", observed_version: "2.1.211", observed_at: "2026-07-17T00:02:00.000Z", raw_state: "dispatched" },
  }).then((result) => api.observeConsultation({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: result.revision, consultation_id: "claude-switch",
    observation: { state: "completed", source: "claude-native", observed_version: "2.1.211", observed_at: "2026-07-17T00:03:00.000Z", raw_state: "completed", decision_ref: "docs/switch-decision.md" },
  }));
  await assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "provider-switch", actor_id: "parent", expected_revision: completedSwitch.revision,
    consultation: makeConsultation({ consultation_id: "third-attempt", assignment_id: "switch-assignment", connector: "codex-sidecar", consultation_handle: null }),
  }), code("ASSIGNMENT_ACTIVE"));
});

test("consultation observationはrecordのconnector・handleと相関しない観測を拒否する", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "observation-binding");
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const gpt = await api.consultationRecord({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "gpt-bind", assignment_id: "gpt-bind-assignment" }),
  });
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: gpt.revision, consultation_id: "gpt-bind",
    observation: { state: "dispatched", source: "claude-native", observed_version: "2.1.211", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched" },
  }), code("INVALID_SCHEMA"));
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: gpt.revision, consultation_id: "gpt-bind",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched", consultation_handle: { slug: "some-other-slug" } },
  }), code("INVALID_SCHEMA"));
  const dispatched = await api.observeConsultation({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: gpt.revision, consultation_id: "gpt-bind",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched", consultation_handle: { slug: "known-session-slug" } },
  });
  const stored = dispatched.manifest.consultations[0].executor_observation;
  assert.deepEqual(Object.keys(stored).sort(), ["observed_at", "observed_version", "raw_state", "source"]);
  const claude = await api.consultationRecord({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: dispatched.revision,
    consultation: makeConsultation({ consultation_id: "claude-bind", assignment_id: "claude-bind-assignment", connector: "claude-native", consultation_handle: { session_id: sessionId } }),
  });
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "observation-binding", actor_id: "parent", expected_revision: claude.revision, consultation_id: "claude-bind",
    observation: { state: "dispatched", source: "claude-native", observed_version: "2.1.211", observed_at: "2026-07-17T00:01:00.000Z", raw_state: "dispatched", consultation_handle: { session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  }), code("INVALID_SCHEMA"));
});

test("v26 recordはconnector固有のeffort語彙へ束縛されdispatch不能なplanned recordを作らない", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "effort-binding");
  const reject = async (consultation) => assert.rejects(api.consultationRecord({
    cwd: repo.root, control_id: "effort-binding", actor_id: "parent", expected_revision: revision, consultation,
  }), code("INVALID_SCHEMA"));
  await reject(makeConsultation({ consultation_id: "sidecar-max", assignment_id: "sidecar-max-assignment", connector: "codex-sidecar", consultation_handle: null, effort: "max" }));
  await reject(makeConsultation({ consultation_id: "claude-banana", assignment_id: "claude-banana-assignment", connector: "claude-native", consultation_handle: { session_id: "123e4567-e89b-42d3-a456-426614174000" }, effort: "standard" }));
  const claudeMax = await api.consultationRecord({
    cwd: repo.root, control_id: "effort-binding", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "claude-max", assignment_id: "claude-max-assignment", connector: "claude-native", consultation_handle: { session_id: "123e4567-e89b-42d3-a456-426614174000" }, effort: "max" }),
  });
  const gptFree = await api.consultationRecord({
    cwd: repo.root, control_id: "effort-binding", actor_id: "parent", expected_revision: claudeMax.revision,
    consultation: makeConsultation({ consultation_id: "gpt-free", assignment_id: "gpt-free-assignment", effort: "standard" }),
  });
  assert.equal(gptFree.manifest.consultations.length, 2);
});

test("control-migrate receiptは対象Control・v25/v26遷移・連鎖・最終schema一致をreaderが検証する", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "migrate-receipt-guard");
  await downgradeControlToV25(repo, "migrate-receipt-guard");
  const migrated = await api.controlMigrate({ cwd: repo.root, control_id: "migrate-receipt-guard", actor_id: "parent", expected_revision: revision, target_schema_version: V26 });
  const valid = migrated.manifest;
  api.validateManifest(structuredClone(valid));
  const tamper = (mutate) => {
    const manifest = structuredClone(valid);
    const receipt = manifest.transition_receipts.at(-1);
    assert.equal(receipt.operation, "control-migrate");
    mutate(manifest, receipt);
    const previous = manifest.transition_receipts.at(-2);
    manifest.transition_receipts[manifest.transition_receipts.length - 1] = makeTransitionReceipt({
      revision: receipt.revision, actor_id: receipt.actor_id, operation: receipt.operation, subject: receipt.subject,
      previous_state: receipt.previous_state, next_state: receipt.next_state, evidence: receipt.evidence,
      recorded_at: receipt.recorded_at, previous_receipt_digest: previous.receipt_digest,
    });
    manifest.last_update = { actor_id: receipt.actor_id, updated_at: receipt.recorded_at };
    return manifest;
  };
  assert.throws(() => api.validateManifest(tamper((_manifest, receipt) => { receipt.subject = { kind: "task", id: "bogus" }; })), code("INVALID_SCHEMA"));
  assert.throws(() => api.validateManifest(tamper((_manifest, receipt) => { receipt.previous_state = "dotagents.orchestration-control.v99"; })), code("INVALID_SCHEMA"));
  assert.throws(() => api.validateManifest(tamper((_manifest, receipt) => { receipt.next_state = "dotagents.orchestration-control.v25"; receipt.previous_state = "dotagents.orchestration-control.v25"; })), code("INVALID_SCHEMA"));
  assert.throws(() => api.validateManifest(tamper((manifest, _receipt) => { manifest.schema_version = "dotagents.orchestration-control.v25"; })), code("INVALID_SCHEMA"));
});

test("取消済みTaskのplanned consultationはfinalize・容量予約・campaign終端を恒久ブロックしない", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "orphaned-consult-close" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  // ADR 0053の孤児除外はv25/v26のreader semantics（v27の脱出経路はconsultation-cancel）
  await downgradeControlToV26(repo, "orphaned-consult-close");
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "orphan-task", effect: "read", write_scope: [] }),
  });
  const consultation = await api.consultationRecord({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: task.revision,
    consultation: makeConsultation({ consultation_id: "orphan-consult", task_id: "orphan-task", assignment_id: "orphan-assignment" }),
  });
  const campaign = await api.campaignRecord({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: consultation.revision,
    campaign: { campaign_id: "orphan-campaign", campaign_type: "discovery", members: [{ kind: "consultation", id: "orphan-consult" }], gated_task_ids: ["orphan-task"], audit_required: false },
  });
  assert.equal((await api.campaignStatus({ cwd: repo.root, control_id: "orphaned-consult-close", campaign_id: "orphan-campaign" })).all_terminal, false);
  const cancelDecision = await materializeDocumentEvidence(repo, evidence("docs/orphan-cancel.md", "decision"));
  const cancelled = await api.taskCancelRecord({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: campaign.revision,
    task_id: "orphan-task", decision: cancelDecision,
  });
  // 除外はstateを書き換えず、dispatch拒否（非偽装）も維持される
  const manifest = await api.status({ cwd: repo.root, control_id: "orphaned-consult-close" });
  assert.equal(manifest.consultations[0].state, "planned");
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: cancelled.revision, consultation_id: "orphan-consult",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "dispatched" },
  }), code("TASK_CANCELLED"));
  // campaign終端判定は取消済みTaskのplanned consultationを孤児として除外する
  assert.equal((await api.campaignStatus({ cwd: repo.root, control_id: "orphaned-consult-close", campaign_id: "orphan-campaign" })).all_terminal, true);
  const releaseDecision = await materializeDocumentEvidence(repo, evidence("docs/orphan-release.md", "decision"));
  const released = await api.releaseCampaign({
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: cancelled.revision,
    campaign_id: "orphan-campaign", decision: releaseDecision, audit_evidence: [],
  });
  const phaseComplete = await advancePhaseGate(repo, "orphaned-consult-close", released.revision);
  // 容量予約の除外: 253まで詰めてもfinalize＋archiveのちょうど2 slotで閉じ切れる
  const padded = structuredClone(phaseComplete.manifest);
  for (let revision = padded.record_revision + 1; revision <= 253; revision++) {
    const previous = padded.transition_receipts.at(-1);
    padded.transition_receipts.push(makeTransitionReceipt({
      revision, actor_id: "parent", operation: "task-record",
      subject: { kind: "task", id: `orphan-close-padding-${revision}` },
      previous_state: null, next_state: "recorded", previous_receipt_digest: previous.receipt_digest,
    }));
  }
  padded.record_revision = 253;
  padded.last_update = { actor_id: "parent", updated_at: padded.transition_receipts.at(-1).recorded_at };
  await writeJson(join(repo.commonDir, "dotagents", "orchestrate", "controls", "orphaned-consult-close", "manifest.json"), padded);
  const finalized = await api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: 253,
    acceptance_matrix_ref: "docs/orphan-close-acceptance.md",
    final_audit_evidence: [evidence("docs/orphan-close-audit.md")],
    regression_evidence: [evidence("docs/orphan-close-regression.md")],
    knowledge_return_refs: ["docs/orphan-close-knowledge.md"],
    parent_decision: evidence("docs/adr/orphan-close-decision.md", "decision"), finalized_by: "parent",
  }));
  assert.equal(finalized.revision, 254);
  assert.equal(finalized.manifest.consultations[0].state, "planned");
  const archived = await api.archive({ cwd: repo.root, control_id: "orphaned-consult-close", actor_id: "parent", expected_revision: finalized.revision });
  assert.equal(archived.manifest.status, "archived");
});

test("未取消Taskのplanned consultationは従来どおりControl finalizationをブロックする", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "planned-still-blocks" });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "planned-still-blocks", actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "planned-still-blocks", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "blocking-task", effect: "read", write_scope: [] }),
  });
  const consultation = await api.consultationRecord({
    cwd: repo.root, control_id: "planned-still-blocks", actor_id: "parent", expected_revision: task.revision,
    consultation: makeConsultation({ consultation_id: "blocking-consult", task_id: "blocking-task", assignment_id: "blocking-assignment" }),
  });
  const phaseComplete = await advancePhaseGate(repo, "planned-still-blocks", consultation.revision);
  await assert.rejects(api.finalizeControl(await materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "planned-still-blocks", actor_id: "parent", expected_revision: phaseComplete.revision,
    acceptance_matrix_ref: "docs/blocking-acceptance.md",
    final_audit_evidence: [evidence("docs/blocking-audit.md")],
    regression_evidence: [evidence("docs/blocking-regression.md")],
    knowledge_return_refs: ["docs/blocking-knowledge.md"],
    parent_decision: evidence("docs/adr/blocking-decision.md", "decision"), finalized_by: "parent",
  })), code("FINALIZATION_NOT_READY"));
});

const makeSelectorDecision = (overrides = {}) => ({
  schema_version: "dotagents.selector-decision.v1",
  selected_quota_pool_id: "openai-sub-main",
  selected_executor: { adapter_id: "codex-native", contract_version: "v1", instance_id: "native-subagent", handle_schema_id: "codex-native.agent-path.v1" },
  evaluated_at: "2026-07-17T00:00:00.000Z",
  reason: "only-eligible",
  pool_evaluations: [{ quota_pool_id: "openai-sub-main", min_pace_bp: 11667, binding_window_id: "5h", eligible: true, exclusion_reason: null }],
  snapshot_evidence: [{ type: "executor-receipt", ref: "quota-snapshot:openai-sub-main:2026-07-17T00:00:00.000Z", digest: "a".repeat(64), observed_at: "2026-07-17T00:00:00.000Z" }],
  reservation: { wall_time_seconds: 3600, cost_microusd: 1000000 },
  ...overrides,
});

test("v27のconsultation-cancelはplannedだけをDecision証拠付きで終端し観測経由の偽装を許さない", async (t) => {
  const { repo, revision: v28Revision } = await consultationTaskRecorded(t, "v27-cancel");
  await downgradeControlToV28(repo, "v27-cancel");
  const v27 = await api.controlMigrate({ cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: v28Revision, target_schema_version: V27 }); const revision = v27.revision;
  const recorded = await api.consultationRecord({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "cancel-me", assignment_id: "cancel-assignment" }),
  });
  // 観測stateにcancelledは存在しない（偽装cancel不可）
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: recorded.revision, consultation_id: "cancel-me",
    observation: { state: "cancelled", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:00:00.000Z", raw_state: "cancelled" },
  }), code("INVALID_SCHEMA"));
  const cancelled = await api.consultationCancel({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: recorded.revision,
    consultation_id: "cancel-me", decision: evidence("docs/adr/cancel-me-decision.md", "decision"),
  });
  const stored = cancelled.manifest.consultations.find((entry) => entry.consultation_id === "cancel-me");
  assert.equal(stored.state, "cancelled");
  assert.equal(stored.executor_observation, null);
  assert.equal(stored.decision_ref, null);
  assert.deepEqual(stored.terminal_evidence, []);
  const receipt = cancelled.manifest.transition_receipts.at(-1);
  assert.equal(receipt.operation, "consultation-cancel");
  assert.deepEqual(receipt.subject, { kind: "consultation", id: "cancel-me" });
  assert.equal(receipt.previous_state, "planned");
  assert.equal(receipt.next_state, "cancelled");
  assert.equal(receipt.evidence[0].ref, "docs/adr/cancel-me-decision.md");
  // cancelledからの観測遷移は不可
  await assert.rejects(api.observeConsultation({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: cancelled.revision, consultation_id: "cancel-me",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:01:00.000Z", raw_state: "dispatched" },
  }), code("INVALID_TRANSITION"));
  // 同一assignmentの再相談はfailed同様に許可される
  const retried = await api.consultationRecord({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: cancelled.revision,
    consultation: makeConsultation({ consultation_id: "retry-after-cancel", assignment_id: "cancel-assignment" }),
  });
  // 非plannedのcancelは不可
  const dispatched = await api.observeConsultation({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: retried.revision, consultation_id: "retry-after-cancel",
    observation: { state: "dispatched", source: "gpt-connector", observed_version: "gpt-5.6", observed_at: "2026-07-17T00:02:00.000Z", raw_state: "dispatched" },
  });
  await assert.rejects(api.consultationCancel({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: dispatched.revision,
    consultation_id: "retry-after-cancel", decision: evidence("docs/adr/late-cancel.md", "decision"),
  }), code("INVALID_TRANSITION"));
  // mutation産cancelledが居る間はv26へrollbackできない
  await assert.rejects(api.controlMigrate({
    cwd: repo.root, control_id: "v27-cancel", actor_id: "parent", expected_revision: dispatched.revision, target_schema_version: V26,
  }), code("ROLLBACK_UNSUPPORTED"));
  // v26 manifestではconsultation-cancel自体がSCHEMA_UPGRADE_REQUIRED
  const legacy = await consultationTaskRecorded(t, "v26-no-cancel");
  await downgradeControlToV26(legacy.repo, "v26-no-cancel");
  const legacyRecorded = await api.consultationRecord({
    cwd: legacy.repo.root, control_id: "v26-no-cancel", actor_id: "parent", expected_revision: legacy.revision,
    consultation: makeConsultation({ consultation_id: "legacy-consult", assignment_id: "legacy-assignment" }),
  });
  await assert.rejects(api.consultationCancel({
    cwd: legacy.repo.root, control_id: "v26-no-cancel", actor_id: "parent", expected_revision: legacyRecorded.revision,
    consultation_id: "legacy-consult", decision: evidence("docs/adr/legacy-cancel.md", "decision"),
  }), code("SCHEMA_UPGRADE_REQUIRED"));
});

test("v27では孤児除外が適用されずconsultation-cancelが明示の脱出経路になる", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "v27-escape");
  const recorded = await api.consultationRecord({
    cwd: repo.root, control_id: "v27-escape", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultation({ consultation_id: "escape-consult", assignment_id: "escape-assignment" }),
  });
  const cancelDecision = await materializeDocumentEvidence(repo, evidence("docs/escape-task-cancel.md", "decision"));
  const taskCancelled = await api.taskCancelRecord({
    cwd: repo.root, control_id: "v27-escape", actor_id: "parent", expected_revision: recorded.revision,
    task_id: "consultation-task", decision: cancelDecision,
  });
  const phaseComplete = await advancePhaseGate(repo, "v27-escape", taskCancelled.revision);
  const finalizeInput = async (revision) => materializeFinalizationInput(repo, {
    cwd: repo.root, control_id: "v27-escape", actor_id: "parent", expected_revision: revision,
    acceptance_matrix_ref: "docs/escape-acceptance.md",
    final_audit_evidence: [evidence("docs/escape-audit.md")],
    regression_evidence: [evidence("docs/escape-regression.md")],
    knowledge_return_refs: ["docs/escape-knowledge.md"],
    parent_decision: evidence("docs/adr/escape-decision.md", "decision"), finalized_by: "parent",
  });
  // v27では孤児plannedがfinalizeをブロックする（除外は適用されない）
  await assert.rejects(api.finalizeControl(await finalizeInput(phaseComplete.revision)), code("FINALIZATION_NOT_READY"));
  const escapeDecision = await materializeDocumentEvidence(repo, evidence("docs/escape-consult-cancel.md", "decision"));
  const escaped = await api.consultationCancel({
    cwd: repo.root, control_id: "v27-escape", actor_id: "parent", expected_revision: phaseComplete.revision,
    consultation_id: "escape-consult", decision: escapeDecision,
  });
  const finalized = await api.finalizeControl(await finalizeInput(escaped.revision));
  assert.equal(finalized.manifest.control_finalization !== null, true);
});

test("migration ladderはv25→v26→v27を一段ずつ進み孤児plannedだけをcancelledへ決定的に変換する", async (t) => {
  const { repo, revision } = await consultationTaskRecorded(t, "ladder-control");
  await downgradeControlToV25(repo, "ladder-control");
  const keep = await api.consultationRecord({
    cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: revision,
    consultation: makeConsultationV25({ consultation_id: "keep-planned", assignment_id: "keep-assignment" }),
  });
  const doomedTask = await api.taskRecord({
    cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: keep.revision,
    task: makeTask({ task_id: "doomed-task", effect: "read", write_scope: [] }),
  });
  const orphan = await api.consultationRecord({
    cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: doomedTask.revision,
    consultation: makeConsultationV25({ consultation_id: "orphan-consult", task_id: "doomed-task", assignment_id: "orphan-assignment" }),
  });
  const doomCancelled = await api.taskCancelRecord({
    cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: orphan.revision,
    task_id: "doomed-task", decision: evidence("docs/doomed-cancel.md", "decision"),
  });
  const toV26 = await api.controlMigrate({ cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: doomCancelled.revision, target_schema_version: V26 });
  assert.equal(toV26.manifest.schema_version, V26);
  assert.equal(toV26.manifest.consultations.every((entry) => entry.state === "planned"), true);
  const toV27 = await api.controlMigrate({ cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: toV26.revision, target_schema_version: V27 });
  assert.equal(toV27.manifest.schema_version, V27);
  const states = Object.fromEntries(toV27.manifest.consultations.map((entry) => [entry.consultation_id, entry.state]));
  assert.deepEqual(states, { "keep-planned": "planned", "orphan-consult": "cancelled" });
  const migrateReceipts = toV27.manifest.transition_receipts.filter((entry) => entry.operation === "control-migrate");
  assert.deepEqual(migrateReceipts.map((entry) => [entry.previous_state, entry.next_state]), [[V25, V26], [V26, V27]]);
  // rollback v27→v26はmigration産cancelledを決定的にplannedへ復元する
  const rolledBack = await api.controlMigrate({ cwd: repo.root, control_id: "ladder-control", actor_id: "parent", expected_revision: toV27.revision, target_schema_version: V26 });
  assert.equal(rolledBack.manifest.schema_version, V26);
  assert.equal(rolledBack.manifest.consultations.find((entry) => entry.consultation_id === "orphan-consult").state, "planned");
});

test("selector_decisionはv27のplacement reservationへoptional keyとして束縛されv26では拒否される", async (t) => {
  const { repo, result } = await initialized(t, { control_id: "selector-placement" });
  await downgradeControlToV28(repo, "selector-placement");
  const v27 = await api.controlMigrate({ cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: result.revision, target_schema_version: V27 });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: v27.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: phaseGate.revision,
    task: makeTask({ task_id: "selector-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const registry = await api.registryObservationRecord({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: task.revision,
    observation: makeRegistryObservation({
      registry_observation_id: "selector-registry", expires_at: "2099-07-14T00:00:00.000Z",
      capacity: {
        admission: { value: "true", evidence: evidence("docs/selector-admission.md") },
        hard_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/selector-hard.md") },
        soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/selector-soft.md") },
        observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/selector-inflight.md") },
      },
    }),
  });
  const selectorCandidate = () => makePlacementCandidate({
    candidate_id: "selector-run", registry_observation_id: "selector-registry",
    assignment_id: "selector-assignment", workspace_cwd: repo.root, executor_handle: null,
    lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "selector-assignment" },
  });
  // ADR 0054 Wave A: selector経由のreservationはquota pool leaseの保持が必須（配線が飾りにならない）
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: registry.revision,
    task_id: "selector-task", candidate: selectorCandidate(), review_decision: null,
    selector_decision: makeSelectorDecision(),
  }), code("QUOTA_POOL_LOCK_REQUIRED"));
  // lease tokenはselector_decisionなしでは意味を持たない
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: registry.revision,
    task_id: "selector-task", candidate: selectorCandidate(), review_decision: null,
    quota_pool_lock_token: "0f0e0d0c-0b0a-4998-8776-655443322110",
  }), code("INVALID_SCHEMA"));
  const poolLock = await api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "openai-sub-main" });
  // 別pool向けのleaseでは選択poolの保持を満たさない
  const otherLock = await api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "anthropic-sub-main" });
  await assert.rejects(api.reservePlacement({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: registry.revision,
    task_id: "selector-task", candidate: selectorCandidate(), review_decision: null,
    selector_decision: makeSelectorDecision(), quota_pool_lock_token: otherLock.token,
  }), code("QUOTA_POOL_LOCK_REQUIRED"));
  const reserved = await api.reservePlacement({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: registry.revision,
    task_id: "selector-task", candidate: selectorCandidate(), review_decision: null,
    selector_decision: makeSelectorDecision(), quota_pool_lock_token: poolLock.token,
  });
  await api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "anthropic-sub-main", token: otherLock.token });
  await api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "openai-sub-main", token: poolLock.token });
  const reservation = reserved.manifest.worker_runs[0].placement_reservation;
  assert.deepEqual(reservation.selector_decision, makeSelectorDecision());
  const receipt = reserved.manifest.transition_receipts.at(-1);
  assert.equal(receipt.operation, "placement-reserve");
  assert.equal(typeof receipt.subject_digest, "string");
  // digest束縛: selector_decisionの改竄は読取で恒久検出される
  const tampered = structuredClone(reserved.manifest);
  tampered.worker_runs[0].placement_reservation.selector_decision = makeSelectorDecision({ reason: "max-headroom" });
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
  // selector_decision付きreservationが居る間はv26へrollbackできない
  await assert.rejects(api.controlMigrate({
    cwd: repo.root, control_id: "selector-placement", actor_id: "parent", expected_revision: reserved.revision, target_schema_version: V26,
  }), code("ROLLBACK_UNSUPPORTED"));
  // selectorを経ないreservationにはkey自体が存在しない
  assert.equal(Object.hasOwn(makePlacementCandidate(), "selector_decision"), false);
  // v26 manifestへのselector_decisionはSCHEMA_UPGRADE_REQUIRED
  const legacy = await initialized(t, { control_id: "selector-legacy" });
  await downgradeControlToV26(legacy.repo, "selector-legacy");
  const legacyPhaseGate = await api.phaseGateRecord({ cwd: legacy.repo.root, control_id: "selector-legacy", actor_id: "parent", expected_revision: legacy.result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const legacyTask = await api.taskRecord({
    cwd: legacy.repo.root, control_id: "selector-legacy", actor_id: "parent", expected_revision: legacyPhaseGate.revision,
    task: makeTask({ task_id: "selector-task", effect: "read", write_scope: [], isolation: "none", required_capabilities: ["report.structured", "workspace.read"] }),
  });
  const legacyRegistry = await api.registryObservationRecord({
    cwd: legacy.repo.root, control_id: "selector-legacy", actor_id: "parent", expected_revision: legacyTask.revision,
    observation: makeRegistryObservation({
      registry_observation_id: "selector-registry", expires_at: "2099-07-14T00:00:00.000Z",
      capacity: {
        admission: { value: "true", evidence: evidence("docs/selector-admission.md") },
        hard_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/selector-hard.md") },
        soft_inflight_limit: { knowledge: "known", value: 1, evidence: evidence("docs/selector-soft.md") },
        observed_inflight: { knowledge: "known", value: 0, evidence: evidence("docs/selector-inflight.md") },
      },
    }),
  });
  await assert.rejects(api.reservePlacement({
    cwd: legacy.repo.root, control_id: "selector-legacy", actor_id: "parent", expected_revision: legacyRegistry.revision,
    task_id: "selector-task",
    candidate: makePlacementCandidate({
      candidate_id: "selector-legacy-run", registry_observation_id: "selector-registry",
      assignment_id: "selector-legacy-assignment", workspace_cwd: legacy.repo.root, executor_handle: null,
      lineage: { ...makePlacementCandidate().lineage, root_assignment_id: "selector-legacy-assignment" },
    }),
    review_decision: null,
    selector_decision: makeSelectorDecision(),
  }), code("SCHEMA_UPGRADE_REQUIRED"));
});

test("quota pool lockはpool単位のleaseとして競合をfail loudにしtoken明示でだけ解放される", async (t) => {
  const { repo } = await initialized(t, { control_id: "pool-lock-lifecycle" });
  const lock = await api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "openai-sub-main" });
  assert.match(lock.token, /^[0-9a-f-]{36}$/);
  // 同一poolの二重acquireはLOCK_CONTENDEDで、保持者のtoken・acquired_atを開示する（協調回収の入口）
  await assert.rejects(api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "openai-sub-main" }), (error) => {
    assert.ok(error instanceof api.ControlRecordError); assert.equal(error.code, "LOCK_CONTENDED");
    assert.equal(error.details.owners.length, 1); assert.equal(error.details.owners[0].token, lock.token);
    return true;
  });
  // 別poolは独立して獲得できる（pool単位の射程）
  const other = await api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "anthropic-sub-main" });
  await api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "anthropic-sub-main", token: other.token });
  // 誤ったtokenでは解放できない
  await assert.rejects(api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "openai-sub-main", token: "00000000-0000-4000-8000-000000000000" }), code("LOCK_NOT_FOUND"));
  await api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "openai-sub-main", token: lock.token });
  // 解放済みleaseの再解放と再取得
  await assert.rejects(api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "openai-sub-main", token: lock.token }), code("LOCK_NOT_FOUND"));
  const again = await api.quotaPoolLockAcquire({ cwd: repo.root, quota_pool_id: "openai-sub-main" });
  await api.quotaPoolLockRelease({ cwd: repo.root, quota_pool_id: "openai-sub-main", token: again.token });
});

// ---- state placement: mode-fidelity probe / external state / project binding ----

async function withStateFidelity(forced, xdgDir, fn) {
  const prevEnv = process.env.NODE_ENV; const prevForce = process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY; const prevXdg = process.env.XDG_STATE_HOME;
  process.env.NODE_ENV = "test";
  if (forced === null) delete process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY; else process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY = forced;
  process.env.XDG_STATE_HOME = xdgDir;
  try { return await fn(); }
  finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevForce === undefined) delete process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY; else process.env.DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY = prevForce;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
  }
}

function externalKeyDirOf(xdgDir, commonDir) {
  return join(xdgDir, "dotagents", "orchestrate", "repos", createHash("sha256").update(commonDir, "utf8").digest("hex"));
}

test("mode非忠実FSではControl stateを外部XDGへ置き、init/status/mutation/resume-checkが同じControlを回収する", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  await withStateFidelity("incapable", xdg, async () => {
    const init = await api.init({ cwd: repo.root, control_id: "drvfs-control", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    assert.equal(init.revision, 0);
    // in-repo側にstateを作っていない
    await assert.rejects(access(join(repo.commonDir, "dotagents")), { code: "ENOENT" });
    // 外部側にbinding(0600)とmanifestがある
    const keyDir = externalKeyDirOf(xdg, repo.commonDir);
    const bindingRaw = JSON.parse(await readFile(join(keyDir, "binding.json"), "utf8"));
    assert.equal(bindingRaw.schema_version, "dotagents.orchestration-state-binding.v1");
    assert.equal(bindingRaw.common_dir_realpath, repo.commonDir);
    const persisted = JSON.parse(await readFile(join(keyDir, "controls", "drvfs-control", "manifest.json"), "utf8"));
    assert.equal(persisted.control_id, "drvfs-control");
    // status / mutation(lock経路) / resume-check が同じControlを回収する
    const status = await api.status({ cwd: repo.root, control_id: "drvfs-control" });
    assert.equal(status.control_id, "drvfs-control");
    const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "drvfs-control", actor_id: "parent", expected_revision: 0, risk: "standard", behavior_lane: "behavior-preserving" });
    const task = await api.taskRecord({ cwd: repo.root, control_id: "drvfs-control", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "drvfs-task" }) });
    assert.equal(task.revision, 2);
    const resume = await api.resumeCheck({ cwd: repo.root, control_id: "drvfs-control" });
    assert.ok(["ready", "review-required", "blocked"].includes(resume.outcome));
  });
});

test("外部stateのbindingが別repoを指す場合、lock書込みの前にfail closedする", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repoA = await createGitRepo(base, "repo-a"); const repoB = await createGitRepo(base, "repo-b");
  const xdg = join(base, "xdg-state");
  await withStateFidelity("incapable", xdg, async () => {
    await api.init({ cwd: repoA.root, control_id: "bind-a", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    // repo Bのkey位置へrepo Aのstate一式を移植（binding改ざん相当）
    const keyA = externalKeyDirOf(xdg, repoA.commonDir); const keyB = externalKeyDirOf(xdg, repoB.commonDir);
    const { cp } = await import("node:fs/promises");
    await cp(keyA, keyB, { recursive: true });
    await assert.rejects(api.status({ cwd: repoB.root, control_id: "bind-a" }), code("STATE_PATH_UNSAFE"));
    await assert.rejects(api.taskRecord({ cwd: repoB.root, control_id: "bind-a", actor_id: "parent", expected_revision: 0, task: makeTask({ task_id: "t" }) }), code("STATE_PATH_UNSAFE"));
    // 書込み(lock-owner)が発生していないこと
    assert.deepEqual(await readdir(join(keyB, "lock-owners")), []);
  });
});

test("capable FS上のin-repo state 0700違反は改ざんとして従来どおりfailする（probeは外部へ逃がさない）", async (t) => {
  if (process.platform === "win32") return;
  const { repo } = await initialized(t, { control_id: "capable-tamper" });
  const root = join(repo.commonDir, "dotagents", "orchestrate");
  await chmod(root, 0o755);
  const xdg = join(dirname(repo.root), "xdg-state");
  await withStateFidelity(null, xdg, async () => {
    await assert.rejects(api.status({ cwd: repo.root, control_id: "capable-tamper" }), code("STATE_PATH_UNSAFE"));
    await assert.rejects(access(join(xdg, "dotagents")), { code: "ENOENT" });
  });
  await chmod(root, 0o700);
});

test("mode非忠実FSで非空のin-repo残骸は黙って無視せず、残骸pathを名指ししてfailする", async (t) => {
  if (process.platform === "win32") return;
  const { repo } = await initialized(t, { control_id: "residue-control" });
  const root = join(repo.commonDir, "dotagents", "orchestrate");
  await chmod(root, 0o755);
  const xdg = join(dirname(repo.root), "xdg-state-residue");
  await withStateFidelity("incapable", xdg, async () => {
    await assert.rejects(api.status({ cwd: repo.root, control_id: "residue-control" }), (error) => {
      assert.ok(error instanceof api.ControlRecordError); assert.equal(error.code, "STATE_PATH_UNSAFE");
      assert.equal(error.details?.residue_path, root);
      assert.ok(error.details?.entries.includes("controls"));
      return true;
    });
  });
  await chmod(root, 0o700);
});

test("mode非忠実FSで空のin-repo残骸は無視して外部stateへ進む", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const root = join(repo.commonDir, "dotagents", "orchestrate");
  await mkdir(join(repo.commonDir, "dotagents"), { mode: 0o755, recursive: true });
  await mkdir(root, { mode: 0o755 });
  const xdg = join(base, "xdg-state");
  await withStateFidelity("incapable", xdg, async () => {
    const init = await api.init({ cwd: repo.root, control_id: "empty-residue", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    assert.equal(init.revision, 0);
    const status = await api.status({ cwd: repo.root, control_id: "empty-residue" });
    assert.equal(status.control_id, "empty-residue");
  });
});

test("in-repoと外部のControl stateが同居したら曖昧として明示failする", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  await withStateFidelity("incapable", xdg, async () => {
    await api.init({ cwd: repo.root, control_id: "dual-control", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  });
  await mkdir(join(repo.commonDir, "dotagents"), { mode: 0o700 });
  await mkdir(join(repo.commonDir, "dotagents", "orchestrate"), { mode: 0o700 });
  await withStateFidelity(null, xdg, async () => {
    await assert.rejects(api.status({ cwd: repo.root, control_id: "dual-control" }), code("STATE_PATH_UNSAFE"));
  });
});

test("capable FSの新規createで外部stateが既存なら、黙ってorphanせずfailする", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  const keyDir = externalKeyDirOf(xdg, repo.commonDir);
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  await withStateFidelity(null, xdg, async () => {
    await assert.rejects(api.init({ cwd: repo.root, control_id: "orphan-guard", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("STATE_PATH_UNSAFE"));
  });
});

test("外部stateのbinding/manifestにも0600 owner検査が効く", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  await withStateFidelity("incapable", xdg, async () => {
    await api.init({ cwd: repo.root, control_id: "ext-mode", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    const keyDir = externalKeyDirOf(xdg, repo.commonDir);
    await chmod(join(keyDir, "binding.json"), 0o644);
    await assert.rejects(api.status({ cwd: repo.root, control_id: "ext-mode" }), code("STATE_PATH_UNSAFE"));
    await chmod(join(keyDir, "binding.json"), 0o600);
    await chmod(join(keyDir, "controls", "ext-mode", "manifest.json"), 0o644);
    await assert.rejects(api.status({ cwd: repo.root, control_id: "ext-mode" }), code("STATE_PATH_UNSAFE"));
  });
});

test("正規CLIがmode非忠実FSで同じ外部Controlをinit/status/resume-checkで回収する", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  const env = { ...process.env, NODE_ENV: "test", DOTAGENTS_ORCHESTRATE_TEST_STATE_FIDELITY: "incapable", XDG_STATE_HOME: xdg };
  const inputDir = join(base, "inputs"); await mkdir(inputDir);
  await writeJson(join(inputDir, "init.json"), { cwd: repo.root, control_id: "cli-ext", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission({ decision: evidence("docs/p.md", "decision") }) });
  const init = spawnOrchestrate(["init", "--input", join(inputDir, "init.json")], { env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(JSON.parse(init.stdout).ok, true);
  await writeJson(join(inputDir, "status.json"), { cwd: repo.root, control_id: "cli-ext" });
  const status = spawnOrchestrate(["status", "--input", join(inputDir, "status.json")], { env });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(JSON.parse(status.stdout).result.control_id, "cli-ext");
  await writeJson(join(inputDir, "resume.json"), { cwd: repo.root, control_id: "cli-ext" });
  const resume = spawnOrchestrate(["resume-check", "--input", join(inputDir, "resume.json")], { env });
  assert.equal(resume.status, 0, resume.stderr || resume.stdout);
  assert.ok(["ready", "review-required", "blocked"].includes(JSON.parse(resume.stdout).result.outcome));
});

test("既存の共有namespace（<XDG>/dotagents が0775）は外部state作成を妨げない。orchestrate層から下は0700を要求する", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  // FOX実測の再現: namespaceが他コンポーネントと同居して0775
  await mkdir(join(xdg, "dotagents", "factory-reporter"), { recursive: true, mode: 0o700 });
  await chmod(join(xdg, "dotagents"), 0o775);
  await withStateFidelity("incapable", xdg, async () => {
    const init = await api.init({ cwd: repo.root, control_id: "ns-shared", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
    assert.equal(init.revision, 0);
    const status = await api.status({ cwd: repo.root, control_id: "ns-shared" });
    assert.equal(status.control_id, "ns-shared");
    // orchestrate層から下は0700
    const { stat: statFn } = await import("node:fs/promises");
    const orch = await statFn(join(xdg, "dotagents", "orchestrate"));
    assert.equal(orch.mode & 0o777, 0o700);
    // orchestrate層の0700違反は、create経路（新規Control）でfail closedする
    // （read経路が祖先を再検査しないのはin-repo配置の従来対称性。keyDir以下の0700は維持される）
    await chmod(join(xdg, "dotagents", "orchestrate"), 0o755);
    await assert.rejects(api.init({ cwd: repo.root, control_id: "ns-shared-2", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("STATE_PATH_UNSAFE"));
    await chmod(join(xdg, "dotagents", "orchestrate"), 0o700);
  });
});

test("共有namespaceがsymlinkならfail closedする", async (t) => {
  if (process.platform === "win32") return;
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const xdg = join(base, "xdg-state");
  await mkdir(join(base, "elsewhere"), { recursive: true, mode: 0o700 });
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  await symlink(join(base, "elsewhere"), join(xdg, "dotagents"));
  await withStateFidelity("incapable", xdg, async () => {
    await assert.rejects(api.init({ cwd: repo.root, control_id: "ns-symlink", objective_ref: "docs/p.md", actor_id: "parent", document_refs: ["docs/p.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() }), code("STATE_PATH_UNSAFE"));
  });
});

// ---- file evidence の resume 履歴保持（ADR 0060） ----

async function retentionControlWithFileEvidence(t, { commit }) {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const ref = "docs/living-evidence.md"; const body = "living evidence v1\n";
  await writeFile(join(repo.root, ref), body);
  if (commit) { runGit(repo.root, ["add", ref]); runGit(repo.root, ["commit", "-q", "-m", "add living evidence"]); }
  const digest = createHash("sha256").update(body).digest("hex");
  const proof = { type: "file", ref, digest, observed_at: "2026-07-14T00:00:00.000Z" };
  const init = await api.init({ cwd: repo.root, control_id: "adr60", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "adr60", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "adr60", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "adr60-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const template = makeWorkerRun();
  await api.workerRunRecord({
    cwd: repo.root, control_id: "adr60", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "adr60-worker", task_id: "adr60-task", assignment_id: "adr60-assignment", write_mode: "none", workspace_cwd: repo.root, workflow_capabilities: template.workflow_capabilities.map((entry) => ({ ...entry, evidence: proof })), execution_verification: { ...template.execution_verification, evidence: { type: "executor-receipt", ref: "connector:test:adr60", digest: "f".repeat(64), observed_at: "2026-07-14T00:00:00.000Z" } }, lineage: { ...template.lineage, root_assignment_id: "adr60-assignment" } }),
  });
  return { repo, ref };
}

test("commit済みfile evidenceは参照先の更新後もretained-historyへ救済され、evidence起因でblockしない", async (t) => {
  const { repo, ref } = await retentionControlWithFileEvidence(t, { commit: true });
  await writeFile(join(repo.root, ref), "living evidence v2\n");
  const result = await api.resumeCheck({ cwd: repo.root, control_id: "adr60" });
  const entry = result.evidence_retention.local.find((e) => e.ref === ref);
  assert.equal(entry.status, "retained-history");
  assert.equal(entry.error_code, "RETAINED_IN_GIT_HISTORY");
  assert.ok(!result.blocking_reasons.some((e) => e.subject_kind === "evidence"));
  // driftは別チャンネル（dirty-state/workspace-content）がreviewとして拾う
  assert.ok(result.review_reasons.some((e) => e.code === "control-dirty-state-changed" || e.code === "control-workspace-content-changed"));
});

test("commit済みfile evidenceのpath消失（archive退避相当）はretained-history＋reviewで、blockedにもreadyにもしない", async (t) => {
  const { repo, ref } = await retentionControlWithFileEvidence(t, { commit: true });
  await rm(join(repo.root, ref));
  const result = await api.resumeCheck({ cwd: repo.root, control_id: "adr60" });
  const entry = result.evidence_retention.local.find((e) => e.ref === ref);
  assert.equal(entry.status, "retained-history");
  assert.equal(entry.observed_digest, null);
  assert.ok(!result.blocking_reasons.some((e) => e.subject_kind === "evidence"));
  assert.ok(result.review_reasons.some((e) => e.code === "evidence-retained-history-missing" && e.subject_id === ref));
});

test("未commitのfile evidenceは修正後も従来どおりfail closed（履歴に無いdigestを救済しない）", async (t) => {
  const { repo, ref } = await retentionControlWithFileEvidence(t, { commit: false });
  await writeFile(join(repo.root, ref), "tampered\n");
  const mismatch = await api.resumeCheck({ cwd: repo.root, control_id: "adr60" });
  assert.equal(mismatch.outcome, "blocked");
  assert.ok(mismatch.blocking_reasons.some((e) => e.code === "evidence-digest-mismatch" && e.subject_id === ref));
  await rm(join(repo.root, ref));
  const missing = await api.resumeCheck({ cwd: repo.root, control_id: "adr60" });
  assert.equal(missing.outcome, "blocked");
  assert.ok(missing.blocking_reasons.some((e) => e.code === "evidence-missing" && e.subject_id === ref));
});

test("同一manifest内でfile型とdecision型のevidenceが同じ更新後drift状況でも対称にretained-historyへ救済される", async (t) => {
  const base = await makeTempDir(); t.after(() => cleanupDir(base));
  const repo = await createGitRepo(base);
  const fileRef = "docs/dual-evidence-file.md"; const fileOldBody = "dual evidence file v1\n"; const fileNewBody = "dual evidence file v2\n";
  const decisionRef = "docs/dual-evidence-decision.md"; const decisionOldBody = "dual evidence decision v1\n"; const decisionNewBody = "dual evidence decision v2\n";
  await writeFile(join(repo.root, fileRef), fileOldBody);
  await writeFile(join(repo.root, decisionRef), decisionOldBody);
  runGit(repo.root, ["add", fileRef, decisionRef]);
  runGit(repo.root, ["commit", "-q", "-m", "add dual evidence refs"]);
  const fileProof = { type: "file", ref: fileRef, digest: createHash("sha256").update(fileOldBody).digest("hex"), observed_at: "2026-07-14T00:00:00.000Z" };
  const decisionProof = { type: "decision", ref: decisionRef, digest: createHash("sha256").update(decisionOldBody).digest("hex"), observed_at: "2026-07-14T00:00:00.000Z" };
  const init = await api.init({ cwd: repo.root, control_id: "adr60-dual", objective_ref: "docs/control-record-plan.md", actor_id: "parent", document_refs: ["docs/control-record-plan.md"], budget: makeBudget(), lane_admission: makeLaneAdmission() });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: "adr60-dual", actor_id: "parent", expected_revision: init.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: "adr60-dual", actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "adr60-dual-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const template = makeWorkerRun();
  const capabilities = template.workflow_capabilities.map((entry, index) => ({ ...entry, evidence: index % 2 === 0 ? fileProof : decisionProof }));
  await api.workerRunRecord({
    cwd: repo.root, control_id: "adr60-dual", actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "adr60-dual-worker", task_id: "adr60-dual-task", assignment_id: "adr60-dual-assignment", write_mode: "none", workspace_cwd: repo.root, workflow_capabilities: capabilities, execution_verification: { ...template.execution_verification, evidence: { type: "executor-receipt", ref: "connector:test:adr60-dual", digest: "f".repeat(64), observed_at: "2026-07-14T00:00:00.000Z" } }, lineage: { ...template.lineage, root_assignment_id: "adr60-dual-assignment" } }),
  });
  await writeFile(join(repo.root, fileRef), fileNewBody);
  await writeFile(join(repo.root, decisionRef), decisionNewBody);
  const result = await api.resumeCheck({ cwd: repo.root, control_id: "adr60-dual" });
  const fileEntry = result.evidence_retention.local.find((e) => e.ref === fileRef);
  const decisionEntry = result.evidence_retention.local.find((e) => e.ref === decisionRef);
  assert.equal(fileEntry.status, "retained-history");
  assert.equal(fileEntry.error_code, "RETAINED_IN_GIT_HISTORY");
  assert.equal(decisionEntry.status, "retained-history");
  assert.equal(decisionEntry.error_code, "RETAINED_IN_GIT_HISTORY");
  assert.ok(!result.blocking_reasons.some((e) => e.subject_kind === "evidence"));
});

// ── external_source binding（v30・ADR 0116）────────────────────────────────

const V30 = "dotagents.orchestration-control.v30";

const makeExternalSource = (overrides = {}) => ({
  namespace: "lattice.todo",
  contract_version: "lattice.todo_status_result.v4",
  external_id: "factory-master/rev-5878b6b9d54eabb5f3309427/fm-0666",
  immutable_digest: "a".repeat(64),
  ...overrides,
});

async function v30PacketFixture(t, controlId) {
  const { repo, result } = await initialized(t, { control_id: controlId });
  const phaseGate = await api.phaseGateRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: result.revision, risk: "standard", behavior_lane: "behavior-preserving" });
  const task = await api.taskRecord({ cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: phaseGate.revision, task: makeTask({ task_id: "v30-task", effect: "read", write_scope: [], required_capabilities: ["report.structured", "workspace.read"] }) });
  const worker = await api.workerRunRecord({
    cwd: repo.root, control_id: controlId, actor_id: "parent", expected_revision: task.revision,
    worker_run: makeWorkerRun({ worker_run_id: "v30-worker", task_id: "v30-task", assignment_id: "v30-assignment", write_mode: "none", workspace_cwd: repo.root, lineage: { ...makeWorkerRun().lineage, root_assignment_id: "v30-assignment" } }),
  });
  return { repo, revision: worker.revision };
}

test("v29→v30 migrationは全taskへnullを刻みadmission digestとpacket digestを1bitも変えない", async (t) => {
  const { repo, revision } = await v30PacketFixture(t, "v30-migration");
  const before = await readPersistedManifest(repo.commonDir, "v30-migration");
  const beforeDigest = before.tasks[0].admission_digest;
  const beforePacket = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "v30-migration", worker_run_id: "v30-worker" });
  const migrated = await api.controlMigrate({ cwd: repo.root, control_id: "v30-migration", actor_id: "parent", expected_revision: revision, target_schema_version: V30 });
  assert.equal(migrated.manifest.schema_version, V30);
  assert.equal(migrated.manifest.tasks[0].external_source, null);
  assert.equal(migrated.manifest.tasks[0].admission_digest, beforeDigest);
  // report importは現manifestからpacketを再計算して照合する＝migration跨ぎで一致しなければ
  // 走行中workerのreportが恒久import不能になる（ADR 0116 Decision 2 / refuter指摘1）
  const afterPacket = await api.delegationPacketForWorker({ cwd: repo.root, control_id: "v30-migration", worker_run_id: "v30-worker" });
  assert.equal(afterPacket.packet_digest, beforePacket.packet_digest);
  assert.deepEqual(await readPersistedManifest(repo.commonDir, "v30-migration"), migrated.manifest);
});

test("v30 task-recordはexternal_source keyを必須としclosed tupleだけを受ける", async (t) => {
  const { repo, revision } = await v30PacketFixture(t, "v30-record");
  const migrated = await api.controlMigrate({ cwd: repo.root, control_id: "v30-record", actor_id: "parent", expected_revision: revision, target_schema_version: V30 });
  // key不在はv30で拒否（v25〜v29の正規形をv30へ持ち込まない）
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "v30-record", actor_id: "parent", expected_revision: migrated.revision, task: makeTask({ task_id: "v30-missing-key", effect: "read", write_scope: [] }) }), code("INVALID_SCHEMA"));
  // null＝direct path。admission digestはkey不在時と等価（正規化）
  const direct = await api.taskRecord({ cwd: repo.root, control_id: "v30-record", actor_id: "parent", expected_revision: migrated.revision, task: makeTask({ task_id: "v30-direct", effect: "read", write_scope: [], external_source: null }) });
  const directStored = direct.manifest.tasks.find((entry) => entry.task_id === "v30-direct");
  assert.equal(directStored.external_source, null);
  const withoutKey = structuredClone(directStored); delete withoutKey.external_source;
  assert.equal(directStored.admission_digest, taskAdmissionDigest(withoutKey));
  // 非null closed tupleは保存されdigestへ入る
  const bound = await api.taskRecord({ cwd: repo.root, control_id: "v30-record", actor_id: "parent", expected_revision: direct.revision, task: makeTask({ task_id: "v30-bound", effect: "read", write_scope: [], external_source: makeExternalSource() }) });
  const boundStored = bound.manifest.tasks.find((entry) => entry.task_id === "v30-bound");
  assert.deepEqual(boundStored.external_source, makeExternalSource());
  assert.notEqual(boundStored.admission_digest, directStored.admission_digest);
  // 余剰キー・自由形式metadata・不正digestは拒否
  const reject = async (external_source) => assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "v30-record", actor_id: "parent", expected_revision: bound.revision, task: makeTask({ task_id: "v30-invalid", effect: "read", write_scope: [], external_source }) }), code("INVALID_SCHEMA"));
  await reject(makeExternalSource({ label: "free-form" }));
  await reject(makeExternalSource({ immutable_digest: "not-a-digest" }));
  await reject(makeExternalSource({ external_id: "/absolute/path" }));
  await reject({ namespace: "lattice.todo" });
  // 保存後のmanifest改竄（非null→null）はdigest不一致で検出される
  const tampered = structuredClone(bound.manifest);
  tampered.tasks.find((entry) => entry.task_id === "v30-bound").external_source = null;
  assert.throws(() => api.validateManifest(tampered), code("INVALID_SCHEMA"));
});

test("v29以下のmanifestへのexternal_source付きtask-recordはSCHEMA_UPGRADE_REQUIREDになる", async (t) => {
  const { repo, revision } = await v30PacketFixture(t, "v30-gate");
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "v30-gate", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "needs-v30", effect: "read", write_scope: [], external_source: null }) }), code("SCHEMA_UPGRADE_REQUIRED"));
  await assert.rejects(api.taskRecord({ cwd: repo.root, control_id: "v30-gate", actor_id: "parent", expected_revision: revision, task: makeTask({ task_id: "needs-v30-bound", effect: "read", write_scope: [], external_source: makeExternalSource() }) }), code("SCHEMA_UPGRADE_REQUIRED"));
});

test("v30→v29 rollbackは全binding nullの時だけ可能で非null bindingが1件でもあれば拒否する", async (t) => {
  const { repo, revision } = await v30PacketFixture(t, "v30-rollback");
  const migrated = await api.controlMigrate({ cwd: repo.root, control_id: "v30-rollback", actor_id: "parent", expected_revision: revision, target_schema_version: V30 });
  const rolledBack = await api.controlMigrate({ cwd: repo.root, control_id: "v30-rollback", actor_id: "parent", expected_revision: migrated.revision, target_schema_version: V29 });
  assert.equal(rolledBack.manifest.schema_version, V29);
  assert.ok(!Object.hasOwn(rolledBack.manifest.tasks[0], "external_source"));
  const remigrated = await api.controlMigrate({ cwd: repo.root, control_id: "v30-rollback", actor_id: "parent", expected_revision: rolledBack.revision, target_schema_version: V30 });
  const bound = await api.taskRecord({ cwd: repo.root, control_id: "v30-rollback", actor_id: "parent", expected_revision: remigrated.revision, task: makeTask({ task_id: "v30-rollback-bound", effect: "read", write_scope: [], external_source: makeExternalSource() }) });
  await assert.rejects(api.controlMigrate({ cwd: repo.root, control_id: "v30-rollback", actor_id: "parent", expected_revision: bound.revision, target_schema_version: V29 }), code("ROLLBACK_UNSUPPORTED"));
});
