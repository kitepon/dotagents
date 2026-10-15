# GitHub Actions runnerのjob開始hook（Windowsの工場席）。runnerの `.env` の ACTIONS_RUNNER_HOOK_JOB_STARTED で指す。
# 所有者が対話で使うPCで、jobが論理CPUを使い切らないようにする。
# Runner.Workerの優先度とCPUの割り当てを下げると、その後に起動されるstepのprocessが引き継ぐ。
# 製品のworkflowは os.availableParallelism() で並列数を決めるので、割り当てた数へ追従する。
# OpenLogicoolのbuild/publishとCIは並行する。marker引数は互換用に受け取るが読まず、待たない。
param(
  [int]$TargetProcessId = 0,
  [int]$ReservedLogicalProcessors = 8,
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

  $logical = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $target = Get-Process -Id $TargetProcessId
  $allowed = $logical
  # 残りが少ない端末と、64を超える端末（processor groupが分かれる）では割り当てを変えない。
  if ($ReservedLogicalProcessors -gt 0 -and $logical -le 64 -and ($logical - $ReservedLogicalProcessors) -ge 4) {
    $all = if ($logical -eq 64) { -1L } else { (1L -shl $logical) - 1L }
    $reserved = (1L -shl $ReservedLogicalProcessors) - 1L
    $target.ProcessorAffinity = [IntPtr]($all -band (-bnot $reserved))
    $allowed = $logical - $ReservedLogicalProcessors
  }
  $target.PriorityClass = $PriorityClass
  $target.Refresh()
  $mask = '{0:X}' -f [int64]$target.ProcessorAffinity
  Write-Host "factory-runner capacity: $($target.ProcessName) pid=$TargetProcessId priority=$($target.PriorityClass) logical=$allowed/$logical affinity=0x$mask"
} catch {
  # hookの失敗でjobを落とさない。絞れなかった事はjobの注記に残す。
  Write-Host "::warning title=factory-runner capacity::The job-started hook could not limit this job: $($_.Exception.Message)"
}

exit 0
