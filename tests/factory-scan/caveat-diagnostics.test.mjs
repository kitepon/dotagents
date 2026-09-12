import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCaveatDiagnostic } from '../../lib/factory/caveat-diagnostics.mjs';

function diagnostic(withCursor = true) {
  const ready = () => ({ status: 'ready', reason_code: 'ready' });
  const hooks = (names) => Object.fromEntries(names.map((name) => [name, ready()]));
  return {
    schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '0.19.1',
    overall: { status: 'ready' },
    database: { ...ready(), schema_version: 3, supported_schema_version: 3, migration_status: 'current' },
    sync: ready(),
    connectors: {
      claude: { status: 'ready', mcp: ready(), hooks: hooks(['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop']) },
      codex: { status: 'ready', hooks: hooks(['user_prompt_submit', 'post_tool_use', 'stop']) },
      ...(withCursor ? { cursor: { compatibility_status: 'ready', hooks: hooks(['before_submit_prompt', 'post_tool_use', 'post_tool_use_failure', 'stop']) } } : {}),
    },
  };
}

test('Caveatの公開結果だけを読み、未使用fieldを検査・転送しない', () => {
  for (const withCursor of [false, true]) {
    assert.deepEqual(parseCaveatDiagnostic(diagnostic(withCursor)), {
      overall: 'ready', version: '0.19.1', state: '3', migration: 'current',
    });
  }
  const unknown = diagnostic();
  unknown.connectors.cursor.private_path = '/private';
  assert.equal(parseCaveatDiagnostic(unknown).overall, 'ready');
  assert.ok(!JSON.stringify(parseCaveatDiagnostic(unknown)).includes('/private'));
});

test('Caveatの既定・Cursor必須の合否を工場で再集約しない', () => {
  const value = diagnostic();
  value.connectors.cursor.compatibility_status = 'not_ready';
  value.connectors.cursor.hooks.stop = { status: 'not_ready', reason_code: 'missing' };
  assert.equal(parseCaveatDiagnostic(value).overall, 'ready');
  value.overall.status = 'not_ready';
  assert.equal(parseCaveatDiagnostic(value).overall, 'not_ready');
  value.overall.status = 'unverified';
  assert.equal(parseCaveatDiagnostic(value).overall, 'unverified');
});

test('Caveatの未知状態と型違いを成功へ変換しない', () => {
  for (const mutate of [
    (value) => { value.overall.status = 'unknown'; },
    (value) => { value.database.migration_status = 'unknown'; },
    (value) => { value.database.schema_version = '3'; },
    (value) => { value.version = null; },
  ]) {
    const value = diagnostic(); mutate(value);
    assert.throws(() => parseCaveatDiagnostic(value), /native_diagnostics_schema/u);
  }
});
