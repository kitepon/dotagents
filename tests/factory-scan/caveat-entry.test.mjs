import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCaveatDiagnosticPort } from '../../lib/factory/caveat-entry.mjs';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { scanV9 } from '../../lib/factory/v9.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
function inventory() {
  const entry = { launcher: '/fixture/entry/caveat.mjs', root: '/fixture', package_root: '/fixture/package',
    version: '0.21.2', pointer_sha256: digest('pointer'), manifest_sha256: digest('manifest'),
    entry_sha256: digest('entry'), runtime_sha256: digest('runtime'), consistent: true };
  return { healthy: null, finished_at: '2026-10-25T09:00:00Z', collector_runtime: { executable: '/fixture/node' },
    managed_deployments: [entry], packages: [{ root: entry.package_root, installed_version: '0.21.2',
      managed_entry_verified: true, deployment_revision_candidate: 'managed-installed-sha256:' + digest('deployment') }],
    harnesses: ['claude', 'codex', 'grok', 'cursor'].map((name) => ({ name, caveat_registration_present: true,
      enabled: true, managed_mcp_argument_contract: true, config_consistent: true, package_roots: [entry.package_root],
      caveat_argument_files: [entry.launcher], command_realpath: '/fixture/node', command_basename: 'node',
      config_file: `/fixture/${name}.config`, config_sha256: digest(name) })) };
}
const diagnostic = (version = '0.21.2') => ({ version, overall: { status: 'not_ready' },
  database: { status: 'ready', reason_code: 'ready', schema_version: 3, migration_status: 'current' },
  sync: { status: 'not_ready', reason_code: 'remote_mismatch' } });
const result = (version) => ({ ok: false, code: 1, reason: 'exit', stdout: JSON.stringify(diagnostic(version)), stderr: '' });
function portFor(before, after) {
  let reads = 0;
  const port = createCaveatDiagnosticPort({ collectInventory: async () => {
    reads += 1;
    if (reads === 2 && after instanceof Error) throw after;
    return reads === 1 ? before : after;
  } });
  return { port, reads: () => reads };
}
test('製品collector/selectorのbytesは固定した正本と一致する', async () => {
  for (const [name, hash] of [['read-host.cjs', '7f26036d1397c8b9ddec36650779635bb9e866d1b5b2cd505b9c452c49f91521'],
    ['diagnostic-descriptor.mjs', 'f1eeac96e071e72f36b76bdcc815f0723ecb7df1562cc2a3edb631b400826a1a']]) {
    assert.equal(digest(await readFile(new URL(`../../lib/factory/caveat-product/${name}`, import.meta.url))), hash);
  }
});
test('実行前後のfresh選択と実JSON版を照合し、exit1のresultをそのまま返す', async () => {
  const before = inventory(), after = structuredClone(before), raw = result();
  after.finished_at = '2026-10-25T09:00:01Z'; after.harnesses.reverse();
  const { port, reads } = portFor(before, after), calls = [];
  const observed = await port({ cwd: '/fixture/cwd', runCommand: async (...args) => { calls.push(args); return raw; } });
  assert.strictEqual(observed.result, raw); assert.deepEqual(observed.binding, { status: 'pass' });
  assert.equal(reads(), 2); assert.deepEqual(calls, [['/fixture/node', ['--disable-warning=ExperimentalWarning',
    '/fixture/entry/caveat.mjs', 'factory-diagnostics', '--json', '--require-connector', 'cursor', '--require-connector', 'grok'], { cwd: '/fixture/cwd' }]]);
  assert.equal(port.evidence().diagnostic_sha256, digest(raw.stdout));
  const copy = port.evidence(); copy.before.command = 'changed'; assert.equal(port.evidence().before.command, '/fixture/node');
});
test('通常collector adapterは毎回新しく製品collectorを呼び、設定本文を工場で解釈しない', async () => {
  const port = createCaveatDiagnosticPort({ node: '/fixture/node' }), calls = [];
  const collector = fileURLToPath(new URL('../../lib/factory/caveat-product/read-host.cjs', import.meta.url));
  const observed = await port({ cwd: '/fixture', runCommand: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.length === 1 && args[0] === collector) {
      return { ok: true, stdout: JSON.stringify(inventory()), stderr: '' };
    }
    return result();
  } });
  assert.equal(observed.binding.status, 'pass'); assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.command === '/fixture/node'));
  assert.equal(calls[0].options.maxOutputBytes, 4 * 1024 * 1024);
  assert.equal(calls[2].args[0], calls[0].args[0]);
});
test('pointer/manifest/entry/runtime/config/Node/選択payload差はbindingだけ未確認にして、failを失わない', async () => {
  const mutations = [
    (v) => { v.managed_deployments[0].pointer_sha256 = digest('new-pointer'); },
    (v) => { v.managed_deployments[0].manifest_sha256 = digest('new-manifest'); },
    (v) => { v.managed_deployments[0].entry_sha256 = digest('new-entry'); },
    (v) => { v.managed_deployments[0].runtime_sha256 = digest('new-runtime'); },
    (v) => { v.harnesses[0].config_sha256 = digest('new-config'); },
    (v) => { v.collector_runtime.executable = '/fixture/other/node'; for (const h of v.harnesses) h.command_realpath = v.collector_runtime.executable; },
    (v) => { v.packages[0].deployment_revision_candidate += 'changed'; },
  ];
  for (const mutate of mutations) {
    const before = inventory(), after = structuredClone(before); mutate(after);
    const { port } = portFor(before, after), raw = result();
    const observed = await port({ runCommand: async () => raw });
    assert.strictEqual(observed.result, raw);
    assert.deepEqual(observed.binding, { status: 'unverified', reason_code: 'registered_entry_changed' });
  }
});
test('実行後の読取不能でもrawを保ち、出力0.20.3を希望0.21.2へ置換しない', async () => {
  for (const after of [new Error('private error must not leak'), inventory()]) {
    const { port } = portFor(inventory(), after), raw = result('0.20.3');
    const observed = await port({ runCommand: async () => raw });
    assert.strictEqual(observed.result, raw); assert.equal(observed.binding.status, 'unverified');
    assert.equal(JSON.parse(observed.result.stdout).version, '0.20.3');
    assert.equal(observed.binding.reason_code, after instanceof Error ? 'registered_entry_unavailable' : 'diagnostic_version_mismatch');
    assert.ok(!JSON.stringify(port.evidence()).includes('private error'));
  }
});
test('事前の競合/破損は選択欠測を残し、global/PATHへのfallbackをしない', async () => {
  for (const mutate of [(v) => { v.harnesses[0].command_realpath = '/other/node'; },
    (v) => { v.managed_deployment_errors = [{ diagnostic: 'invalid_json' }]; },
    (v) => { v.harnesses[0].enabled = false; }]) {
    const before = inventory(); mutate(before);
    const { port, reads } = portFor(before, inventory()); let invoked = 0;
    const observed = await port({ runCommand: async () => { invoked += 1; throw Error('unexpected execution'); } });
    assert.equal(invoked, 0); assert.equal(reads(), 1); assert.equal(observed.result, null);
    assert.deepEqual(observed.binding, { status: 'unverified', reason_code: 'registered_entry_unavailable' });
  }
});
test('非JSONとtimeoutの元resultも置換せず、登録判断をportへ持ち込まない', async () => {
  for (const raw of [{ ok: false, reason: 'timeout', stdout: '', stderr: '' },
    { ok: false, code: 1, reason: 'exit', stdout: '{', stderr: 'original-log' }]) {
    const { port } = portFor(inventory(), inventory());
    const observed = await port({ runCommand: async () => raw });
    assert.strictEqual(observed.result, raw); assert.equal(observed.binding.status, 'unverified');
    assert.equal(port.evidence().diagnostic_sha256, digest(raw.stdout));
  }
});
test('v9正規projectionはbinding不成立でも診断fail/重大度/実行版を通常wireへ残す', async () => {
  const { port } = portFor(inventory(), new Error('post-read failed'));
  const calls = [];
  const report = await scanV9({ host: { id: 'fixture', profile: 'linux' }, cwd: '/fixture', home: '/fixture',
    arch: 'x64', platform: 'linux', toolchainLedgerPath: '/fixture/missing-ledger', caveatDiagnosticPort: port,
    runCommand: async (command, args) => {
      calls.push(command);
      if (command === '/fixture/node') return result('0.20.3');
      if (command === 'git') return { ok: true, stdout: 'abc1234\n', stderr: '' };
      return { ok: false, reason: 'spawn', stdout: '', stderr: '', error: { code: 'ENOENT' } };
    } });
  validateReportV9(report);
  assert.ok(!calls.includes('caveat')); assert.equal(report.products.caveat.installed_version, '0.20.3');
  const failure = report.products.caveat.checks.find((c) => c.check_id === 'sync');
  assert.equal(failure.status, 'fail'); assert.equal(failure.severity, 'warn'); assert.equal(failure.reason_code, 'remote_mismatch');
  assert.deepEqual(report.products.caveat.checks.at(-1), { check_id: 'diagnostic_entry_binding', status: 'unverified', reason_code: 'registered_entry_unavailable' });
  assert.deepEqual(report.products.caveat.resolutions, []); assert.deepEqual(report.products.caveat.runtime_errors, []);
  assert.ok(!JSON.stringify(report).includes('/fixture/entry'));
});
