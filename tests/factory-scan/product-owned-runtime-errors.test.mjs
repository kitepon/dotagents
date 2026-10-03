import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { scanV9WithAcknowledgements } from '../../lib/factory/v9.mjs';

// 実行時エラーを上げるのは各製品の責務。工場のscanは、製品の記録を読みに行かない。
const EXITED = Object.freeze({ ok: false, code: 1, reason: 'exit', stdout: '', stderr: '' });
const ok = (value) => ({ ok: true, code: 0, reason: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const READINESS_IDS = ['database', 'schema', 'pull_poll', 'factory_ingest', 'factory_delivery', 'source_revision'];

// serverはLinuxだけの種類なので、試験を走らせるOSに関わらずlinuxとして組み立てる。
async function scan(t, profile, respond, platform = process.platform) {
  const root = await mkdtemp(join(tmpdir(), 'factory-product-owned-'));
  const home = join(root, 'home');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await scanV9WithAcknowledgements({
    host: { id: 'test-host', profile }, cwd: root, arch: 'x64', platform, home,
    collectionEnabled: true, toolchainLedgerPath: join(root, 'toolchain-ledger.json'),
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'git') return ok('abc1234\n');
      return respond(command, args) ?? EXITED;
    },
  });
  validateReportV9(result.report);
  return { ...result, calls };
}

test('工場のscanはlatticeの実行時エラーを読まず、ackも作らない', async (t) => {
  const profile = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'linux';
  const { report, acknowledgements, calls } = await scan(t, profile, (command, args) => {
    if (command !== 'lattice') return null;
    if (args[0] === 'factory-diagnostics') return ok({ version: '1.2.3', overall: 'ok' });
    // 製品が自分でBugHubへ上げている記録。工場が読みに行けば、ここで見つかる。
    return ok({ schema: 'lattice.runtime_errors.v1', product: 'lattice', version: '1.2.3', state_schema_version: '1.0',
      cursor: { high_watermark: 3, acknowledged_through: 0, next: 3 }, runtime_errors: [], resolutions: [],
      diagnostics: { collection: 'enabled', status: 'ready', total_count: 3, pending_count: 0, truncated: false } });
  });
  assert.deepEqual(calls.filter((line) => line.startsWith('lattice ')), ['lattice factory-diagnostics --json']);
  const product = report.products.lattice;
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '1.2.3');
  assert.deepEqual(product.runtime_errors, []);
  assert.deepEqual(product.resolutions, []);
  assert.equal(acknowledgements.report_id, report.report_id);
  assert.deepEqual(acknowledgements.acknowledgements, []);
});

test('工場のscanはServerManagerの外部eventを読まず、readinessのcheckだけを運ぶ', async (t) => {
  const { report, acknowledgements, calls } = await scan(t, 'server', (command) => {
    if (command !== 'bughub-external-probe') return null;
    return ok({
      schema_version: 'dotagents.bughub-external-probe.v1', product_version: '0.1.0', source_revision: REVISION,
      status: 'ready', reason_code: 'ready',
      checks: READINESS_IDS.map((id) => ({ id, status: 'pass', reason_code: id === 'source_revision' ? 'revision_match' : 'ready' })),
    });
  }, 'linux');
  assert.deepEqual(calls.filter((line) => line.startsWith('factory-external-event')), []);
  const product = report.products.servermanager;
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '0.1.0');
  assert.equal(product.compatibility_status, 'compatible');
  assert.deepEqual(product.checks.map((check) => [check.check_id, check.status]), READINESS_IDS.map((id) => [`readiness_${id}`, 'pass']));
  // checkの解消は、同じcheckがpassと届くことで決まる。全fingerprintへのresolutionsは載せない。
  assert.deepEqual(product.runtime_errors, []);
  assert.deepEqual(product.resolutions, []);
  assert.deepEqual(acknowledgements.acknowledgements, []);
});

test('readinessのcheckが落ちた時は、checkとして運び、実行時エラーの欄は使わない', async (t) => {
  const { report } = await scan(t, 'server', (command) => {
    if (command !== 'bughub-external-probe') return null;
    return { ok: false, code: 1, reason: 'exit', stderr: '', stdout: JSON.stringify({
      schema_version: 'dotagents.bughub-external-probe.v1', product_version: '0.1.0', source_revision: REVISION,
      status: 'not_ready', reason_code: 'readiness_failed',
      checks: READINESS_IDS.map((id) => (id === 'pull_poll'
        ? { id, status: 'fail', reason_code: 'source_failed' }
        : { id, status: 'pass', reason_code: id === 'source_revision' ? 'revision_match' : 'ready' })),
    }) };
  }, 'linux');
  const product = report.products.servermanager;
  assert.equal(product.compatibility_status, 'incompatible');
  const failed = product.checks.filter((check) => check.status === 'fail');
  assert.deepEqual(failed.map((check) => [check.check_id, check.reason_code]), [['readiness_pull_poll', 'source_failed']]);
  assert.match(failed[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(product.runtime_errors, []);
  assert.deepEqual(product.resolutions, []);
});
