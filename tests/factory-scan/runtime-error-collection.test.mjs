import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { scanV9 } from '../../lib/factory/v9.mjs';

const EXITED = Object.freeze({ ok: false, code: 1, reason: 'exit', stdout: '', stderr: '' });
const ok = (value) => ({ ok: true, code: 0, reason: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const PROFILE = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'linux';

const snapshot = (product, schema, collection) => ({
  schema, product, version: '1.2.3', state_schema_version: '1.0',
  cursor: { high_watermark: 0, acknowledged_through: 0, next: 0 },
  runtime_errors: [], resolutions: [],
  diagnostics: {
    collection, status: collection === 'enabled' ? 'ready' : 'not_applicable', total_count: 0, pending_count: 0, truncated: false,
  },
});

// 製品の診断は ready。変えるのは実行時エラーのsnapshotが答える収集状態だけ。
function runner({ lattice, gpt }) {
  return async (command, args) => {
    if (command === 'git') return ok('abc1234\n');
    if (command === 'lattice' && args[0] === 'factory-diagnostics') return ok({ version: '1.2.3', overall: 'ok' });
    if (command === 'lattice' && args[0] === 'runtime-errors') return lattice === null ? EXITED : ok(snapshot('lattice', 'lattice.runtime_errors.v1', lattice));
    if (command === 'gpt-connector' && args[0] === 'factory-diagnostics') {
      return ok({ package_version: '1.2.3', overall: 'ready', state: { schema: 'state.v1', migration: 'current' }, checks: [] });
    }
    if (command === 'gpt-connector' && args[0] === 'runtime-errors') return gpt === null ? EXITED : ok(snapshot('gpt-connector', 'gpt-connector.runtime-errors.v1', gpt));
    return EXITED;
  };
}

async function scan(t, states, collectionEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'factory-collection-check-'));
  const home = join(root, 'home');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await scanV9({
    host: { id: 'test-host', profile: PROFILE }, cwd: root, arch: 'x64', platform: process.platform, home,
    collectionEnabled, toolchainLedgerPath: join(root, 'toolchain-ledger.json'), runCommand: runner(states),
  });
  validateReportV9(report);
  return report.products;
}

const collectionCheck = (product) => product.checks.find((item) => item.check_id === 'runtime_error_collection');

test('工場が収集を有効にしているのに製品が無効と答えたら、failで残す', async (t) => {
  const products = await scan(t, { lattice: 'disabled', gpt: 'disabled' });
  for (const id of ['lattice', 'gpt-connector']) {
    const item = collectionCheck(products[id]);
    assert.equal(item.status, 'fail', id);
    assert.equal(item.reason_code, 'collection_disabled', id);
    assert.equal(item.severity, 'warn', id);
    assert.equal(products[id].compatibility_status, 'incompatible', id);
    assert.deepEqual(products[id].runtime_errors, [], id);
  }
  assert.notEqual(collectionCheck(products.lattice).fingerprint, collectionCheck(products['gpt-connector']).fingerprint);
});

test('収集が有効で実行時エラーを読めた製品は、passで残す', async (t) => {
  const products = await scan(t, { lattice: 'enabled', gpt: 'enabled' });
  for (const id of ['lattice', 'gpt-connector']) {
    assert.deepEqual(collectionCheck(products[id]), { check_id: 'runtime_error_collection', status: 'pass' }, id);
    assert.equal(products[id].compatibility_status, 'compatible', id);
  }
});

test('実行時エラーを読めなかった製品には、収集のcheckを出さない', async (t) => {
  const products = await scan(t, { lattice: 'enabled', gpt: null });
  assert.equal(collectionCheck(products['gpt-connector']), undefined);
  assert.deepEqual(products['gpt-connector'].checks.find((item) => item.check_id === 'runtime_errors'),
    { check_id: 'runtime_errors', status: 'unverified', reason_code: 'runtime_snapshot_unavailable' });
});

test('工場の設定で収集が無効な端末では、収集のcheckを出さない', async (t) => {
  const products = await scan(t, { lattice: 'disabled', gpt: 'disabled' }, false);
  for (const id of ['lattice', 'gpt-connector']) assert.equal(collectionCheck(products[id]), undefined, id);
});
