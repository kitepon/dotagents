#Requires -Version 7.0
# Capacity only: build/publish markers never serialize CI jobs.
# Deprecated marker arguments remain accepted for already-running runner environments.
param(
  [int]$TargetProcessId=0,
  [string]$BusyMarkerPath='',
  [ValidateRange(0,3600)][int]$BusyMarkerMaxWaitSeconds=300,
  [ValidateRange(1,60)][int]$BusyMarkerPollSeconds=5,
  [string]$CapacityHookPath=(Join-Path $PSScriptRoot 'job-started.ps1')
)
$ErrorActionPreference='Stop'
try {
  & $CapacityHookPath -TargetProcessId $TargetProcessId -BusyMarkerPath ''
} catch {
  Write-Host '::warning title=factory-runner capacity::The capacity hook could not be invoked.'
}
exit 0
