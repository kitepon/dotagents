import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCaveatDiagnosticPort } from '../../lib/factory/caveat-entry.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
function inventory() {
  const entry = { launcher: '/fixture/entry/caveat.mjs', root: '/fixture', package_root: '/fixture/package',
    version: '0.21.2', pointer_sha256: sha('pointer'), manifest_sha256: sha('manifest'),
    entry_sha256: sha('entry'), runtime_sha256: sha('runtime'), consistent: true };
  return { healthy: null, finished_at: '2026-10-25T12:17:00Z', collector_runtime: { executable: '/fixture/node' },
    managed_deployments: [entry], packages: [{ root: entry.package_root, installed_version: '0.21.2',
      managed_entry_verified: true, deployment_revision_candidate: 'managed-installed-sha256:' + sha('deployment') }],
    harnesses: ['claude', 'codex', 'grok', 'cursor'].map((name) => ({ name, caveat_registration_present: true,
      enabled: true, managed_mcp_argument_contract: true, config_consistent: true, package_roots: [entry.package_root],
      caveat_argument_files: [entry.launcher], command_realpath: '/fixture/node', command_basename: 'node',
      config_file: `/fixture/${name}.config`, config_sha256: sha(name) })) };
}
const collector = (value) => ({ ok: true, code: 0, reason: null, stdout: JSON.stringify(value), stderr: '' });
const notReady = { ok: false, code: 1, reason: 'exit', stdout: JSON.stringify({ version: '0.21.2', overall: { status: 'not_ready' } }), stderr: 'original diagnostic log' };

test('collector非0/timeout/spawnをphaseと固定reasonで分け、原ログはhashだけ保存する', async () => {
  for (const raw of [
    { ok: false, code: 37, reason: 'exit', stdout: 'private stdout', stderr: 'private stderr' },
    { ok: false, reason: 'timeout', stdout: '', stderr: '' },
    { ok: false, reason: 'spawn', error: { code: 'ENOENT', message: 'private exception' }, stdout: '', stderr: '' },
  ]) {
    let calls = 0;
    const port = createCaveatDiagnosticPort();
    const value = await port({ runCommand: async () => { calls += 1; return raw; } });
    assert.equal(calls, 1); assert.equal(value.result, null);
    assert.deepEqual(value.binding, { status: 'unverified', reason_code: 'registered_entry_unavailable' });
    const trace = port.evidence().descriptor_reads.before;
    assert.equal(trace.phase, 'collector_execute'); assert.equal(trace.reason_code, 'collector_' + raw.reason);
    assert.equal(trace.collector.exit_code, raw.code ?? null);
    assert.equal(trace.collector.stdout.sha256, sha(raw.stdout));
    assert.equal(trace.collector.stderr.sha256, sha(raw.stderr));
    assert.equal(trace.collector.spawn_code, raw.reason === 'spawn' ? 'ENOENT' : null);
    assert.equal(port.evidence().descriptor_reads.after, null);
    assert.doesNotMatch(JSON.stringify(port.evidence()), /private stdout|private stderr|private exception/u);
  }
});

test('collector成功後のJSON不正をselector拒否と区別する', async () => {
  const port = createCaveatDiagnosticPort();
  await port({ runCommand: async () => ({ ok: true, code: 0, stdout: '{private-invalid-json', stderr: '' }) });
  const trace = port.evidence().descriptor_reads.before;
  assert.equal(trace.phase, 'collector_json'); assert.equal(trace.reason_code, 'collector_json_invalid');
  assert.equal(trace.collector.status, 'success'); assert.equal(trace.collector.exit_code, 0);
  assert.doesNotMatch(JSON.stringify(port.evidence()), /private-invalid-json/u);
});

test('新旧Node不一致はselector固定拒否codeを保持し、診断やPATH代替を実行しない', async () => {
  const original = inventory(); original.collector_runtime.executable = '/fixture/new/node';
  let calls = 0;
  const port = createCaveatDiagnosticPort();
  const observed = await port({ runCommand: async () => { calls += 1; return collector(original); } });
  assert.equal(calls, 1); assert.equal(observed.result, null);
  const trace = port.evidence().descriptor_reads.before;
  assert.equal(trace.phase, 'selector'); assert.equal(trace.reason_code, 'registered_runtime_conflict');
  assert.equal(trace.collector.status, 'success');
  assert.equal(port.evidence().status, 'unconfirmed');
});

test('未知のselector例外は固定generic codeだけにして入力や例外本文を漏らさない', async () => {
  const original = inventory(); original.harnesses = null;
  const port = createCaveatDiagnosticPort();
  await port({ runCommand: async () => collector(original) });
  const trace = port.evidence().descriptor_reads.before;
  assert.equal(trace.phase, 'selector'); assert.equal(trace.reason_code, 'selector_failed');
  assert.equal(trace.collector.status, 'success');
  assert.doesNotMatch(JSON.stringify(port.evidence()), /TypeError|Cannot read/u);
});

test('collector呼出しthrowとinjected inventory throwは別phaseに記録する', async () => {
  const direct = createCaveatDiagnosticPort();
  await direct({ runCommand: async () => { throw Error('private invocation'); } });
  assert.equal(direct.evidence().descriptor_reads.before.reason_code, 'collector_invocation_failed');
  const injected = createCaveatDiagnosticPort({ collectInventory: async () => { throw Error('private inventory'); } });
  await injected({ runCommand: async () => { throw Error('must not execute'); } });
  assert.equal(injected.evidence().descriptor_reads.before.phase, 'inventory_source');
  assert.equal(injected.evidence().descriptor_reads.before.reason_code, 'inventory_source_failed');
  assert.doesNotMatch(JSON.stringify([direct.evidence(), injected.evidence()]), /private invocation|private inventory|must not execute/u);
});

test('後読取のJSON失敗でも先に得たnot_ready/exit1の同一resultを保持する', async () => {
  let calls = 0;
  const port = createCaveatDiagnosticPort();
  const observed = await port({ runCommand: async () => {
    calls += 1;
    return calls === 1 ? collector(inventory()) : calls === 2 ? notReady : { ok: true, code: 0, stdout: '{', stderr: '' };
  } });
  assert.equal(calls, 3); assert.strictEqual(observed.result, notReady);
  assert.equal(observed.binding.status, 'unverified');
  assert.equal(port.evidence().descriptor_reads.before.status, 'ready');
  assert.equal(port.evidence().descriptor_reads.after.phase, 'collector_json');
  assert.equal(port.evidence().descriptor_reads.after.reason_code, 'collector_json_invalid');
  assert.equal(port.evidence().diagnostic_sha256, sha(notReady.stdout));
  assert.equal(port.evidence().output_version, '0.21.2');
});

test('正常読取と元not_readyの対照は2collector/1診断のままboundで保持する', async () => {
  let calls = 0;
  const port = createCaveatDiagnosticPort();
  const observed = await port({ runCommand: async () => { calls += 1; return calls === 2 ? notReady : collector(inventory()); } });
  assert.equal(calls, 3); assert.strictEqual(observed.result, notReady);
  assert.equal(observed.binding.status, 'pass');
  assert.equal(port.evidence().descriptor_reads.before.status, 'ready');
  assert.equal(port.evidence().descriptor_reads.after.status, 'ready');
  assert.equal(port.evidence().status, 'bound');
});
