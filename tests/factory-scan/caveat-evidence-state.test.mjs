import assert from 'node:assert/strict';
import test from 'node:test';
import { V9_PRODUCT_IDS, scanV9 } from '../../lib/factory/v9.mjs';
import { sha256, prepareBinding, createBindingState, addPrepared, finalizeBinding, recordDelivery } from '../../lib/factory/evidence/report-binding.mjs';
import { LIMITS, createRetentionState, reserveCapacity, settleReservation, planRetention, acknowledgeDeletion } from '../../lib/factory/evidence/retention.mjs';
import { simulateEvidenceCollection, localStatus } from '../../lib/factory/evidence/private-contract.mjs';

const NOW = Date.parse('2026-10-18T07:00:00.000Z');
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = { pid: 40, bootId: 'boot-a', creationId: 'start-a', nonce: 'owner-a' };
const report = () => ({ schema_version: '9.0', report_id: UUID(1), host_id: 'test-host', host_profile: 'linux',
  platform: { os: 'linux', arch: 'x64' }, report_mode: 'full', observed_at: new Date(NOW).toISOString(), created_at: new Date(NOW).toISOString(),
  reporter: { version: '9.0.0', dotagents_revision: 'abc1234' },
  products: Object.fromEntries(V9_PRODUCT_IDS.map((id) => [id, { presence_status: 'installed', installed_version: '0.20.3',
    contract_version: '9.0', checks: ['claude-code', 'codex-cli', 'grok-build'].includes(id)
      ? [{ check_id: 'last_update', status: 'unverified', reason_code: 'post_gate_pending' }] : [], runtime_errors: [], resolutions: [] }])) });
const bytes = (r) => Buffer.from(`${JSON.stringify(r)}\n`);

test('prepared/finalized hash the exact bytes, preserving one immutable collection through last_update only', () => {
  const input = report(); const original = structuredClone(input); const raw = bytes(input);
  const prepared = prepareBinding(raw, UUID(2), NOW);
  assert.equal(prepared.body_sha256, sha256(raw));
  assert.notEqual(prepared.body_sha256, sha256(JSON.stringify(input)));
  const initial = addPrepared(createBindingState(), prepared).state;
  const frozen = structuredClone(initial);
  const changed = structuredClone(input);
  for (const id of ['claude-code', 'codex-cli', 'grok-build']) changed.products[id].checks = [{ check_id: 'last_update', status: 'pass' }];
  const result = finalizeBinding(initial, bytes(changed), NOW + 1);
  assert.equal(result.status, 'finalized');
  assert.equal(result.binding.parent_prepared_sha256, prepared.body_sha256);
  assert.notEqual(result.binding.body_sha256, prepared.body_sha256);
  assert.equal(result.binding.normalized_report_sha256, prepared.normalized_report_sha256);
  assert.deepEqual(initial, frozen); assert.deepEqual(input, original);
  assert.equal(finalizeBinding(result.state, bytes(changed), NOW + 2).status, 'reused');
  assert.equal(finalizeBinding(result.state, raw, NOW + 3).status, 'binding_conflict');
});

test('normal enqueue is bound; missing/ambiguous parent, wrong wire and altered public observations never invent a collection', () => {
  const r = report(); const raw = bytes(r); const p = prepareBinding(raw, UUID(2), NOW);
  const state = addPrepared(createBindingState(), p).state;
  assert.equal(finalizeBinding(state, raw, NOW).status, 'finalized');
  assert.equal(finalizeBinding(createBindingState(), raw, NOW).status, 'finalized_unbound');
  const ambiguous = addPrepared(state, prepareBinding(raw, UUID(3), NOW)).state;
  assert.equal(finalizeBinding(ambiguous, raw, NOW).status, 'binding_conflict');
  for (const mutate of [
    (x) => { x.products.caveat.installed_version = '0.20.4'; },
    (x) => { x.observed_at = new Date(NOW - 1).toISOString(); },
    (x) => { x.products['claude-code'].checks.push({ check_id: 'other', status: 'pass' }); },
    (x) => { x.reporter.version = '9.0.1'; },
  ]) { const x = structuredClone(r); mutate(x); assert.equal(finalizeBinding(state, bytes(x), NOW).status, 'binding_conflict'); }
  const old = structuredClone(r); old.schema_version = '8.0';
  assert.equal(finalizeBinding(state, bytes(old), NOW).status, 'unverified');
  assert.equal(finalizeBinding(state, Buffer.from('{'), NOW).status, 'unverified');
  assert.equal(addPrepared(state, { ...p, body_sha256: 'a'.repeat(64) }).status, 'binding_conflict');
});

test('delivery is a separate per-report phase; unrelated bytes/aggregate results cannot be accepted', () => {
  const raw = bytes(report());
  const s = finalizeBinding(addPrepared(createBindingState(), prepareBinding(raw, UUID(2), NOW)).state, raw, NOW).state;
  const event = { eventId: UUID(4), reportId: UUID(1), bodySha256: sha256(raw), outcome: 'accepted', now: NOW };
  const accepted = recordDelivery(s, event);
  assert.equal(accepted.status, 'delivery_recorded'); assert.equal(s.deliveries.length, 0);
  assert.equal(recordDelivery(accepted.state, event).status, 'reused');
  assert.equal(recordDelivery(accepted.state, { ...event, outcome: 'rejected' }).status, 'binding_conflict');
  assert.equal(recordDelivery(s, { ...event, bodySha256: 'a'.repeat(64) }).status, 'delivery_unbound');
  assert.equal(recordDelivery(s, { ...event, outcome: 'sent1' }).status, 'unverified');
});

const reserve = (state, id, extra = {}) => reserveCapacity(state, { id: UUID(id), owner, now: NOW,
  lockVerified: true, inventoryVerified: true, ...extra });

test('capacity reserves maxima without waiting; temp/management bytes and concurrency are charged', () => {
  let s = createRetentionState();
  for (let i = 1; i <= 4; i++) { const r = reserve(s, i); assert.equal(r.status, 'reserved'); s = r.state; }
  assert.equal(reserve(s, 5).status, 'capacity_exceeded');
  assert.equal(reserve(s, 1).status, 'binding_conflict');
  assert.equal(reserve({ ...createRetentionState(), managedBytes: LIMITS.bytes - LIMITS.runBytes + 1 }, 1).status, 'capacity_exceeded');
  assert.equal(reserve(createRetentionState(), 1, { lockVerified: false }).status, 'storage_unavailable');
  assert.equal(reserve(createRetentionState(), 1, { inventoryVerified: false }).status, 'storage_unavailable');
  assert.equal(reserve({ ...createRetentionState(), managedBytes: -1 }, 1).status, 'storage_unavailable');
  assert.equal(settleReservation(s, { id: UUID(1), owner: { ...owner, creationId: 'reused-pid' }, bytes: 10, now: NOW }).status, 'unverified');
  assert.equal(settleReservation(s, { id: UUID(1), owner, bytes: LIMITS.runBytes + 1, now: NOW }).status, 'capacity_exceeded');
});

test('live/unknown/reused PID collections are retained; tombstones stay charged across cleanup interruption', () => {
  const reserved = reserve(createRetentionState(), 1).state;
  const s = settleReservation(reserved, { id: UUID(1), owner, bytes: 100, now: NOW, complete: false }).state;
  const future = NOW + 8 * 86400000;
  const plan = (observation) => planRetention(s, { now: future, lockVerified: true, inventoryVerified: true,
    observations: observation ? { [UUID(1)]: observation } : {} });
  const observed = { owner, ownershipVerified: true, identityVerified: true, alive: false };
  for (const seen of [undefined, { ...observed, alive: true }, { ...observed, alive: null },
    { ...observed, owner: { ...owner, creationId: 'new-process' } }, { ...observed, ownershipVerified: false }]) assert.deepEqual(plan(seen).tombstones, []);
  const cleanup = plan(observed); assert.deepEqual(cleanup.tombstones, [UUID(1)]);
  assert.equal(cleanup.state.records[0].bytes, 100); assert.equal(cleanup.state.records[0].phase, 'tombstone');
  assert.equal(s.records[0].phase, 'partial');
  assert.equal(acknowledgeDeletion(cleanup.state, { id: UUID(1), owner, deletionVerified: false }).status, 'unverified');
  const resumed = planRetention(cleanup.state, { now: future, lockVerified: true, inventoryVerified: true, observations: { [UUID(1)]: observed } });
  assert.deepEqual(resumed.tombstones, [UUID(1)]);
  assert.equal(acknowledgeDeletion(resumed.state, { id: UUID(1), owner, deletionVerified: true }).state.records.length, 0);
});

test('root capacity is not released by planning deletion; only the oldest verified completion is selected', () => {
  let s = createRetentionState();
  for (let id = 1; id <= 128; id++) {
    s = reserve(s, id).state;
    s = settleReservation(s, { id: UUID(id), owner, bytes: LIMITS.runBytes, now: NOW, complete: true }).state;
  }
  assert.equal(reserve(s, 129).status, 'capacity_exceeded');
  const observations = Object.fromEntries(s.records.map((r) => [r.id, { owner, ownershipVerified: true, identityVerified: true, alive: false }]));
  const plan = planRetention(s, { now: NOW + 1, lockVerified: true, inventoryVerified: true, observations, requiredBytes: LIMITS.runBytes });
  assert.deepEqual(plan.tombstones, [UUID(1)]);
  assert.equal(reserve(plan.state, 129).status, 'capacity_exceeded');
  const removed = acknowledgeDeletion(plan.state, { id: UUID(1), owner, deletionVerified: true }).state;
  assert.equal(reserve(removed, 129).status, 'reserved');
});

test('malformed retention inventory is refused without mutation or deletion', () => {
  for (const s of [{ ...createRetentionState(), records: [null] },
    { ...createRetentionState(), managedBytes: Number.NaN },
    { ...createRetentionState(), records: [{ id: UUID(1), owner, bytes: 1, startedAt: NOW, phase: 'unknown' }] }]) {
    const before = structuredClone(s);
    assert.equal(reserve(s, 2).status, 'storage_unavailable');
    assert.deepEqual(planRetention(s, { now: NOW, lockVerified: true, inventoryVerified: true, observations: {} }).tombstones, []);
    assert.deepEqual(s, before);
  }
});

test('orphaned reservation cleanup requires verified dead identity and retains the full charge until acknowledgement', () => {
  const s = reserve(createRetentionState(), 1).state;
  const observed = { owner, ownershipVerified: true, identityVerified: true, alive: false };
  const plan = (now, observation = observed) => planRetention(s, { now, lockVerified: true, inventoryVerified: true,
    observations: { [UUID(1)]: observation } });
  assert.deepEqual(plan(NOW + 23 * 3600000).tombstones, []);
  assert.deepEqual(plan(NOW + 25 * 3600000, { ...observed, alive: true }).tombstones, []);
  assert.deepEqual(plan(NOW + 25 * 3600000, { ...observed, ownershipVerified: 'true' }).tombstones, []);
  const result = plan(NOW + 25 * 3600000);
  assert.deepEqual(result.tombstones, [UUID(1)]);
  assert.equal(result.state.reservations.length, 0);
  assert.equal(result.state.records[0].bytes, LIMITS.runBytes);
  assert.equal(s.reservations.length, 1);
  assert.equal(acknowledgeDeletion(result.state, { id: UUID(1), owner, deletionVerified: 'true' }).status, 'unverified');
  assert.equal(acknowledgeDeletion(result.state, { id: UUID(1), owner, deletionVerified: true }).state.records.length, 0);
  assert.equal(reserve(createRetentionState(), 2, { lockVerified: 'true' }).status, 'storage_unavailable');
  const partial = settleReservation(s, { id: UUID(1), owner, bytes: 10, now: NOW, complete: 'true' });
  assert.equal(partial.status, 'partial');
});

test('OFF invokes only the normal operation, retaining public check/exit/delivery bytes and identity', async () => {
  const normal = Object.freeze({ check: { status: 'fail', reason_code: 'remote_mismatch' }, code: 1,
    body: Buffer.from('public bytes\n'), delivery: 'deferred' });
  let calls = 0;
  const options = { runNormal: async () => { calls++; return normal; } };
  for (const key of ['evaluate', 'osSnapshot', 'workerSnapshot', 'schemas', 'capture', 'privateChannel']) Object.defineProperty(options, key, { get() { throw new Error('OFF accessed auxiliary work'); } });
  assert.equal(await simulateEvidenceCollection(options), normal); assert.equal(calls, 1);
  assert.ok(!('evidence_save_status' in normal));
});

test('existing v9 scan with a fake runner retains its Caveat failure and serialized bytes across the OFF seam', async () => {
  const calls = [];
  const normalOperation = async () => {
    const publicReport = await scanV9({ host: { id: 'test-host', profile: 'linux' }, platform: 'linux', arch: 'x64',
      cwd: process.env.HOME, home: process.env.HOME, toolchainLedgerPath: `${process.env.HOME}/absent-ledger.json`,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === 'git') return { ok: true, code: 0, stdout: args.includes('--short=7') ? 'abc1234\n' : 'a'.repeat(40) + '\n', stderr: '' };
        if (command === 'caveat') return { ok: false, code: 1, reason: 'exit', stderr: '', stdout: JSON.stringify({
          schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '0.20.3', overall: { status: 'not_ready' },
          database: { status: 'ready', reason_code: 'ready', schema_version: 3, migration_status: 'current' },
          sync: { status: 'not_ready', reason_code: 'remote_mismatch' },
        }) };
        return { ok: false, reason: 'spawn', stdout: '', stderr: '', error: { code: 'ENOENT' } };
      } });
    return { publicReport, code: 1, delivery: 'not_requested', body: Buffer.from(JSON.stringify(publicReport, null, 2) + '\n') };
  };
  const options = { enabled: false, runNormal: normalOperation };
  Object.defineProperty(options, 'evaluate', { get() { throw new Error('OFF preparation'); } });
  const result = await simulateEvidenceCollection(options);
  const check = result.publicReport.products.caveat.checks.find((c) => c.check_id === 'sync');
  assert.equal(check.status, 'fail'); assert.equal(check.reason_code, 'remote_mismatch'); assert.equal(check.severity, 'warn');
  assert.equal(check.message_template, 'Caveat同期診断で共有先HEADと端末HEADの不一致を検出。同期操作の成否・原因・実害は未確認。');
  assert.equal(calls.filter((c) => c.command === 'caveat').length, 1);
  assert.equal(calls.filter((c) => c.args.some((a) => ['sync', 'report', 'runtime-errors'].includes(a))).length, 0);
  const snapshot = Buffer.from(result.body);
  const bound = prepareBinding(result.body, UUID(9), NOW);
  assert.equal(bound.body_sha256, sha256(snapshot)); assert.deepEqual(result.body, snapshot);
  const refused = await simulateEvidenceCollection({ enabled: true, runNormal: async () => result,
    osSnapshot: { safe: false } });
  assert.equal(refused.publicResult, result); assert.equal(result.code, 1); assert.equal(result.delivery, 'not_requested');
  assert.deepEqual(result.body, snapshot);
});

test('fake worker/OS refusal and private failures cannot change public results or leak private input', async () => {
  const secret = 'private-canary-SID-nonce-HEAD';
  for (const [osSnapshot, workerSnapshot, evaluate, expected] of [
    [{ safe: false }, null, null, 'storage_denied'],
    [{ safe: true }, { ready: false }, null, 'storage_unavailable'],
    [{ safe: true }, { ready: true, capacityAvailable: false }, null, 'capacity_exceeded'],
    [{ safe: true }, { ready: true, capacityAvailable: true }, () => { throw new Error(secret); }, 'unverified'],
    [{ safe: true }, { ready: true, capacityAvailable: true }, () => ({ ok: false, status: 'not_supported', reason: secret }), 'not_supported'],
    [{ safe: true }, { ready: true, capacityAvailable: true }, () => ({ ok: true }), 'pending'],
  ]) {
    const normal = { check: { status: 'pass' }, code: 0, delivery: 'accepted', body: Buffer.from('original\n') };
    const snapshot = { ...structuredClone(normal), body: Buffer.from(normal.body) }; let calls = 0;
    const result = await simulateEvidenceCollection({ enabled: true, runNormal: async () => { calls++; return normal; }, osSnapshot, workerSnapshot, evaluate });
    assert.equal(calls, 1); assert.equal(result.publicResult, normal); assert.deepEqual(normal, snapshot);
    assert.deepEqual(result.local, { evidence_save_status: expected });
    assert.ok(!JSON.stringify(result.local).includes(secret));
  }
  assert.deepEqual(localStatus(secret), { evidence_save_status: 'unverified' });
  const failure = new Error('normal operation failed');
  await assert.rejects(simulateEvidenceCollection({ enabled: true, runNormal: () => { throw failure; } }), (error) => error === failure);
});
