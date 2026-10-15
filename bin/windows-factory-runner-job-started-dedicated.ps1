#Requires -Version 7.0
# Candidate dedicated runner hook. A read-only activity marker is not a mutex:
# keep Worker coordination and the agreed notification/wait procedure.
param(
  [int]$TargetProcessId=0,
  [string]$BusyMarkerPath=$env:FACTORY_RUNNER_BUSY_MARKER,
  [ValidateRange(0,3600)][int]$BusyMarkerMaxWaitSeconds=300,
  [ValidateRange(1,60)][int]$BusyMarkerPollSeconds=5,
  [string]$CapacityHookPath=(Join-Path $PSScriptRoot 'job-started.ps1')
)
$ErrorActionPreference='Stop'
try {
  # Reuse capacity limiting; explicitly disable the legacy advisory marker path.
  & $CapacityHookPath -TargetProcessId $TargetProcessId -BusyMarkerPath ''
} catch {
  Write-Host '::warning title=factory-runner capacity::The capacity hook could not be invoked.'
}
try {
  if (!$BusyMarkerPath -or ![IO.Path]::IsPathFullyQualified($BusyMarkerPath) -or $BusyMarkerPath.StartsWith('\\')) {
    throw 'Marker configuration unavailable'
  }
  $parent=Get-Item -LiteralPath (Split-Path -Parent $BusyMarkerPath) -Force -ErrorAction Stop
  if (!$parent.PSIsContainer -or $parent.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Unsafe marker parent'}
  $started=[DateTimeOffset]::UtcNow
  while ($true) {
    $marker=$null
    try {$marker=Get-Item -LiteralPath $BusyMarkerPath -Force -ErrorAction Stop}
    catch [Management.Automation.ItemNotFoundException] {}
    if ($null -eq $marker) {
      Write-Host 'factory-runner busy marker: policy=block result=clear'
      exit 0
    }
    if ($marker.PSIsContainer -or $marker.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Unsafe marker type'}
    # LastWriteTime is not evidence that a writer has released its live handle.
    # Never discard a marker because it is old, and never read/delete its content.
    if (([DateTimeOffset]::UtcNow-$started).TotalSeconds -ge $BusyMarkerMaxWaitSeconds) {
      Write-Host '::error title=factory-runner busy marker::policy=block result=timeout; product steps were not started.'
      exit 1
    }
    Start-Sleep -Seconds $BusyMarkerPollSeconds
  }
} catch {
  Write-Host '::error title=factory-runner busy marker::policy=block result=unavailable; product steps were not started.'
  exit 1
}
