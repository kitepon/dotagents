#Requires -Version 7.0
# Elevated, Owner-approved step on Fox: add the pinned parallel runner instances under the EXISTING dedicated task.
# Contract: docs/feature-map/runner-capacity.md. The operator dot-sources the admin API broker (Invoke-Sec002AdminApi).
# Never resets the factory-runner password: an admin reset destroys the user DPAPI key that protects the
# registered instance's .credentials_rsaparams and invalidates the task credential.
[CmdletBinding()]
param([ValidateSet('Inspect','Apply')][string]$Mode = 'Inspect', [string]$ApprovalId = '', [string]$SourceDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$tools = 'C:\ProgramData\dotagents\factory-tools'
$taskName = 'dotagents-factory-runner-dedicated'
$existingRoot = 'C:\actions-runner-dotagents-u'
$newRoots = [ordered]@{ 'factory-windows-fox-u2' = 'C:\actions-runner-dotagents-u2'; 'factory-windows-fox-u3' = 'C:\actions-runner-dotagents-u3' }
$names = @('factory-windows-fox-u') + @($newRoots.Keys)
$files = [ordered]@{
  "$tools\native-task-entry.ps1" = 'windows-factory-runner-task-entry.ps1'
  "$tools\run-dedicated.ps1" = 'windows-factory-runner-run.ps1'
  'C:\ProgramData\dotagents\factory-runner\job-started.ps1' = 'windows-factory-runner-job-started.ps1'
}
# Runner layout copied from the registered root; identity, credentials, logs and work stay behind.
$layout = @('bin','externals','config.cmd','run.cmd','run-helper.cmd.template','run-helper.sh.template','.path','.env')

function Get-Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() } }
function Get-Workers { @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'") }

$factory = Get-LocalUser -Name 'factory-runner'
$task = Get-ScheduledTask -TaskName $taskName
$state = [ordered]@{
  factory_sid = $factory.SID.Value; task_state = [string]$task.State; workers = (Get-Workers).Count
  files = [ordered]@{}; roots = [ordered]@{}
}
foreach ($f in $files.GetEnumerator()) { $state.files[$f.Key] = [ordered]@{ current = (Get-Sha $f.Key); staged = (Get-Sha (Join-Path $SourceDir $f.Value)) } }
foreach ($r in $newRoots.GetEnumerator()) { $state.roots[$r.Key] = [ordered]@{ exists = (Test-Path -LiteralPath $r.Value); registered = (Test-Path -LiteralPath (Join-Path $r.Value '.runner')) } }
if ($Mode -eq 'Inspect') { $state | ConvertTo-Json -Depth 4; return }

if ($ApprovalId -notmatch '^K-[A-Z0-9]{6}$') { throw 'Owner approval id required' }
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevation required' }
if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $factory.SID.Value }) { throw 'Factory account must remain nonadministrator' }
if ($task.Principal.LogonType -ne 'Password' -or $task.Principal.RunLevel -ne 'Limited' -or $task.Principal.UserId -notmatch '(^|\\)factory-runner$') { throw 'Unexpected dedicated task principal' }
if (!(Get-Command Invoke-Sec002AdminApi -ErrorAction SilentlyContinue)) { throw 'Admin API broker not loaded' }
foreach ($f in $state.files.Values) { if (!$f.staged) { throw 'Staged helper missing' } }
if ((Get-Workers).Count) { [ordered]@{ result = 'busy'; changed = $false } | ConvertTo-Json -Compress; exit 3 }

# 1. Roots: protected ACL copied from the registered root (Admins/SYSTEM/factory only), then the runner layout.
foreach ($r in $newRoots.GetEnumerator()) {
  if (Test-Path -LiteralPath (Join-Path $r.Value '.runner')) { continue }
  if (!(Test-Path -LiteralPath $r.Value)) {
    New-Item -ItemType Directory -Path $r.Value | Out-Null
    Set-Acl -LiteralPath $r.Value -AclObject (Get-Acl -LiteralPath $existingRoot)
  }
  foreach ($item in $layout) {
    $from = Get-Item -LiteralPath (Join-Path $existingRoot $item) -Force
    # Runner self-update leaves bin/externals as factory-runner-owned junctions; elevation refuses to traverse them, so copy the version dir.
    if ($from.LinkType -eq 'Junction') { $from = Get-Item -LiteralPath (Join-Path $existingRoot (Split-Path -Leaf $from.Target)) -Force }
    if ($from.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unexpected reparse point: $($from.FullName)" }
    if ($from.PSIsContainer) {
      $to = Join-Path $r.Value $item; New-Item -ItemType Directory -Path $to -Force | Out-Null
      Copy-Item -Path (Join-Path $from.FullName '*') -Destination $to -Recurse -Force
    } else { Copy-Item -LiteralPath $from.FullName -Destination $r.Value -Force }
  }
}

# 2. Helpers and hook: replaced in place, so they keep the protected directory ACL.
foreach ($f in $files.GetEnumerator()) {
  Copy-Item -LiteralPath (Join-Path $SourceDir $f.Value) -Destination $f.Key -Force
  if ((Get-Sha $f.Key) -ne $state.files[$f.Key].staged) { throw "Installed helper differs: $($f.Key)" }
}

# 3. Registration pipe (first instance only, so a squatted name fails here and no token is sent).
Add-Type -AssemblyName System.IO.Pipes.AccessControl
$security = [IO.Pipes.PipeSecurity]::new(); $security.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-32-544','S-1-5-18')) { $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [IO.Pipes.PipeAccessRights]::FullControl, 'Allow')) }
$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($factory.SID, [IO.Pipes.PipeAccessRights]::ReadWrite, 'Allow'))
$options = [IO.Pipes.PipeOptions]([int][IO.Pipes.PipeOptions]::Asynchronous -bor 524288)
$server = [IO.Pipes.NamedPipeServerStreamAcl]::Create('dotagents-factory-runner-register', 'InOut', 1, 'Byte', $options, 4096, 4096, $security, 'None', 0)
$results = @()
try {
  # 4. Restart the one task only while idle; the running listener exits with it.
  if ((Get-Workers).Count) { [ordered]@{ result = 'busy'; changed = 'roots and helpers only' } | ConvertTo-Json -Compress; exit 3 }
  Stop-ScheduledTask -TaskName $taskName
  for ($i = 0; $i -lt 60 -and @(Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'").Count; $i++) { Start-Sleep -Seconds 1 }
  Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" | Where-Object { $_.ExecutablePath -like 'C:\actions-runner-dotagents-u*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName $taskName
  $connect = $server.WaitForConnectionAsync()
  if (!$connect.Wait(90000)) { throw 'Task entry did not request registration' }
  $reader = [IO.StreamReader]::new($server, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
  $writer = [IO.StreamWriter]::new($server, [Text.UTF8Encoding]::new($false), 4096, $true); $writer.AutoFlush = $true
  $token = Invoke-Sec002AdminApi -Arguments @('api','--method','POST','orgs/kitepon/actions/runners/registration-token','--jq','.token')
  $writer.WriteLine($token); $token = $null
  while ($true) {
    $next = $reader.ReadLineAsync(); if (!$next.Wait(300000)) { throw 'Registration still running; inspect' }
    $line = $next.GetAwaiter().GetResult(); if (!$line) { throw 'Task entry disconnected' }
    $item = $line | ConvertFrom-Json; if ($item.phase -eq 'complete') { break }
    $results += [ordered]@{ name = $item.name; exit_code = $item.exit_code }; $line
  }
} finally { $token = $null; $server.Dispose() }

# 5. Readback: every instance online with exactly the factory + windows-native custom labels.
$online = $null
for ($i = 0; $i -lt 24; $i++) {
  $online = @(Invoke-Sec002AdminApi -Arguments @('api','orgs/kitepon/actions/runners','--jq','[.runners[]|{name,status,labels:[.labels[]|select(.type=="custom")|.name]}]') | ConvertFrom-Json |
    Where-Object { $_.name -in $names -and $_.status -eq 'online' -and (($_.labels | Sort-Object) -join ',') -eq 'factory,windows-native' })
  if ($online.Count -eq $names.Count) { break }
  Start-Sleep -Seconds 5
}
[ordered]@{
  at = [DateTimeOffset]::Now.ToString('o'); approval = $ApprovalId; registration = $results
  online = @($online | ForEach-Object name); files = @($files.Keys | ForEach-Object { [ordered]@{ path = $_; sha256 = (Get-Sha $_) } })
  password_reset = $false
} | ConvertTo-Json -Depth 4 -Compress
if ($online.Count -ne $names.Count) { exit 1 }
