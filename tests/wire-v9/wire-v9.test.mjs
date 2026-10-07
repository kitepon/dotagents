import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { validateReportV8, validateReportV9 } from '../../lib/factory/contract.mjs';
import { V8_PRODUCT_IDS } from '../../lib/factory/v8.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';

const EXPECTED = [...V8_PRODUCT_IDS, 'jev-ultrafast', 'agent-desktop'];
const NOW = '2026-08-29T00:00:00.000Z';

const product = (contractVersion = '9.0') => ({
  presence_status: 'installed', installed_version: '0.2.0', contract_version: contractVersion,
  checks: [], runtime_errors: [], resolutions: [],
});

function reportV9() {
  return {
    schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904',
    host_id: 'mac-kite', host_profile: 'mac', platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full', observed_at: NOW, created_at: NOW,
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(EXPECTED.map((id) => [id, product()])),
  };
}

function run(script, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null }));
  });
}


test('v9は両第三者製品を必須にし、旧v8の集合を変更しない', () => {
  assert.deepEqual(V9_PRODUCT_IDS, EXPECTED);
  const report = reportV9();
  assert.doesNotThrow(() => validateReportV9(report));
  for (const id of ['jev-ultrafast', 'agent-desktop']) {
    const missing = structuredClone(report); delete missing.products[id];
    assert.throws(() => validateReportV9(missing));
  }
  const old = { ...report, schema_version: '8.0', products: Object.fromEntries(V8_PRODUCT_IDS.map(id => [id, product('8.0')])) };
  assert.doesNotThrow(() => validateReportV8(old));
  assert.throws(() => validateReportV8(report));
});
test('safe_contextの許可keyはlatticeの3つだけで、他製品と未定義keyは拒否する', () => {
  const runtimeError = (safeContext) => ({
    error_code: 'LATTICE.CLI_INTERNAL_FAILED', component: 'cli', status: 'open', severity: 'high',
    fingerprint: 'a'.repeat(64), message_template: 'Lattice CLI crashed outside the typed error contract',
    occurrence_count: 1, first_seen: NOW, last_seen: NOW, state_schema_version: '1.0',
    safe_context: safeContext,
  });
  const context = { command_kind: 'run.list', error_kind: 'TypeError', cause_code: 'ERR_MODULE_NOT_FOUND' };
  const withContext = (id, safeContext) => {
    const report = reportV9(); report.products[id].runtime_errors = [runtimeError(safeContext)]; return report;
  };
  assert.doesNotThrow(() => validateReportV9(withContext('lattice', context)));
  // 同じ許可keyはrollback先のv8でも通る（contractは全majorで共有）。
  const v8 = { ...reportV9(), schema_version: '8.0', products: Object.fromEntries(V8_PRODUCT_IDS.map((id) => [id, product('8.0')])) };
  v8.products.lattice.runtime_errors = [runtimeError(context)];
  assert.doesNotThrow(() => validateReportV8(v8));
  assert.throws(() => validateReportV9(withContext('lattice', { ...context, detail: 'x' })), /allowlist/u);
  assert.throws(() => validateReportV9(withContext('lattice', { ...context, cause_code: ['ENOENT'] })), /safe_context/u);
  for (const id of ['caveat', 'throughline', 'spotter', 'aiterm-mcp']) {
    assert.throws(() => validateReportV9(withContext(id, context)), /allowlist/u, id);
  }
});
test('v9 reporterはv9 reportだけを専用stateで受理する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v9-reporter-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json'); const configPath = join(root, 'config.json');
  const reporter = resolve(import.meta.dirname, '../../bin/factory-reporter-v9.mjs');
  await writeFile(reportPath, JSON.stringify(reportV9()));
  await writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: false }, reporting: { enabled: false } }));
  const preview = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], { XDG_STATE_HOME: join(root, 'state') });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(preview.json.report.schema_version, '9.0');
  const v8 = reportV9(); v8.schema_version = '8.0'; v8.reporter.version = '8.0.0'; delete v8.products['jev-ultrafast']; delete v8.products['agent-desktop']; for (const value of Object.values(v8.products)) value.contract_version = '8.0';
  await writeFile(reportPath, JSON.stringify(v8));
  const rejected = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], { XDG_STATE_HOME: join(root, 'state') });
  assert.equal(rejected.code, 1); assert.equal(rejected.json.code, 'FACTORY_REPORTER_V9_ERROR');
  assert.match(await readFile(reporter, 'utf8'), /factory-reporter-v5\.mjs/u);
});

test('flushは、BugHubへ届かなかった保留と、BugHubが応答した保留を分けて返す', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v9-flush-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json'); const configPath = join(root, 'config.json'); const credentialPath = join(root, 'credential');
  const reporter = resolve(import.meta.dirname, '../../bin/factory-reporter-v9.mjs');
  const env = { XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state') };
  const config = (port) => writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: true },
    reporting: { enabled: true, endpoint: `http://127.0.0.1:${port}/api/factory/v9/reports`, credential_file: credentialPath } }));
  const server = createServer((request, response) => { request.resume(); response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}'); });
  await new Promise((done) => { server.listen(0, '127.0.0.1', done); });
  const { port } = server.address();
  await new Promise((done) => { server.close(done); });
  await writeFile(credentialPath, 'unit-test-token\n', { mode: 0o600 });
  await writeFile(reportPath, JSON.stringify(reportV9()));
  await config(port);
  const enqueued = await run(reporter, ['enqueue', '--report', reportPath, '--config', configPath], env);
  assert.equal(enqueued.code, 0, enqueued.stderr);
  // 宛先が閉じている: 送信待ちに残り、届かなかった件数として数える。
  const unreachable = await run(reporter, ['flush', '--config', configPath], env);
  assert.equal(unreachable.code, 1, unreachable.stderr);
  assert.equal(unreachable.json.retained, 1); assert.equal(unreachable.json.unreachable, 1); assert.equal(unreachable.json.count, 1);
  // BugHubが応答して断った保留は、届かなかった件数に数えない。
  const responding = createServer((request, response) => { request.resume(); response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}'); });
  await new Promise((done) => { responding.listen(0, '127.0.0.1', done); });
  t.after(() => new Promise((done) => { responding.close(done); }));
  await config(responding.address().port);
  await new Promise((done) => { setTimeout(done, 300); });
  const refused = await run(reporter, ['flush', '--config', configPath], env);
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(refused.json.retained, 1); assert.equal(refused.json.unreachable, 0); assert.equal(refused.json.count, 1);
});

test('schedulerはv9 endpoint・runner・専用stateを同じmajorへ束縛する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v9-scheduler-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json'); const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, 'unit-test-token\n', { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: true }, reporting: { enabled: true, endpoint: 'http://128.0.0.1:1/api/factory/v9/reports', credential_file: credentialPath } }));
  const result = await run(resolve(import.meta.dirname, '../../bin/factory-reporter-scheduler.mjs'), ['install', '--dry-run', '--platform', 'darwin', '--config', configPath], { HOME: root, XDG_STATE_HOME: join(root, 'state') });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json.wire_major, 'v9');
  assert.match(result.json.artifact_content, /factory-reporter-v9-schedule-runner/u); assert.match(result.json.state, /factory-reporter-v9$/u);
});
