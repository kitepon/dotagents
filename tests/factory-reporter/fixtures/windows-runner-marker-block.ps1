param([string]$GuardSource)
$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('runner-parallel-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$hook=Join-Path $fixture 'hook.ps1';$capacity=Join-Path $fixture 'capacity.ps1';$marker=Join-Path $fixture 'build.lock'
[IO.File]::WriteAllText($hook,$GuardSource,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($capacity,'param($TargetProcessId,$BusyMarkerPath); if($BusyMarkerPath){exit 77}; "capacity-ready"; exit 0',[Text.UTF8Encoding]::new($false))
$passed=@();$handle=$null;$previous=$env:FACTORY_RUNNER_BUSY_MARKER
function Invoke-Hook([string]$Path,[switch]$EnvOnly) {
  $start=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
  $start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($a in @('-NoProfile','-NonInteractive','-File',$hook,'-TargetProcessId','999999999','-BusyMarkerMaxWaitSeconds','60','-CapacityHookPath',$capacity)) {[void]$start.ArgumentList.Add($a)}
  if(!$EnvOnly){[void]$start.ArgumentList.Add('-BusyMarkerPath');[void]$start.ArgumentList.Add($Path)}
  $child=[Diagnostics.Process]::Start($start)
  try {
    if(!$child.WaitForExit(15000)){$child.Kill($true);throw 'Hook waited for a marker'}
    $text=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
    if($child.ExitCode -ne 0 -or !$text.Contains('capacity-ready') -or $text.Contains('busy marker')){throw ('Unexpected isolated hook result: '+$err)}
  } finally {$child.Dispose()}
}
try {
  Invoke-Hook $marker;$passed+='absent_runs'
  [IO.File]::WriteAllText($marker,'fixture-owner');[IO.File]::SetLastWriteTime($marker,(Get-Date).AddHours(-1))
  Invoke-Hook $marker
  if([IO.File]::ReadAllText($marker) -ne 'fixture-owner'){throw 'Fixture changed'}
  [IO.File]::Delete($marker);$passed+='stale_untouched'
  $handle=[IO.FileStream]::new($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $bytes=[Text.Encoding]::UTF8.GetBytes('held-owner');$handle.Write($bytes);$handle.Flush()
  Invoke-Hook $marker;$passed+='exclusive_handle_does_not_block'
  Invoke-Hook (Join-Path $fixture 'missing-parent\build.lock');$passed+='missing_parent_ignored'
  Invoke-Hook '\\nonexistent.invalid\share\build.lock';$passed+='unc_not_accessed'
  $env:FACTORY_RUNNER_BUSY_MARKER=$marker
  Invoke-Hook '' -EnvOnly;$passed+='cached_environment_ignored'
  [void]$handle.Seek(0,[IO.SeekOrigin]::Begin);$read=[byte[]]::new($bytes.Length);[void]$handle.Read($read)
  if([Text.Encoding]::UTF8.GetString($read) -ne 'held-owner'){throw 'Held fixture changed'}
  [ordered]@{result='PASS';cases=$passed;count=$passed.Count;scope='owned temp marker held across job start; capacity stub; no real runner, product, or auth changes'}|ConvertTo-Json
} finally {
  $env:FACTORY_RUNNER_BUSY_MARKER=$previous
  if($null -ne $handle){$handle.Dispose()}
  if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
