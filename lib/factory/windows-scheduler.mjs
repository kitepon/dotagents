import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  WINDOWS_POWERSHELL_7_COMMAND,
  WINDOWS_POWERSHELL_7_INSTALL,
  resolveWindowsPowerShell7,
} from './windows-powershell.mjs';

export function windowsOwnerOnlyAclScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
$p = $env:DOTAGENTS_FACTORY_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($p) -or -not (Test-Path -LiteralPath $p)) { throw 'ACL target is invalid' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $p
$inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($item, [Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { if ($null -ne $existing) { [void]$acl.RemoveAccessRuleAll($existing) } }
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
[IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)`;
}

// GUI script host prevents the initial console flash; wait preserves Task Scheduler exit status.
export function windowsHiddenTask(file, commandLine) {
  if ([file, commandLine].some((value) => typeof value !== 'string' || !value || /[\0\r\n]/u.test(value))) throw new Error('hidden task commandが不正です');
  if (file.includes('"')) throw new Error('hidden task pathが不正です');
  return {
    command: win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    arguments: `//B //Nologo //E:JScript "${file}"`,
    launcher: { file, content: `WScript.Quit(new ActiveXObject("WScript.Shell").Run(${JSON.stringify(commandLine)}, 0, true));\r\n` },
  };
}

export function windowsTaskExists(taskName, spawn = spawnSync) {
  const command = `if (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`;
  const powershell = resolveWindowsPowerShell7(spawn);
  const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (result.error?.code === 'ENOENT') throw new Error(`PowerShell 7が必要です: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  throw new Error(`Windows Task Scheduler照会に失敗しました: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`);
}

// 既存タスクが工場の日次契約（2:00・LeastPrivilege・Interactive・一撃setup -ScheduledRun）と一致するか。
// 昇格作成の残骸は schtasks /Create /F も /Delete も Access Denied になるので、一致時は再登録しない。
export function windowsDailyFactoryTaskMatches(taskName, action, powershell, spawn = spawnSync) {
  if (typeof action?.command !== 'string' || !win32.isAbsolute(action.command)
    || win32.basename(action.command).toLowerCase() !== 'wscript.exe'
    || typeof action.arguments !== 'string' || /[\0\r\n]/u.test(action.command + action.arguments)) throw new Error('hidden scheduler actionが不正です');
  if (typeof powershell !== 'string' || !win32.isAbsolute(powershell) || win32.basename(powershell).toLowerCase() !== WINDOWS_POWERSHELL_7_COMMAND || /[\r\n']/u.test(powershell)) throw new Error('PowerShell 7 pathが不正です');
  const command = `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue
if (-not $t) { exit 3 }
$action = @($t.Actions)[0]
$trigger = @($t.Triggers)[0]
$ok = ($t.Settings.Enabled -eq $true) -and (@($t.Actions).Count -eq 1) -and ($action.Execute -eq '${action.command.replaceAll("'", "''")}') -and ($action.Arguments -eq '${action.arguments.replaceAll("'", "''")}') -and (@($t.Triggers).Count -eq 1) -and ($trigger.DaysInterval -eq 1) -and (([datetime]$trigger.StartBoundary).TimeOfDay -eq [timespan]::FromHours(2)) -and ($t.Principal.RunLevel -eq 'Limited') -and ($t.Principal.LogonType -eq 'Interactive')
if ($ok) { exit 0 } else { exit 4 }`;
  const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (result.error?.code === 'ENOENT') throw new Error(`PowerShell 7が必要です: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  if (result.status === 0) return true;
  if (result.status === 3 || result.status === 4) return false;
  throw new Error(`Windows Task Scheduler照合に失敗しました: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`);
}

export async function writeWindowsTaskXml(file, content, launcher) {
  if (launcher) await writeFile(launcher.file, Buffer.from(`\ufeff${launcher.content}`, 'utf16le'), { mode: 0o600 });
  await writeFile(file, Buffer.from(`\ufeff${content}`, 'utf16le'), { mode: 0o600 });
}
