# GitHub Actions runnerのjob開始hook（Windowsの工場席）。runnerの `.env` の ACTIONS_RUNNER_HOOK_JOB_STARTED で指す。
# 所有者が対話で使うPCで、jobより所有者の操作を先に動かす。
# Runner.Workerの優先度とCPU集合（affinity）を設定すると、その後に起動されるstepのprocessが引き継ぐ。
# 各jobは論理CPUを CpusPerJob 個ずつに区切った塊の1つで動き、他のRunner.Workerと重なりが最も少ない塊を使う（2026-11-14 オーナー裁定）。
# 同数なら開始時の1回の採取で最も空いた塊、採取できなければ番号の大きい塊（所有者の負荷は低い番号のCPUに寄る）。
# 同時に動くjobの数は、hostのscalerが実負荷から決める（docs/feature-map/runner-capacity.md）。
# OpenLogicoolのbuild/publishとCIは並行する。marker引数は互換用に受け取るが読まず、待たない。
param(
  [int]$TargetProcessId = 0,
  [string]$PriorityClass = 'BelowNormal',
  [int]$CpusPerJob = 8,
  [string]$WorkerName = 'Runner.Worker',
  [string]$BusyMarkerPath = '',
  [int]$BusyMarkerMaxWaitSeconds = 300,
  [int]$BusyMarkerStaleMinutes = 15,
  [int]$BusyMarkerPollSeconds = 5
)

# Fewest overlapping other workers first; ties: least summed sampled load, then the highest index ($Load $null = no sample).
function Select-CpuBlock([int]$Blocks, [int]$CpusPerJob, [uint64[]]$Others, [double[]]$Load) {
  $best = $null
  for ($i = $Blocks - 1; $i -ge 0; $i--) {
    $mask = ([uint64][Math]::Pow(2, $CpusPerJob) - 1) * [uint64][Math]::Pow(2, $i * $CpusPerJob)
    $count = @($Others | Where-Object { ($_ -band $mask) -ne 0 }).Count
    $sum = if ($null -ne $Load) { [double]($Load[($i * $CpusPerJob)..(($i + 1) * $CpusPerJob - 1)] | Measure-Object -Sum).Sum } else { $null }
    if ($null -eq $best -or $count -lt $best.Count -or ($count -eq $best.Count -and $null -ne $sum -and $sum -lt $best.Load)) {
      $best = [pscustomobject]@{ Mask = $mask; Count = $count; Load = $sum }
    }
  }
  $best
}

# One per-CPU sample of CPUs 0..Count-1; $null when the query fails or a CPU is missing. Names are numbers, not localized.
function Get-CpuLoad([int]$Count) {
  try {
    $load = [double[]]::new($Count); $seen = 0
    foreach ($row in Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop) {
      if ($row.Name -match '^\d+$' -and [int]$row.Name -lt $Count) { $load[[int]$row.Name] = [double]$row.PercentProcessorTime; $seen++ }
    }
    if ($seen -eq $Count) { return ,$load }
  } catch {}
  $null
}

# Dot-sourced (tests): define the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
$loadText = 'load=unknown'
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
  $logical = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $blocks = [Math]::Floor([Math]::Min($logical, 63) / [Math]::Max($CpusPerJob, 1))
  if ($blocks -ge 1) {
    # Named mutex: two jobs starting together must see each other's block.
    $mutex = [Threading.Mutex]::new($false, 'dotagents-factory-runner-cpuset')
    $owned = $false
    try { $owned = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $owned = $true }
    try {
      # shortcut: masks are 64-bit and one processor group; hosts above 63 logical CPUs need group-aware affinity.
      $others = @(Get-Process -Name $WorkerName -ErrorAction SilentlyContinue | Where-Object Id -ne $TargetProcessId |
        ForEach-Object { try { [uint64][int64]$_.ProcessorAffinity } catch { [uint64]::MaxValue } })
      $best = Select-CpuBlock -Blocks $blocks -CpusPerJob $CpusPerJob -Others $others -Load (Get-CpuLoad ($blocks * $CpusPerJob))
      if ($null -ne $best.Load) { $loadText = "load=$([Math]::Round($best.Load / $CpusPerJob))%" }
      $target.ProcessorAffinity = [IntPtr][int64]$best.Mask
    } finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
  }
  $target.Refresh()
  Write-Host "factory-runner capacity: runner=$env:RUNNER_NAME $($target.ProcessName) pid=$TargetProcessId priority=$($target.PriorityClass) affinity=0x$(([int64]$target.ProcessorAffinity).ToString('X')) $loadText"
} catch {
  # hookの失敗でjobを落とさない。下げられなかった事はjobの注記に残す。
  Write-Host "::warning title=factory-runner capacity::The job-started hook could not limit this job: $($_.Exception.Message)"
}

exit 0
