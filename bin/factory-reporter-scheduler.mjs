#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../lib/factory/contract.mjs';
import { windowsOwnerOnlyAclScript, windowsTaskExists, writeWindowsTaskXml } from '../lib/factory/windows-scheduler.mjs';
import { resolveWindowsPowerShell7 } from '../lib/factory/windows-powershell.mjs';

const LABEL = 'com.kite.factory-reporter';
const TASK_NAME = 'dotagents-factory-reporter';
const CRON_MARKER = '# dotagents-factory-reporter';
const UNSAFE_PATH = /[\0\r\n]/;
const NO_CRONTAB = /no crontab(?: for)?/i;
const ABSENT_LAUNCHD = /could not find service|no such process|not found/i;

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { process.stderr.write(`[factory-reporter-scheduler] ${message}\n`); emit({ ok: false, code: 'FACTORY_REPORTER_SCHEDULER_ERROR' }); process.exitCode = 1; }
function safePath(value, name) { if (typeof value !== 'string' || !value || UNSAFE_PATH.test(value)) throw new Error(`${name}に改行またはNULを含められません`); return value; }
function posixQuote(value) { return `'${safePath(value, 'command path').replaceAll("'", "'\"'\"'")}'`; }
function cronQuote(value) { return posixQuote(value).replaceAll('%', '\\%'); }
function xml(value) { return safePath(value, 'XML path').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function windowsQuote(value) { return `&quot;${xml(value)}&quot;`; }
function commandError(result, action) { return new Error(`${action}に失敗しました: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`); }

function locations(target, wireMajor) {
  const home = safePath(process.env.HOME || process.env.USERPROFILE || homedir(), 'HOME');
  const local = safePath(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'LOCALAPPDATA');
  const stateName = wireMajor === 'v1' ? 'factory-reporter' : `factory-reporter-${wireMajor}`;
  if (target === 'win32') return { home, config: join(local, 'dotagents', 'factory-reporter', 'config.json'), state: join(local, 'dotagents', stateName), control: join(local, 'dotagents', 'factory-reporter-scheduler'), legacyStates: [join(local, 'dotagents', 'factory-reporter'), join(local, 'dotagents', 'factory-reporter-v2')] };
  const stateRoot = process.env.XDG_STATE_HOME ? join(safePath(process.env.XDG_STATE_HOME, 'XDG_STATE_HOME'), 'dotagents') : join(home, '.local', 'state', 'dotagents');
  return { home, config: process.env.XDG_CONFIG_HOME ? join(safePath(process.env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME'), 'dotagents', 'factory-reporter.json') : join(home, '.config', 'dotagents', 'factory-reporter.json'), state: join(stateRoot, stateName), control: join(stateRoot, 'factory-reporter-scheduler'), legacyStates: [join(stateRoot, 'factory-reporter'), join(stateRoot, 'factory-reporter-v2')] };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'uninstall'].includes(command)) throw new Error('使い方: factory-reporter-scheduler install|uninstall [--dry-run|--apply] [--wire-major v1|v2|v4|v5|v6|v7|v8] [--config <file>] [--platform darwin|linux|win32]');
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (key === '--dry-run' || key === '--apply') { const mode = key.slice(2); if (options.mode) throw new Error('--dry-runと--applyは併用または重複できません'); options.mode = mode; continue; }
    if (!['--config', '--platform', '--wire-major'].includes(key) || !rest[index + 1] || options[key]) throw new Error('引数が不正です');
    options[key] = rest[++index];
  }
  const target = options['--platform'] || hostPlatform();
  if (!['darwin', 'linux', 'win32'].includes(target)) throw new Error('--platformはdarwin、linux、win32のいずれかです');
  const wireMajor = options['--wire-major'] || 'v4';
  if (!['v1', 'v2', 'v4', 'v5', 'v6', 'v7', 'v8'].includes(wireMajor)) throw new Error('--wire-majorはv1、v2、v4、v5、v6、v7、v8のいずれかです');
  if (options.mode === 'apply' && target !== hostPlatform()) throw new Error('--applyは実行中OSと異なる--platformを指定できません');
  return { command, target, config: options['--config'] && safePath(options['--config'], '--config'), wireMajor, dryRun: options.mode !== 'apply' };
}

function platformMatches(profile, target) { return (target === 'darwin' && profile === 'mac') || (target === 'linux' && ['server', 'linux', 'wsl'].includes(profile)) || (target === 'win32' && profile === 'windows-native'); }
export function stableNodePath(target, executable = process.execPath, exists = existsSync) {
  const node = safePath(executable, 'node path');
  if (target !== 'darwin') return node;
  const match = node.match(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/node\/[^/]+\/bin\/node$/u);
  if (!match) return node;
  const stable = `${match[1]}/bin/node`;
  if (!exists(stable)) throw new Error(`Homebrew stable Node入口がありません: ${stable}`);
  return stable;
}
function artifact(target, config, location, wireMajor) {
  const runnerName = wireMajor === 'v1' ? 'factory-reporter-schedule-runner' : `factory-reporter-${wireMajor}-schedule-runner`;
  const node = stableNodePath(target); const runner = join(location.home, '.local', 'bin', runnerName); const log = join(location.state, 'scheduler.log');
  [runner, log, config, location.state].forEach((value) => safePath(value, 'scheduler path'));
  if (target === 'darwin') {
    const file = join(location.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(LABEL)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string><string>--config</string><string>${xml(config)}</string></array><key>StartCalendarInterval</key><dict><key>Minute</key><integer>17</integer></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
    const domain = `gui/${process.getuid?.() ?? '<uid>'}`; return { file, content, runner, commands: [['launchctl', 'bootstrap', domain, file]], uninstall: [['launchctl', 'bootout', `${domain}/${LABEL}`]], acl: [] };
  }
  if (target === 'linux') {
    const file = join(location.control, 'scheduler', 'factory-reporter.cron');
    const content = `17 * * * * ${cronQuote(node)} ${cronQuote(runner)} --config ${cronQuote(config)} >> ${cronQuote(log)} 2>&1 ${CRON_MARKER}\n`;
    return { file, content, runner, commands: [['crontab', '<managed-crontab-with-entry>']], uninstall: [['crontab', '<managed-crontab-without-entry>']], acl: [] };
  }
  const file = join(location.control, 'scheduler', `${TASK_NAME}.xml`);
  const argumentsText = `${windowsQuote(runner)} --config ${windowsQuote(config)}`;
  const content = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><CalendarTrigger><StartBoundary>2026-01-01T00:17:00</StartBoundary><Repetition><Interval>PT1H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${argumentsText}</Arguments><WorkingDirectory>${xml(location.home)}</WorkingDirectory></Exec></Actions></Task>`;
  const script = windowsOwnerOnlyAclScript();
  const powershell = hostPlatform() === 'win32'
    ? resolveWindowsPowerShell7() : 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  return { file, content, runner, commands: [['schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', file, '/F']], uninstall: [['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F']], acl: [[powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]] };
}

async function ensurePrivateState(target, state, acl) {
  try { const info = await lstat(state); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathはsymlinkでないdirectoryでなければなりません'); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(state, { recursive: true, mode: 0o700 }); const info = await lstat(state); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathはsymlinkでないdirectoryでなければなりません'); }
  if (target !== 'win32') { await chmod(state, 0o700); return; }
  const [bin, ...args] = acl[0]; const result = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, DOTAGENTS_FACTORY_ACL_TARGET: state }, timeout: 5_000 });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Windows owner-only ACL設定に失敗しました (acl_timeout)');
  if (result.error) throw new Error('Windows owner-only ACL設定に失敗しました (acl_process_failed)');
  if (result.status !== 0) throw new Error('Windows owner-only ACL設定に失敗しました (acl_apply_failed)');
}

function readCrontab() { const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' }); if (result.status === 0) return result.stdout; if (result.status === 1 && NO_CRONTAB.test(`${result.stderr}\n${result.stdout}`)) return ''; throw commandError(result, 'crontab読取'); }
export function nextCron(current, content, removeOnly) { const managed = content.trimEnd(); const ownedSuffix = ` ${CRON_MARKER}`; const lines = current.split('\n'); while (lines.at(-1) === '') lines.pop(); const kept = lines.filter((line) => !line.trimEnd().endsWith(ownedSuffix)); if (!removeOnly) kept.push(managed); return kept.length === 0 ? '' : `${kept.join('\n')}\n`; }
function replaceCron(content, removeOnly) { const current = readCrontab(); const result = spawnSync('crontab', ['-'], { input: nextCron(current, content, removeOnly), encoding: 'utf8' }); if (result.status !== 0) throw commandError(result, 'crontab更新'); }
function isAbsent(result, pattern) { return result.status !== 0 && pattern.test(`${result.stderr}\n${result.stdout}`); }

// schtasksのconsole出力はOS localeのcodepage（日本語Windowsはcp932）で、UTF-8 decodeすると
// mojibake化して不在文言regexが一致しない。存在判定はlocaleテキストに依存しない
// PowerShell Get-ScheduledTaskのexit codeだけで行う。

async function apply(command, target, spec, location) {
  if (command === 'install') {
    await ensurePrivateState(target, location.state, spec.acl); await ensurePrivateState(target, location.control, spec.acl); await mkdir(dirname(spec.file), { recursive: true, mode: 0o700 }); if (target === 'win32') await writeWindowsTaskXml(spec.file, spec.content); else await writeFile(spec.file, spec.content, { mode: 0o600 });
    if (target === 'linux') { replaceCron(spec.content, false); await removeLegacyArtifacts(target, location); return; }
    if (target === 'darwin') { const probe = spawnSync('launchctl', ['print', spec.uninstall[0][2]], { encoding: 'utf8' }); if (probe.status === 0) { const stopped = spawnSync('launchctl', spec.uninstall[0].slice(1), { encoding: 'utf8' }); if (stopped.status !== 0) throw commandError(stopped, 'launchd既存scheduler停止'); } else if (!isAbsent(probe, ABSENT_LAUNCHD)) throw commandError(probe, 'launchd scheduler照会'); }
    const [bin, ...args] = spec.commands[0]; const result = spawnSync(bin, args, { encoding: 'utf8' }); if (result.status !== 0) throw commandError(result, `${bin}登録`); await removeLegacyArtifacts(target, location); return;
  }
  if (target === 'linux') replaceCron(spec.content, true);
  else if (target === 'darwin') { const probe = spawnSync('launchctl', ['print', spec.uninstall[0][2]], { encoding: 'utf8' }); if (probe.status === 0) { const result = spawnSync('launchctl', spec.uninstall[0].slice(1), { encoding: 'utf8' }); if (result.status !== 0) throw commandError(result, 'launchd解除'); } else if (!isAbsent(probe, ABSENT_LAUNCHD)) throw commandError(probe, 'launchd scheduler照会'); }
  else if (windowsTaskExists(TASK_NAME)) { const [bin, ...args] = spec.uninstall[0]; const result = spawnSync(bin, args, { encoding: 'utf8' }); if (result.status !== 0) throw commandError(result, 'Windows Task Scheduler解除'); }
  await rm(spec.file, { force: true }); await removeLegacyArtifacts(target, location);
}

export async function removeLegacyArtifacts(target, location) {
  if (target === 'darwin') return;
  const filename = target === 'linux' ? 'factory-reporter.cron' : `${TASK_NAME}.xml`;
  await Promise.all(location.legacyStates.map((state) => rm(join(state, 'scheduler', filename), { force: true })));
}

async function main() {
  const request = parseArgs(process.argv.slice(2)); const location = locations(request.target, request.wireMajor); const configPath = request.config || location.config;
  if (request.command === 'install') { const config = await readConfig(configPath); if (config.source !== 'file') throw new Error('設定ファイルなしではschedulerを登録しません'); if (!platformMatches(config.host.profile, request.target)) throw new Error(`host.profile=${config.host.profile}は${request.target} schedulerに登録できません`); assertReportingEndpoint(config, request.wireMajor); }
  const spec = artifact(request.target, configPath, location, request.wireMajor);
  // --applyは、schedulerが指すrunnerが実際に起動可能であることを登録前に検証する。
  // 配布symlink（install.sh）が未実行だと、登録は成功するのに実行時にCannot find moduleで落ちる
  // fail-openになる（2026-08-10実被弾: wire v7 canary cutover）。dry-runはartifact確認用のため検証しない。
  if (request.command === 'install' && !request.dryRun) assertRunnerExecutable(spec.runner, request.target);
  if (!request.dryRun) await apply(request.command, request.target, spec, location);
  emit({ ok: true, command: request.command, dry_run: request.dryRun, platform: request.target, wire_major: request.wireMajor, config: configPath, state: location.state, artifact: spec.file, artifact_content: request.command === 'install' ? spec.content : undefined, commands: request.command === 'install' ? spec.commands : spec.uninstall, acl_commands: spec.acl, reporting_enabled_changed: false, collection_enabled_changed: false });
}
function assertRunnerExecutable(runner, target) {
  if (!existsSync(runner)) throw new Error(`schedulerが起動するrunnerが存在しません (runner_unresolved): ${runner}。./install.sh を再実行してsymlinkを配布してから--applyしてください`);
  if (target !== 'win32') {
    try { accessSync(runner, fsConstants.X_OK); } catch { throw new Error(`schedulerが起動するrunnerに実行権限がありません (runner_unresolved): ${runner}`); }
  }
}
function assertReportingEndpoint(config, wireMajor) {
  if (!config.reporting.enabled) return;
  const expected = `/api/factory/${wireMajor}/reports`;
  let endpoint;
  try { endpoint = new URL(config.reporting.endpoint); } catch { throw new Error('reporting.endpointがURLではありません'); }
  if (endpoint.pathname !== expected) throw new Error(`reporting.endpointは${expected}でなければなりません`);
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => fail(error?.message || '失敗'));
}
