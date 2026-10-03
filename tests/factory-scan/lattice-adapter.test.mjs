import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { latticeProduct } from '../../lib/factory/scan.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';
import {
  acknowledgeRuntimeErrors,
  acknowledgementBundle,
  collectCaveatRuntimeErrors,
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

test('Lattice本体が出す定義（0.71.1のsrc/runtime-errors.mjs）をすべて受け入れる', async () => {
  const published = [
    ['LATTICE.SENSOR_EVIDENCE_FAILED', 'sensor_adapter', 'LatticeSensor evidence collection failed'],
    ['LATTICE.RUN_STORE_IO_FAILED', 'run_store', 'Lattice run store IO failed'],
    ['LATTICE.EVENT_CHAIN_INTEGRITY_FAILED', 'event_store', 'Lattice run event chain integrity check failed'],
    ['LATTICE.CLI_INTERNAL_FAILED', 'cli', 'Lattice CLI crashed outside the typed error contract'],
    ['LATTICE.MCP_SERVER_FAILED', 'mcp', 'Lattice MCP server failed'],
  ];
  for (const [code, component, template] of published) {
    const value = snapshotValue();
    Object.assign(value.runtime_errors[0], { error_code: code, component, message_template: template, fingerprint: latticeFingerprint(component, code, template) });
    const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(value) });
    assert.equal(projection.runtime_errors[0].error_code, code);
  }
});

const CLI = Object.freeze({ code: 'LATTICE.CLI_INTERNAL_FAILED', component: 'cli', template: 'Lattice CLI crashed outside the typed error contract' });
const CONTEXT = Object.freeze({ command_kind: 'run.list', error_kind: 'TypeError', cause_code: 'none' });

// Latticeと合意した式: 現行の4要素の後ろへ command_kind・error_kind・cause_code をNUL区切りで足す。
function contextFingerprint(context, { code, component, template } = CLI) {
  return createHash('sha256')
    .update(['lattice', component, code, template, context.command_kind, context.error_kind, context.cause_code].join('\0'))
    .digest('hex');
}

function contextRecord(context = CONTEXT, definition = CLI) {
  return {
    ...snapshotValue().runtime_errors[0],
    error_code: definition.code,
    component: definition.component,
    message_template: definition.template,
    fingerprint: contextFingerprint(context, definition),
    safe_context: { ...context },
  };
}

function contextSnapshot(...records) {
  const value = snapshotValue();
  value.runtime_errors = records;
  value.diagnostics.total_count = records.length;
  value.diagnostics.pending_count = records.length;
  return value;
}

test('safe_context付きの記録は3値を含む式で照合し、そのままprojectionへ運ぶ', async () => {
  const legacy = {
    ...snapshotValue().runtime_errors[0],
    error_code: CLI.code,
    component: CLI.component,
    message_template: CLI.template,
    fingerprint: latticeFingerprint(CLI.component, CLI.code, CLI.template),
  };
  // 古いstoreの記録（safe_contextなし・現行の式）と新しい記録は、同じerror_codeで1つのsnapshotに並ぶ。
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(contextSnapshot(legacy, contextRecord())) });
  assert.equal(projection.runtime_errors.length, 2);
  assert.equal('safe_context' in projection.runtime_errors[0], false);
  assert.equal(projection.runtime_errors[0].fingerprint, legacy.fingerprint);
  assert.deepEqual(projection.runtime_errors[1].safe_context, CONTEXT);
  assert.deepEqual(Object.keys(projection.runtime_errors[1].safe_context), ['command_kind', 'error_kind', 'cause_code']);
  assert.equal(projection.runtime_errors[1].fingerprint, contextFingerprint(CONTEXT));
  assert.notEqual(projection.runtime_errors[1].fingerprint, legacy.fingerprint);
});

test('safe_context付きのprojectionは、そのままwire v9のreport検査（privacy検査を含む）を通る', async () => {
  const contexts = [
    CONTEXT,
    { command_kind: 'other', error_kind: 'other', cause_code: 'none' },
    { command_kind: 'runtime-errors.snapshot', error_kind: 'SystemError', cause_code: `ERR_${'A'.repeat(60)}` },
  ];
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(contextSnapshot(...contexts.map((context) => contextRecord(context)))) });
  const observedAt = '2026-07-18T00:02:00.000Z';
  const empty = () => ({ presence_status: 'installed', installed_version: '0.2.0', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] });
  const report = {
    schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904',
    host_id: 'mac-kite', host_profile: 'mac', platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full', observed_at: observedAt, created_at: observedAt,
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(V9_PRODUCT_IDS.map((id) => [id, empty()])),
  };
  report.products.lattice.runtime_errors = projection.runtime_errors;
  assert.doesNotThrow(() => validateReportV9(report));
  assert.deepEqual(report.products.lattice.runtime_errors.map((record) => record.safe_context), contexts);
});

test('safe_contextの語彙はLatticeが持ち、工場は形だけを検査する', async () => {
  const accepted = [
    ...['other', 'run.list', 'plan.compile', 'todo.start', 'runtime-errors.snapshot', 'a'.repeat(48)].map((command_kind) => ({ ...CONTEXT, command_kind })),
    ...['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'SystemError', 'other'].map((error_kind) => ({ ...CONTEXT, error_kind })),
    ...['none', 'ENOENT', 'EACCES', 'EADDRINUSE', 'ERR_MODULE_NOT_FOUND', `ERR_${'A'.repeat(60)}`].map((cause_code) => ({ ...CONTEXT, cause_code })),
  ];
  for (const context of accepted) {
    const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(contextSnapshot(contextRecord(context))) });
    assert.deepEqual(projection.runtime_errors[0].safe_context, context, JSON.stringify(context));
  }
  // CLI以外の記録（MCP・sensor・run store・event store）にも付く。
  const mcp = { code: 'LATTICE.MCP_SERVER_FAILED', component: 'mcp', template: 'Lattice MCP server failed' };
  const context = { command_kind: 'other', error_kind: 'Error', cause_code: 'ENOENT' };
  const projection = await collectLatticeRuntimeErrors({ runner: runnerFor(contextSnapshot(contextRecord(context, mcp))) });
  assert.equal(projection.runtime_errors[0].fingerprint, contextFingerprint(context, mcp));
});

test('safe_contextはキー3つの完全一致・値の形・式の一致を外れるとfail closedする', async () => {
  const mutate = (change) => { const record = contextRecord(); change(record); return record; };
  const withContext = (context) => ({ ...contextRecord(), safe_context: context, fingerprint: contextFingerprint({ ...CONTEXT, ...context }) });
  const rejected = [
    ['キー欠け', mutate((record) => { delete record.safe_context.cause_code; })],
    ['余分なキー', mutate((record) => { record.safe_context.detail = 'x'; })],
    ['object以外', mutate((record) => { record.safe_context = null; })],
    ['配列', mutate((record) => { record.safe_context = ['run.list', 'TypeError', 'none']; })],
    ['文字列以外の値', withContext({ ...CONTEXT, cause_code: 2 })],
    ['command_kind 大文字', withContext({ ...CONTEXT, command_kind: 'Run.List' })],
    ['command_kind 3階層', withContext({ ...CONTEXT, command_kind: 'run.list.all' })],
    ['command_kind path', withContext({ ...CONTEXT, command_kind: '/tmp/plan' })],
    ['command_kind 49文字', withContext({ ...CONTEXT, command_kind: 'a'.repeat(49) })],
    ['command_kind 空', withContext({ ...CONTEXT, command_kind: '' })],
    ['error_kind 小文字', withContext({ ...CONTEXT, error_kind: 'typeerror' })],
    ['error_kind 33文字', withContext({ ...CONTEXT, error_kind: `E${'r'.repeat(32)}` })],
    ['error_kind 記号', withContext({ ...CONTEXT, error_kind: 'Type Error' })],
    ['cause_code 小文字', withContext({ ...CONTEXT, cause_code: 'enoent' })],
    ['cause_code E/ERR_以外', withContext({ ...CONTEXT, cause_code: 'MODULE_NOT_FOUND' })],
    ['cause_code 空', withContext({ ...CONTEXT, cause_code: '' })],
    ['safe_contextありで現行の式', mutate((record) => { record.fingerprint = latticeFingerprint(CLI.component, CLI.code, CLI.template); })],
    ['safe_contextなしで新しい式', mutate((record) => { delete record.safe_context; })],
    ['値の入れ替え', mutate((record) => { record.safe_context = { command_kind: 'other', error_kind: 'TypeError', cause_code: 'none' }; })],
  ];
  for (const [name, record] of rejected) {
    await assert.rejects(collectLatticeRuntimeErrors({ runner: runnerFor(contextSnapshot(record)) }), { code: 'E_FACTORY_RUNTIME_ERRORS' }, name);
  }
});

test('safe_contextを受け入れるのはlatticeだけ（他のnative製品は従来どおり完全一致）', async () => {
  const fingerprint = createHash('sha256').update('caveat\0sync\0CAVEAT.SYNC_FAILED\0Caveat own sync failed').digest('hex');
  const value = {
    ...snapshotValue(),
    schema: 'caveat.runtime_errors.v1',
    product: 'caveat',
    runtime_errors: [{
      ...snapshotValue().runtime_errors[0],
      error_code: 'CAVEAT.SYNC_FAILED',
      component: 'sync',
      message_template: 'Caveat own sync failed',
      fingerprint,
    }],
  };
  const projection = await collectCaveatRuntimeErrors({ runner: runnerFor(value) });
  assert.equal(projection.runtime_errors.length, 1);
  value.runtime_errors[0].safe_context = { ...CONTEXT };
  await assert.rejects(collectCaveatRuntimeErrors({ runner: runnerFor(value) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });
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

  // 収集に対応しない端末（Windows）で製品が答える形。記録は空でなければならない。
  const unsupported = { ...disabled, diagnostics: { ...disabled.diagnostics, collection: 'unsupported' } };
  const skipped = await collectLatticeRuntimeErrors({ runner: runnerFor(unsupported) });
  assert.equal(skipped.status, 'collection_unsupported');
  assert.deepEqual(skipped.runtime_errors, []);
  assert.equal(skipped.acknowledgement, null);
  await assert.rejects(collectLatticeRuntimeErrors({
    runner: runnerFor({ ...unsupported, cursor: { high_watermark: 1, acknowledged_through: 0, next: 1 } }),
  }));
  await assert.rejects(collectLatticeRuntimeErrors({
    runner: runnerFor({ ...unsupported, diagnostics: { ...unsupported.diagnostics, collection: 'paused' } }),
  }));
});
