param([string]$GuardSource)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('sec002-marker-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$hook=Join-Path $fixture 'guard.ps1'
$capacity=Join-Path $fixture 'capacity.ps1'
$marker=Join-Path $fixture 'build.lock'
[IO.File]::WriteAllText($hook,$GuardSource,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($capacity,'param($TargetProcessId,$BusyMarkerPath); "capacity-ready"; exit 0',[Text.UTF8Encoding]::new($false))
$passed=@()
$handle=$null
function Invoke-Guard([string]$Path,[int]$Expected,[string]$ExpectedTag) {
  $text=@(& pwsh.exe -NoProfile -NonInteractive -File $hook -TargetProcessId 999999999 -BusyMarkerPath $Path -BusyMarkerMaxWaitSeconds 0 -CapacityHookPath $capacity 2>&1)-join "`n"
  if ($LASTEXITCODE -ne $Expected -or !$text.Contains($ExpectedTag)) {throw 'Unexpected isolated guard result'}
}
try {
  Invoke-Guard $marker 0 'result=clear';$passed+='absent_clear'
  [IO.File]::WriteAllText($marker,'fixture-owner')
  [IO.File]::SetLastWriteTime($marker,(Get-Date).AddHours(-1))
  Invoke-Guard $marker 1 'result=timeout'
  if ([IO.File]::ReadAllText($marker) -ne 'fixture-owner') {throw 'Ordinary fixture changed'}
  [IO.File]::Delete($marker);$passed+='stale_not_ignored_or_deleted'
  $directory=Join-Path $fixture 'not-a-marker';[void][IO.Directory]::CreateDirectory($directory)
  Invoke-Guard $directory 1 'result=unavailable';$passed+='directory_blocks'
  Invoke-Guard (Join-Path $fixture 'missing-parent\build.lock') 1 'result=unavailable';$passed+='missing_parent_blocks'
  $handle=[IO.FileStream]::new($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::DeleteOnClose)
  $bytes=[Text.Encoding]::UTF8.GetBytes('fixture-live-owner');$handle.Write($bytes);$handle.Flush()
  Invoke-Guard $marker 1 'result=timeout'
  if (!(Test-Path -LiteralPath $marker)) {throw 'Live handle marker disappeared'}
  $passed+='live_handle_blocks_with_metadata_read'
  $start=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
  $start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach ($a in @('-NoProfile','-NonInteractive','-File',$hook,'-TargetProcessId','999999999','-BusyMarkerPath',$marker,'-BusyMarkerMaxWaitSeconds','10','-BusyMarkerPollSeconds','1','-CapacityHookPath',$capacity)) {$start.ArgumentList.Add($a)}
  $child=[Diagnostics.Process]::Start($start)
  if ($child.StandardOutput.ReadLine() -ne 'capacity-ready') {throw 'Capacity fixture did not start'}
  Start-Sleep -Milliseconds 1500
  $handle.Dispose();$handle=$null
  if (!$child.WaitForExit(15000)) {$child.Kill($true);throw 'Isolated release wait timed out'}
  if ($child.ExitCode -ne 0 -or !$child.StandardOutput.ReadToEnd().Contains('result=clear')) {throw 'Released own handle did not unblock the hook'}
  $passed+='own_handle_release_unblocks'
  [ordered]@{result='PASS';cases=$passed;count=$passed.Count;scope='temporary fixture only; capacity stub; no real runner, marker, setup, build, auth, or product process touched'}|ConvertTo-Json
} finally {
  if ($null -ne $handle) {$handle.Dispose()}
  if (Test-Path -LiteralPath $fixture) {Remove-Item -LiteralPath $fixture -Recurse -Force}
}
