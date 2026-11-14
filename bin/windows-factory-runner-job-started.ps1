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

# Per-CPU busy % of CPUs 0..Count-1 over $SampleMs; $null when the read fails or a CPU is missing.
# NtQuerySystemInformation needs no rights; perf counters (CIM Win32_PerfFormattedData_*, Get-Counter) are denied to the
# runner account (non-admin, batch logon: not INTERACTIVE, not in Performance Monitor Users; Perflib ACL).
function Get-CpuLoad([int]$Count, [int]$SampleMs = 250) {
  try {
    if (-not ('DotagentsCpuTimes' -as [type])) {
      Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class DotagentsCpuTimes {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, long[] info, int len, out int ret);
  // Class 8 = SystemProcessorPerformanceInformation: per CPU 6 longs (Idle, Kernel incl. idle, User, Dpc, Interrupt, count).
  public static long[] Read() {
    var a = new long[6 * 64]; int ret;
    int status = NtQuerySystemInformation(8, a, a.Length * 8, out ret);
    if (status != 0) throw new InvalidOperationException("NtQuerySystemInformation 0x" + status.ToString("X"));
    Array.Resize(ref a, ret / 8); return a;
  }
}
"@
    }
    $a = [DotagentsCpuTimes]::Read(); Start-Sleep -Milliseconds $SampleMs; $b = [DotagentsCpuTimes]::Read()
    if ($b.Length / 6 -lt $Count) { return $null }
    $load = [double[]]::new($Count)
    for ($i = 0; $i -lt $Count; $i++) {
      $total = ($b[6 * $i + 1] - $a[6 * $i + 1]) + ($b[6 * $i + 2] - $a[6 * $i + 2])
      $load[$i] = if ($total -gt 0) { [Math]::Max(0, 100 * (1 - ($b[6 * $i] - $a[6 * $i]) / $total)) } else { 0 }
    }
    return ,$load
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
