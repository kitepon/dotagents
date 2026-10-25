import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRabbitObservationOnce, RABBIT_OBSERVATION_ONCE } from '../../lib/factory/rabbit-observation-once.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';
const linux = { skip: process.platform !== 'linux' };
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rabbit-once-')), root = join(directory, 'once'); mkdirSync(root, { mode: 0o700 });
  const scope = structuredClone(RABBIT_OBSERVATION_ONCE.scope); scope.state_directory = root; scope.principal.uid = process.getuid();
  let time = Date.parse(scope.window.scheduled_capture);
  const gate = createRabbitObservationOnce(scope, { clock: () => time });
  const revision = 'a'.repeat(40), receipt = 'fixture:rabbit-supply';
  const permit = { schema: 'dotagents.rabbit-observation-permit.v1', status: 'approved', scope_sha256: gate.scopeSha,
    owner_decision_ref: 'K-FIXTUR', factory_revision: revision, max_opt_in_calls: 1, max_send_attempts: 1,
    host_readback: { host_id: 'rabbit', product_id: 'dotagents-rabbit', principal_user: 'kite', principal_uid: scope.principal.uid,
      factory_checkout: scope.factory_checkout.path, factory_revision: revision, state_directory: root, image_kind: 'native_no_container',
      receipt_ref: 'fixture:readback', receipt_sha256: 'c'.repeat(64) },
    product_supply: { status: 'supplied', host_id: 'rabbit', version: '0.16.5', tarball_sha256: scope.package.tarball_sha256,
      receipt_ref: receipt, receipt_sha256: 'b'.repeat(64), completed_at: scope.package_window.install_complete_by,
      confirmed_at: '2026-10-25T20:14:00.000Z' },
    readiness: { schema: 'dotagents.gpt-observation-path.v1',
      central_release: { status: 'released', ref: `fixture:${scope.central_revision}` },
      validator_adoption: { status: 'adopted', ref: 'fixture:validator' },
      product_cli_adoption: { status: 'adopted', ref: receipt },
      factory_entry_adoption: { status: 'adopted', ref: `fixture:${revision}` } } };
  const writePermit = value => writeFileSync(join(root, 'approved-permit.json'), bytes(value), { mode: 0o600 });
  const context = { gpt_obs_schema: 'v1', gpt_auth_session_http: '401', gpt_auth_session_user: 'uninspected',
    gpt_bridge_present: 'false', gpt_bridge_version: 'uninspected', gpt_bridge_build: 'uninspected', gpt_bridge_summary: 'uninspected' };
  const report = () => ({ schema_version: '9.0', report_id: scope.report_id, host_id: 'rabbit', host_profile: 'linux', platform: { os: 'linux', arch: 'x64' },
    report_mode: 'full', observed_at: scope.window.scheduled_capture, created_at: scope.window.scheduled_capture,
    reporter: { version: '9.0.0', dotagents_revision: revision.slice(0, 7) }, products: Object.fromEntries(V9_PRODUCT_IDS.map(id => [id,
      { presence_status: 'installed', installed_version: id === 'gpt-connector' ? '0.16.5' : '1.0.0', contract_version: '9.0',
        checks: id === 'gpt-connector' ? [{ check_id: 'auth', status: 'skipped', reason_code: 'auth_required', safe_context: context }] : [], runtime_errors: [], resolutions: [] }])) });
  return { directory, root, scope, gate, permit, writePermit, report, setTime(value) { time = value; }, cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}

test('no approval/supply, wrong host or window never consumes capture', linux, () => {
  const f = fixture();
  try {
    assert.equal(f.gate.begin('rabbit'), null);
    f.writePermit({ ...f.permit, status: 'prepared' }); assert.equal(f.gate.begin('rabbit'), null);
    f.writePermit({ ...f.permit, product_supply: null }); assert.equal(f.gate.begin('rabbit'), null);
    f.writePermit(f.permit); assert.equal(f.gate.begin('fox'), null);
    f.setTime(Date.parse(f.scope.window.end) + 1); assert.equal(f.gate.begin('rabbit'), null);
    assert.equal(existsSync(join(f.root, 'capture.claim.json')), false);
    assert.throws(() => f.gate.claimSend(f.report(), bytes(f.report())), /gate_unconfirmed/);
  } finally { f.cleanup(); }
});
test('approved fixture reserves exactly one opt-in and keeps original body/status', linux, () => {
  const f = fixture();
  try {
    f.writePermit(f.permit); const first = f.gate.begin('rabbit'); assert.equal(first.reportId, f.scope.report_id);
    assert.deepEqual(first.entry.nativeArgs, ['factory-diagnostics', '--json', '--include-observation-context']);
    assert.equal(f.gate.begin('rabbit'), null);
    const report = f.report(), body = bytes(report), original = structuredClone(report);
    f.gate.finish(report, body); f.gate.validateReport(report, body);
    assert.deepEqual(report, original); assert.deepEqual(readFileSync(join(f.root, 'captured-report.json')), body);
    assert.equal(report.products['gpt-connector'].checks[0].status, 'skipped');
    assert.equal(f.gate.claimSend(report, body), true); assert.equal(f.gate.claimSend(report, body), false);
    f.gate.recordSend(report, body); assert.equal(JSON.parse(readFileSync(join(f.root, 'send.result.json'))).accepted, false);
    assert.throws(() => f.gate.claimSend(report, Buffer.from(`${body} `)), /gate_unconfirmed/);
  } finally { f.cleanup(); }
});
test('changed source, host or package cannot become the captured report', linux, () => {
  for (const change of ['revision', 'host', 'version']) {
    const f = fixture();
    try {
      f.writePermit(f.permit); f.gate.begin('rabbit'); const report = f.report();
      if (change === 'revision') report.reporter.dotagents_revision = 'ccccccc';
      if (change === 'host') report.host_id = 'fox';
      if (change === 'version') report.products['gpt-connector'].installed_version = '0.16.3';
      assert.throws(() => f.gate.finish(report, bytes(report)), /gate_unconfirmed/);
      assert.equal(existsSync(join(f.root, 'captured-report.json')), false);
      assert.equal(f.gate.begin('rabbit'), null);
    } finally { f.cleanup(); }
  }
});
test('expired send or consumed attempt is preserved outside retry queue', linux, () => {
  const f = fixture();
  try {
    f.writePermit(f.permit); f.gate.begin('rabbit'); const report = f.report(), body = bytes(report); f.gate.finish(report, body);
    f.setTime(Date.parse(f.scope.window.end) + 1); assert.equal(f.gate.claimSend(report, body), false);
    const outbox = join(f.directory, 'outbox'); mkdirSync(outbox, { mode: 0o700 }); const file = join(outbox, `${report.report_id}.json`);
    const envelope = bytes({ fixture_envelope: true, report_base64: body.toString('base64') }); writeFileSync(file, envelope, { mode: 0o600 });
    f.gate.holdOutbox(report, file); assert.equal(existsSync(file), false);
    assert.deepEqual(readFileSync(join(f.root, 'held-outbox.json')), envelope);
    assert.deepEqual(readFileSync(join(f.root, 'captured-report.json')), body);
  } finally { f.cleanup(); }
});
test('unsafe permit and partial durable claim never authorize another capture', linux, () => {
  const f = fixture();
  try {
    f.writePermit(f.permit); chmodSync(join(f.root, 'approved-permit.json'), 0o644); assert.equal(f.gate.begin('rabbit'), null);
    chmodSync(join(f.root, 'approved-permit.json'), 0o600);
    writeFileSync(join(f.root, 'capture.claim.json'), '{partial', { mode: 0o600 }); assert.equal(f.gate.begin('rabbit'), null);
    rmSync(join(f.root, 'capture.claim.json')); rmSync(join(f.root, 'approved-permit.json'));
    const outside = join(f.directory, 'private-sentinel'); writeFileSync(outside, 'private-value', { mode: 0o600 }); symlinkSync(outside, join(f.root, 'approved-permit.json'));
    assert.equal(f.gate.begin('rabbit'), null);
  } finally { f.cleanup(); }
});
test('ordinary legacy report stays compatible and never consumes the candidate gate', () => {
  const report = { schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904', host_id: 'mac-kite', host_profile: 'mac',
    platform: { os: 'darwin', arch: 'arm64' }, report_mode: 'full', observed_at: '2026-10-25T17:17:00.000Z', created_at: '2026-10-25T17:17:00.000Z',
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' }, products: Object.fromEntries(V9_PRODUCT_IDS.map(id => [id,
      { presence_status: 'unverified', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] }])) };
  assert.equal(RABBIT_OBSERVATION_ONCE.begin('mac-kite'), null); RABBIT_OBSERVATION_ONCE.validateReport(report);
  assert.equal(RABBIT_OBSERVATION_ONCE.claimSend(report, bytes(report)), true);
});

// Run the actual private reporter entry with injected transport, never HTTP or
// credential IO. This checks the new one-shot branch without invoking main().
async function reporterPost(gate, report, body, entry, fetch) {
  const source = readFileSync(new URL('../../bin/factory-reporter-v5.mjs', import.meta.url), 'utf8');
  const implementation = source.slice(source.indexOf('async function postOne('), source.indexOf('function parseArgs(', source.indexOf('async function postOne(')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('readFile', 'decode', 'IS_V9', 'RABBIT_OBSERVATION_ONCE', 'REQUEST_TIMEOUT_MS', 'fetch', 'WIRE', 'config', 'entry',
    `${implementation}; return postOne(config, 'fixture-token', {}, entry);`)(
    async file => readFileSync(file), stored => { gate.validateReport(report, stored); return { report, bytes: body, acknowledgements: null }; },
    true, gate, 500, fetch, {}, { host: { id: 'rabbit', profile: 'linux' }, reporting: { endpoint: 'https://fixture.invalid/api/factory/v9/reports' } }, entry);
}
test('actual reporter transport consumes once and preserves a failed attempt without retry or redirect', linux, async () => {
  const f = fixture();
  try {
    f.writePermit(f.permit); f.gate.begin('rabbit'); const report = f.report(), body = bytes(report); f.gate.finish(report, body);
    const outbox = join(f.directory, 'outbox'); mkdirSync(outbox, { mode: 0o700 }); const file = join(outbox, `${report.report_id}.json`);
    writeFileSync(file, body, { mode: 0o600 }); let calls = 0;
    const fetch = async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); assert.deepEqual(options.body, body); throw new Error('fixture-network'); };
    const result = await reporterPost(f.gate, report, body, { file }, fetch);
    assert.equal(result.action, 'hold'); assert.equal(calls, 1); assert.equal(existsSync(file), false);
    assert.deepEqual(readFileSync(join(f.root, 'held-outbox.json')), body);
    writeFileSync(file, body, { mode: 0o600 });
    const again = await reporterPost(f.gate, report, body, { file }, fetch);
    assert.equal(again.action, 'hold'); assert.equal(calls, 1); assert.equal(existsSync(file), false);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'send.result.json'))).http_status, null);
  } finally { f.cleanup(); }
});
test('late or time-inconsistent supply receipt cannot enable the candidate capture', linux, () => {
  const f = fixture();
  try {
    for (const times of [
      { completed_at: '2026-10-25T20:05:00.001Z', confirmed_at: '2026-10-25T20:14:00.000Z' },
      { completed_at: '2026-10-25T20:05:00.000Z', confirmed_at: '2026-10-25T20:15:00.000Z' },
      { completed_at: '2026-10-25T20:05:00.000Z', confirmed_at: '2026-10-25T20:04:00.000Z' },
    ]) {
      f.writePermit({ ...f.permit, product_supply: { ...f.permit.product_supply, ...times } });
      assert.equal(f.gate.begin('rabbit'), null);
    }
    assert.equal(existsSync(join(f.root, 'capture.claim.json')), false);
  } finally { f.cleanup(); }
});
