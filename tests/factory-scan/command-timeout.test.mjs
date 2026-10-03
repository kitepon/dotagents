import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { aishellProduct, serverManagerNative } from '../../lib/factory/scan.mjs';
import { scanV9 } from '../../lib/factory/v9.mjs';

const NOW = '2026-10-03T05:17:00.000Z';
const TIMED_OUT = Object.freeze({ ok: false, reason: 'timeout', stdout: '', stderr: '' });
const EXITED = Object.freeze({ ok: false, code: 1, reason: 'exit', stdout: '', stderr: '' });
const ok = (stdout) => ({ ok: true, code: 0, reason: null, stdout, stderr: '' });
const GIT = ok('abc1234\n');
const PROFILE = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'linux';

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'factory-command-timeout-'));
  const home = join(root, 'home');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const scan = (runCommand) => scanV9({
    host: { id: 'test-host', profile: PROFILE }, cwd: root, arch: 'x64', platform: process.platform, home,
    toolchainLedgerPath: join(root, 'toolchain-ledger.json'), runCommand,
  });
  return { home, scan };
}

const checks = (product) => product.checks.map((item) => [item.check_id, item.status, item.reason_code]);

test('時間切れはcli_timeoutで報告し、製品側の契約違反と区別する', { concurrency: false }, async (t) => {
  const box = await sandbox(t);
  const report = await box.scan(async (command) => command === 'git' ? GIT : TIMED_OUT);
  validateReportV9(report);

  for (const id of ['caveat', 'throughline', 'spotter', 'aiterm-mcp', 'gpt-connector', 'lattice', 'peertable', 'unai']) {
    assert.deepEqual(checks(report.products[id]), [['native_diagnostics', 'unverified', 'cli_timeout']], id);
    assert.equal(report.products[id].presence_status, 'unverified', id);
    assert.equal(report.products[id].installed_version, undefined, id);
  }
  assert.deepEqual(checks(report.products.markitdown), [['version', 'unverified', 'cli_timeout']]);
  for (const id of ['claude-code', 'codex-cli']) {
    assert.deepEqual(checks(report.products[id]).slice(0, 2), [
      ['installed_version', 'unverified', 'cli_timeout'], ['npm_latest', 'unverified', 'cli_timeout'],
    ], id);
    assert.equal(report.products[id].presence_status, 'unverified', id);
  }
  assert.deepEqual(checks(report.products['grok-build'])[0], ['stable_update', 'unverified', 'cli_timeout']);
  assert.deepEqual(checks(report.products['jev-ultrafast']), [['installation', 'unverified', 'cli_timeout']]);
  // 時間切れは製品の故障として数えない。
  const failed = Object.entries(report.products)
    .flatMap(([id, product]) => product.checks.filter((item) => item.status === 'fail').map((item) => `${id}:${item.check_id}`));
  assert.deepEqual(failed, []);

  const aishell = await aishellProduct({ runner: async () => TIMED_OUT, profile: 'mac' }, NOW);
  assert.deepEqual(checks(aishell), [['native_diagnostics', 'unverified', 'cli_timeout']]);
  const serverManager = await serverManagerNative({}, NOW, async () => TIMED_OUT);
  assert.deepEqual(checks(serverManager), [['external_readiness', 'unverified', 'cli_timeout']]);
});

test('製品が応答した時の理由コードは変えない', { concurrency: false }, async (t) => {
  const box = await sandbox(t);
  const report = await box.scan(async (command) => command === 'git' ? GIT : EXITED);
  for (const id of ['caveat', 'throughline', 'spotter', 'aiterm-mcp', 'lattice', 'peertable', 'unai']) {
    assert.deepEqual(checks(report.products[id]), [['native_diagnostics', 'unverified', 'native_schema_invalid']], id);
  }
  assert.deepEqual(checks(report.products['gpt-connector']), [['native_diagnostics', 'unverified', 'gpt_connector_diagnostics_schema']]);
  assert.deepEqual(checks(report.products['codex-cli']).slice(0, 2), [
    ['installed_version', 'unverified', 'cli_unavailable'], ['npm_latest', 'unverified', 'registry_unverified'],
  ]);
});

test('版の読み取りが時間切れの時、PATH上の別の導入の版を報告しない', { concurrency: false }, async (t) => {
  const box = await sandbox(t);
  const versionCalls = [];
  const runner = (first) => async (command, args) => {
    if (command === 'git') return GIT;
    if (command === 'npm' && args[0] === 'prefix') return ok('/opt/npm-global\n');
    if (command === 'codex' && args[0] === '--version') {
      versionCalls.push(args);
      return versionCalls.length === 1 ? first : ok('codex-cli 0.160.0\n');
    }
    return EXITED;
  };

  // npm global側に無い時は、今までどおりPATH上の導入を読む。
  let codex = (await box.scan(runner(EXITED))).products['codex-cli'];
  assert.equal(versionCalls.length, 2);
  assert.equal(codex.installed_version, '0.160.0');

  versionCalls.length = 0;
  codex = (await box.scan(runner(TIMED_OUT))).products['codex-cli'];
  assert.equal(versionCalls.length, 1);
  assert.equal(codex.presence_status, 'unverified');
  assert.equal(codex.installed_version, undefined);
  assert.deepEqual(checks(codex)[0], ['installed_version', 'unverified', 'cli_timeout']);
});

test('npm globalの場所を読めない時、codexを呼ばず未検証にする', { concurrency: false, skip: process.platform === 'win32' }, async (t) => {
  const box = await sandbox(t);
  const called = [];
  const report = await box.scan(async (command, args) => {
    if (command === 'git') return GIT;
    if (command === 'npm' && args[0] === 'prefix') return TIMED_OUT;
    if (['codex', 'claude'].includes(command)) { called.push(command); return ok(`${command} 0.160.0\n`); }
    return EXITED;
  });
  assert.deepEqual(called, []);
  assert.deepEqual(checks(report.products['codex-cli'])[0], ['installed_version', 'unverified', 'cli_timeout']);
  assert.equal(report.products['codex-cli'].installed_version, undefined);
});

test('codex features listの時間切れはconfig_parserをfailにしない', { concurrency: false }, async (t) => {
  const box = await sandbox(t);
  const hook = join(box.home, '.local', 'bin', 'codex-git-destroy-gate-hook');
  const command = process.platform === 'win32'
    ? `& "C:\\Python314\\python.exe" "${hook}"`
    : `/usr/bin/env python3 ${hook}`;
  await mkdir(join(box.home, '.codex'));
  await writeFile(join(box.home, '.codex', 'config.toml'),
    '[features]\nhooks = true\n\n[features.multi_agent_v2]\nhide_spawn_agent_metadata = false\ntool_namespace = "agents"\n');
  await writeFile(join(box.home, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command, timeout: 5, async: false, statusMessage: null }] }] },
  }));
  const runner = (parser) => async (name, args) => {
    if (name === 'git') return GIT;
    if (name === 'npm' && args[0] === 'prefix') return ok('/opt/npm-global\n');
    if (name === 'npm' && args[0] === 'view') return ok('"0.160.0"\n');
    if (name === 'codex' && args[0] === '--version') return ok('codex-cli 0.160.0\n');
    if (name === 'codex' && args[0] === 'features') return parser;
    return EXITED;
  };

  let codex = (await box.scan(runner(ok('hooks stable true\n')))).products['codex-cli'];
  assert.equal(codex.compatibility_status, 'compatible');
  assert.deepEqual(checks(codex).find(([id]) => id === 'config_parser'), ['config_parser', 'pass', undefined]);

  codex = (await box.scan(runner(TIMED_OUT))).products['codex-cli'];
  assert.equal(codex.compatibility_status, 'unverified');
  assert.deepEqual(checks(codex).find(([id]) => id === 'config_parser'), ['config_parser', 'unverified', 'cli_timeout']);
  assert.deepEqual(checks(codex).filter(([, status]) => status === 'fail'), []);

  // 応答した上での失敗は、今までどおり設定の故障として報告する。
  codex = (await box.scan(runner(EXITED))).products['codex-cli'];
  assert.equal(codex.compatibility_status, 'incompatible');
  assert.deepEqual(checks(codex).find(([id]) => id === 'config_parser'), ['config_parser', 'fail', 'config_parser_failed']);
});
