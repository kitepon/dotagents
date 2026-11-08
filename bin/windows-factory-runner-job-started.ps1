# GitHub Actions runnerのjob開始hook（Windowsの工場席）。runnerの `.env` の ACTIONS_RUNNER_HOOK_JOB_STARTED で指す。
# 所有者が対話で使うPCで、jobより所有者の操作を先に動かす。
# Runner.Workerの優先度を下げると、その後に起動されるstepのprocessが引き継ぐ。CPUは割り当てない（全CPUを使う）。
# 同時に動くjobの数は、hostのscalerが実負荷から決める（docs/feature-map/runner-capacity.md）。
# OpenLogicoolのbuild/publishとCIは並行する。marker引数は互換用に受け取るが読まず、待たない。
param(
  [int]$TargetProcessId = 0,
  [string]$PriorityClass = 'BelowNormal',
  [string]$BusyMarkerPath = '',
  [int]$BusyMarkerMaxWaitSeconds = 300,
  [int]$BusyMarkerStaleMinutes = 15,
  [int]$BusyMarkerPollSeconds = 5
)

$ErrorActionPreference = 'Stop'
try {
  if ($TargetProcessId -eq 0) {
    $current = $PID
    foreach ($depth in 1..6) {
      $row = Get-CimInstance Win32_Process -Filter "ProcessId=$current"
      if ($null -eq $row) { break }
      if ($row.Name -eq 'Runner.Worker.exe') { $TargetProcessId = [int]$row.ProcessId; break }
      $current = [int]$row.ParentProcessId
    }
    if ($TargetProcessId -eq 0) { throw 'Runner.Worker was not found among the ancestors of this hook' }
  }

  $target = Get-Process -Id $TargetProcessId
  $target.PriorityClass = $PriorityClass
  $target.Refresh()
  Write-Host "factory-runner capacity: runner=$env:RUNNER_NAME $($target.ProcessName) pid=$TargetProcessId priority=$($target.PriorityClass)"
} catch {
  # hookの失敗でjobを落とさない。下げられなかった事はjobの注記に残す。
  Write-Host "::warning title=factory-runner capacity::The job-started hook could not limit this job: $($_.Exception.Message)"
}

exit 0
