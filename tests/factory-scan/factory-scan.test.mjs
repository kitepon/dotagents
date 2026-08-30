import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, posix, resolve, win32 } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { resolveWindowsCommand, run as runCommand } from '../../lib/factory/command.mjs';
import { validateReport } from '../../lib/factory/contract.mjs';
import { writeCommandFixture } from './command-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'bin', 'factory-scan.mjs');
const COMMANDS = [
  'caveat', 'throughline', 'spotter', 'aiterm-mcp',
  'codex-sidecar', 'codegraph', 'markitdown', 'oracle',
];
const WINDOWS_FIXTURE_PATH = process.platform === 'win32' ? win32 : { ...posix, delimiter: ';' };

function validConfig(overrides = {}) {
  return {
    schema_version: '1.0',
    host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'server' },
    collection: { enabled: false },
    reporting: { enabled: false },
    ...overrides,
  };
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'factory-scan-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    bin,
    config: join(root, 'config.json'),
    output: join(root, 'report.json'),
    async script(name, body) {
      await writeCommandFixture(bin, name, body);
    },
  };
}

async function installHealthyCommands(box) {
  for (const name of COMMANDS) {
    await box.script(name, `
if [ "$1" = "--version" ]; then
  case "$0" in
    */codegraph) echo 'codegraph 1.4.0' ;;
    */markitdown) echo 'markitdown 0.1.0' ;;
    */oracle) echo 'oracle 0.16.0' ;;
    *) echo '${name} 1.2.3' ;;
  esac
elif [ "$1" = "status" ]; then
  echo '{"initialized":false}'
elif [ "$1" = "doctor" ]; then
  echo '{"healthy":true}'
else
  echo 'converted'
fi`);
  }
  await box.script('throughline', `
if [ "$1" = "--version" ]; then
  echo 'throughline 1.2.3'
elif [ "$1" = "factory-diagnostics" ] && [ "$2" = "--json" ]; then
  echo '{"schema":"throughline.native_factory_diagnostics.v1","version":"1.2.3","overall":{"status":"ready"},"databaseSchema":{"schema":"throughline.database.v8","status":"ready"}}'
else
  exit 2
fi`);
  await box.script('caveat', `
if [ "$1" = "factory-diagnostics" ] && [ "$2" = "--json" ]; then
  echo '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"1.2.3","overall":{"status":"ready"},"database":{"status":"ready","reason_code":"current","schema_version":3,"supported_schema_version":3,"migration_status":"current"},"sync":{"status":"ready","reason_code":"synchronized"},"connectors":{"claude":{"status":"ready","mcp":{"status":"ready","reason_code":"configured"},"hooks":{"user_prompt_submit":{"status":"ready","reason_code":"configured"},"post_tool_use":{"status":"ready","reason_code":"configured"},"post_tool_use_failure":{"status":"ready","reason_code":"configured"},"stop":{"status":"ready","reason_code":"configured"}}},"codex":{"status":"ready","hooks":{"user_prompt_submit":{"status":"ready","reason_code":"configured"},"post_tool_use":{"status":"ready","reason_code":"configured"},"stop":{"status":"ready","reason_code":"configured"}}}}}'
else
  exit 2
fi`);
  await box.script('spotter', `
if [ "$1" = "--version" ]; then
  echo 'spotter 1.2.3'
elif [ "$1" = "diagnostics" ] && [ "$2" = "factory" ]; then
  echo '{"schema_version":"1.0","product":"spotter","version":"1.2.3","overall_status":"pass","marker_schema_version":"2"}'
else
  exit 2
fi`);
  await box.script('codex-sidecar', `
if [ "$1" = "factory-diagnostics" ] && [ "$2" = "--project" ] && [ "$3" = "${box.root}" ]; then
  echo '{"status":"ok","factoryReadiness":{"schemaVersion":"1","overall":"ready","packageVersions":{"status":"ready","packages":{"cli":"1.2.3","core":"1.2.3","mcp":"1.2.3"}}}}'
else
  exit 2
fi`);
  await box.script('aiterm-mcp', `
if [ "$1" = "--version" ]; then
  echo 'aiterm-mcp 1.2.3'
else
  cat >/dev/null
  echo '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.2.3"}}}'
  echo '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"diagnostic_schema\\":\\"aiterm-mcp.factory-diagnostics.v1\\",\\"version\\":\\"1.2.3\\",\\"overall\\":\\"ready\\"}"}]}}'
fi`);
  await box.script('bughub-external-probe', `
echo '{"schema_version":"dotagents.bughub-external-probe.v1","product_version":"0.1.0","source_revision":"0123456789abcdef0123456789abcdef01234567","status":"ready","reason_code":"ready","checks":[{"id":"database","status":"pass","reason_code":"ready"},{"id":"schema","status":"pass","reason_code":"ready"},{"id":"pull_poll","status":"pass","reason_code":"ready"},{"id":"factory_ingest","status":"pass","reason_code":"ready"},{"id":"factory_delivery","status":"pass","reason_code":"ready"},{"id":"source_revision","status":"pass","reason_code":"revision_match"}]}'`);
}

function processState(pid) {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (error?.status === 1) return '';
    throw error;
  }
}

function assertProcessNotRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  const state = processState(pid);
  assert.ok(!state || state.startsWith('Z'), `子processが実行中です: state=${state}`);
}

function runScanner(box, extraEnv = {}, extraArgs = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [
      CLI, '--config', box.config, '--output', box.output, '--cwd', box.root,
      ...extraArgs,
    ], {
      env: { ...process.env, PATH: `${box.bin}${delimiter}${process.env.PATH}`, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('公開CLIだけで固定9製品のreportを生成し、shared contractを通す', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('oracle', `
if [ "$1" = "--version" ]; then
  echo 'oracle 0.16.0'
elif [ "$1" = "doctor" ] && [ "$2" = "--providers" ] && [ "$3" = "--json" ]; then
  echo '{"healthy":true}'
else
  exit 2
fi`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.doesNotThrow(() => validateReport(report));
  assert.equal(Object.keys(report.products).length, 9);
  assert.equal(report.products.codegraph.presence_status, 'not_applicable');
  assert.deepEqual(report.products.codegraph.checks, []);
  assert.equal(report.products.markitdown.checks[0].status, 'pass', JSON.stringify(report.products.markitdown));
  assert.equal(report.products.oracle.checks[0].status, 'pass');
  assert.equal(report.products.caveat.installed_version, '1.2.3');
  assert.equal(report.products.caveat.state_schema_version, '3');
  assert.equal(report.products.caveat.migration_status, 'current');
  assert.equal(report.products.caveat.checks[0].status, 'pass');
  assert.equal(report.products.throughline.checks[0].status, 'pass');
  assert.equal(report.products.throughline.migration_status, 'current');
  assert.equal(report.products.spotter.checks[0].status, 'pass');
  assert.equal(report.products.spotter.state_schema_version, '2');
  assert.equal(report.products['aiterm-mcp'].checks[0].status, 'pass');
  assert.equal(report.products['codex-sidecar'].installed_version, '1.2.3');
  assert.equal(report.products['codex-sidecar'].checks[0].status, 'pass');
  assert.equal(report.products['codex-sidecar'].compatibility_status, 'compatible');
  assert.equal(
    report.products.servermanager.presence_status,
    process.platform === 'linux' ? 'installed' : 'not_applicable',
  );
  assert.equal(
    report.reporter.dotagents_revision,
    execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  );
  if (process.platform !== 'win32') assert.equal((await stat(box.output)).mode & 0o777, 0o600);
});

test('--oracle-retiredはOracle CLIを実行せずv1最終not_applicable snapshotを生成する', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  const calls = join(box.root, 'oracle.calls');
  await box.script('oracle', `echo called >> '${calls}'; exit 99`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box, {}, ['--oracle-retired']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output, 'utf8'));
  assert.doesNotThrow(() => validateReport(report));
  assert.equal(report.report_mode, 'full');
  assert.deepEqual(report.products.oracle, {
    presence_status: 'not_applicable',
    contract_version: '1.0',
    checks: [],
    runtime_errors: [],
    resolutions: [],
  });
  await assert.rejects(readFile(calls), { code: 'ENOENT' });
});

test('--oracle-retiredの重複はreport生成前に拒否する', async (t) => {
  const box = await sandbox(t);
  await writeFile(box.config, JSON.stringify(validConfig()));
  const result = await runScanner(box, {}, ['--oracle-retired', '--oracle-retired']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /重複/);
  await assert.rejects(readFile(box.output), { code: 'ENOENT' });
});

test('Caveat native diagnosticsはexitとの組合せ、DB射影、exact schemaを厳密に検証する', async (t) => {
  const cases = [
    ['not_ready', `echo '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"1.2.3","overall":{"status":"not_ready"},"database":{"status":"not_ready","reason_code":"migration_failed","schema_version":2,"supported_schema_version":3,"migration_status":"failed"},"sync":{"status":"not_ready","reason_code":"sync_failed"},"connectors":{"claude":{"status":"not_ready","mcp":{"status":"not_ready","reason_code":"missing"},"hooks":{"user_prompt_submit":{"status":"not_ready","reason_code":"missing"},"post_tool_use":{"status":"not_ready","reason_code":"missing"},"post_tool_use_failure":{"status":"not_ready","reason_code":"missing"},"stop":{"status":"not_ready","reason_code":"missing"}}},"codex":{"status":"not_ready","hooks":{"user_prompt_submit":{"status":"not_ready","reason_code":"missing"},"post_tool_use":{"status":"not_ready","reason_code":"missing"},"stop":{"status":"not_ready","reason_code":"missing"}}}}}' ; exit 1`, 'fail'],
    ['unverified', `echo '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"1.2.3","overall":{"status":"unverified"},"database":{"status":"unverified","reason_code":"database_unavailable","schema_version":null,"supported_schema_version":3,"migration_status":"unverified"},"sync":{"status":"unverified","reason_code":"sync_unavailable"},"connectors":{"claude":{"status":"unverified","mcp":{"status":"unverified","reason_code":"unavailable"},"hooks":{"user_prompt_submit":{"status":"unverified","reason_code":"unavailable"},"post_tool_use":{"status":"unverified","reason_code":"unavailable"},"post_tool_use_failure":{"status":"unverified","reason_code":"unavailable"},"stop":{"status":"unverified","reason_code":"unavailable"}}},"codex":{"status":"unverified","hooks":{"user_prompt_submit":{"status":"unverified","reason_code":"unavailable"},"post_tool_use":{"status":"unverified","reason_code":"unavailable"},"stop":{"status":"unverified","reason_code":"unavailable"}}}}}' ; exit 1`, 'unverified'],
    ['ready_exit_mismatch', `echo '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"1.2.3","overall":{"status":"ready"},"database":{"status":"ready","reason_code":"current","schema_version":3,"supported_schema_version":3,"migration_status":"current"},"sync":{"status":"ready","reason_code":"synchronized"},"connectors":{"claude":{"status":"ready","mcp":{"status":"ready","reason_code":"configured"},"hooks":{"user_prompt_submit":{"status":"ready","reason_code":"configured"},"post_tool_use":{"status":"ready","reason_code":"configured"},"post_tool_use_failure":{"status":"ready","reason_code":"configured"},"stop":{"status":"ready","reason_code":"configured"}}},"codex":{"status":"ready","hooks":{"user_prompt_submit":{"status":"ready","reason_code":"configured"},"post_tool_use":{"status":"ready","reason_code":"configured"},"stop":{"status":"ready","reason_code":"configured"}}}}}' ; exit 1`, 'unverified'],
  ];
  for (const [name, body, expected] of cases) {
    const box = await sandbox(t);
    await installHealthyCommands(box);
    await box.script('caveat', body);
    await writeFile(box.config, JSON.stringify(validConfig()));
    const result = await runScanner(box);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    const caveat = JSON.parse(await readFile(box.output, 'utf8')).products.caveat;
    if (expected === 'fail') {
      assert.equal(caveat.checks[0].status, 'fail');
      assert.equal(caveat.compatibility_status, 'incompatible');
      assert.equal(caveat.state_schema_version, '2');
      assert.equal(caveat.migration_status, 'failed');
    } else {
      assert.equal(caveat.checks[0].status, 'unverified');
      if (name === 'ready_exit_mismatch') assert.equal(caveat.checks[0].reason_code, 'native_schema_invalid');
    }
  }
});

test('scanはwall clockが後退してもcreated_atをobserved_atより前へ置かない', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../lib/factory/scan.mjs'), 'utf8');
  assert.match(source, /created_at: createdCandidate < observedAt \? observedAt : createdCandidate/u);
});

test('Caveat native diagnosticsのschema drift・追加field・path漏洩をreportへ通さない', async (t) => {
  for (const [name, mutate] of [
    ['schema', (value) => { value.schema = 'caveat.native_factory_diagnostics.v2'; }],
    ['additional_field', (value) => { value.path = '/Users/kite/private'; }],
    ['nested_path', (value) => { value.connectors.claude.mcp.path = '/Users/kite/private'; }],
    ['aggregate_mismatch', (value) => { value.connectors.codex.hooks.stop.status = 'not_ready'; }],
    ['database_ready_mismatch', (value) => { value.database.schema_version = 2; }],
  ]) {
    const box = await sandbox(t);
    await installHealthyCommands(box);
    const base = { schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '1.2.3', overall: { status: 'ready' }, database: { status: 'ready', reason_code: 'current', schema_version: 3, supported_schema_version: 3, migration_status: 'current' }, sync: { status: 'ready', reason_code: 'synchronized' }, connectors: { claude: { status: 'ready', mcp: { status: 'ready', reason_code: 'configured' }, hooks: Object.fromEntries(['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop'].map((key) => [key, { status: 'ready', reason_code: 'configured' }])) }, codex: { status: 'ready', hooks: Object.fromEntries(['user_prompt_submit', 'post_tool_use', 'stop'].map((key) => [key, { status: 'ready', reason_code: 'configured' }])) } } };
    mutate(base);
    await box.script('caveat', `echo '${JSON.stringify(base)}'`);
    await writeFile(box.config, JSON.stringify(validConfig()));
    const result = await runScanner(box);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    const report = JSON.parse(await readFile(box.output, 'utf8'));
    assert.deepEqual(report.products.caveat.checks, [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid' }]);
    assert.doesNotMatch(JSON.stringify(report), /Users|private|path/);
  }
});

test('Caveat CLI不在は壊れた診断出力と区別してmissingへ写像する', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await rm(join(box.bin, process.platform === 'win32' ? 'caveat.cmd' : 'caveat'));
  await box.script('git', "echo '1234567'");
  await writeFile(box.config, JSON.stringify(validConfig()));
  const result = await runScanner(box, { PATH: box.bin });
  assert.equal(result.code, 0, result.stderr);
  const caveat = JSON.parse(await readFile(box.output, 'utf8')).products.caveat;
  assert.equal(caveat.presence_status, 'missing');
  assert.deepEqual(caveat.checks, [{
    check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_unavailable',
  }]);
});

test('native diagnosticsの既知not_readyを固定fingerprintのfailへ写像し、生値を出さない', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('codex-sidecar', `
echo '{"status":"failed","factoryReadiness":{"schemaVersion":"1","overall":"not_ready","packageVersions":{"status":"ready","packages":{"cli":"1.2.3","core":"1.2.3","mcp":"1.2.3"}},"raw":"/Users/kite/secret","preset":"private-preset"}}'
exit 1`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  const check = report.products['codex-sidecar'].checks[0];
  assert.equal(check.status, 'fail');
  assert.equal(check.severity, 'high');
  assert.equal(check.fingerprint, '3a8158a0c08f294e83f725fb53ab71755c1be5e13567a2cb0dfb229aa2a8a034');
  assert.equal(report.products['codex-sidecar'].compatibility_status, 'incompatible');
  assert.equal(report.products['codex-sidecar'].installed_version, '1.2.3');
  assert.doesNotMatch(JSON.stringify(report), /Users|secret|raw|private-preset/);
});

test('codex-sidecarのschema不正とunverifiedはgreenへ丸めずunverifiedにする', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('codex-sidecar', `
echo '{"status":"ok","factoryReadiness":{"schemaVersion":"2","overall":"ready","packageVersions":{"packages":{"cli":"1.2.3","core":"1.2.3","mcp":"1.2.3"}}}}'`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.equal(report.products['codex-sidecar'].presence_status, 'unverified');
  assert.deepEqual(report.products['codex-sidecar'].checks, [{
    check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
  }]);
  assert.equal(report.products['codex-sidecar'].compatibility_status, undefined);
});

test('codex-sidecar package version不整合はfixed fail/incompatibleへ写像する', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('codex-sidecar', `
echo '{"status":"failed","factoryReadiness":{"schemaVersion":"1","overall":"not_ready","packageVersions":{"status":"not_ready","packages":{"cli":"1.2.3","core":"1.2.4","mcp":"1.2.3"}}}}'
exit 1`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.equal(report.products['codex-sidecar'].presence_status, 'unverified');
  assert.equal(report.products['codex-sidecar'].compatibility_status, 'incompatible');
  assert.equal(report.products['codex-sidecar'].checks[0].status, 'fail');
  assert.equal(report.products['codex-sidecar'].installed_version, undefined);
});

test('codex-sidecar native unverifiedはinstalledや生出力をreportへ転記しない', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('codex-sidecar', `
echo '{"status":"failed","factoryReadiness":{"schemaVersion":"1","overall":"unverified","prompt":"Bearer private-token","projectRoot":"/Users/kite/private"}}'
exit 1`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.equal(report.products['codex-sidecar'].presence_status, 'unverified');
  assert.equal(report.products['codex-sidecar'].installed_version, undefined);
  assert.equal(report.products['codex-sidecar'].compatibility_status, 'unverified');
  assert.deepEqual(report.products['codex-sidecar'].checks, [{
    check_id: 'native_diagnostics', status: 'unverified',
  }]);
  assert.doesNotMatch(JSON.stringify(report), /Bearer|private-token|\/Users|projectRoot|prompt/);
});

test('codex-sidecarのtop/overallとexit statusの矛盾はunverifiedにする', async (t) => {
  for (const [name, body] of [
    ['top_overall', 'echo \'{"status":"ok","factoryReadiness":{"schemaVersion":"1","overall":"not_ready","packageVersions":{"status":"not_ready","packages":{"cli":"1.2.3","core":"1.2.4","mcp":"1.2.3"}}}}\''],
    ['exit_status', 'echo \'{"status":"failed","factoryReadiness":{"schemaVersion":"1","overall":"not_ready","packageVersions":{"status":"not_ready","packages":{"cli":"1.2.3","core":"1.2.4","mcp":"1.2.3"}}}}\''],
  ]) {
    const box = await sandbox(t);
    await installHealthyCommands(box);
    await box.script('codex-sidecar', body);
    await writeFile(box.config, JSON.stringify(validConfig()));
    const result = await runScanner(box);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    const report = JSON.parse(await readFile(box.output));
    assert.deepEqual(report.products['codex-sidecar'].checks, [{
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    }]);
  }
});

test('不正host idと未知config fieldを同じ共有契約で拒否する', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  const invalid = validConfig({ host: { id: '/Users/kite/secret', profile: validConfig().host.profile } });
  invalid.unknown = true;
  await writeFile(box.config, JSON.stringify(invalid));

  const result = await runScanner(box);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /設定shapeが不正/);
  await assert.rejects(readFile(box.output), { code: 'ENOENT' });
});

test('host profileと実platformの不一致をreport生成前に拒否する', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  const mismatch = process.platform === 'darwin' ? 'server' : 'mac';
  await writeFile(box.config, JSON.stringify(validConfig({ host: { id: 'test-host', profile: mismatch } })));

  const result = await runScanner(box);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /実行platformが不一致/);
});

test('悪意あるversion出力・Oracle人間向け出力をgreenへ丸めずCodegraphは実行しない', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('caveat', "echo 'Bearer top-secret /Users/kite/private'");
  await box.script('oracle', `
if [ "$1" = "--version" ]; then echo 'oracle 0.16.0'; else echo 'human status'; fi`);
  await box.script('codegraph', `
if [ "$1" = "--version" ]; then echo 'codegraph 1.4.0'; else exit 9; fi`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.equal(report.products.caveat.presence_status, 'unverified');
  assert.equal(report.products.codegraph.presence_status, 'not_applicable');
  assert.deepEqual(report.products.codegraph.checks, []);
  assert.equal(report.products.oracle.checks[0].status, 'unverified');
  assert.doesNotMatch(JSON.stringify(report), /top-secret|\/Users\/kite|human status/);
});

test('Oracleの機械可読なprovider未準備はpassにせず理由付きunverifiedにする', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await box.script('oracle', `
if [ "$1" = "--version" ]; then echo 'oracle 0.16.0'; else echo '{"providers":[]}' && exit 1; fi`);
  await writeFile(box.config, JSON.stringify(validConfig()));

  const result = await runScanner(box);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(box.output));
  assert.deepEqual(report.products.oracle.checks[0], {
    check_id: 'doctor', status: 'unverified', reason_code: 'provider_not_ready',
  });
  assert.doesNotMatch(JSON.stringify(report), /providers/);
});

test('第三者adapterは対応範囲外またはversion不明で診断を実行しない', async (t) => {
  const products = [
    { id: 'markitdown', checkId: 'local_fixture', supported: '0.1.0+build.7', known: 'markitdown 0.1.5', drift: '0.2.0', prerelease: '0.1.0-rc.1' },
    { id: 'oracle', checkId: 'doctor', supported: '0.16.0+build.7', known: '0.16.0', drift: '0.17.0', prerelease: '0.16.0-rc.1' },
  ];
  for (const product of products) {
    for (const [name, stdout, expected] of [
      ['supported_boundary', `${product.id} ${product.supported}`, { presence: 'installed', status: 'pass' }],
      ['known_stdout', product.known, { presence: 'installed', status: 'pass' }],
      ['prefixed_v', `${product.id} v${product.supported}`, { presence: 'installed', status: 'pass' }],
      ['next_minor', `${product.id} ${product.drift}`, { presence: 'installed', status: 'unsupported', reason: 'upstream_version_unsupported' }],
      ['prerelease', `${product.id} ${product.prerelease}`, { presence: 'installed', status: 'unsupported', reason: 'upstream_version_unsupported' }],
      ['unknown', 'version format drift', { presence: 'unverified', status: 'unverified', reason: 'version_unverified' }],
      ['multiple_versions', `dependency ${product.supported} actual ${product.drift}`, { presence: 'unverified', status: 'unverified', reason: 'version_unverified' }],
      ['warning', `warning ${product.supported}`, { presence: 'unverified', status: 'unverified', reason: 'version_unverified' }],
    ]) {
      const box = await sandbox(t);
      await installHealthyCommands(box);
      const calls = join(box.root, `${product.id}-${name}.calls`);
      await box.script(product.id, `
if [ "$1" = "--version" ]; then
  echo '${stdout}'
else
  echo diagnostic >> '${calls}'
  ${product.id === 'oracle' ? "echo '{\"healthy\":true}'" : "echo 'converted'"}
fi`);
      await writeFile(box.config, JSON.stringify(validConfig()));

      const result = await runScanner(box);
      assert.equal(result.code, 0, `${product.id}/${name}: ${result.stderr}`);
      const report = JSON.parse(await readFile(box.output));
      const observed = report.products[product.id];
      assert.equal(observed.presence_status, expected.presence, `${product.id}/${name}`);
      assert.deepEqual(observed.checks, [{
        check_id: product.checkId, status: expected.status,
        ...(expected.reason ? { reason_code: expected.reason } : {}),
      }], `${product.id}/${name}`);
      if (expected.status === 'pass') {
        assert.equal((await readFile(calls, 'utf8')).trim(), 'diagnostic');
      } else {
        await assert.rejects(readFile(calls), { code: 'ENOENT' });
      }
    }
  }
});

test('command出力上限とtimeoutは固定reasonで失敗し、生出力を返さない', async (t) => {
  const box = await sandbox(t);
  await box.script('noisy', 'while :; do echo x; done');
  await box.script('slow', 'while :; do :; done');
  const childPidFile = join(box.root, 'child.pid');
  const env = { ...process.env, PATH: `${box.bin}${delimiter}${process.env.PATH}` };
  let lateCommand = 'late';
  let lateEnv = env;
  if (process.platform === 'win32') {
    const native = await windowsCommandFixture(t);
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    await native.entry('late-tree.js', `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => {
  process.stdout.write('x'.repeat(4096));
  setInterval(() => {}, 1000);
});
`);
    await native.cmd('late-tree', 'node_modules\\safe-package\\bin\\late-tree.js');
    lateCommand = 'late-tree';
    lateEnv = native.env;
  } else {
    await box.script('late', `sleep 60 & child=$!; echo "$child" > '${childPidFile}'; while :; do echo x; done`);
  }

  const noisy = await runCommand('noisy', [], { env, maxOutputBytes: 128, timeoutMs: 1000 });
  assert.deepEqual({ reason: noisy.reason, stdout: noisy.stdout, stderr: noisy.stderr }, {
    reason: 'output_limit', stdout: '', stderr: '',
  });
  const slow = await runCommand('slow', [], { env, timeoutMs: 50 });
  assert.deepEqual({ reason: slow.reason, stdout: slow.stdout, stderr: slow.stderr }, {
    reason: 'timeout', stdout: '', stderr: '',
  });
  const late = await runCommand(lateCommand, [], { env: lateEnv, maxOutputBytes: 128, timeoutMs: 5000 });
  assert.equal(late.reason, 'output_limit');
  const childPid = Number.parseInt(await readFile(childPidFile, 'utf8'), 10);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; } });
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } else {
    assertProcessNotRunning(childPid);
  }
});

async function windowsCommandFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'factory-windows-command-'));
  const bin = join(root, 'bin with space');
  await mkdir(bin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmShim = (entry, { elsePathext = true, pathext = '%PATHEXT:;.JS;=;%', programIndent = ' ' } = {}) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n${programIndent}SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n${programIndent}SET "_prog=node"\r\n${elsePathext ? `  SET PATHEXT=${pathext}\r\n` : ''})\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${elsePathext ? '' : 'set PATHEXT=%PATHEXT:;.JS;=;% & '}"%_prog%"  "%dp0%\\${entry}" %*\r\n`;
  return {
    root, bin,
    env: { Path: bin, PathExt: '.CMD;.EXE' },
    async entry(name, body) {
      const file = join(bin, 'node_modules', 'safe-package', 'bin', name);
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeFile(file, body);
      return file;
    },
    async cmd(name, entry, options) {
      const file = join(bin, `${name}.cmd`);
      await writeFile(file, npmShim(entry, options));
      return file;
    },
  };
}

test('Windows npm .cmd実物variantは空白を含むPathから検証済みNode entrypointへ解決する', async (t) => {
  const box = await windowsCommandFixture(t);
  const entry = await box.entry('safe.js', 'process.exit(0);\n');
  await box.cmd('safe-cli', 'node_modules\\safe-package\\bin\\safe.js', { programIndent: '  ' });
  const resolved = await resolveWindowsCommand('safe-cli', { env: box.env, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: process.execPath, prefixArgs: [await realpath(entry)] });
});

test('Windows npm .cmdはAppContainerのrealpath仮想化後もshim字面のentrypointで起動する', async (t) => {
  const box = await windowsCommandFixture(t);
  const entry = await box.entry('safe.js', 'process.exit(0);\n');
  await box.cmd('safe-cli', 'node_modules\\safe-package\\bin\\safe.js');
  const canonicalBin = await realpath(box.bin);
  const canonicalEntry = await realpath(entry);
  const redirectedBin = join(box.root, 'app-container-cache');
  const redirectedEntry = join(redirectedBin, 'node_modules', 'safe-package', 'bin', 'safe.js');
  const virtualizingFs = {
    lstat: (path) => import('node:fs/promises').then((fs) => fs.lstat(path)),
    readFile: (path, encoding) => readFile(path, encoding),
    async realpath(path) {
      const canonical = await realpath(path);
      if (canonical === canonicalBin) return redirectedBin;
      if (canonical === canonicalEntry) return redirectedEntry;
      return canonical;
    },
  };
  const resolved = await resolveWindowsCommand('safe-cli', { env: box.env, fs: virtualizingFs, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: process.execPath, prefixArgs: [entry] });
});

test('Windows npm AppContainer仮想化時は子CLIのPATHも同一の検証済みnpm cacheへ揃える', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-windows-appcontainer-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'AppData', 'Roaming', 'npm');
  const entry = join(bin, 'node_modules', 'safe-package', 'bin', 'safe.js');
  const virtualNpm = join(root, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_test123', 'LocalCache', 'Roaming', 'npm');
  await mkdir(resolve(entry, '..'), { recursive: true });
  await writeFile(entry, 'process.stdout.write(process.env.PATH);\n');
  const helper = join(root, 'success-helper.mjs');
  await writeFile(helper, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ status: 'ok', command: ${JSON.stringify(process.execPath)}, prefixArgs: [${JSON.stringify(entry)}], pathPrefix: ${JSON.stringify(virtualNpm)} })));\n`);
  const result = await runCommand('safe-cli', [], { env: { Path: bin, PathExt: '.CMD;.EXE' }, platform: 'win32', windowsPathModule: WINDOWS_FIXTURE_PATH, windowsHelperPath: helper });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, `${virtualNpm};${bin}`);
});

test('Windows npm .cmdはentrypointだけがCodex AppContainerへ仮想化されても同一suffixを検証する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-windows-appcontainer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'AppData', 'Roaming', 'npm');
  const entry = join(bin, 'node_modules', 'safe-package', 'bin', 'safe.js');
  await mkdir(resolve(entry, '..'), { recursive: true });
  await writeFile(entry, 'process.exit(0);\n');
  const fixture = await windowsCommandFixture(t);
  const fixtureCmd = await fixture.cmd('safe-cli', 'node_modules\\safe-package\\bin\\safe.js');
  await writeFile(join(bin, 'safe-cli.cmd'), await readFile(fixtureCmd, 'utf8'));
  const canonicalEntry = await realpath(entry);
  const redirectedEntry = join(root, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_test123', 'LocalCache', 'Roaming', 'npm', 'node_modules', 'safe-package', 'bin', 'safe.js');
  const virtualizingFs = {
    lstat: (path) => import('node:fs/promises').then((fs) => fs.lstat(path)),
    readFile: (path, encoding) => readFile(path, encoding),
    async realpath(path) {
      const canonical = await realpath(path);
      return canonical === canonicalEntry ? redirectedEntry : canonical;
    },
  };
  const resolved = await resolveWindowsCommand('safe-cli', { env: { Path: bin, PathExt: '.CMD;.EXE' }, fs: virtualizingFs, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: process.execPath, prefixArgs: [entry], pathPrefix: join(root, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_test123', 'LocalCache', 'Roaming', 'npm') });
});

test('Windows .exeはPATHEXT順で直接起動し、npm .cmdへはcmd.exeを介在させない', async (t) => {
  const box = await windowsCommandFixture(t);
  const executable = join(box.bin, 'native.exe');
  await writeFile(executable, 'placeholder');
  const resolved = await resolveWindowsCommand('native', { env: { ...box.env, PathExt: '.EXE;.CMD' }, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: executable, prefixArgs: [] });
});

test('Windows npm native .cmdはnode_modules内の固定exeだけをshell非介在で起動する', async (t) => {
  const box = await windowsCommandFixture(t);
  const executable = await box.entry('native.exe', 'placeholder');
  await writeFile(join(box.bin, 'native-cli.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\safe-package\\bin\\native.exe"   %*\r\n');
  const resolved = await resolveWindowsCommand('native-cli', { env: box.env, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: executable, prefixArgs: [] });
  await writeFile(join(box.bin, 'native-cli.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\..\\outside.exe" %*\r\n');
  await assert.rejects(resolveWindowsCommand('native-cli', { env: box.env, pathModule: WINDOWS_FIXTURE_PATH }), { code: 'EINVAL' });
});

test('Windows command解決はPATHEXT先頭の許可外ps1を実行せず検証済みnpm cmdへ進む', async (t) => {
  const box = await windowsCommandFixture(t);
  const entry = await box.entry('safe.js', 'process.exit(0);\n');
  await writeFile(join(box.bin, 'safe-cli.ps1'), 'throw "must not run"\n');
  await box.cmd('safe-cli', 'node_modules\\safe-package\\bin\\safe.js');
  const resolved = await resolveWindowsCommand('safe-cli', { env: { ...box.env, PathExt: '.PS1;.CMD;.EXE' }, pathModule: WINDOWS_FIXTURE_PATH });
  assert.deepEqual(resolved, { command: process.execPath, prefixArgs: [await realpath(entry)] });
});

test('Windows npm .cmdはstdin・cwd・envを保ってNodeで実行する', async (t) => {
  const box = await windowsCommandFixture(t);
  const entry = await box.entry('runner.js', "let input = ''; process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), marker: process.env.FACTORY_MARKER })));\n");
  await box.cmd('runner', 'node_modules\\safe-package\\bin\\runner.js');
  const helper = join(box.root, 'success-helper.mjs');
  await writeFile(helper, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ status: 'ok', command: ${JSON.stringify(process.execPath)}, prefixArgs: [${JSON.stringify(entry)}] })));\n`);
  const result = await runCommand('runner', [], { cwd: box.root, env: { ...box.env, FACTORY_MARKER: 'kept' }, input: 'stdin-kept', platform: 'win32', windowsPathModule: WINDOWS_FIXTURE_PATH, windowsHelperPath: helper });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { input: 'stdin-kept', cwd: await realpath(box.root), marker: 'kept' });
});

test('Windows command helperの解決もrun開始時からtimeoutへ含め、timeout後にlate spawnしない', async (t) => {
  const box = await windowsCommandFixture(t);
  const marker = join(box.root, 'late-spawned');
  const helper = join(box.root, 'hanging-helper.mjs');
  await writeFile(helper, `import { writeFile } from 'node:fs/promises'; await new Promise((resolveDelay) => setTimeout(resolveDelay, 80)); await writeFile(${JSON.stringify(marker)}, 'late');\n`);
  const result = await runCommand('late', [], {
    env: box.env,
    platform: 'win32',
    timeoutMs: 10,
    windowsHelperPath: helper,
  });
  assert.deepEqual({ reason: result.reason, stdout: result.stdout, stderr: result.stderr }, { reason: 'timeout', stdout: '', stderr: '' });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Windows command helperの返却schemaとentrypointは親でも検証し、不正値を実行しない', async (t) => {
  const box = await windowsCommandFixture(t);
  const marker = join(box.root, 'unexpected-spawn');
  const helper = join(box.root, 'invalid-helper.mjs');
  await writeFile(helper, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ command: ${JSON.stringify(process.execPath)}, prefixArgs: [${JSON.stringify(join(box.root, 'outside.js'))}] })));\n`);
  const result = await runCommand('invalid', [], { env: box.env, platform: 'win32', windowsHelperPath: helper, windowsPathModule: { ...posix, delimiter: ';' } });
  assert.equal(result.reason, 'spawn');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Windows command helperはCLI不在のENOENTだけを閉じたerror schemaで親へ返す', async (t) => {
  const box = await windowsCommandFixture(t);
  const result = await runCommand('missing', [], { env: { Path: 'C:\\dotagents-command-missing', PathExt: '.CMD;.EXE' }, platform: 'win32' });
  assert.equal(result.reason, 'spawn');
  assert.equal(result.error?.code, 'ENOENT');
  const invalid = join(box.root, 'unknown-error-helper.mjs');
  await writeFile(invalid, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ status: 'error', code: 'ESECRET' })));\n");
  const rejected = await runCommand('unknown', [], { env: box.env, platform: 'win32', windowsHelperPath: invalid, windowsPathModule: { ...posix, delimiter: ';' } });
  assert.equal(rejected.reason, 'spawn');
  assert.equal(rejected.error?.code, 'EINVAL');
});

test('Windows command解決は悪意あるshim・traversal・dynamic command pathをfail-loudする', async (t) => {
  const box = await windowsCommandFixture(t);
  const marker = join(box.root, 'executed');
  await writeFile(join(box.bin, 'evil.cmd'), `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\n"%dp0%\\node.exe"  "%dp0%\\node_modules\\safe-package\\bin\\safe.js" %* & echo owned > "${marker}"\n`);
  await assert.rejects(resolveWindowsCommand('evil', { env: box.env, pathModule: { ...posix, delimiter: ';' } }), { code: 'EINVAL' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await box.cmd('traversal', 'node_modules\\safe-package\\bin\\..\\..\\..\\escape.js');
  await assert.rejects(resolveWindowsCommand('traversal', { env: box.env, pathModule: { ...posix, delimiter: ';' } }), { code: 'EINVAL' });
  await assert.rejects(resolveWindowsCommand('..\\evil', { env: box.env, pathModule: { ...posix, delimiter: ';' } }), { code: 'EINVAL' });
  await box.cmd('bad-pathext', 'node_modules\\safe-package\\bin\\safe.js', { pathext: '%PATH%' });
  await assert.rejects(resolveWindowsCommand('bad-pathext', { env: box.env, pathModule: { ...posix, delimiter: ';' } }), { code: 'EINVAL' });
});

test('rename失敗時に一時reportを残さない', async (t) => {
  const box = await sandbox(t);
  await installHealthyCommands(box);
  await writeFile(box.config, JSON.stringify(validConfig()));
  await mkdir(box.output);

  const result = await runScanner(box);
  assert.notEqual(result.code, 0);
  const names = await readdir(box.root);
  assert.equal(names.some((name) => name.startsWith('report.json.') && name.endsWith('.tmp')), false);
});
