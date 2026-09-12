import assert from 'node:assert/strict';
import test from 'node:test';
import { spotterDiagnostic, throughlineDiagnostic } from '../../lib/factory/v5.mjs';

const ready = () => ({ status: 'ready', reason: 'ready' });
const throughline = () => ({
  schema: 'throughline.native_factory_diagnostics.v1', version: '1.2.3', overall: { status: 'ready' },
  databaseSchema: { schema: 'throughline.database.v10', status: 'ready', databaseSchemaVersion: 10, supportedDatabaseSchemaVersion: 10, reason: 'ready' },
  hooks: { scope: 'codex', status: 'ready', reason: 'ready', events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' } },
  readiness: { capture: ready(), restore: ready(), handoff: ready() },
  evidence: { restoreSmoke: ready() }, connectors: { claude: ready(), codex: ready() },
});
const spotter = () => ({
  schema_version: '1.0', product: 'spotter', version: '1.2.3', overall_status: 'pass', marker_schema_version: '3',
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
  assert.throws(() => throughlineDiagnostic({ ...throughline(), schema: 'throughline.native_factory_diagnostics.v2' }));
});

test('Spotterのmarker世代は製品に委ね、失敗と未知の公開schemaを保持する', () => {
  for (const marker_schema_version of ['1', '2', '3', '42']) {
    assert.equal(spotterDiagnostic({ ...spotter(), marker_schema_version }).overall, 'ready');
  }
  const failed = spotter();
  failed.overall_status = 'fail';
  failed.checks[1] = { check_id: 'marker_schema', status: 'fail', reason_code: 'marker_schema_unsupported' };
  assert.equal(spotterDiagnostic(failed).overall, 'not_ready');
  assert.throws(() => spotterDiagnostic({ ...spotter(), schema_version: '2.0' }));
});
