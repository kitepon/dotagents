import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'bin', 'factory-reporter.mjs');
const PRODUCT_IDS = ['caveat', 'throughline', 'spotter', 'codegraph', 'markitdown', 'oracle', 'aiterm-mcp', 'codex-sidecar', 'servermanager'];
const roots = [];

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'factory-reporter-test-'));
  roots.push(root);
  return { root, state: join(root, 'state'), config: join(root, 'config.json'), report: join(root, 'report.json'), credential: join(root, 'credential') };
}

function report(id = '018f0000-0000-8000-8000-000000000001') {
  return {
    schema_version: '1.0', report_id: id, host_id: 'test-host', host_profile: 'mac',
    platform: { os: 'darwin', arch: 'arm64' }, report_mode: 'full',
    observed_at: '2026-07-13T00:00:00Z', created_at: '2026-07-13T00:00:01Z',
    reporter: { version: '1.0.0', dotagents_revision: '1234567' },
    products: Object.fromEntries(PRODUCT_IDS.map((id) => [id, { presence_status: 'missing', contract_version: '1.0', checks: [], runtime_errors: [], resolutions: [] }])),
  };
}

async function writeReport(box, body = report()) { await writeFile(box.report, JSON.stringify(body, null, 2)); return readFile(box.report); }
async function writeConfig(box, endpoint, enabled = true, hostId = 'test-host', hostProfile = 'mac') {
  await writeFile(box.credential, 'unit-test-token\n', { mode: 0o600 });
  await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: hostId, profile: hostProfile }, collection: { enabled: false }, reporting: enabled ? { enabled: true, endpoint, credential_file: box.credential } : { enabled: false } }));
}
function run(box, args, extra = {}, cli = CLI) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, XDG_STATE_HOME: box.state, XDG_CONFIG_HOME: join(box.root, 'config-home'), LOCALAPPDATA: box.state, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null }));
  });
}

test('配布symlink経由でもv1 reporterがmainを実行する', async () => {
  const box = await sandbox(); const link = join(box.root, 'factory-reporter');
  await symlink(CLI, link); await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api/factory/v1/reports');
  const result = await run(box, ['preview', '--report', box.report, '--config', box.config], {}, link);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json?.ok, true); assert.equal(result.json?.command, 'preview');
});
async function startServer(handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    await handler(req, res, received.length);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { received, endpoint: `http://127.0.0.1:${server.address().port}/api/factory/v1/reports`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}
function accepted(res, id, duplicate = false) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accepted: true, duplicate, report_id: id })); }
function queueDir(box) { return join(box.state, 'dotagents', 'factory-reporter', 'outbox'); }
function deadDir(box) { return join(box.state, 'dotagents', 'factory-reporter', 'dead-letter'); }

after(async () => { for (const root of roots) await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); });

test('reporting OFFはenqueueとnetworkを行わず既存outboxを保持する', async () => {
  const box = await sandbox(); const server = await startServer(() => assert.fail('network must not run'));
  await writeReport(box); await writeConfig(box, server.endpoint, false);
  await mkdir(queueDir(box), { recursive: true }); await writeFile(join(queueDir(box), 'existing.json'), '{}');
  const enqueue = await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const flush = await run(box, ['flush', '--config', box.config]);
  assert.equal(enqueue.code, 0); assert.equal(enqueue.json.enqueued, false); assert.equal(flush.json.retained, 1);
  assert.equal(server.received.length, 0); assert.deepEqual(await readdir(queueDir(box)), ['existing.json']); await server.close();
});

test('設定ファイルなしはcollection/reportingともfail closedになる', async () => {
  const box = await sandbox(); await writeReport(box);
  const result = await run(box, ['enqueue', '--report', box.report]);
  assert.equal(result.code, 0); assert.equal(result.json.reporting_enabled, false); assert.equal(result.json.enqueued, false);
});

test('previewはnetworkゼロでreportを検証する', async () => {
  const box = await sandbox(); const server = await startServer(() => assert.fail('preview must not network'));
  await writeReport(box); await writeConfig(box, server.endpoint);
  const result = await run(box, ['preview', '--report', box.report, '--config', box.config]);
  assert.equal(result.code, 0); assert.equal(result.json.report_id, report().report_id); assert.equal(server.received.length, 0); await server.close();
});

test('config.hostとreport host identityの不一致はpreview/enqueueで拒否する', async () => {
  const box = await sandbox(); await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api', true, 'other-host');
  for (const command of ['preview', 'enqueue']) { const result = await run(box, [command, '--report', box.report, '--config', box.config]); assert.equal(result.code, 1); assert.match(result.stderr, /identity.*一致/); }
  await writeConfig(box, 'http://127.0.0.1:1/api', true, 'test-host', 'wsl');
  const profileMismatch = await run(box, ['preview', '--report', box.report, '--config', box.config]); assert.equal(profileMismatch.code, 1); assert.match(profileMismatch.stderr, /identity.*一致/);
});

test('同一report_idは同bytesのみduplicateであり、異なるbytesはcollisionとして既存を保持する', async () => {
  const box = await sandbox(); const first = await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api');
  assert.equal((await run(box, ['enqueue', '--report', box.report, '--config', box.config])).json.enqueued, true);
  assert.equal((await run(box, ['enqueue', '--report', box.report, '--config', box.config])).json.enqueued, false);
  const changed = report(); changed.reporter.version = '1.0.1'; await writeReport(box, changed);
  const collision = await run(box, ['enqueue', '--report', box.report, '--config', box.config]); assert.equal(collision.code, 1); assert.match(collision.stderr, /collision/);
  assert.deepEqual(await readFile(join(queueDir(box), `${report().report_id}.json`)), first);
});

test('privacy禁止key/patternを含むreportはenqueue前に拒否する', async () => {
  const box = await sandbox(); const unsafe = report(); unsafe.reporter.version = 'Bearer leaked-value'; await writeReport(box, unsafe);
  const result = await run(box, ['preview', '--report', box.report]);
  assert.equal(result.code, 1); assert.match(result.stderr, /privacy禁止pattern/); assert.doesNotMatch(result.stderr, /leaked-value/);
});

test('ServerManager schema/semantic validatorのnegative fixtureを拒否する', async () => {
  const fp = 'a'.repeat(64);
  const failingCheck = () => ({ check_id: 'diagnostic', status: 'fail', severity: 'warn', fingerprint: fp, message_template: 'safe template', occurrence_count: 1, first_seen: '2026-07-13T00:00:00Z', last_seen: '2026-07-13T00:00:00Z' });
  const runtime = (status = 'open') => ({ error_code: 'TEST.FAILURE', component: 'runner', status, severity: 'warn', fingerprint: fp, message_template: 'safe template', occurrence_count: 1, first_seen: '2026-07-13T00:00:00Z', last_seen: '2026-07-13T00:00:00Z' });
  const resolution = () => ({ fingerprint: fp, resolved_at: '2026-07-13T00:00:00Z', reason_code: 'fixed' });
  const fixtures = [
    ['top additionalProperties', (r) => { r.extra = true; }],
    ['reporter additionalProperties', (r) => { r.reporter.extra = true; }],
    ['platform additionalProperties', (r) => { r.platform.extra = true; }],
    ['product additionalProperties', (r) => { r.products.caveat.extra = true; }],
    ['check conditional failure fields', (r) => { r.products.caveat.checks = [{ check_id: 'diagnostic', status: 'pass', severity: 'warn' }]; }],
    ['runtimeError additionalProperties', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), extra: true }]; }],
    ['resolution additionalProperties', (r) => { r.products.caveat.resolutions = [{ ...resolution(), extra: true }]; }],
    ['safe_context type/key', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), safe_context: { Bad: [] } }]; }],
    ['safe_context initial empty allowlist', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), safe_context: { safe: true } }]; }],
    ['contract_version required', (r) => { delete r.products.caveat.contract_version; }],
    ['host profile platform consistency', (r) => { r.platform.os = 'linux'; }],
    ['timestamp order', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), first_seen: '2026-07-13T00:00:02Z', last_seen: '2026-07-13T00:00:01Z' }]; }],
    ['fingerprint duplicate', (r) => { r.products.caveat.checks = [failingCheck(), { ...failingCheck(), check_id: 'other' }]; }],
    ['stderr丸投げ', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), stderr: 'raw-stderr-secret' }]; }],
    ['stack丸投げ', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), stack: 'raw-stack-secret' }]; }],
    ['exception丸投げ', (r) => { r.products.caveat.runtime_errors = [{ ...runtime(), exception: { message: 'raw-exception-secret' } }]; }],
    ['複数layerで同一失敗', (r) => { r.products.caveat.checks = [failingCheck()]; r.products.caveat.runtime_errors = [runtime('open')]; }],
    ['open resolve conflict', (r) => { r.products.caveat.runtime_errors = [runtime('open')]; r.products.caveat.resolutions = [resolution()]; }],
  ];
  for (const [name, mutate] of fixtures) {
    const box = await sandbox(); const invalid = report(); mutate(invalid); await writeReport(box, invalid);
    const result = await run(box, ['preview', '--report', box.report]); assert.equal(result.code, 1, name); assert.equal(result.json.code, 'FACTORY_REPORTER_ERROR', name);
    assert.doesNotMatch(result.stderr, /raw-(?:stderr|stack|exception)-secret/, name);
  }
});

test('不正UTF-8のconfig/reportとoptional config fieldは拒否する', async () => {
  const reportBox = await sandbox(); await writeFile(reportBox.report, Buffer.from([0xff, 0xfe]));
  const invalidReport = await run(reportBox, ['preview', '--report', reportBox.report]); assert.equal(invalidReport.code, 1); assert.match(invalidReport.stderr, /report JSON/);
  const configBox = await sandbox(); await writeReport(configBox); await writeFile(configBox.config, Buffer.from([0xff, 0xfe]));
  const invalidConfig = await run(configBox, ['preview', '--report', configBox.report, '--config', configBox.config]); assert.equal(invalidConfig.code, 1); assert.match(invalidConfig.stderr, /設定JSON/);
  await writeFile(configBox.config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: 'mac' }, collection: { enabled: false }, reporting: { enabled: false, endpoint: 'ftp://example.test', credential_file: '' } }));
  const invalidOptional = await run(configBox, ['preview', '--report', configBox.report, '--config', configBox.config]); assert.equal(invalidOptional.code, 1); assert.match(invalidOptional.stderr, /endpoint/);
});

test('config host profile/additional fieldと旧reporting.host_idを拒否する', async () => {
  const cases = [
    { host: { id: 'test-host', profile: 'desktop' }, collection: { enabled: false }, reporting: { enabled: false } },
    { host: { id: 'test-host', profile: 'mac', extra: true }, collection: { enabled: false }, reporting: { enabled: false } },
    { host: { id: 'test-host', profile: 'mac' }, collection: { enabled: false }, reporting: { enabled: false, host_id: 'test-host' } },
  ];
  for (const config of cases) {
    const box = await sandbox(); await writeReport(box); await writeFile(box.config, JSON.stringify({ schema_version: '1.0', ...config }));
    const result = await run(box, ['preview', '--report', box.report, '--config', box.config]); assert.equal(result.code, 1);
  }
});

test('accepted responseのみoutboxから削除する', async () => {
  const box = await sandbox(); const payload = await writeReport(box);
  const server = await startServer((req, res) => accepted(res, report().report_id)); await writeConfig(box, server.endpoint);
  assert.equal((await run(box, ['enqueue', '--report', box.report, '--config', box.config])).json.enqueued, true);
  const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.json.sent, 1); assert.deepEqual(await readdir(queueDir(box)), []);
  assert.deepEqual(server.received[0].body, payload); assert.match(server.received[0].headers['x-factory-sent-at'], /Z$/); await server.close();
});

test('duplicate accepted responseも同一report_idなら削除する', async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer((req, res) => accepted(res, report().report_id, true)); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.json.sent, 1); assert.equal(server.received.length, 1); await server.close();
});

test('受理後の削除失敗は同じbytesを保持し、duplicate再受理後だけ削除する', async () => {
  const box = await sandbox(); const payload = await writeReport(box); let calls = 0;
  const target = join(queueDir(box), `${report().report_id}.json`); const backup = `${target}.accepted`;
  const server = await startServer(async (req, res) => {
    const duplicate = calls++ > 0;
    if (!duplicate) { await rename(target, backup); await mkdir(target); }
    accepted(res, report().report_id, duplicate);
  }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const interrupted = await run(box, ['flush', '--config', box.config]);
  assert.equal(interrupted.code, 1); assert.deepEqual(await readFile(backup), payload);
  await rm(target, { recursive: true }); await rename(backup, target);
  const retried = await run(box, ['flush', '--config', box.config]);
  assert.equal(retried.code, 0); assert.equal(retried.json.sent, 1); assert.deepEqual(await readdir(queueDir(box)), []);
  assert.deepEqual(server.received[0].body, payload); assert.deepEqual(server.received[1].body, payload); await server.close();
});

test('flushはoutbox reportとconfigのhost不一致をnetworkなしでdead-letterへ隔離する', async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer(() => assert.fail('host mismatch must not network')); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); await writeConfig(box, server.endpoint, true, 'test-host', 'wsl');
  const flushed = await run(box, ['flush', '--config', box.config]); assert.equal(flushed.json.dead_lettered, 1); assert.equal(server.received.length, 0); assert.equal((await readdir(deadDir(box))).length, 1); await server.close();
  assert.equal(flushed.code, 1); assert.equal(flushed.json.ok, false); assert.match(flushed.stderr, /永久拒否/);
});

for (const status of [409, 413, 422]) test(`HTTP ${status} はdead-letterへ隔離する`, async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer((req, res) => { res.statusCode = status; res.end('{}'); }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.code, 1); assert.equal(flushed.json.ok, false); assert.equal(flushed.json.dead_lettered, 1); assert.match(flushed.stderr, /永久拒否/); assert.equal((await readdir(deadDir(box))).length, 1); await server.close();
});

for (const status of [401, 429]) test(`HTTP ${status} は復旧可能としてoutboxを保持する`, async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer((req, res) => { res.statusCode = status; res.end('{}'); }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.code, 1); assert.equal(flushed.json.ok, false); assert.equal(flushed.json.retained, 1); assert.match(flushed.stderr, /未送信report/); assert.equal((await readdir(queueDir(box))).length, 1); await server.close();
});

test('500後は本文bytesを変えず再送する（crash/応答消失と同じ保持経路）', async () => {
  const box = await sandbox(); const payload = await writeReport(box); let calls = 0;
  const server = await startServer((req, res) => { calls++; if (calls === 1) { res.statusCode = 500; return res.end('{}'); } accepted(res, report().report_id); }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const retained = await run(box, ['flush', '--config', box.config]);
  assert.equal(retained.code, 1); assert.equal(retained.json.ok, false); assert.equal(retained.json.retained, 1);
  assert.equal((await run(box, ['flush', '--config', box.config])).json.sent, 1);
  assert.deepEqual(server.received[0].body, payload); assert.deepEqual(server.received[1].body, payload); await server.close();
});

test('timeoutはoutboxを保持する', async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer(async () => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_500)); }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.code, 1); assert.equal(flushed.json.ok, false); assert.equal(flushed.json.retained, 1); assert.equal((await readdir(queueDir(box))).length, 1); await server.close();
});

test('single-flight lockは並行flushを拒否する', async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer(async (req, res) => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 400)); accepted(res, report().report_id); }); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const first = run(box, ['flush', '--config', box.config]); await new Promise((resolveDelay) => setTimeout(resolveDelay, 80)); const second = await run(box, ['flush', '--config', box.config]);
  assert.equal(second.code, 1); assert.equal(second.json.code, 'FACTORY_REPORTER_ERROR'); assert.match(second.stderr, /すでに実行中/); assert.equal((await first).json.sent, 1); await server.close();
});

test('crash後の死んだPID lockは回収してoutboxを再送できる', async () => {
  const box = await sandbox(); await writeReport(box); const server = await startServer((req, res) => accepted(res, report().report_id)); await writeConfig(box, server.endpoint);
  await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const lock = join(box.state, 'dotagents', 'factory-reporter', 'flush.lock'); await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'pid'), '999999');
  const flushed = await run(box, ['flush', '--config', box.config]); assert.equal(flushed.json.sent, 1); await server.close();
});

test('outbox overflowは既存queueを保持して新規enqueueを拒否する', async () => {
  const box = await sandbox(); const payload = await writeReport(box); const server = await startServer(() => assert.fail('network must not run')); await writeConfig(box, server.endpoint);
  await mkdir(queueDir(box), { recursive: true }); for (let i = 0; i < 128; i++) await writeFile(join(queueDir(box), `queued-${i}.json`), payload);
  const result = await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  assert.equal(result.code, 1); assert.match(result.stderr, /outbox上限超過/); assert.equal((await readdir(queueDir(box))).length, 128); assert.equal(server.received.length, 0); await server.close();
});

test('malformed outbox itemはflushを塞がずdead-letterへ隔離する', async () => {
  const box = await sandbox(); const server = await startServer(() => assert.fail('malformed must not network')); await writeConfig(box, server.endpoint);
  await mkdir(queueDir(box), { recursive: true }); await writeFile(join(queueDir(box), 'broken.json'), '{bad');
  const flushed = await run(box, ['flush', '--config', box.config]); assert.equal(flushed.code, 1); assert.equal(flushed.json.ok, false); assert.equal(flushed.json.dead_lettered, 1); assert.equal((await readdir(deadDir(box))).length, 1); await server.close();
});
