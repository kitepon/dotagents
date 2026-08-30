import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  collectAitermRuntimeErrors,
  collectCaveatRuntimeErrors,
  collectCodexSidecarRuntimeErrors,
  collectRuntimeErrors,
  collectServerManagerExternalEvents,
  collectSpotterRuntimeErrors,
  collectThroughlineRuntimeErrors,
  acknowledgeRuntimeErrors,
} from '../../lib/factory/runtime-errors.mjs';

const NOW = '2026-07-13T00:00:00.000Z';

function nulFingerprint(product, component, errorCode, template) {
  return createHash('sha256').update([product, component, errorCode, template].join('\0')).digest('hex');
}

function spotterFingerprint(component, errorCode, template) {
  return createHash('sha256').update(['factory-v1', 'spotter', component, errorCode, template].join('\n')).digest('hex');
}

function runnerFor(value, calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return { ok: true, code: 0, reason: null, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
  };
}

function sequencedRecord(product, overrides = {}) {
  const component = overrides.component ?? 'persistence';
  const errorCode = overrides.error_code ?? 'PRODUCT.PERSISTENCE_FAILED';
  const template = overrides.message_template ?? 'Product persistence operation failed';
  const fingerprint = product === 'spotter'
    ? spotterFingerprint(component, errorCode, template)
    : nulFingerprint(product, component, errorCode, template);
  return {
    ...(product === 'codex-sidecar' ? {} : { product }),
    product_version: '1.2.3',
    component,
    error_code: errorCode,
    message_template: template,
    severity: 'high',
    fingerprint,
    occurrence_count: 2,
    first_seen: NOW,
    last_seen: NOW,
    state_schema_version: product === 'codex-sidecar' ? '2' : '1.0',
    os: 'darwin',
    arch: 'arm64',
    status: 'open',
    resolved_at: null,
    reason_code: null,
    sequence: 3,
    ...overrides,
  };
}

test('5製品の公開CLIだけをbounded runnerで呼び、openとack metadataへ固定投影する', async () => {
  const throughlineTemplate = 'Throughline persistence operation failed';
  const throughlineRecord = {
    error_code: 'THROUGHLINE.PERSISTENCE_FAILED',
    component: 'persistence',
    status: 'open',
    severity: 'high',
    fingerprint: nulFingerprint('throughline', 'persistence', 'THROUGHLINE.PERSISTENCE_FAILED', throughlineTemplate),
    message_template: throughlineTemplate,
    occurrence_count: 1,
    first_seen: NOW,
    last_seen: NOW,
    state_schema_version: '1.0',
  };
  const fixtures = [
    {
      product: 'caveat', collect: collectCaveatRuntimeErrors,
      command: 'caveat', args: ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'],
      ack: ['runtime-errors', 'ack', '3', '--json'],
      value: {
        schema: 'caveat.runtime_errors.v1', product: 'caveat', version: '1.2.3', state_schema_version: '1.0',
        cursor: { high_watermark: 3, acknowledged_through: 0, next: 3 },
        runtime_errors: [{ ...throughlineRecord, error_code: 'CAVEAT.DATABASE_OPEN_FAILED', component: 'database', message_template: 'Caveat database open failed', fingerprint: nulFingerprint('caveat', 'database', 'CAVEAT.DATABASE_OPEN_FAILED', 'Caveat database open failed') }], resolutions: [],
        diagnostics: { collection: 'enabled', status: 'ready', total_count: 1, pending_count: 1, truncated: false },
      },
    },
    {
      product: 'throughline', collect: collectThroughlineRuntimeErrors,
      command: 'throughline', args: ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'],
      ack: ['runtime-errors', 'ack', '3', '--json'],
      value: {
        schema: 'throughline.runtime_errors.v1', product: 'throughline', version: '1.2.3', state_schema_version: '1.0',
        cursor: { high_watermark: 3, acknowledged_through: 0, next: 3 },
        runtime_errors: [throughlineRecord], resolutions: [],
        diagnostics: { collection: 'enabled', status: 'ready', total_count: 1, pending_count: 1, truncated: false },
      },
    },
    {
      product: 'spotter', collect: collectSpotterRuntimeErrors,
      command: 'spotter', args: ['diagnostics', 'runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256'],
      ack: ['diagnostics', 'runtime-errors', 'ack', '3'],
      value: {
        schema: 'spotter.runtime_errors.v1', collection: 'enabled', records: [sequencedRecord('spotter')],
        after_cursor: 0, next_cursor: 3, latest_sequence: 3, acknowledged_through: 0, has_more: false,
      },
    },
    {
      product: 'aiterm-mcp', collect: collectAitermRuntimeErrors,
      command: 'aiterm-runtime-errors', args: ['snapshot'], ack: ['ack', '--cursor', '3'],
      value: {
        ok: true, command: 'snapshot', snapshot: {
          collection: 'enabled', schema_version: 'aiterm-mcp.runtime-errors.v1', cursor: 3,
          acknowledged_cursor: 0, records: [sequencedRecord('aiterm-mcp')],
        },
      },
    },
    {
      product: 'codex-sidecar', collect: collectCodexSidecarRuntimeErrors,
      command: 'codex-sidecar', args: ['factory-errors', 'snapshot'],
      ack: ['factory-errors', '--action', 'ack', '--cursor', '3'],
      value: {
        status: 'ok', factoryRuntimeErrors: {
          schema_version: '2', cursor: 3, acknowledged_through: 0,
          records: [sequencedRecord('codex-sidecar')],
        },
      },
    },
  ];

  for (const fixture of fixtures) {
    const calls = [];
    const result = await fixture.collect({ runner: runnerFor(fixture.value, calls) });
    assert.equal(result.status, 'ready');
    assert.equal(result.cursor, 3);
    assert.equal(result.runtime_errors.length, 1);
    assert.equal(result.runtime_errors[0].status, 'open');
    assert.equal('sequence' in result.runtime_errors[0], false);
    assert.deepEqual(result.resolutions, []);
    assert.deepEqual(result.acknowledgement, {
      product: fixture.product, cursor: 3, command: fixture.command, args: fixture.ack,
    });
    assert.deepEqual(calls[0].command, fixture.command);
    assert.deepEqual(calls[0].args, fixture.args);
    assert.equal(calls[0].options.timeoutMs, 10_000);
    assert.equal(calls[0].options.maxOutputBytes, 256 * 1024);
  }
});

test('ackはexit 0だけで成功扱いせず、返却cursorが要求値へ到達したことを検証する', async () => {
  const bundle = { schema_version: '1.0', report_id: 'r', acknowledgements: [{ product: 'caveat', cursor: 3, command: 'caveat', args: ['runtime-errors', 'ack', '3', '--json'] }] };
  await assert.rejects(acknowledgeRuntimeErrors(bundle, { runner: async () => ({ ok: true, stdout: '{}\n' }) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });
  const response = { schema: 'caveat.runtime_errors.v1', product: 'caveat', version: '1.2.3', state_schema_version: '1.0', cursor: { high_watermark: 3, acknowledged_through: 3, next: 0 }, runtime_errors: [], resolutions: [], diagnostics: { collection: 'enabled', status: 'ready', total_count: 0, pending_count: 0, truncated: false } };
  await acknowledgeRuntimeErrors(bundle, { runner: runnerFor(response) });
});

test('各製品のexplicit resolutionをresolutionsへ分離する', async () => {
  const fingerprint = 'a'.repeat(64);
  const result = await collectThroughlineRuntimeErrors({ runner: runnerFor({
    schema: 'throughline.runtime_errors.v1', product: 'throughline', version: '1.2.3', state_schema_version: '1.0',
    cursor: { high_watermark: 4, acknowledged_through: 1, next: 4 }, runtime_errors: [],
    resolutions: [{ fingerprint, resolved_at: NOW, reason_code: 'manual' }],
    diagnostics: { collection: 'enabled', status: 'ready', total_count: 1, pending_count: 1, truncated: false },
  }) });
  assert.deepEqual(result.runtime_errors, []);
  assert.deepEqual(result.resolutions, [{ fingerprint, resolved_at: NOW, reason_code: 'manual' }]);
  assert.equal(result.acknowledgement.cursor, 4);

  const sidecar = await collectCodexSidecarRuntimeErrors({ runner: runnerFor({
    status: 'ok', factoryRuntimeErrors: {
      schema_version: '2', cursor: 3, acknowledged_through: 0,
      records: [sequencedRecord('codex-sidecar', {
        status: 'resolved', resolved_at: NOW, reason_code: 'operator_resolved',
      })],
    },
  }) });
  assert.deepEqual(sidecar.runtime_errors, []);
  assert.deepEqual(sidecar.resolutions, [{
    fingerprint: sidecar.resolutions[0].fingerprint,
    resolved_at: NOW,
    reason_code: 'operator_resolved',
  }]);
});

test('ServerManager external eventは固定CLIとfingerprintだけを受理し、ack metadataへ載せる', async () => {
  const fp = createHash('sha256').update('servermanager:availability:unreachable').digest('hex');
  const value = {
    schema: 'dotagents.external-events.v1',
    cursor: { high_watermark: 1, acknowledged_through: 0, next: 1 },
    events: [{ sequence: 1, fingerprint: fp, check: 'availability', reason: 'unreachable', status: 'open', first_seen: NOW, last_seen: NOW, occurrence_count: 1, resolved_at: null }],
  };
  const calls = [];
  const result = await collectServerManagerExternalEvents({ runner: runnerFor(value, calls) });
  assert.deepEqual(calls[0].command, 'factory-external-event');
  assert.deepEqual(calls[0].args, ['snapshot', '--json']);
  assert.deepEqual(result.acknowledgement, { product: 'servermanager', cursor: 1, command: 'factory-external-event', args: ['ack', '--cursor', '1', '--json'] });
  assert.equal(result.runtime_errors[0].fingerprint, fp);
  const invalid = structuredClone(value); invalid.events[0].reason = 'delivery_failed'; invalid.events[0].fingerprint = createHash('sha256').update('servermanager:availability:delivery_failed').digest('hex');
  await assert.rejects(collectServerManagerExternalEvents({ runner: runnerFor(invalid) }), { code: 'E_FACTORY_RUNTIME_ERRORS', reason_code: 'servermanager_event' });
  const passReason = structuredClone(value); passReason.events[0].check = 'database'; passReason.events[0].reason = 'ready'; passReason.events[0].fingerprint = createHash('sha256').update('servermanager:database:ready').digest('hex');
  await assert.rejects(collectServerManagerExternalEvents({ runner: runnerFor(passReason) }), { code: 'E_FACTORY_RUNTIME_ERRORS', reason_code: 'servermanager_event' });
});

test('CLI不在とcollection disabledは安全な空projectionと機械可読statusになる', async () => {
  const missing = await collectRuntimeErrors('spotter', {
    runner: async () => ({ ok: false, reason: 'spawn', error: { code: 'ENOENT' }, stdout: '', stderr: '' }),
  });
  assert.deepEqual(missing, {
    product: 'spotter', status: 'cli_unavailable', cursor: 0,
    runtime_errors: [], resolutions: [], acknowledgement: null,
  });

  const disabled = await collectAitermRuntimeErrors({ runner: runnerFor({
    ok: true, command: 'snapshot', snapshot: {
      collection: 'disabled', schema_version: 'aiterm-mcp.runtime-errors.v1', cursor: 0,
      acknowledged_cursor: 0, records: [],
    },
  }) });
  assert.equal(disabled.status, 'collection_disabled');
  assert.equal(disabled.acknowledgement, null);

  const caveatDisabled = await collectCaveatRuntimeErrors({ runner: runnerFor({
    schema: 'caveat.runtime_errors.v1', product: 'caveat', version: '1.2.3', state_schema_version: '1.0',
    cursor: { high_watermark: 0, acknowledged_through: 0, next: 0 }, runtime_errors: [], resolutions: [],
    diagnostics: { collection: 'disabled', status: 'not_applicable', total_count: 0, pending_count: 0, truncated: false },
  }) });
  assert.equal(caveatDisabled.status, 'collection_disabled');
  assert.equal(caveatDisabled.acknowledgement, null);
});

test('未知field、生path/log/stack/context、fingerprint改ざんを明示拒否する', async () => {
  const base = {
    schema: 'spotter.runtime_errors.v1', collection: 'enabled', records: [sequencedRecord('spotter')],
    after_cursor: 0, next_cursor: 3, latest_sequence: 3, acknowledged_through: 0, has_more: false,
  };
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.records[0].stack = 'raw stack'; },
    (value) => { value.records[0].context = { path: '/Users/private/file' }; },
    (value) => {
      value.records[0].message_template = 'failed at /var/private/secret';
      value.records[0].fingerprint = spotterFingerprint('persistence', value.records[0].error_code, value.records[0].message_template);
    },
    (value) => { value.records[0].fingerprint = 'b'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(collectSpotterRuntimeErrors({ runner: runnerFor(value) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });
  }
});

test('resolved metadata欠落、非canonical UTC、cursor不整合を明示拒否する', async () => {
  const resolvedWithoutMetadata = {
    status: 'ok', factoryRuntimeErrors: {
      schema_version: '2', cursor: 3, acknowledged_through: 0,
      records: [sequencedRecord('codex-sidecar', { status: 'resolved', resolved_at: null, reason_code: null })],
    },
  };
  await assert.rejects(collectCodexSidecarRuntimeErrors({ runner: runnerFor(resolvedWithoutMetadata) }), {
    code: 'E_FACTORY_RUNTIME_ERRORS', reason_code: '$.records[0].resolution',
  });

  const badUtc = structuredClone(resolvedWithoutMetadata);
  badUtc.factoryRuntimeErrors.records[0].status = 'open';
  badUtc.factoryRuntimeErrors.records[0].last_seen = '2026-07-13T00:00:00Z';
  await assert.rejects(collectCodexSidecarRuntimeErrors({ runner: runnerFor(badUtc) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });

  const badCursor = structuredClone(resolvedWithoutMetadata);
  badCursor.factoryRuntimeErrors.records[0].status = 'open';
  badCursor.factoryRuntimeErrors.cursor = 2;
  await assert.rejects(collectCodexSidecarRuntimeErrors({ runner: runnerFor(badCursor) }), { code: 'E_FACTORY_RUNTIME_ERRORS' });

  const badChronology = structuredClone(resolvedWithoutMetadata);
  badChronology.factoryRuntimeErrors.records[0].resolved_at = '2026-07-12T23:59:59.000Z';
  badChronology.factoryRuntimeErrors.records[0].reason_code = 'operator_resolved';
  await assert.rejects(collectCodexSidecarRuntimeErrors({ runner: runnerFor(badChronology) }), {
    code: 'E_FACTORY_RUNTIME_ERRORS', reason_code: '$.records[0].resolution_chronology',
  });
});

test('command failureやmalformed collectionをCLI不在へ偽装せず製品IDを固定診断へ残す', async () => {
  await assert.rejects(collectSpotterRuntimeErrors({
    runner: async () => ({ ok: false, reason: 'exit', code: 1, stdout: '', stderr: '/Users/private/error' }),
  }), {
    code: 'E_FACTORY_RUNTIME_ERRORS',
    reason_code: 'command_failed',
    product_id: 'spotter',
    message: 'runtime error adapter contract failed: spotter:command_failed',
  });

  await assert.rejects(collectAitermRuntimeErrors({ runner: runnerFor({
    ok: true, command: 'snapshot', snapshot: {
      collection: 'malformed', schema_version: 'aiterm-mcp.runtime-errors.v1', cursor: 0,
      acknowledged_cursor: 0, records: [],
    },
  }) }), {
    code: 'E_FACTORY_RUNTIME_ERRORS',
    reason_code: 'aiterm_collection',
    product_id: 'aiterm-mcp',
    message: 'runtime error adapter contract failed: aiterm-mcp:aiterm_collection',
  });
});
