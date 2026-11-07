#Requires -Version 7.0
# Entry of the existing task \dotagents-factory-runner-dedicated (factory-runner, Password, Limited).
# Host copy: C:\ProgramData\dotagents\factory-tools\native-task-entry.ps1. Contract: docs/feature-map/runner-capacity.md.
# Starts every pinned instance that is registered. A root without .runner is registered only when the elevated
# instances script offers the registration pipe; the token goes to config.cmd over stdin and is never written.
param([ValidateSet('Runner')][string]$Target = 'Runner')
$ErrorActionPreference = 'Stop'
$tools = 'C:\ProgramData\dotagents\factory-tools'
# Must equal the windows-native instances of FACTORY_RUNNERS in lib/factory/deployment-contract.mjs.
$Instances = [ordered]@{
  'factory-windows-fox-u'  = 'C:\actions-runner-dotagents-u'
  'factory-windows-fox-u2' = 'C:\actions-runner-dotagents-u2'
  'factory-windows-fox-u3' = 'C:\actions-runner-dotagents-u3'
}

function New-InstanceStart([string]$Name, [string]$Root, [switch]$Register) {
  $start = [Diagnostics.ProcessStartInfo]::new('C:\Program Files\PowerShell\7\pwsh.exe')
  $start.UseShellExecute = $false; $start.WorkingDirectory = $Root
  $start.Environment.Clear()
  $profile = 'C:\Users\factory-runner'
  $allowed = @{SystemRoot='C:\Windows';WINDIR='C:\Windows';SystemDrive='C:';ComSpec='C:\Windows\System32\cmd.exe';PATH=[IO.File]::ReadAllText($Root+'\.path');USERPROFILE=$profile;HOME=$profile;APPDATA=$profile+'\AppData\Roaming';LOCALAPPDATA=$profile+'\AppData\Local';TEMP=$profile+'\AppData\Local\Temp';TMP=$profile+'\AppData\Local\Temp';USERNAME='factory-runner';USERDOMAIN=$env:COMPUTERNAME;COMPUTERNAME=$env:COMPUTERNAME;ProgramData='C:\ProgramData';ProgramFiles='C:\Program Files';ProgramW6432='C:\Program Files';'ProgramFiles(x86)'='C:\Program Files (x86)';CommonProgramFiles='C:\Program Files\Common Files';'CommonProgramFiles(x86)'='C:\Program Files (x86)\Common Files';OS='Windows_NT';PATHEXT='.COM;.EXE;.BAT;.CMD';NUMBER_OF_PROCESSORS=[string][Environment]::ProcessorCount}
  foreach ($e in $allowed.GetEnumerator()) { $start.Environment[$e.Key] = $e.Value }
  foreach ($arg in @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"$tools\run-dedicated.ps1",'-Root',$Root,'-Name',$Name)) { $start.ArgumentList.Add($arg) }
  if ($Register) {
    $start.ArgumentList.Add('-Register')
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  }
  return $start
}

$pending = @($Instances.GetEnumerator() | Where-Object { (Test-Path -LiteralPath $_.Value) -and !(Test-Path -LiteralPath (Join-Path $_.Value '.runner')) })
if ($pending.Count) {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'dotagents-factory-runner-register', [IO.Pipes.PipeDirection]::InOut)
  $token = $null
  try {
    $pipe.Connect(30000)
    $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
    $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true); $writer.AutoFlush = $true
    $token = $reader.ReadLine()
    foreach ($item in $pending) {
      $child = [Diagnostics.Process]::Start((New-InstanceStart $item.Key $item.Value -Register))
      $child.StandardInput.WriteLine($token); $child.StandardInput.Close()
      $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEnd(); $child.WaitForExit()
      $text = ($stdout.GetAwaiter().GetResult() + $stderr)
      if ($token) { $text = $text.Replace($token, '[redacted]') }
      $writer.WriteLine((@{ name = $item.Key; exit_code = $child.ExitCode; text = $text } | ConvertTo-Json -Compress))
    }
    $writer.WriteLine('{"phase":"complete"}')
  } catch {
    # No pipe offered (ordinary restart) or pipe I/O failure: registered instances still start below.
    Write-Host "registration skipped: $($_.Exception.Message)"
  } finally {
    $token = $null; $pipe.Dispose()
  }
}

$children = @(foreach ($item in $Instances.GetEnumerator()) {
  if (Test-Path -LiteralPath (Join-Path $item.Value '.runner')) { [Diagnostics.Process]::Start((New-InstanceStart $item.Key $item.Value)) }
})
if (!$children.Count) { exit 1 }
$code = 0
foreach ($child in $children) { $child.WaitForExit(); if ($child.ExitCode -ne 0) { $code = $child.ExitCode } }
exit $code
