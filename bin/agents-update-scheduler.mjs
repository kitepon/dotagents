#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { assertFixtureSidUsage } from '../lib/factory/agents-update-scheduler-contract.mjs';
import { windowsDailyFactoryTaskMatches, windowsOwnerOnlyAclScript, windowsTaskExists, writeWindowsTaskXml } from '../lib/factory/windows-scheduler.mjs';
import { resolveWindowsPowerShell7 } from '../lib/factory/windows-powershell.mjs';

const TASK_NAME = 'dotagents-agents-update';
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { process.stderr.write(`[agents-update-scheduler] ${message}\n`); emit({ ok: false, code: 'AGENTS_UPDATE_SCHEDULER_ERROR' }); process.exitCode = 1; }
function xml(value) { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new Error('scheduler pathが不正です'); return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function parse(argv) { const [command, ...rest] = argv; if (!['install', 'status', 'uninstall'].includes(command)) throw new Error('使い方: agents-update-scheduler install|status|uninstall [--dry-run|--apply] [--sid <SID>]'); const modes = rest.filter((v) => v === '--dry-run' || v === '--apply'); const sidIndex = rest.indexOf('--sid'); const sid = sidIndex < 0 ? null : rest[sidIndex + 1]; const valid = rest.filter((v, i) => v === '--dry-run' || v === '--apply' || i === sidIndex || i === sidIndex + 1); if (modes.length > 1 || valid.length !== rest.length || (sidIndex >= 0 && (!sid || !/^S-1-[0-9-]+$/iu.test(sid)))) throw new Error('引数が不正です'); return { command, dryRun: modes[0] !== '--apply', sid }; }
function paths() { const home = process.env.USERPROFILE || process.env.HOME || homedir(); const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'); return { home, control: join(local, 'dotagents', 'agents-update-scheduler'), artifact: join(local, 'dotagents', 'agents-update-scheduler', 'scheduler', `${TASK_NAME}.xml`), runner: join(dirname(fileURLToPath(import.meta.url)), 'setup-windows-native-factory.ps1') }; }
function currentSid() { const result = spawnSync(resolveWindowsPowerShell7(), ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', timeout: 5_000 }); const sid = result.stdout?.trim(); if (result.status !== 0 || !/^S-1-[0-9-]+$/iu.test(sid)) throw new Error('Windows current SIDを取得できません'); return sid; }
function artifact(location, sid, powershell) { const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;${xml(location.runner)}&quot; -ScheduledRun`; return { content: `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><CalendarTrigger><StartBoundary>2026-01-01T02:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(powershell)}</Command><Arguments>${args}</Arguments><WorkingDirectory>${xml(location.home)}</WorkingDirectory></Exec></Actions></Task>` }; }
function applyAcl(path) { const result = spawnSync(resolveWindowsPowerShell7(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsOwnerOnlyAclScript()], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, DOTAGENTS_FACTORY_ACL_TARGET: path } }); if (result.status !== 0) throw new Error('Windows owner-only ACL設定に失敗しました'); }
async function main() { const request = parse(process.argv.slice(2)); assertFixtureSidUsage({ ...request, os: platform() }); if (!request.dryRun && platform() !== 'win32') throw new Error('--applyはWindows nativeだけで実行できます'); const location = paths(); if (request.command === 'status') { if (request.dryRun) return emit({ ok: true, command: 'status', dry_run: true, task_name: TASK_NAME, artifact: location.artifact }); return emit({ ok: true, command: 'status', installed: windowsTaskExists(TASK_NAME), task_name: TASK_NAME, artifact: location.artifact }); }
  if (request.command === 'uninstall') { if (request.dryRun) return emit({ ok: true, command: 'uninstall', dry_run: true, task_name: TASK_NAME, artifact: location.artifact, rollback: 'agents-update-scheduler uninstall --apply' }); }
  const fixturePowerShell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const powershell = request.command === 'install'
    ? (platform() === 'win32' ? resolveWindowsPowerShell7() : fixturePowerShell) : null;
  const spec = request.command === 'install' ? artifact(location,
    request.dryRun ? (platform() === 'win32' ? currentSid() : (() => { if (!request.sid) throw new Error('非Windowsのinstall --dry-runは--sidが必要です'); return request.sid; })()) : currentSid(),
    powershell) : null;
  if (request.command === 'install' && !request.dryRun) {
    if (!existsSync(location.runner)) throw new Error('scheduled runnerが未配布です。./install.sh を実行してください');
    await mkdir(dirname(location.artifact), { recursive: true, mode: 0o700 });
    applyAcl(location.control);
    await writeWindowsTaskXml(location.artifact, spec.content);
    if (windowsTaskExists(TASK_NAME) && windowsDailyFactoryTaskMatches(TASK_NAME, location.runner, powershell)) {
      return emit({ ok: true, command: request.command, dry_run: false, already_installed: true, task_name: TASK_NAME, artifact: location.artifact, artifact_content: spec.content, commands: [['schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', location.artifact, '/F']], rollback: 'agents-update-scheduler uninstall --apply' });
    }
    const result = spawnSync('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', location.artifact, '/F'], { encoding: 'utf8' });
    if (result.status !== 0) {
      const leftover = windowsTaskExists(TASK_NAME) ? '。既存タスクが契約と不一致で、昇格作成の残骸だとユーザー空間からは上書きできません。タスク スケジューラから dotagents-agents-update を削除して再実行してください' : '';
      throw new Error(`Windows Task Scheduler登録に失敗しました (status ${result.status})${leftover}`);
    }
    if (!windowsTaskExists(TASK_NAME)) throw new Error('Windows Task Scheduler登録後の読み戻しに失敗しました');
  }
  if (request.command === 'uninstall' && !request.dryRun) { if (windowsTaskExists(TASK_NAME)) { const result = spawnSync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' }); if (result.status !== 0) throw new Error('Windows Task Scheduler解除に失敗しました'); } await rm(location.artifact, { force: true }); }
  emit({ ok: true, command: request.command, dry_run: request.dryRun, task_name: TASK_NAME, artifact: location.artifact, artifact_content: request.command === 'install' ? spec.content : undefined, commands: request.command === 'install' ? [['schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', location.artifact, '/F']] : [['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F']], rollback: 'agents-update-scheduler uninstall --apply' }); }
main().catch((error) => fail(error.message));
