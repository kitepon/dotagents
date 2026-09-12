import assert from 'node:assert/strict';
import test from 'node:test';
import { aitermDiagnostic, sidecarDiagnostic, spotterDiagnostic, throughlineDiagnostic, projectGptConnectorFactory } from '../../lib/factory/v5.mjs';

const ready = () => ({ status: 'ready', reason: 'ready' });

test('Aitermとsidecarの内部状態で製品のoverallを再判定しない', () => {
  const aiterm = aitermDiagnostic({ version: '1.2.3', overall: 'ready',
    mcp: { tool_call: 'ready' }, pty_list: { status: 'unverified', session_count: -1 },
    runtime_error_store: { status: 'not_applicable', collection: 'future_state' } });
  assert.equal(aiterm.overall, 'ready');
  assert.equal(aiterm.components.find((item) => item.id === 'pty_list').status, 'unverified');
  const sidecar = sidecarDiagnostic({ factoryReadiness: { overall: 'ready',
    packageVersions: { packages: { cli: '1.2.3', core: '1.2.4', mcp: '1.2.5' } },
    presets: { status: 'not_ready' }, modelPolicy: { source: 'future_policy' } } });
  assert.deepEqual(sidecar, { overall: 'ready', version: '1.2.3' });
});

test('gpt-connectorの診断項目追加を許し、製品が返した失敗を記録する', () => {
  const diagnostic = { package_version: '1.2.3', overall: 'ready', state: { schema: '2', migration: 'current' },
    checks: [{ id: 'future_check', status: 'not_ready', reason: 'future_failure' }], extra: '/private/path' };
  const projected = projectGptConnectorFactory(diagnostic, null, true, '2026-09-12T00:00:00.000Z');
  assert.equal(projected.compatibility_status, 'compatible');
  assert.equal(projected.checks[0].status, 'fail');
  assert.ok(!JSON.stringify(projected).includes('/private/path'));
});
const throughline = () => ({
  schema: 'throughline.native_factory_diagnostics.v1', version: '1.2.3', overall: { status: 'ready' },
  databaseSchema: { schema: 'throughline.database.v10', status: 'ready', databaseSchemaVersion: 10, supportedDatabaseSchemaVersion: 10, reason: 'ready' },
  hooks: { scope: 'codex', status: 'ready', reason: 'ready', events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' } },
  readiness: { capture: ready(), restore: ready(), handoff: ready() },
  evidence: { restoreSmoke: ready() }, connectors: { claude: ready(), codex: ready() },
});
const spotter = () => ({
  schema_version: '1.1', product: 'spotter', version: '1.2.3', compatibility_status: 'compatible', overall_status: 'pass', marker_schema_version: '3',
  throughline_context: 'disabled', catalogs: { claude: 'available', codex: 'available' },
  codex_hook_readiness: 'not-installed',
  runtime_error_store: { schema: 'spotter.runtime_error_status.v1', collection: 'disabled', store: 'not_accessed', records: 0, open: 0, resolved: 0, unacknowledged: 0, latest_sequence: 0, acknowledged_through: 0 },
  checks: ['project_activation', 'marker_schema', 'throughline_context', 'claude_catalog', 'codex_catalog', 'audit_catalog_readiness', 'codex_hooks'].map((check_id) => ({ check_id, status: 'pass' })),
});

test('Throughlineが正常と診断したDB世代を工場の許容一覧で拒否しない', () => {
  for (const generation of [8, 9, 10, 42]) {
    const diagnostic = throughline();
    Object.assign(diagnostic.databaseSchema, {
      schema: `throughline.database.v${generation}`, databaseSchemaVersion: generation, supportedDatabaseSchemaVersion: generation,
    });
    const result = throughlineDiagnostic(diagnostic);
    assert.equal(result.overall, 'ready');
    assert.equal(result.state, `throughline.database.v${generation}`);
    assert.equal(result.migration, 'current');
  }
  const failed = throughline();
  failed.overall.status = 'not_ready';
  Object.assign(failed.databaseSchema, { status: 'not_ready', reason: 'not_ready' });
  assert.equal(throughlineDiagnostic(failed).overall, 'not_ready');
  assert.equal(throughlineDiagnostic(failed).migration, 'failed');
  const changed = throughline();
  changed.schema = 'throughline.native_factory_diagnostics.v2';
  changed.hooks.events.stop = 'not_ready';
  changed.readiness.restore.status = 'not_ready';
  assert.equal(throughlineDiagnostic(changed).overall, 'ready');
  assert.equal(throughlineDiagnostic(changed).components.find((item) => item.id === 'restore').status, 'not_ready');
});

test('Spotterの内部世代は製品に委ね、製品が返す失敗を保持する', () => {
  for (const marker_schema_version of ['1', '2', '3', '42']) {
    assert.equal(spotterDiagnostic({ ...spotter(), marker_schema_version }, { ok: true, code: 0 }).overall, 'ready');
  }
  const failed = spotter();
  failed.overall_status = 'fail';
  failed.compatibility_status = 'incompatible';
  failed.checks[1] = { check_id: 'marker_schema', status: 'fail', reason_code: 'marker_schema_unsupported' };
  assert.equal(spotterDiagnostic(failed, { ok: false, code: 1 }).overall, 'not_ready');
  assert.equal(spotterDiagnostic({ ...spotter(), schema_version: '2.0' }, { ok: true, code: 0 }).overall, 'ready');
});
