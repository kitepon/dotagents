import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { nextCron, removeLegacyArtifacts, stableNodePath } from '../../bin/factory-reporter-scheduler.mjs';
import { postUpdateFailures } from '../../lib/factory/deployment-contract.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCHEDULER = join(ROOT, 'bin', 'factory-reporter-scheduler.mjs');
const RUNNER = join(ROOT, 'bin', 'factory-reporter-v4-schedule-runner.mjs');
const V7_RUNNER = join(ROOT, 'bin', 'factory-reporter-v7-schedule-runner.mjs');
const roots = [];
const CURRENT_PROFILE = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl';
async function sandbox(profile = 'mac', collection = false, reporting = false) { const root = await mkdtemp(join(tmpdir(), 'factory-reporter-scheduler-test-')); roots.push(root); const config = join(root, 'config.json'); const credential = join(root, 'credential'); await writeFile(credential, 'unit-test-token\n', { mode: 0o600 }); await writeFile(config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile }, collection: { enabled: collection }, reporting: reporting ? { enabled: true, endpoint: 'http://127.0.0.1:1/api/factory/v4/reports', credential_file: credential } : { enabled: false } })); const stateRoot = process.platform === 'win32' ? join(root, 'local-app-data', 'dotagents') : join(root, 'state-home', 'dotagents'); return { root, config, credential, state: join(stateRoot, 'factory-reporter-v4'), stateRoot }; }
function run(script, args, box, extraEnv = {}) { return new Promise((resolveRun) => { const env = { ...process.env, HOME: box.root, USERPROFILE: box.root, LOCALAPPDATA: join(box.root, 'local-app-data'), XDG_CONFIG_HOME: join(box.root, 'config-home'), XDG_STATE_HOME: join(box.root, 'state-home'), ...extraEnv }; if (process.platform === 'win32' && extraEnv.PATH) env.PATH = `${extraEnv.PATH}${delimiter}${process.env.PATH}`; const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => { let json = null; for (const line of stdout.trim().split(/\r?\n/u).reverse()) { try { json = JSON.parse(line); break; } catch {} } resolveRun({ code, stderr, json }); }); }); }
async function fixtureCommand(directory, name, body) {
  const file = join(directory, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  if (process.platform !== 'win32') return file;
  const packageDir = join(directory, 'node_modules', 'factory-test-fixtures');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, `${name}.mjs`), `
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const result = spawnSync(join(process.env.ProgramFiles, 'Git', 'bin', 'sh.exe'), [resolve(import.meta.dirname, '..', '..', '${name}'), ...process.argv.slice(2)], { env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  await writeFile(`${file}.cmd`, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\factory-test-fixtures\\${name}.mjs" %*\r\n`);
  return file;
}
async function writeRunnerLock(box, pid, nonce = '00000000-0000-4000-8000-000000000001') { await mkdir(box.state, { recursive: true }); const path = join(box.state, `schedule.lock.${nonce}.owner`); await writeFile(path, `${JSON.stringify({ schema_version: 'dotagents.factory-scheduler-lock.v1', nonce, pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 }); return path; }
async function v7FixtureBin(box) {
  const bin = join(box.root, 'v7-bin'); await mkdir(bin);
  for (const name of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await fixtureCommand(bin, name, 'exit 1');
  await fixtureCommand(bin, 'git', 'echo 1234567');
  return bin;
}
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test('macOS Homebrew Nodeはversioned Cellar pathでなくstable入口をschedulerへ保存する', () => {
  assert.equal(stableNodePath('darwin', '/opt/homebrew/Cellar/node/26.5.0/bin/node', (path) => path === '/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  assert.equal(stableNodePath('darwin', '/usr/local/Cellar/node/24.1.0/bin/node', (path) => path === '/usr/local/bin/node'), '/usr/local/bin/node');
  assert.throws(() => stableNodePath('darwin', '/opt/homebrew/Cellar/node/26.5.0/bin/node', () => false), /stable Node/);
  assert.equal(stableNodePath('linux', '/home/kite/.nvm/versions/node/v24.14.1/bin/node', () => false), '/home/kite/.nvm/versions/node/v24.14.1/bin/node');
});

test('dry-run/apply併用は順序にかかわらず拒否する', async () => { const box = await sandbox(); for (const flags of [['--dry-run', '--apply'], ['--apply', '--dry-run']]) { const result = await run(SCHEDULER, ['install', ...flags, '--config', box.config], box); assert.equal(result.code, 1); assert.match(result.stderr, /併用/); } });
test('install --applyはrunner binが解決できない時typed errorで拒否し、dry-runは検証しない', async () => {
  // 実被弾（2026-08-10 wire v7 canary cutover）: install.sh未実行でsymlink未配布でも
  // installが成功を返し、launchctl kickstart時に初めてCannot find moduleで落ちるfail-open。
  const box = await sandbox(CURRENT_PROFILE);
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  // sandbox HOMEには ~/.local/bin/ のrunner symlinkが無い → applyはOS操作へ進む前に拒否する
  const applied = await run(SCHEDULER, ['install', '--apply', '--platform', platform, '--config', box.config], box);
  assert.equal(applied.code, 1);
  assert.match(applied.stderr, /runner_unresolved/);
  assert.match(applied.stderr, /install\.sh/);
  // dry-runはartifact確認用のため、runner不在でも従来どおり成功する
  const dry = await run(SCHEDULER, ['install', '--dry-run', '--platform', platform, '--config', box.config], box);
  assert.equal(dry.code, 0, dry.stderr);
  // 検証はapplyのOS操作より前に配線されている（正側のapply実行は実launchd/cron/schtasksを
  // 変更するためテストしない。検証通過後の経路は既存のapply系テストが覆う）
  const source = await readFile(SCHEDULER, 'utf8');
  assert.match(source, /assertRunnerExecutable\(spec\.runner, request\.target\);\r?\n  if \(!request\.dryRun\) await apply\(/);
});
test('配布symlink経由でもscheduler CLIがmainを実行する', async () => { const box = await sandbox('mac'); const link = join(box.root, 'factory-reporter-scheduler'); await symlink(SCHEDULER, link); const result = await run(link, ['install', '--dry-run', '--platform', 'darwin', '--config', box.config], box); assert.equal(result.code, 0, result.stderr); assert.equal(result.json.ok, true); assert.equal(result.json.dry_run, true); });
test('macOS launchdはnode→v4 runnerをXML escapeして生成する', async () => { const box = await sandbox('mac'); const result = await run(SCHEDULER, ['install', '--platform', 'darwin', '--config', box.config], box); assert.equal(result.code, 0); assert.match(result.json.artifact_content, /<string>.*node.*<\/string><string>.*factory-reporter-v4-schedule-runner/); assert.match(result.json.artifact_content, /<key>Minute<\/key><integer>17<\/integer>/); });
test('Linux/WSL cronは厳密single quoteでnode→v4 runnerを起動する', async () => { const box = await sandbox('wsl'); const result = await run(SCHEDULER, ['install', '--platform', 'linux', '--config', box.config], box); assert.equal(result.code, 0); assert.match(result.json.artifact_content, /^17 \* \* \* \* '[^']*node(?:\.exe)?' '[^']*factory-reporter-v4-schedule-runner' --config '/); assert.match(result.json.artifact_content, /# dotagents-factory-reporter\n$/); });
test('Windows Task SchedulerはUTF-16宣言、毎時trigger、v4 private ACL commandをdry-runへ出す', async () => { const box = await sandbox('windows-native'); const result = await run(SCHEDULER, ['install', '--platform', 'win32', '--config', box.config], box); assert.equal(result.code, 0); const xml = result.json.artifact_content; assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/); assert.match(xml, /<Interval>PT1H<\/Interval><Duration>P1D<\/Duration>/); assert.ok(xml.indexOf('<StartBoundary>') < xml.indexOf('<Repetition>')); assert.match(xml, /<Command>.*node.*<\/Command><Arguments>&quot;.*factory-reporter-v4-schedule-runner/); assert.match(result.json.state, /factory-reporter-v4$/); assert.match(result.json.acl_commands[0][0], /PowerShell[\\/]7[\\/]pwsh\.exe$/iu); assert.doesNotMatch(result.json.acl_commands[0][0], /WindowsPowerShell/iu); const acl = result.json.acl_commands[0][6]; assert.match(acl, /DOTAGENTS_FACTORY_ACL_TARGET/); assert.match(acl, /SetAccessRuleProtection\(\$true, \$false\)/); assert.match(acl, /FileSystemAclExtensions\]::GetAccessControl\(.*AccessControlSections\]::Access\)/); assert.match(acl, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/); assert.doesNotMatch(acl, /Set-Acl /); assert.doesNotMatch(acl, /\[IO\.(?:Directory|File)\]::SetAccessControl/); const source = await readFile(SCHEDULER, 'utf8'); assert.match(source, /timeout: 5_000/); assert.match(source, /acl_apply_failed/); });
test('v1指定は各OS artifactをv1 runnerとv1 stateへ切り替え、control artifactをmajor非依存にする', async () => { for (const [platform, profile] of [['darwin', 'mac'], ['linux', 'wsl'], ['win32', 'windows-native']]) { const box = await sandbox(profile); const v1 = await run(SCHEDULER, ['install', '--dry-run', '--platform', platform, '--wire-major', 'v1', '--config', box.config], box); const v2 = await run(SCHEDULER, ['install', '--dry-run', '--platform', platform, '--wire-major', 'v2', '--config', box.config], box); assert.equal(v1.code, 0, v1.stderr); assert.equal(v1.json.wire_major, 'v1'); assert.match(v1.json.artifact_content, /factory-reporter-schedule-runner/); assert.doesNotMatch(v1.json.artifact_content, /factory-reporter-v2-schedule-runner/); assert.match(v1.json.state, /factory-reporter$/); assert.equal(v1.json.artifact, v2.json.artifact); assert.match(v1.json.artifact, /factory-reporter-scheduler/); } });
test('wire-major省略はv4のartifactとstateを生成する', async () => { const box = await sandbox('mac'); const result = await run(SCHEDULER, ['install', '--dry-run', '--platform', 'darwin', '--config', box.config], box); assert.equal(result.code, 0); assert.equal(result.json.wire_major, 'v4'); assert.match(result.json.artifact_content, /factory-reporter-v4-schedule-runner/); assert.match(result.json.state, /factory-reporter-v4$/); });
test('reporting ON時はwire-majorとfactory endpoint pathnameの一致を必須にする', async () => { const box = await sandbox('mac', false, true); const v1 = await run(SCHEDULER, ['install', '--dry-run', '--platform', 'darwin', '--wire-major', 'v1', '--config', box.config], box); assert.equal(v1.code, 1); assert.match(v1.stderr, /api\/factory\/v1\/reports/); await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: 'mac' }, collection: { enabled: false }, reporting: { enabled: true, endpoint: 'http://127.0.0.1:1/api/factory/v1/reports', credential_file: box.credential } })); const v4 = await run(SCHEDULER, ['install', '--dry-run', '--platform', 'darwin', '--wire-major', 'v4', '--config', box.config], box); assert.equal(v4.code, 1); assert.match(v4.stderr, /api\/factory\/v4\/reports/); const accepted = await run(SCHEDULER, ['install', '--dry-run', '--platform', 'darwin', '--wire-major', 'v1', '--config', box.config], box); assert.equal(accepted.code, 0, accepted.stderr); });
test('legacy scheduler artifactだけを掃除し、v1/v2 stateとoutboxを残す', async () => { const box = await sandbox(); const states = [join(box.root, 'state-home', 'dotagents', 'factory-reporter'), join(box.root, 'state-home', 'dotagents', 'factory-reporter-v2')]; for (const state of states) { await mkdir(join(state, 'scheduler'), { recursive: true }); await mkdir(join(state, 'outbox')); await writeFile(join(state, 'scheduler', 'factory-reporter.cron'), 'old artifact'); await writeFile(join(state, 'outbox', 'keep'), 'payload'); } await removeLegacyArtifacts('linux', { legacyStates: states }); for (const state of states) { await assert.rejects(lstat(join(state, 'scheduler', 'factory-reporter.cron'))); await stat(join(state, 'outbox', 'keep')); } });
test('cron更新はpath変更前のmanaged行だけを置換し、他行と末尾を正規化する', () => { const old = "5 * * * * '/old/node' '/old/runner' --config '/old/config' # dotagents-factory-reporter\nMAILTO=ops\nforeign # dotagents-factory-reporter-extra\n\n"; const updated = nextCron(old, "17 * * * * '/new/node' '/new/runner' --config '/new/config' # dotagents-factory-reporter\n", false); assert.doesNotMatch(updated, /old\/runner/); assert.match(updated, /new\/runner/); assert.match(updated, /MAILTO=ops/); assert.match(updated, /foreign # dotagents-factory-reporter-extra/); const once = nextCron(updated, "17 * * * * '/new/node' '/new/runner' --config '/new/config' # dotagents-factory-reporter\n", true); assert.equal(nextCron(once, "17 * * * * '/new/node' '/new/runner' --config '/new/config' # dotagents-factory-reporter\n", true), once); });
test('cronはsingle quote後もconfig path内のpercentをescapeする', async () => { const box = await sandbox('wsl'); const config = join(box.root, 'config%with%percent.json'); await writeFile(config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: 'wsl' }, collection: { enabled: false }, reporting: { enabled: false } })); const result = await run(SCHEDULER, ['install', '--platform', 'linux', '--config', config], box); assert.equal(result.code, 0); assert.match(result.json.artifact_content, /config\\%with\\%percent\.json/); });
test('installはconfigのprofileとtarget不一致・制御文字をfail closedする', async () => { const box = await sandbox('mac'); const mismatch = await run(SCHEDULER, ['install', '--platform', 'linux', '--config', box.config], box); assert.equal(mismatch.code, 1); assert.match(mismatch.stderr, /登録できません/); const newline = await run(SCHEDULER, ['install', '--config', `${box.config}\n`], box); assert.equal(newline.code, 1); assert.match(newline.stderr, /改行/); });
test('collection/reporting=falseのrunnerはstate/outboxを作らず正常skipする', async () => { const box = await sandbox(CURRENT_PROFILE, false); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 0); assert.deepEqual(result.json, { ok: true, post_gate_status: 'skipped', skipped: 'collection-and-reporting-disabled' }); await assert.rejects(lstat(box.state)); });
test('post-update gateは完全一致allowlist以外のunverifiedと全failをblockingにする', async () => {
  const profile = CURRENT_PROFILE === 'mac' ? 'windows-native' : CURRENT_PROFILE;
  const required = ['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'peertable', ...(profile === 'server' ? ['servermanager'] : []), ...(profile === 'windows-native' ? [] : ['claude-code', 'codex-cli'])];
  const report = (checks) => ({ products: Object.fromEntries(required.map((id) => [id, { presence_status: 'installed', compatibility_status: 'compatible', checks: checks[id] ?? [] }])) });
  const allowed = { spotter: [{ check_id: 'codex_hooks', status: 'unverified', reason_code: 'trust_not_machine_verifiable' }], throughline: [{ check_id: 'evidence_restore_smoke', status: 'unverified', reason_code: 'diagnostic_unverified' }, { check_id: 'claude_connector', status: 'unverified', reason_code: 'diagnostic_unverified' }], 'aiterm-mcp': [{ check_id: 'pty_list', status: 'unverified', reason_code: 'pty_list_unverified' }] };
  const facts = { profile, os: profile === 'windows-native' ? 'win32' : process.platform, arch: process.arch };
  assert.deepEqual(postUpdateFailures(report(allowed), facts), []);
  assert.deepEqual(postUpdateFailures(report({ spotter: [{ check_id: 'codex_hooks', status: 'unverified', reason_code: 'different_reason' }] }), facts), ['spotter:codex_hooks']);
  assert.deepEqual(postUpdateFailures(report({ throughline: [{ check_id: 'unknown_component', status: 'unverified', reason_code: 'diagnostic_unverified' }] }), facts), ['throughline:unknown_component']);
  assert.deepEqual(postUpdateFailures(report({ 'aiterm-mcp': [{ check_id: 'pty_list', status: 'fail', reason_code: 'pty_list_unverified' }] }), facts), ['aiterm-mcp:pty_list']);
});
test('collection=falseでもreporting=trueなら既存outboxをflushする', async () => { const box = await sandbox(CURRENT_PROFILE, false, true); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.json, { ok: true, post_gate_status: 'success' }); await stat(join(box.state, 'outbox')); await assert.rejects(lstat(join(box.state, 'latest-report.json'))); });
test('v4 runnerのWindows ACLはreporterと同じLiteralPath・current SID・継承遮断契約を使う', async () => { const source = await readFile(RUNNER, 'utf8'); assert.match(source, /DOTAGENTS_FACTORY_ACL_TARGET/); assert.match(source, /WindowsIdentity\]::GetCurrent\(\)\.User/); assert.match(source, /Get-Item -LiteralPath \$p/); assert.match(source, /RemoveAccessRuleAll/); assert.doesNotMatch(source, /New-Object Security\.AccessControl\.(?:Directory|File)Security/); assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/); assert.match(source, /FileSystemAclExtensions\]::GetAccessControl\(.*AccessControlSections\]::Access\)/); assert.match(source, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/); assert.doesNotMatch(source, /Set-Acl /); assert.doesNotMatch(source, /\[IO\.(?:Directory|File)\]::SetAccessControl/); assert.match(source, /timeout: 5_000/); assert.match(source, /acl_apply_failed/); });
test('runnerはcollection=falseでもhost profileと実platformの不一致をfail closedする', async () => { const box = await sandbox(CURRENT_PROFILE === 'mac' ? 'windows-native' : 'mac', false); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 1); assert.match(result.stderr, /実行中platformと一致/); });
test('runnerはprivate lock競合時にscan/enqueue/flushへ進まず非0にする', async () => { const box = await sandbox(CURRENT_PROFILE, true); await writeRunnerLock(box, process.pid); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 1); assert.match(result.stderr, /すでに実行中/); });
test('runnerは旧directory lockをageだけで奪わず明示回収を要求する', async () => { const box = await sandbox(CURRENT_PROFILE, false, true); const lock = join(box.state, 'schedule.lock'); await mkdir(lock, { recursive: true }); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 1); assert.match(result.stderr, /明示回収/); await stat(lock); });
test('win32はtask XMLをUTF-16LE+BOMで書き、存在照会をlocaleテキストでなくGet-ScheduledTask exit codeで行う', async () => {
  const source = await readFile(SCHEDULER, 'utf8');
  const windows = await readFile(join(ROOT, 'lib', 'factory', 'windows-scheduler.mjs'), 'utf8');
  assert.match(source, /writeWindowsTaskXml/);
  assert.match(windows, /Buffer\.from\(`\\ufeff\$\{content\}`, 'utf16le'\)/u);
  assert.match(windows, /Get-ScheduledTask -TaskName '\$\{taskName\}' -ErrorAction SilentlyContinue/u);
  assert.match(windows, /exit 3/u);
  assert.doesNotMatch(windows, /schtasks\.exe', \['\/Query'/u);
});
test('runnerはlaunchd/cron最小PATHでもuser binとnpm globalの製品CLIを補完解決し、明示PATHを先勝ちに保つ', { skip: process.platform === 'win32' }, async () => {
  const { extendedSchedulerPath } = await import('../../lib/factory/scheduler-path.mjs');
  const minimal = '/usr/bin:/bin:/usr/sbin:/sbin';
  const extended = extendedSchedulerPath({ platform: 'darwin', path: minimal, execPath: '/opt/homebrew/bin/node', home: '/Users/u' });
  assert.ok(extended.startsWith(`${minimal}:`));
  assert.ok(extended.includes('/Users/u/.local/bin'));
  assert.ok(extended.includes('/opt/homebrew/bin'));
  assert.equal(extendedSchedulerPath({ platform: 'win32', path: 'C:\\x', execPath: '', home: '' }), 'C:\\x');
  const linuxExtended = extendedSchedulerPath({ platform: 'linux', path: '/a:/opt/homebrew/bin', execPath: '/nvm/v1/bin/node', home: '/home/u' });
  assert.ok(linuxExtended.includes('/home/u/.npm-global/bin'));
  assert.equal(linuxExtended.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1);
  const box = await sandbox(CURRENT_PROFILE, true, false);
  const localBin = join(box.root, '.local', 'bin');
  const npmGlobalBin = join(box.root, '.npm-global', 'bin');
  await mkdir(localBin, { recursive: true });
  await mkdir(npmGlobalBin, { recursive: true });
  await fixtureCommand(npmGlobalBin, 'caveat', 'exit 1');
  for (const name of ['throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await fixtureCommand(localBin, name, 'exit 1');
  await fixtureCommand(localBin, 'git', 'echo 1234567');
  const minimalRun = await run(RUNNER, ['--config', box.config], box, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.equal(minimalRun.code, 0, minimalRun.stderr);
  const report = JSON.parse(await readFile(join(box.state, 'latest-report.json'), 'utf8'));
  assert.notEqual(report.products.caveat.presence_status, 'missing');
  const override = join(box.root, 'override-bin');
  await mkdir(override);
  await fixtureCommand(override, 'caveat', 'exit 7');
  const overrideRun = await run(RUNNER, ['--config', box.config], box, { PATH: `${override}:/usr/bin:/bin:/usr/sbin:/sbin` });
  assert.equal(overrideRun.code, 0, overrideRun.stderr);
  const overrideReport = JSON.parse(await readFile(join(box.state, 'latest-report.json'), 'utf8'));
  assert.notEqual(overrideReport.products.caveat.presence_status, 'missing');
});
test('runnerは原子的owner contenderの死んだPIDだけを掃除して再実行できる', async () => { const box = await sandbox(CURRENT_PROFILE, false, true); const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const deadPid = child.pid; await new Promise((resolveClose) => child.on('close', resolveClose)); const dead = await writeRunnerLock(box, deadPid); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.json, { ok: true, post_gate_status: 'success' }); await assert.rejects(lstat(dead)); assert.deepEqual((await readdir(box.state)).filter((name) => name.includes('schedule.lock.')), []); });
test('runnerはowner完成後の固有hard-link公開とnonce一致cleanupで共有lock削除を避ける', async () => { const source = await readFile(RUNNER, 'utf8'); assert.match(source, /await link\(temporary, published\)/); assert.match(source, /current\?\.nonce === nonce/); assert.match(source, /schedule\\\.lock\\\.\[0-9a-f-\]\{36\}\\\.owner/); assert.doesNotMatch(source, /\.reclaim|oldEnough|mtimeMs/); });
test('runnerは既存POSIX stateのgroup/other permissionを0700へ矯正する', { skip: process.platform === 'win32' }, async () => { const box = await sandbox(CURRENT_PROFILE, true); await chmod(await mkdir(box.state, { recursive: true }).then(() => box.state), 0o755); await writeRunnerLock(box, process.pid); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 1); assert.equal((await stat(box.state)).mode & 0o777, 0o700); });
test('v4 runnerはstate symlink先へscan artifactを書かない', async () => { const box = await sandbox(CURRENT_PROFILE, true); const target = join(box.root, 'symlink-target'); await mkdir(target); await mkdir(join(box.state, '..'), { recursive: true }); await symlink(target, box.state, process.platform === 'win32' ? 'junction' : undefined); const result = await run(RUNNER, ['--config', box.config], box); assert.equal(result.code, 1); assert.match(result.stderr, /symlink/); assert.deepEqual(await readdir(target), []); });
test('通常runはcomponent healthをexitへ変換せず、post-updateだけがdefault-deny gateを適用する', async () => { const box = await sandbox(CURRENT_PROFILE, true, false); const bin = join(box.root, 'bin'); await mkdir(bin); for (const name of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await fixtureCommand(bin, name, 'exit 1'); await fixtureCommand(bin, 'lattice', `
if [ "$1" = --version ]; then echo 0.7.0
elif [ "$1" = factory-diagnostics ]; then echo '{"schema":"lattice.native_factory_diagnostics.v1","product":"lattice","version":"0.7.0","overall":"ok","checks":[{"id":"package_version","status":"ok","detail":"0.7.0"},{"id":"node_runtime","status":"ok","detail":"ready"},{"id":"cli_surface","status":"ok","detail":"ready"},{"id":"mcp_entry","status":"ok","detail":"ready"},{"id":"sensor_attribution","status":"ok","detail":"ready"}]}'
elif [ "$1" = runtime-errors ]; then echo '{"schema":"lattice.runtime_errors.v1","product":"lattice","version":"0.7.0","state_schema_version":"1.0","cursor":{"high_watermark":0,"acknowledged_through":0,"next":0},"runtime_errors":[],"resolutions":[],"diagnostics":{"collection":"enabled","status":"ready","total_count":0,"pending_count":0,"truncated":false}}'
else exit 1; fi
`); await fixtureCommand(bin, 'git', 'echo 1234567'); const normal = await run(RUNNER, ['--config', box.config], box, { PATH: bin }); assert.equal(normal.code, 0, normal.stderr); const result = await run(RUNNER, ['--config', box.config, '--post-update'], box, { PATH: bin }); assert.equal(result.code, 1); assert.deepEqual(result.json, { ok: false, post_gate_status: 'failed', failed_checks: CURRENT_PROFILE === 'windows-native' ? 7 : 9 }); });
test('finalize-updateは最終ledgerを再投影し、製品failure自体を配送失敗へ偽装しない', async () => { const box = await sandbox(CURRENT_PROFILE, false, false); const bin = join(box.root, 'bin'); await mkdir(bin); for (const name of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await fixtureCommand(bin, name, 'exit 1'); await fixtureCommand(bin, 'git', 'echo 1234567'); const result = await run(RUNNER, ['--config', box.config, '--finalize-update'], box, { PATH: bin }); assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.json, { ok: true, finalized: true }); await stat(join(box.state, 'latest-report.json')); });
test('v7 finalize-updateはBugHub acceptedかつ今回report_id一致時だけdelivery receiptを原子的に作る', async () => {
  const token = '11111111-1111-4111-8111-111111111111';
  const cases = [
    ['accepted', true, (response, report) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted: true, report_id: report.report_id })); }, true],
    ['unaccepted', true, (response, report) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted: false, report_id: report.report_id })); }, false],
    ['http-failure', true, (response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}'); }, false],
    ['reporting-disabled', false, null, false],
  ];
  for (const [name, reporting, handler, receiptExpected] of cases) {
    let requests = 0;
    const server = createServer(async (request, response) => {
      requests += 1;
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      handler(response, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const box = await sandbox(CURRENT_PROFILE, false, reporting);
      const address = server.address();
      if (reporting) await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: CURRENT_PROFILE }, collection: { enabled: false }, reporting: { enabled: true, endpoint: `http://127.0.0.1:${address.port}/api/factory/v7/reports`, credential_file: box.credential } }));
      const result = await run(V7_RUNNER, ['--config', box.config, '--finalize-update'], box, { PATH: await v7FixtureBin(box), AGENTS_UPDATE_BATCH_TOKEN: token });
      const state = join(box.stateRoot, 'factory-reporter-v7');
      const receipt = join(state, 'delivery-receipt.json');
      if (receiptExpected) {
        assert.equal(result.code, 0, `${name}: ${result.stderr}`);
        const report = JSON.parse(await readFile(join(state, 'latest-report.json'), 'utf8'));
        assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { schema: 'dotagents.factory-delivery-receipt.v1', report_id: report.report_id, batch_token: token });
        assert.equal(requests, 1);
      } else {
        assert.equal(result.code, name === 'reporting-disabled' ? 0 : 1, `${name}: ${result.stderr}`);
        await assert.rejects(lstat(receipt));
        assert.equal(requests, reporting ? 1 : 0);
      }
    } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
  }
});
test('finalize-updateはpending台帳をenqueue前に拒否しnetworkへ送らない', async () => {
  const requests = [];
  const server = createServer((request, response) => { requests.push(request.url); request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const box = await sandbox(CURRENT_PROFILE, false, true);
    const address = server.address();
    await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: CURRENT_PROFILE }, collection: { enabled: false }, reporting: { enabled: true, endpoint: `http://127.0.0.1:${address.port}/api/factory/v2/reports`, credential_file: box.credential } }));
    const bin = join(box.root, 'bin'); await mkdir(bin);
    for (const name of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await fixtureCommand(bin, name, 'exit 1');
    await fixtureCommand(bin, 'git', 'echo 1234567');
    const ledgerDirectory = process.platform === 'win32' ? join(box.root, 'local-app-data', 'dotagents', 'agents-update') : join(box.root, 'state-home', 'agents-update'); await mkdir(ledgerDirectory, { recursive: true });
    const pending = { before_version: null, latest_version: null, operation_status: 'success', after_version: null, post_gate_status: 'pending', reason_code: 'updated', observed_at: '2026-07-13T14:00:00.000Z' };
    await writeFile(join(ledgerDirectory, 'toolchain-ledger.json'), JSON.stringify({ schema_version: 'dotagents.toolchain-update.v1', products: { 'claude-code': pending, 'codex-cli': pending, 'grok-build': pending } }), { mode: 0o600 });
    const result = await run(RUNNER, ['--config', box.config, '--finalize-update'], box, { PATH: bin });
    assert.equal(result.code, 1); assert.match(result.stderr, /post_gate_pending/); assert.deepEqual(requests, []);
  } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
});
