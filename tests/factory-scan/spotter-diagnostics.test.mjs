import assert from 'node:assert/strict';
import test from 'node:test';
import { spotterDiagnostic } from '../../lib/factory/v5.mjs';

const diagnostic = () => ({
  schema_version: '1.1', product: 'spotter', version: '1.6.4',
  overall_status: 'unverified', compatibility_status: 'compatible', marker_schema_version: '2',
  throughline_context: 'throughline', catalogs: { claude: 'available', codex: 'available' },
  codex_hook_readiness: 'configured-unverified',
  runtime_error_store: { schema: 'spotter.runtime_error_status.v1', collection: 'enabled', store: 'absent', records: 0, open: 0, resolved: 0, unacknowledged: 0, latest_sequence: 0, acknowledged_through: 0 },
  checks: [{ check_id: 'codex_hooks', status: 'unverified', reason_code: 'trust_not_machine_verifiable' }],
});
const exited = (code) => ({ ok: code === 0, code, reason: code === 0 ? null : 'exit' });

test('Spotter公開1.1の互換判定を使い、詳細診断を再集約しない', () => {
  for (const [compatibility_status, code, overall] of [
    ['compatible', 0, 'ready'], ['not_applicable', 0, 'not_applicable'],
    ['incompatible', 1, 'not_ready'], ['indeterminate', 1, 'unverified'],
  ]) {
    const value = { ...diagnostic(), compatibility_status };
    const result = spotterDiagnostic(value, exited(code));
    assert.equal(result.overall, overall);
    assert.equal(result.version, '1.6.4');
    assert.equal(result.components, null);
  }
  const detailFailure = diagnostic();
  detailFailure.overall_status = 'fail';
  detailFailure.checks = [{ check_id: 'optional_context', status: 'fail', reason_code: 'context_unavailable' }];
  assert.equal(spotterDiagnostic(detailFailure, exited(0)).overall, 'ready');
});

test('Spotter公開1.1の終了コード不一致と輸送失敗を拒否する', () => {
  for (const [compatibility_status, code] of [['compatible', 1], ['incompatible', 0], ['indeterminate', 2], ['not_applicable', 1]]) {
    assert.throws(() => spotterDiagnostic({ ...diagnostic(), compatibility_status }, exited(code)), /native_exit_mismatch/);
  }
  assert.throws(() => spotterDiagnostic(diagnostic(), { ok: false, reason: 'timeout' }), /native_exit_mismatch/);
});

test('記録する判定とversionだけを読み、使わない製品情報を検査・転送しない', () => {
  const expanded = { ...diagnostic(), schema_version: '2.0', catalogs: { future: 'available' }, extra: '/Users/example/private' };
  assert.deepEqual(spotterDiagnostic(expanded, exited(0)), { overall: 'ready', version: '1.6.4', components: null });
  assert.equal(spotterDiagnostic({ version: '1.6.4', compatibility_status: 'compatible' }, exited(0)).overall, 'ready');
  for (const patch of [{ version: '/Users/example/private' }, { compatibility_status: 'ready' }, { compatibility_status: null }]) {
    assert.throws(() => spotterDiagnostic({ ...diagnostic(), ...patch }, exited(0)), /native_diagnostics_schema/);
  }
  const missing = diagnostic();
  delete missing.compatibility_status;
  assert.throws(() => spotterDiagnostic(missing, exited(0)), /native_diagnostics_schema/);
});
