import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { validateReportV7, validateReportV8 } from '../../lib/factory/contract.mjs';
import { V7_PRODUCT_IDS } from '../../lib/factory/v7.mjs';
import { projectUnaiFactory, unaiProduct, V8_PRODUCT_IDS } from '../../lib/factory/v8.mjs';

const EXPECTED = [...V7_PRODUCT_IDS, 'unai'];
const NOW = '2026-08-29T00:00:00.000Z';

const product = (contractVersion = '8.0') => ({
  presence_status: 'installed', installed_version: '0.2.0', contract_version: contractVersion,
  checks: [], runtime_errors: [], resolutions: [],
});

function readyDiagnostic() {
  return {
    schema: 'unai.native_factory_diagnostics.v1',
    product: { name: 'unai', version: '0.2.0' },
    checks: { manifest_consistency: 'pass', node_runtime: 'pass', skill_bundle: 'pass' },
    overall: 'ready',
  };
}

function reportV8() {
  return {
    schema_version: '8.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904',
    host_id: 'mac-kite', host_profile: 'mac', platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full', observed_at: NOW, created_at: NOW,
    reporter: { version: '8.0.0', dotagents_revision: 'abc1234' },
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

test('v8はv7順序を保持してunaiを15番目へ追加する', () => {
  assert.deepEqual(V8_PRODUCT_IDS, EXPECTED);
  assert.equal(new Set(V8_PRODUCT_IDS).size, 15);
});

test('v7/v8の追加製品failure時刻はreport観測時刻を越えない', async () => {
  const v7Source = await readFile(resolve(import.meta.dirname, '../../lib/factory/v7.mjs'), 'utf8');
  const v8Source = await readFile(resolve(import.meta.dirname, '../../lib/factory/v8.mjs'), 'utf8');
  assert.match(v7Source, /peertableProduct\(\{ \.\.\.options, now: prior\.report\.observed_at \}\)/u);
  assert.match(v8Source, /unaiProduct\(\{ \.\.\.options, now: prior\.report\.observed_at \}\)/u);
  assert.doesNotMatch(v7Source, /peertableProduct\(\{ \.\.\.options, now: new Date/u);
  assert.doesNotMatch(v8Source, /unaiProduct\(\{ \.\.\.options, now: new Date/u);
});

test('v8 validatorは固定15製品だけを受理し、v7を変更しない', () => {
  const report = reportV8();
  assert.doesNotThrow(() => validateReportV8(report));
  assert.throws(() => validateReportV8({ ...report, products: Object.fromEntries(V7_PRODUCT_IDS.map((id) => [id, product()])) }), /固定15製品/u);
  const v7 = { ...report, schema_version: '7.0', reporter: { ...report.reporter, version: '7.0.0' }, products: Object.fromEntries(V7_PRODUCT_IDS.map((id) => [id, product('7.0')])) };
  assert.doesNotThrow(() => validateReportV7(v7));
  assert.throws(() => validateReportV7({ ...v7, products: { ...v7.products, unai: product('7.0') } }), /未定義field/u);
});

test('projectUnaiFactoryはnative diagnosticsをcompatible/passへ投影する', () => {
  const projected = projectUnaiFactory(readyDiagnostic(), true, NOW);
  assert.equal(projected.installed_version, '0.2.0');
  assert.equal(projected.compatibility_status, 'compatible');
  assert.ok(projected.checks.every((item) => item.status === 'pass'));
});

test('projectUnaiFactoryはfailを固定fingerprintへ投影し、exit不一致を拒否する', () => {
  const fixture = readyDiagnostic(); fixture.checks.skill_bundle = 'fail'; fixture.overall = 'not_ready';
  const projected = projectUnaiFactory(fixture, false, NOW);
  const failed = projected.checks.find((item) => item.check_id === 'skill_bundle');
  assert.equal(projected.compatibility_status, 'incompatible');
  assert.equal(failed.status, 'fail');
  assert.match(failed.fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(projectUnaiFactory(fixture, false, NOW).checks.find((item) => item.check_id === 'skill_bundle').fingerprint, failed.fingerprint);
  assert.throws(() => projectUnaiFactory(readyDiagnostic(), false, NOW), /unai_exit_mismatch/u);
});

test('unaiProductは公式CLI診断を読み、CLI不在をmissingへ投影する', async () => {
  const calls = []; let available = false;
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return available
      ? { ok: true, code: 0, reason: null, stdout: JSON.stringify(readyDiagnostic()), stderr: '' }
      : { ok: false, code: null, reason: 'spawn', error: { code: 'ENOENT' }, stdout: '', stderr: '' };
  };
  const missing = await unaiProduct({ cwd: '/work', now: NOW, platform: 'darwin', runCommand });
  assert.equal(missing.presence_status, 'missing');
  available = true;
  const installed = await unaiProduct({ cwd: '/work', now: NOW, platform: 'darwin', runCommand });
  assert.equal(installed.presence_status, 'installed');
  assert.equal(installed.compatibility_status, 'compatible');
  assert.deepEqual(calls, [
    { command: 'unai', args: ['factory-diagnostics', '--json'], options: { cwd: '/work' } },
    { command: 'unai', args: ['factory-diagnostics', '--json'], options: { cwd: '/work' } },
  ]);
});

test('Windowsのunai診断は公式固定配置だけをPowerShell 7経由で読む', async () => {
  const calls = [];
  const installed = await unaiProduct({
    cwd: 'C:\\work', now: NOW, platform: 'win32', home: 'C:\\Users\\kite',
    runCommand: async () => { throw new Error('bare commandを使ってはいけません'); },
    runPowerShellScript: async (script, args, options) => {
      calls.push({ script, args, options });
      return { ok: true, code: 0, reason: null, stdout: JSON.stringify(readyDiagnostic()), stderr: '' };
    },
  });
  assert.equal(installed.presence_status, 'installed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, 'C:\\Users\\kite\\.local\\bin\\unai.ps1');
  assert.deepEqual(calls[0].args, ['factory-diagnostics', '--json']);
  assert.equal(calls[0].options.cwd, 'C:\\work');
});

test('v8 reporterはv8 reportだけを専用stateで受理する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v8-reporter-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json'); const configPath = join(root, 'config.json');
  const reporter = resolve(import.meta.dirname, '../../bin/factory-reporter-v8.mjs');
  await writeFile(reportPath, JSON.stringify(reportV8()));
  await writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: false }, reporting: { enabled: false } }));
  const preview = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], { XDG_STATE_HOME: join(root, 'state') });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(preview.json.report.schema_version, '8.0');
  const v7 = reportV8(); v7.schema_version = '7.0'; v7.reporter.version = '7.0.0'; delete v7.products.unai; for (const value of Object.values(v7.products)) value.contract_version = '7.0';
  await writeFile(reportPath, JSON.stringify(v7));
  const rejected = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], { XDG_STATE_HOME: join(root, 'state') });
  assert.equal(rejected.code, 1); assert.equal(rejected.json.code, 'FACTORY_REPORTER_V8_ERROR');
  assert.match(await readFile(reporter, 'utf8'), /factory-reporter-v5\.mjs/u);
});

test('schedulerはv8 endpoint・runner・専用stateを同じmajorへ束縛する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v8-scheduler-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json'); const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, 'unit-test-token\n', { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: true }, reporting: { enabled: true, endpoint: 'http://127.0.0.1:1/api/factory/v8/reports', credential_file: credentialPath } }));
  const result = await run(resolve(import.meta.dirname, '../../bin/factory-reporter-scheduler.mjs'), ['install', '--dry-run', '--platform', 'darwin', '--wire-major', 'v8', '--config', configPath], { HOME: root, XDG_STATE_HOME: join(root, 'state') });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json.wire_major, 'v8');
  assert.match(result.json.artifact_content, /factory-reporter-v8-schedule-runner/u); assert.match(result.json.state, /factory-reporter-v8$/u);
});
