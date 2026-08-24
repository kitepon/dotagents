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

export function windowsTaskExists(taskName, spawn = spawnSync) {
  const command = `if (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`;
  const powershell = resolveWindowsPowerShell7(spawn);
  const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 15_000 });
  if (result.error?.code === 'ENOENT') throw new Error(`PowerShell 7が必要です: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  throw new Error(`Windows Task Scheduler照会に失敗しました: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`);
}

// 既存タスクが工場の日次契約（2:00・LeastPrivilege・Interactive・一撃setup -ScheduledRun）と一致するか。
// 昇格作成の残骸は schtasks /Create /F も /Delete も Access Denied になるので、一致時は再登録しない。
export function windowsDailyFactoryTaskMatches(taskName, runner, powershell, spawn = spawnSync) {
  if (typeof runner !== 'string' || !runner || /[\r\n']/u.test(runner)) throw new Error('scheduler runnerが不正です');
  if (typeof powershell !== 'string' || !win32.isAbsolute(powershell)
    || win32.basename(powershell).toLowerCase() !== WINDOWS_POWERSHELL_7_COMMAND
    || /[\r\n']/u.test(powershell)) throw new Error('PowerShell 7 pathが不正です');
  const command = `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue
if (-not $t) { exit 3 }
$action = @($t.Actions)[0]
$trigger = @($t.Triggers)[0]
$ok = ($t.Settings.Enabled -eq $true) -and (@($t.Actions).Count -eq 1) -and ($action.Execute -eq '${powershell.replaceAll("'", "''")}') -and ($action.Arguments -like '*setup-windows-native-factory.ps1*') -and ($action.Arguments -like '*-ScheduledRun*') -and ($action.Arguments -like '*${runner.replaceAll("'", "''")}*') -and (@($t.Triggers).Count -eq 1) -and ($trigger.DaysInterval -eq 1) -and (([datetime]$trigger.StartBoundary).TimeOfDay -eq [timespan]::FromHours(2)) -and ($t.Principal.RunLevel -eq 'Limited') -and ($t.Principal.LogonType -eq 'Interactive')
if ($ok) { exit 0 } else { exit 4 }`;
  const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 15_000 });
  if (result.error?.code === 'ENOENT') throw new Error(`PowerShell 7が必要です: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  if (result.status === 0) return true;
  if (result.status === 3 || result.status === 4) return false;
  throw new Error(`Windows Task Scheduler照合に失敗しました: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`);
}

export async function writeWindowsTaskXml(file, content) {
  await writeFile(file, Buffer.from(`\ufeff${content}`, 'utf16le'), { mode: 0o600 });
}
