import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { latticeProduct } from '../../lib/factory/scan.mjs';
import {
  acknowledgeRuntimeErrors,
  acknowledgementBundle,
  collectLatticeRuntimeErrors,
} from '../../lib/factory/runtime-errors.mjs';

const OK_CHECKS = [
  { id: 'package_version', status: 'ok', detail: '0.1.0' },
  { id: 'node_runtime', status: 'ok', detail: 'v26.5.0 satisfies engines.node >=22.13' },
  { id: 'cli_surface', status: 'ok', detail: 'runtime CLI surface loads and exports runRuntimeCli' },
  { id: 'mcp_entry', status: 'ok', detail: 'bin/lattice-mcp.mjs is present' },
  { id: 'sensor_attribution', status: 'ok', detail: 'sensor/LICENSE and sensor/NOTICE are present' },
];

function diagnostics(overrides = {}) {
  return {
    schema: 'lattice.native_factory_diagnostics.v1',
    product: 'lattice',
    version: '0.1.0',
    overall: 'ok',
    checks: OK_CHECKS.map((check) => ({ ...check })),
    ...overrides,
  };
}

const runnerFor = (value, ok = true) => async () => ({ ok, stdout: `${JSON.stringify(value)}\n` });

test('正常diagnosticsをinstalled/compatibleへ投影する', async () => {
  const product = await latticeProduct({ runner: runnerFor(diagnostics()) }, '2026-07-18T00:00:00.000Z');
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '0.1.0');
  assert.equal(product.compatibility_status, 'compatible');
  assert.deepEqual(product.checks, [{ check_id: 'native_diagnostics', status: 'pass' }]);
});

test('overall failed＋非0 exitは固定fingerprintのfail/incompatibleへ落ちる', async () => {
  const failed = diagnostics({ overall: 'failed' });
  failed.checks[0] = { id: 'package_version', status: 'failed', detail: 'package.json version is missing or not semver' };
  const product = await latticeProduct({ runner: runnerFor(failed, false) }, '2026-07-18T00:00:00.000Z');
  assert.equal(product.compatibility_status, 'incompatible');
  assert.equal(product.checks[0].status, 'fail');
  assert.equal(product.checks[0].fingerprint, createHash('sha256').update('lattice:native_not_ready').digest('hex'));
});

test('記録するoverallと終了コードの不整合はunverifiedへ落とす', async () => {
  for (const [value, ok] of [
    [diagnostics(), false],
    [diagnostics({ overall: 'failed' }), true],
  ]) {
    const product = await latticeProduct({ runner: runnerFor(value, ok) });
    assert.equal(product.presence_status, 'unverified');
    assert.deepEqual(product.checks, [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid' }]);
  }
});

test('未使用detailは検査も転記もせず、製品のoverallを使う', async () => {
  for (const leak of [
    '/Users/kite/Developer/Lattice/ is broken',
    'auth failed with Bearer abc123',
    'key sk_live_abcDEF123 rejected',
    'C:\\Users\\kite secret',
    'token ghp_abcDEF123 rejected',
    'pat github_pat_abcDEF123 rejected',
    '-----BEGIN RSA PRIVATE KEY----- leaked',
    'line1\nline2',
  ]) {
    const value = diagnostics();
    value.checks[3] = { id: 'mcp_entry', status: 'ok', detail: leak };
    const product = await latticeProduct({ runner: runnerFor(value) });
    assert.equal(product.presence_status, 'installed');
    assert.equal(product.compatibility_status, 'compatible');
    assert.ok(!JSON.stringify(product).includes('kite'), 'leak文字列がprojectionへ混入した');
  }
});

test('checkの追加・順序・個別結果で製品overallを再集約しない', async () => {
  for (const checks of [[], [...OK_CHECKS].reverse(), [{ id: 'future_check', status: 'failed' }]]) {
    const product = await latticeProduct({ runner: runnerFor(diagnostics({ checks, extra: true })) });
    assert.equal(product.compatibility_status, 'compatible');
  }
});

test('CLI不在（ENOENT）はmissing/cli_unavailableへ落ちる', async () => {
  const runner = async () => ({ ok: false, reason: 'spawn', error: { code: 'ENOENT' }, stdout: '' });
  const product = await latticeProduct({ runner });
  assert.equal(product.presence_status, 'missing');
  assert.deepEqual(product.checks, [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_unavailable' }]);
});

function latticeFingerprint(component, code, template) {
  return createHash('sha256').update(`lattice\0${component}\0${code}\0${template}`).digest('hex');
}

function snapshotValue() {
  return {
    schema: 'lattice.runtime_errors.v1',
    product: 'lattice',
    version: '0.1.0',
    state_schema_version: '1.0',
    cursor: { high_watermark: 2, acknowledged_through: 0, next: 2 },
    runtime_errors: [{
      error_code: 'LATTICE.RUN_STORE_IO_FAILED',
      component: 'run_store',
      status: 'open',
      severity: 'high',
      fingerprint: latticeFingerprint('run_store', 'LATTICE.RUN_STORE_IO_FAILED', 'Lattice run store IO failed'),
      message_template: 'Lattice run store IO failed',
      occurrence_count: 2,
      first_seen: '2026-07-18T00:00:00.000Z',
      last_seen: '2026-07-18T00:01:00.000Z',
      state_schema_version: '1.0',
    }],
    resolutions: [],
    diagnostics: { collection: 'enabled', status: 'ready', total_count: 1, pending_count: 1, truncated: false },
  };
}

test('runtime error snapshotを固定catalog検証つきでready projectionへ写す', async () => {
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(snapshotValue()) });
  assert.equal(projection.product, 'lattice');
  assert.equal(projection.status, 'ready');
  assert.equal(projection.runtime_errors.length, 1);
  assert.equal(projection.runtime_errors[0].error_code, 'LATTICE.RUN_STORE_IO_FAILED');
  assert.deepEqual(projection.acknowledgement, {
    product: 'lattice',
    cursor: 2,
    command: 'lattice',
    args: ['runtime-errors', 'ack', '2', '--json'],
  });
});

test('catalog逸脱（未知code・template改変）はfail closedする', async () => {
  const unknown = snapshotValue();
  unknown.runtime_errors[0].error_code = 'LATTICE.NOT_A_CODE';
  unknown.runtime_errors[0].fingerprint = latticeFingerprint('run_store', 'LATTICE.NOT_A_CODE', 'Lattice run store IO failed');
  await assert.rejects(collectLatticeRuntimeErrors({ runner: runnerFor(unknown) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });

  const tampered = snapshotValue();
  tampered.runtime_errors[0].message_template = 'tampered template';
  tampered.runtime_errors[0].fingerprint = latticeFingerprint('run_store', 'LATTICE.RUN_STORE_IO_FAILED', 'tampered template');
  await assert.rejects(collectLatticeRuntimeErrors({ runner: runnerFor(tampered) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });
});

test('ack round-trip: lattice ack応答（snapshot同型）を検証しcursor不足を拒否する', async () => {
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(snapshotValue()) });
  const bundle = acknowledgementBundle('report-1', [projection.acknowledgement]);

  const acked = snapshotValue();
  acked.cursor.acknowledged_through = 2;
  acked.diagnostics.pending_count = 0;
  await acknowledgeRuntimeErrors(bundle, { runner: runnerFor(acked) });

  // ack応答のacknowledged_throughが要求cursor未満なら拒否する。
  await assert.rejects(
    acknowledgeRuntimeErrors(bundle, { runner: runnerFor(snapshotValue()) }),
    { code: 'E_FACTORY_RUNTIME_ERRORS' },
  );
});

test('collection disabledは空projection（collection_disabled）で返しackを作らない', async () => {
  const disabled = {
    schema: 'lattice.runtime_errors.v1',
    product: 'lattice',
    version: '0.1.0',
    state_schema_version: '1.0',
    cursor: { high_watermark: 0, acknowledged_through: 0, next: 0 },
    runtime_errors: [],
    resolutions: [],
    diagnostics: { collection: 'disabled', status: 'not_applicable', total_count: 0, pending_count: 0, truncated: false },
  };
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(disabled) });
  assert.equal(projection.status, 'collection_disabled');
  assert.deepEqual(projection.runtime_errors, []);
  assert.equal(projection.acknowledgement, null);
});
