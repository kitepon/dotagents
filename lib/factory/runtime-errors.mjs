import { createHash } from 'node:crypto';
import { run } from './command.mjs';

const MAX_RECORDS = 256;
// npm更新直後のWindows native CLIは初回ロードとDefender走査が重なり、
// 3秒を越えることがある。出力上限とschema検証は維持し、cold startを10秒まで待つ。
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const FORBIDDEN_TEXT = /(?:[\r\n\0]|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+|-----BEGIN [A-Z ]+-----|(?:^|[\s"'])\/[A-Za-z0-9._-]+\/|(?:^|[\s"'])[A-Za-z]:\\)/;
const SERVERMANAGER_EVENT_REASONS = Object.freeze({
  availability: new Set(['unreachable']),
  database: new Set(['query_failed']),
  schema: new Set(['version_mismatch', 'query_failed']),
  pull_poll: new Set(['not_observed', 'timestamp_invalid', 'source_status_invalid', 'source_failed', 'delivery_failed', 'poll_failed', 'stale', 'query_failed']),
  factory_ingest: new Set(['stale', 'query_failed']),
  factory_delivery: new Set(['state_invalid', 'stale', 'delivery_failed', 'query_failed']),
  source_revision: new Set(['revision_missing', 'revision_invalid', 'revision_mismatch']),
});
const CAVEAT_RUNTIME_DEFINITIONS = Object.freeze({
  'CAVEAT.DATABASE_OPEN_FAILED': Object.freeze({ component: 'database', severity: 'high', template: 'Caveat database open failed' }),
  'CAVEAT.INDEX_FAILED': Object.freeze({ component: 'index', severity: 'high', template: 'Caveat index operation failed' }),
  'CAVEAT.SYNC_FAILED': Object.freeze({ component: 'sync', severity: 'high', template: 'Caveat own sync failed' }),
  'CAVEAT.MCP_SERVER_FAILED': Object.freeze({ component: 'mcp', severity: 'high', template: 'Caveat MCP server failed' }),
  'CAVEAT.MCP_TOOL_FAILED': Object.freeze({ component: 'mcp_tool', severity: 'high', template: 'Caveat MCP tool handler failed' }),
  'CAVEAT.CLAUDE_HOOK_FAILED': Object.freeze({ component: 'claude_hook', severity: 'high', template: 'Caveat Claude hook failed' }),
  'CAVEAT.CODEX_HOOK_FAILED': Object.freeze({ component: 'codex_hook', severity: 'high', template: 'Caveat Codex hook failed' }),
  'CAVEAT.CURSOR_HOOK_FAILED': Object.freeze({ component: 'cursor_hook', severity: 'high', template: 'Caveat Cursor hook failed' }),
});

const LATTICE_RUNTIME_DEFINITIONS = Object.freeze({
  'LATTICE.CODEGRAPH_EVIDENCE_FAILED': Object.freeze({ component: 'sensor_adapter', severity: 'high', template: 'Lattice codegraph evidence collection failed' }),
  'LATTICE.RUN_STORE_IO_FAILED': Object.freeze({ component: 'run_store', severity: 'high', template: 'Lattice run store IO failed' }),
  'LATTICE.EVENT_CHAIN_INTEGRITY_FAILED': Object.freeze({ component: 'event_store', severity: 'high', template: 'Lattice run event chain integrity check failed' }),
  'LATTICE.CLI_INTERNAL_FAILED': Object.freeze({ component: 'cli', severity: 'high', template: 'Lattice CLI crashed outside the typed error contract' }),
  'LATTICE.MCP_SERVER_FAILED': Object.freeze({ component: 'mcp', severity: 'high', template: 'Lattice MCP server failed' }),
});

const PRODUCTS = Object.freeze({
  caveat: {
    command: 'caveat',
    args: ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'],
    ack: (cursor) => ['runtime-errors', 'ack', String(cursor), '--json'],
    parse: parseCaveat,
  },
  throughline: {
    command: 'throughline',
    args: ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'],
    ack: (cursor) => ['runtime-errors', 'ack', String(cursor), '--json'],
    parse: parseThroughline,
  },
  spotter: {
    command: 'spotter',
    args: ['diagnostics', 'runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256'],
    ack: (cursor) => ['diagnostics', 'runtime-errors', 'ack', String(cursor)],
    parse: parseSpotter,
  },
  'aiterm-mcp': {
    command: 'aiterm-runtime-errors',
    args: ['snapshot'],
    ack: (cursor) => ['ack', '--cursor', String(cursor)],
    parse: parseAiterm,
  },
  'codex-sidecar': {
    command: 'codex-sidecar',
    args: ['factory-errors', 'snapshot'],
    ack: (cursor) => ['factory-errors', '--action', 'ack', '--cursor', String(cursor)],
    parse: parseCodexSidecar,
  },
  // 編入中（L6）。wire v3 reportへは未enroll＝scanはreport productsに無いidをskipする。
  lattice: {
    command: 'lattice',
    args: ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'],
    ack: (cursor) => ['runtime-errors', 'ack', String(cursor), '--json'],
    parse: parseLattice,
  },
  servermanager: {
    command: 'factory-external-event',
    args: ['snapshot', '--json'],
    ack: (cursor) => ['ack', '--cursor', String(cursor), '--json'],
    parse: parseServerManagerExternal,
  },
});

export const RUNTIME_ERROR_PRODUCTS = Object.freeze(Object.keys(PRODUCTS));

export function acknowledgementBundle(reportId, acknowledgements) {
  const bundle = { schema_version: '1.0', report_id: reportId, acknowledgements };
  validateAcknowledgementBundle(bundle, reportId);
  return bundle;
}

export function validateAcknowledgementBundle(value, expectedReportId) {
  exact(value, ['schema_version', 'report_id', 'acknowledgements'], '$');
  if (value.schema_version !== '1.0' || typeof value.report_id !== 'string'
    || value.report_id !== expectedReportId || !Array.isArray(value.acknowledgements)
    || value.acknowledgements.length > RUNTIME_ERROR_PRODUCTS.length) fail('ack_bundle');
  const seen = new Set();
  for (const [index, acknowledgement] of value.acknowledgements.entries()) {
    const path = `$.acknowledgements[${index}]`;
    exact(acknowledgement, ['product', 'cursor', 'command', 'args'], path);
    const adapter = PRODUCTS[acknowledgement.product];
    if (!adapter || seen.has(acknowledgement.product)) fail('ack_product');
    seen.add(acknowledgement.product);
    const expectedCursor = cursor(acknowledgement.cursor, `${path}.cursor`);
    const expectedArgs = adapter.ack(expectedCursor);
    if (acknowledgement.command !== adapter.command
      || !Array.isArray(acknowledgement.args)
      || acknowledgement.args.length !== expectedArgs.length
      || acknowledgement.args.some((arg, argIndex) => arg !== expectedArgs[argIndex])) {
      fail('ack_command');
    }
  }
  return value;
}

export async function acknowledgeRuntimeErrors(bundle, { runner = run, cwd, env } = {}) {
  validateAcknowledgementBundle(bundle, bundle?.report_id);
  for (const acknowledgement of bundle.acknowledgements) {
    const result = await runner(acknowledgement.command, [...acknowledgement.args], {
      cwd,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (!result?.ok) throw contractError('ack_failed', acknowledgement.product);
    try {
      validateAcknowledgementResponse(acknowledgement.product, acknowledgement.cursor, result.stdout);
    } catch (error) {
      if (error?.code === 'E_FACTORY_RUNTIME_ERRORS' && !error.product_id) {
        throw contractError(error.reason_code ?? 'ack_response', acknowledgement.product);
      }
      throw error;
    }
  }
}

// v2 wireのruntime producerはgpt-connectorと、server hostのservermanager external event連携だけ。
export function validateAcknowledgementBundleV2(value, expectedReportId) {
  exact(value, ['schema_version', 'report_id', 'acknowledgements'], '$');
  if (value.schema_version !== '2.0' || typeof value.report_id !== 'string' || value.report_id !== expectedReportId || !Array.isArray(value.acknowledgements) || value.acknowledgements.length > 2) fail('ack_bundle_v2');
  const seen = new Set();
  for (const acknowledgement of value.acknowledgements) {
    exact(acknowledgement, ['product', 'cursor', 'command', 'args'], '$.acknowledgements[]');
    if (seen.has(acknowledgement.product)) fail('ack_bundle_v2');
    seen.add(acknowledgement.product);
    const expected = cursor(acknowledgement.cursor, '$.acknowledgements[].cursor');
    if (acknowledgement.product === 'gpt-connector') {
      if (acknowledgement.command !== 'gpt-connector' || !Array.isArray(acknowledgement.args) || acknowledgement.args.length !== 4 || acknowledgement.args[0] !== 'runtime-errors' || acknowledgement.args[1] !== 'ack' || acknowledgement.args[2] !== String(expected) || acknowledgement.args[3] !== '--json') fail('ack_command_v2');
    } else if (acknowledgement.product === 'servermanager') {
      if (acknowledgement.command !== 'factory-external-event' || !Array.isArray(acknowledgement.args) || acknowledgement.args.length !== 4 || acknowledgement.args[0] !== 'ack' || acknowledgement.args[1] !== '--cursor' || acknowledgement.args[2] !== String(expected) || acknowledgement.args[3] !== '--json') fail('ack_command_v2');
    } else fail('ack_command_v2');
  }
  return value;
}

export async function acknowledgeRuntimeErrorsV2(bundle, { runner = run, cwd, env } = {}) {
  validateAcknowledgementBundleV2(bundle, bundle?.report_id);
  for (const acknowledgement of bundle.acknowledgements) {
    const result = await runner(acknowledgement.command, [...acknowledgement.args], { cwd, env, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
    if (!result?.ok) throw contractError('ack_failed_v2');
    const value = parseJsonObject(result.stdout);
    if (acknowledgement.product === 'servermanager') {
      exact(value, ['ok', 'acknowledged_through'], '$');
      if (value.ok !== true || cursor(value.acknowledged_through, '$.acknowledged_through') < acknowledgement.cursor) fail('ack_response_v2');
    } else {
      exact(value, ['status', 'acknowledgedThrough'], '$');
      if (value.status !== 'acknowledged' || cursor(value.acknowledgedThrough, '$.acknowledgedThrough') < acknowledgement.cursor) fail('ack_response_v2');
    }
  }
}

// wire v4ではLatticeがCodegraphを置換し、runtime producerとして正式参加する。
// ack bundleのschema_versionはwire majorへ追従する。products・command・args契約は
// major間で同一なので、検査本体を共有しversionだけを引数で受ける。
export function validateAcknowledgementBundleV4(value, expectedReportId) {
  return validateVersionedAcknowledgementBundle(value, expectedReportId, '4.0');
}

export function validateAcknowledgementBundleV5(value, expectedReportId) {
  return validateVersionedAcknowledgementBundle(value, expectedReportId, '5.0');
}

export function validateAcknowledgementBundleV6(value, expectedReportId) {
  return validateVersionedAcknowledgementBundle(value, expectedReportId, '6.0');
}

export function validateAcknowledgementBundleV7(value, expectedReportId) {
  return validateVersionedAcknowledgementBundle(value, expectedReportId, '7.0');
}

export function validateAcknowledgementBundleV8(value, expectedReportId) {
  return validateVersionedAcknowledgementBundle(value, expectedReportId, '8.0');
}

function validateVersionedAcknowledgementBundle(value, expectedReportId, schemaVersion) {
  exact(value, ['schema_version', 'report_id', 'acknowledgements'], '$');
  if (value.schema_version !== schemaVersion || typeof value.report_id !== 'string' || value.report_id !== expectedReportId || !Array.isArray(value.acknowledgements) || value.acknowledgements.length > 3) fail('ack_bundle_v4');
  const expectedCommands = {
    'gpt-connector': ['gpt-connector', ['runtime-errors', 'ack']],
    lattice: ['lattice', ['runtime-errors', 'ack']],
    servermanager: ['factory-external-event', ['ack', '--cursor']],
  };
  const seen = new Set();
  for (const acknowledgement of value.acknowledgements) {
    exact(acknowledgement, ['product', 'cursor', 'command', 'args'], '$.acknowledgements[]');
    if (seen.has(acknowledgement.product)) fail('ack_bundle_v4');
    seen.add(acknowledgement.product);
    const expected = cursor(acknowledgement.cursor, '$.acknowledgements[].cursor');
    const contract = expectedCommands[acknowledgement.product];
    if (!contract) fail('ack_command_v4');
    const [command, prefix] = contract;
    const expectedArgs = [...prefix, String(expected), '--json'];
    if (acknowledgement.command !== command || !Array.isArray(acknowledgement.args)
      || acknowledgement.args.length !== expectedArgs.length
      || acknowledgement.args.some((arg, index) => arg !== expectedArgs[index])) fail('ack_command_v4');
  }
  return value;
}

export async function acknowledgeRuntimeErrorsV5(bundle, options = {}) {
  validateAcknowledgementBundleV5(bundle, bundle?.report_id);
  return dispatchAcknowledgements(bundle, options);
}

export async function acknowledgeRuntimeErrorsV6(bundle, options = {}) {
  validateAcknowledgementBundleV6(bundle, bundle?.report_id);
  return dispatchAcknowledgements(bundle, options);
}

export async function acknowledgeRuntimeErrorsV7(bundle, options = {}) {
  validateAcknowledgementBundleV7(bundle, bundle?.report_id);
  return dispatchAcknowledgements(bundle, options);
}

export async function acknowledgeRuntimeErrorsV8(bundle, options = {}) {
  validateAcknowledgementBundleV8(bundle, bundle?.report_id);
  return dispatchAcknowledgements(bundle, options);
}

export async function acknowledgeRuntimeErrorsV4(bundle, options = {}) {
  validateAcknowledgementBundleV4(bundle, bundle?.report_id);
  return dispatchAcknowledgements(bundle, options);
}

async function dispatchAcknowledgements(bundle, { runner = run, cwd, env } = {}) {
  for (const acknowledgement of bundle.acknowledgements) {
    const result = await runner(acknowledgement.command, [...acknowledgement.args], { cwd, env, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
    if (!result?.ok) throw contractError('ack_failed_v4', acknowledgement.product);
    try {
      if (acknowledgement.product === 'lattice') {
        validateAcknowledgementResponse('lattice', acknowledgement.cursor, result.stdout);
      } else {
        const value = parseJsonObject(result.stdout);
        if (acknowledgement.product === 'servermanager') {
          exact(value, ['ok', 'acknowledged_through'], '$');
          if (value.ok !== true || cursor(value.acknowledged_through, '$.acknowledged_through') < acknowledgement.cursor) fail('ack_response_v4');
        } else {
          exact(value, ['status', 'acknowledgedThrough'], '$');
          if (value.status !== 'acknowledged' || cursor(value.acknowledgedThrough, '$.acknowledgedThrough') < acknowledgement.cursor) fail('ack_response_v4');
        }
      }
    } catch (error) {
      if (error?.code === 'E_FACTORY_RUNTIME_ERRORS' && !error.product_id) throw contractError(error.reason_code ?? 'ack_response_v4', acknowledgement.product);
      throw error;
    }
  }
}

function validateAcknowledgementResponse(product, expectedCursor, stdout) {
  const value = parseJsonObject(stdout); let acknowledged;
  // lattice ack応答はcaveatと同型（snapshot全体を返す）＝同じ検証を通す。
  if (product === 'caveat' || product === 'lattice' || product === 'throughline') {
    if (product === 'caveat' || product === 'lattice') {
      PRODUCTS[product].parse(value); acknowledged = cursor(value.cursor.acknowledged_through, '$.cursor.acknowledged_through');
    } else {
      exact(value, ['status', 'acknowledgedThrough'], '$');
      if (value.status !== 'acknowledged') fail('throughline_ack');
      acknowledged = cursor(value.acknowledgedThrough, '$.acknowledgedThrough');
    }
  } else if (product === 'spotter') {
    exact(value, ['acknowledged', 'acknowledged_through'], '$');
    if (value.acknowledged !== true) fail('spotter_ack');
    acknowledged = cursor(value.acknowledged_through, '$.acknowledged_through');
  } else if (product === 'aiterm-mcp') {
    exact(value, ['ok', 'command', 'snapshot'], '$'); if (value.ok !== true || value.command !== 'ack') fail('aiterm_ack');
    parseAiterm({ ...value, command: 'snapshot' }); acknowledged = cursor(value.snapshot.acknowledged_cursor, '$.snapshot.acknowledged_cursor');
  } else if (product === 'codex-sidecar') {
    exact(value, ['status', 'action', 'cursor'], '$');
    if (value.status !== 'ok' || value.action !== 'ack') fail('codex_sidecar_ack');
    acknowledged = cursor(value.cursor, '$.cursor');
  } else if (product === 'servermanager') {
    exact(value, ['ok', 'acknowledged_through'], '$'); if (value.ok !== true) fail('servermanager_ack'); acknowledged = cursor(value.acknowledged_through, '$.acknowledged_through');
  } else fail('ack_product');
  if (acknowledged < expectedCursor) fail('ack_cursor');
}

export async function collectRuntimeErrors(product, {
  runner = run,
  cwd,
  env,
} = {}) {
  const adapter = PRODUCTS[product];
  if (!adapter) throw contractError('unknown_product');
  if (typeof runner !== 'function') throw contractError('runner_invalid');
  const result = await runner(adapter.command, [...adapter.args], {
    cwd,
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (!result?.ok) {
    if (result?.reason === 'spawn' && result?.error?.code === 'ENOENT') {
      return emptyProjection(product, 'cli_unavailable');
    }
    throw contractError('command_failed', product);
  }
  let projection;
  try {
    const snapshot = parseJsonObject(result.stdout);
    projection = adapter.parse(snapshot);
  } catch (error) {
    if (error?.code === 'E_FACTORY_RUNTIME_ERRORS' && !error.product_id) {
      throw contractError(error.reason_code ?? 'adapter_failed', product);
    }
    throw error;
  }
  if (projection.status !== 'ready') return projection;
  return {
    ...projection,
    acknowledgement: {
      product,
      cursor: projection.cursor,
      command: adapter.command,
      args: adapter.ack(projection.cursor),
    },
  };
}

export const collectThroughlineRuntimeErrors = (options) => collectRuntimeErrors('throughline', options);
export const collectCaveatRuntimeErrors = (options) => collectRuntimeErrors('caveat', options);
export const collectSpotterRuntimeErrors = (options) => collectRuntimeErrors('spotter', options);
export const collectAitermRuntimeErrors = (options) => collectRuntimeErrors('aiterm-mcp', options);
export const collectCodexSidecarRuntimeErrors = (options) => collectRuntimeErrors('codex-sidecar', options);
export const collectServerManagerExternalEvents = (options) => collectRuntimeErrors('servermanager', options);
export const collectLatticeRuntimeErrors = (options) => collectRuntimeErrors('lattice', options);

function parseThroughline(value) {
  return parseNativeRuntimeErrors(value, 'throughline');
}

function parseLattice(value) {
  const projection = parseNativeRuntimeErrors(value, 'lattice');
  for (const record of value.runtime_errors) {
    const definition = LATTICE_RUNTIME_DEFINITIONS[record.error_code];
    if (!definition || record.component !== definition.component || record.severity !== definition.severity || record.message_template !== definition.template) fail('lattice_definition');
  }
  return projection;
}

function parseCaveat(value) {
  const projection = parseNativeRuntimeErrors(value, 'caveat');
  for (const record of value.runtime_errors) {
    const definition = CAVEAT_RUNTIME_DEFINITIONS[record.error_code];
    if (!definition || record.component !== definition.component || record.severity !== definition.severity || record.message_template !== definition.template) fail('caveat_definition');
  }
  return projection;
}

function parseNativeRuntimeErrors(value, product) {
  exact(value, ['schema', 'product', 'version', 'state_schema_version', 'cursor', 'runtime_errors', 'resolutions', 'diagnostics'], '$');
  if (value.schema !== `${product}.runtime_errors.v1` || value.product !== product) fail(`${product}_schema`);
  boundedVersion(value.version, '$.version');
  boundedVersion(value.state_schema_version, '$.state_schema_version');
  exact(value.cursor, ['high_watermark', 'acknowledged_through', 'next'], '$.cursor');
  const high = cursor(value.cursor.high_watermark, '$.cursor.high_watermark');
  const acknowledged = cursor(value.cursor.acknowledged_through, '$.cursor.acknowledged_through');
  const next = cursor(value.cursor.next, '$.cursor.next');
  if (acknowledged > high || next > high) fail(`${product}_cursor`);
  exact(value.diagnostics, ['collection', 'status', 'total_count', 'pending_count', 'truncated'], '$.diagnostics');
  if (!['enabled', 'disabled'].includes(value.diagnostics.collection)
    || !['ready', 'not_applicable'].includes(value.diagnostics.status)
    || !nonnegative(value.diagnostics.total_count) || !nonnegative(value.diagnostics.pending_count)
    || typeof value.diagnostics.truncated !== 'boolean') fail(`${product}_diagnostics`);
  arrays(value.runtime_errors, value.resolutions);
  if (value.diagnostics.collection === 'disabled') {
    if (value.diagnostics.status !== 'not_applicable' || high !== 0 || acknowledged !== 0 || next !== 0
      || value.runtime_errors.length !== 0 || value.resolutions.length !== 0) fail(`${product}_disabled`);
    return emptyProjection(product, 'collection_disabled');
  }
  if (value.diagnostics.status !== 'ready') fail(`${product}_status`);
  const runtimeErrors = value.runtime_errors.map((record, index) => projectNativeRecord(product, record, index));
  const resolutions = value.resolutions.map((resolution, index) => validateResolution(resolution, `$.resolutions[${index}]`));
  const selectedCount = runtimeErrors.length + resolutions.length;
  if (value.diagnostics.pending_count > value.diagnostics.total_count
    || selectedCount > value.diagnostics.total_count
    || (selectedCount > 0 && next === 0)) fail(`${product}_cursor`);
  assertUniqueAndDisjoint(runtimeErrors, resolutions);
  return readyProjection(product, next, runtimeErrors, resolutions);
}

function parseSpotter(value) {
  exact(value, ['schema', 'collection', 'records', 'after_cursor', 'next_cursor', 'latest_sequence', 'acknowledged_through', 'has_more'], '$');
  if (value.schema !== 'spotter.runtime_errors.v1' || typeof value.collection !== 'string'
    || value.after_cursor !== 0 || typeof value.has_more !== 'boolean') fail('spotter_schema');
  const next = cursor(value.next_cursor, '$.next_cursor');
  const latest = cursor(value.latest_sequence, '$.latest_sequence');
  const acknowledged = cursor(value.acknowledged_through, '$.acknowledged_through');
  if (next > latest || acknowledged > latest) fail('spotter_cursor');
  if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) fail('spotter_records');
  if (value.collection !== 'enabled') {
    if (!['disabled', 'config_missing'].includes(value.collection)) fail('spotter_collection');
    if (next !== 0 || latest !== 0 || acknowledged !== 0 || value.records.length !== 0 || value.has_more) fail('spotter_disabled');
    return emptyProjection('spotter', 'collection_disabled');
  }
  const projected = projectSequencedRecords('spotter', value.records, latest, spotterFingerprint);
  if ((projected.length === 0 ? 0 : projected.at(-1).sequence) !== next) fail('spotter_next_cursor');
  return recordsProjection('spotter', next, projected);
}

function parseAiterm(value) {
  exact(value, ['ok', 'command', 'snapshot'], '$');
  if (value.ok !== true || value.command !== 'snapshot') fail('aiterm_envelope');
  const snapshot = value.snapshot;
  exact(snapshot, ['collection', 'schema_version', 'cursor', 'acknowledged_cursor', 'records'], '$.snapshot');
  if (snapshot.schema_version !== 'aiterm-mcp.runtime-errors.v1') fail('aiterm_schema');
  const high = cursor(snapshot.cursor, '$.snapshot.cursor');
  const acknowledged = cursor(snapshot.acknowledged_cursor, '$.snapshot.acknowledged_cursor');
  if (acknowledged > high || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) fail('aiterm_cursor');
  if (snapshot.collection !== 'enabled') {
    if (snapshot.collection !== 'disabled') fail('aiterm_collection');
    if (high !== 0 || acknowledged !== 0 || snapshot.records.length !== 0) fail('aiterm_disabled');
    return emptyProjection('aiterm-mcp', 'collection_disabled');
  }
  return recordsProjection('aiterm-mcp', high,
    projectSequencedRecords('aiterm-mcp', snapshot.records, high, nulFingerprint));
}

function parseCodexSidecar(value) {
  exact(value, ['status', 'factoryRuntimeErrors'], '$');
  if (value.status !== 'ok') fail('codex_sidecar_status');
  const snapshot = value.factoryRuntimeErrors;
  exact(snapshot, ['schema_version', 'cursor', 'acknowledged_through', 'records'], '$.factoryRuntimeErrors');
  if (snapshot.schema_version !== '2') fail('codex_sidecar_schema');
  const high = cursor(snapshot.cursor, '$.factoryRuntimeErrors.cursor');
  const acknowledged = cursor(snapshot.acknowledged_through, '$.factoryRuntimeErrors.acknowledged_through');
  if (acknowledged > high || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) fail('codex_sidecar_cursor');
  return recordsProjection('codex-sidecar', high,
    projectSequencedRecords('codex-sidecar', snapshot.records, high, nulFingerprint, { recordHasProduct: false }));
}

function parseServerManagerExternal(value) {
  exact(value, ['schema', 'cursor', 'events'], '$');
  if (value.schema !== 'dotagents.external-events.v1') fail('servermanager_schema');
  exact(value.cursor, ['high_watermark', 'acknowledged_through', 'next'], '$.cursor');
  const high = cursor(value.cursor.high_watermark, '$.cursor.high_watermark');
  const acknowledged = cursor(value.cursor.acknowledged_through, '$.cursor.acknowledged_through');
  const next = cursor(value.cursor.next, '$.cursor.next');
  if (acknowledged > high || next > high || !Array.isArray(value.events) || value.events.length > MAX_RECORDS) fail('servermanager_cursor');
  let prior = acknowledged;
  const runtimeErrors = [];
  const resolutions = [];
  const seen = new Set();
  for (const [index, event] of value.events.entries()) {
    const path = `$.events[${index}]`;
    exact(event, ['sequence', 'fingerprint', 'check', 'reason', 'status', 'first_seen', 'last_seen', 'occurrence_count', 'resolved_at'], path);
    const sequence = positiveSafe(event.sequence, `${path}.sequence`);
    if (sequence !== prior + 1 || sequence > high || seen.has(event.fingerprint)
      || typeof event.check !== 'string' || typeof event.reason !== 'string'
      || !SERVERMANAGER_EVENT_REASONS[event.check]?.has(event.reason)
      || event.fingerprint !== serverManagerFingerprint(event.check, event.reason)) fail('servermanager_event');
    prior = sequence; seen.add(event.fingerprint);
    const first = utc(event.first_seen, `${path}.first_seen`);
    const last = utc(event.last_seen, `${path}.last_seen`);
    if (first > last || !positiveSafe(event.occurrence_count, `${path}.occurrence_count`)) fail('servermanager_event');
    if (event.status === 'open') {
      if (event.resolved_at !== null) fail('servermanager_event');
      runtimeErrors.push({
        error_code: `SERVERMANAGER.${event.check.toUpperCase()}_${event.reason.toUpperCase()}`,
        component: 'readiness', status: 'open', severity: ['database', 'schema'].includes(event.check) ? 'fatal' : 'high',
        fingerprint: event.fingerprint, message_template: 'ServerManager external outage event',
        occurrence_count: event.occurrence_count, first_seen: event.first_seen, last_seen: event.last_seen,
        state_schema_version: 'dotagents.external-events.v1',
      });
    } else if (event.status === 'resolved') {
      if (typeof event.resolved_at !== 'string' || utc(event.resolved_at, `${path}.resolved_at`) < last) fail('servermanager_event');
      resolutions.push({ fingerprint: event.fingerprint, resolved_at: event.resolved_at, reason_code: 'external_recovered' });
    } else fail('servermanager_event');
  }
  if ((value.events.length === 0 && (next !== 0 || acknowledged !== high)) || (value.events.length > 0 && next !== prior)) fail('servermanager_next_cursor');
  return readyProjection('servermanager', next, runtimeErrors, resolutions);
}

function serverManagerFingerprint(check, reason) {
  return createHash('sha256').update(`servermanager:${check}:${reason}`).digest('hex');
}

function recordsProjection(product, cursorValue, records) {
  const runtimeErrors = [];
  const resolutions = [];
  for (const record of records) {
    const { sequence: _sequence, resolved_at: resolvedAt, reason_code: reasonCode, ...wire } = record;
    if (record.status === 'resolved') {
      resolutions.push(validateResolution({
        fingerprint: record.fingerprint,
        resolved_at: resolvedAt,
        reason_code: reasonCode,
      }, `${product}.resolution`));
    } else runtimeErrors.push(wire);
  }
  assertUniqueAndDisjoint(runtimeErrors, resolutions);
  return readyProjection(product, cursorValue, runtimeErrors, resolutions);
}

function projectSequencedRecords(product, records, high, fingerprintFn, { recordHasProduct = true } = {}) {
  const projected = records.map((record, index) => {
    const path = `$.records[${index}]`;
    const keys = ['product_version', 'component', 'error_code', 'message_template', 'severity', 'fingerprint',
      'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version', 'os', 'arch', 'status',
      'resolved_at', 'reason_code', 'sequence'];
    if (recordHasProduct) keys.unshift('product');
    exact(record, keys, path);
    if (recordHasProduct && record.product !== product) fail(`${path}.product`);
    const common = validateCommonRecord(record, path);
    if ((record.status === 'open' && (record.resolved_at !== null || record.reason_code !== null))
      || (record.status === 'resolved'
        && (typeof record.resolved_at !== 'string' || record.reason_code !== 'operator_resolved'))) {
      fail(`${path}.resolution`);
    }
    if (record.status === 'resolved'
      && utc(record.resolved_at, `${path}.resolved_at`) < Date.parse(record.last_seen)) {
      fail(`${path}.resolution_chronology`);
    }
    const sequence = positiveSafe(record.sequence, `${path}.sequence`);
    if (sequence > high) fail(`${path}.sequence`);
    if (record.fingerprint !== fingerprintFn(product, record.component, record.error_code, record.message_template)) {
      fail(`${path}.fingerprint`);
    }
    return { ...common, resolved_at: record.resolved_at, reason_code: record.reason_code, sequence };
  });
  const sequences = new Set(projected.map((record) => record.sequence));
  if (sequences.size !== projected.length) fail(`${product}_duplicate_sequence`);
  return projected.sort((left, right) => left.sequence - right.sequence);
}

function projectNativeRecord(product, record, index) {
  const path = `$.runtime_errors[${index}]`;
  exact(record, ['error_code', 'component', 'status', 'severity', 'fingerprint', 'message_template',
    'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version'], path);
  const common = validateCommonRecord(record, path);
  if (common.status !== 'open') fail(`${path}.status`);
  if (record.fingerprint !== nulFingerprint(product, record.component, record.error_code, record.message_template)) {
    fail(`${path}.fingerprint`);
  }
  return common;
}

function validateCommonRecord(record, path) {
  if ('product_version' in record) boundedVersion(record.product_version, `${path}.product_version`);
  stableId(record.component, `${path}.component`);
  if (typeof record.error_code !== 'string' || record.error_code.length > 96 || !ERROR_CODE.test(record.error_code)) fail(`${path}.error_code`);
  if (!['fatal', 'high', 'warn', 'info'].includes(record.severity)) fail(`${path}.severity`);
  if (!['open', 'resolved'].includes(record.status)) fail(`${path}.status`);
  if (typeof record.fingerprint !== 'string' || !FINGERPRINT.test(record.fingerprint)) fail(`${path}.fingerprint`);
  safeText(record.message_template, `${path}.message_template`);
  positiveSafe(record.occurrence_count, `${path}.occurrence_count`);
  const first = utc(record.first_seen, `${path}.first_seen`);
  const last = utc(record.last_seen, `${path}.last_seen`);
  if (first > last) fail(`${path}.timestamp_order`);
  boundedVersion(record.state_schema_version, `${path}.state_schema_version`);
  if ('os' in record) stableId(record.os, `${path}.os`);
  if ('arch' in record) {
    if (typeof record.arch !== 'string' || record.arch.length < 1 || record.arch.length > 32 || !/^[A-Za-z0-9_-]+$/.test(record.arch)) fail(`${path}.arch`);
  }
  return {
    error_code: record.error_code,
    component: record.component,
    status: record.status,
    severity: record.severity,
    fingerprint: record.fingerprint,
    message_template: record.message_template,
    occurrence_count: record.occurrence_count,
    first_seen: record.first_seen,
    last_seen: record.last_seen,
    state_schema_version: record.state_schema_version,
  };
}

function validateResolution(value, path) {
  exact(value, ['fingerprint', 'resolved_at', 'reason_code'], path);
  if (typeof value.fingerprint !== 'string' || !FINGERPRINT.test(value.fingerprint)) fail(`${path}.fingerprint`);
  utc(value.resolved_at, `${path}.resolved_at`);
  stableId(value.reason_code, `${path}.reason_code`);
  return { fingerprint: value.fingerprint, resolved_at: value.resolved_at, reason_code: value.reason_code };
}

function readyProjection(product, cursorValue, runtimeErrors, resolutions) {
  return { product, status: 'ready', cursor: cursorValue, runtime_errors: runtimeErrors, resolutions, acknowledgement: null };
}

function emptyProjection(product, status) {
  return { product, status, cursor: 0, runtime_errors: [], resolutions: [], acknowledgement: null };
}

function assertUniqueAndDisjoint(runtimeErrors, resolutions) {
  const open = new Set();
  for (const item of runtimeErrors) {
    if (open.has(item.fingerprint)) fail('duplicate_fingerprint');
    open.add(item.fingerprint);
  }
  const resolved = new Set();
  for (const item of resolutions) {
    if (resolved.has(item.fingerprint) || open.has(item.fingerprint)) fail('fingerprint_state_conflict');
    resolved.add(item.fingerprint);
  }
}

function arrays(...values) {
  if (values.some((value) => !Array.isArray(value) || value.length > MAX_RECORDS)) fail('record_limit');
  if (values.reduce((sum, value) => sum + value.length, 0) > MAX_RECORDS) fail('record_limit');
}

function parseJsonObject(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) fail('output_invalid');
  let value;
  try { value = JSON.parse(stdout); } catch { fail('json_invalid'); }
  if (!isObject(value)) fail('json_invalid');
  return value;
}

function exact(value, keys, path) {
  if (!isObject(value)) fail(`${path}_object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(`${path}_fields`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cursor(value, path) {
  if (!nonnegative(value)) fail(path);
  return value;
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafe(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(path);
  return value;
}

function stableId(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !STABLE_ID.test(value)) fail(path);
}

function boundedVersion(value, path) {
  if (typeof value !== 'string' || !VERSION.test(value)) fail(path);
}

function safeText(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || FORBIDDEN_TEXT.test(value)) fail(path);
}

function utc(value, path) {
  if (typeof value !== 'string') fail(path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(path);
  return parsed;
}

function nulFingerprint(product, component, errorCode, template) {
  return createHash('sha256').update([product, component, errorCode, template].join('\0')).digest('hex');
}

function spotterFingerprint(product, component, errorCode, template) {
  return createHash('sha256').update(['factory-v1', product, component, errorCode, template].join('\n')).digest('hex');
}

function contractError(code, product) {
  const detail = product ? `${product}:${code}` : code;
  return Object.assign(new Error(`runtime error adapter contract failed: ${detail}`), {
    code: 'E_FACTORY_RUNTIME_ERRORS',
    reason_code: code,
    ...(product ? { product_id: product } : {}),
  });
}

function fail(code) {
  throw contractError(code);
}
