[CmdletBinding()]
param(
  [switch]$ScheduledRun,
  [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Plan = @(
  'factory-reporter-config',
  'retire-legacy-schedulers',
  'dotagents-links',
  'factory-products-bootstrap',
  'codex-config',
  'native-product-wiring',
  'lattice-hooks',
  'spotter-project',
  'mcp-registration',
  'caveat-sync',
  'verify-install',
  'fresh-bughub-delivery',
  'toolchain-finalization',
  'all-product-smoke',
  'daily-0200-task'
)

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'setup-windows-native-factory.ps1 is Windows-native only'
}

if ($PSVersionTable.PSEdition -eq 'Core') {
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($ScheduledRun) { $arguments += '-ScheduledRun' }
  if ($PlanOnly) { $arguments += '-PlanOnly' }
  & $windowsPowerShell @arguments
  exit $LASTEXITCODE
}

if ($PlanOnly) {
  [pscustomobject]@{
    schema = 'dotagents.windows-native-factory-setup-plan.v1'
    platform = 'windows-native'
    steps = $Plan
  } | ConvertTo-Json -Compress
  exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$GitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
$ConfigPath = Join-Path $env:LOCALAPPDATA 'dotagents\factory-reporter\config.json'
$StateDirectory = Join-Path $env:LOCALAPPDATA 'dotagents\windows-native-factory-setup'
$ReceiptPath = Join-Path $StateDirectory 'latest-receipt.json'
$TaskName = 'dotagents-agents-update'
$ReporterTaskName = 'dotagents-factory-reporter'
$RunId = [guid]::NewGuid().ToString()
$RunLock = $null
$LatticeUnsupported = @{}
$TranscriptPath = Join-Path $StateDirectory "run-$RunId.log"

function Write-Step([string]$Name) {
  Write-Host "[windows-native-factory] $Name"
}

function Convert-ToGitBashPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch '^([A-Za-z]):\\(.*)$') { throw "Path cannot be converted for Git Bash: $full" }
  $drive = $Matches[1].ToLowerInvariant()
  $tail = $Matches[2].Replace('\', '/')
  return "/$drive/$tail"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$WorkingDirectory = $RepoRoot,
    [switch]$ClosedStdin
  )
  Write-Step $Label
  Push-Location -LiteralPath $WorkingDirectory
  try {
    if ($ClosedStdin) {
      # caveat init は TTY だと公開ミラー確認で止まる。工場は stdin を閉じる。
      $null | & $File @Arguments | ForEach-Object { Write-Host $_ }
    } else {
      & $File @Arguments | ForEach-Object { Write-Host $_ }
    }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { throw "$Label failed with exit $code" }
}

function Test-External {
  param([string]$File, [string[]]$Arguments)
  if (-not (Get-Command $File -ErrorAction SilentlyContinue)) { return $false }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @Arguments *> $null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return $code -eq 0
}

function Ensure-ClaudeMcp {
  param([string]$Name, [string]$Command, [string[]]$Arguments = @())
  if (Test-External -File 'claude' -Arguments @('mcp', 'get', $Name)) { return }
  $mcpArguments = @('mcp', 'add', '--scope', 'user', $Name, '--', $Command) + $Arguments
  Invoke-Checked -File 'claude' -Arguments $mcpArguments -Label "Claude MCP: $Name"
}

function Ensure-CodexMcp {
  param([string]$Name, [string]$Command, [string[]]$Arguments = @())
  if (Test-External -File 'codex' -Arguments @('mcp', 'get', $Name)) { return }
  $mcpArguments = @('mcp', 'add', $Name, '--', $Command) + $Arguments
  Invoke-Checked -File 'codex' -Arguments $mcpArguments -Label "Codex MCP: $Name"
}

function Set-OwnerOnlyAcl([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)

  $check = Get-Acl -LiteralPath $Path
  $ownerSid = ($check.GetOwner([Security.Principal.SecurityIdentifier])).Value
  $rules = @($check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $aclMatches = $ownerSid -eq $sid.Value -and $rules.Count -eq 1
  if ($aclMatches) {
    $actualRule = $rules[0]
    $aclMatches = $actualRule.IdentityReference.Value -eq $sid.Value -and $actualRule.AccessControlType -eq 'Allow' -and -not $actualRule.IsInherited -and (($actualRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
  }
  if (-not $aclMatches) {
    throw "Owner-only ACL readback failed: $Path"
  }
}

function Assert-ReporterConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Windows factory reporter config is missing: $ConfigPath"
  }
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  if ($config.host.profile -ne 'windows-native') { throw 'factory reporter host.profile must be windows-native' }
  if ($config.collection.enabled -ne $true -or $config.reporting.enabled -ne $true) { throw 'factory collection and reporting must be enabled' }
  $endpoint = [uri]$config.reporting.endpoint
  if ($endpoint.AbsolutePath -ne '/api/factory/v7/reports') { throw 'factory reporter endpoint must use wire v7' }
  $credential = [string]$config.reporting.credential_file
  if ([string]::IsNullOrWhiteSpace($credential) -or -not (Test-Path -LiteralPath $credential -PathType Leaf)) {
    throw 'Windows-native BugHub credential is missing'
  }
}

function Normalize-WindowsReporterConfig {
  Write-Step 'factory-reporter-config: UTF-8 without BOM'
  Assert-ReporterConfig
  $backup = Join-Path $StateDirectory "factory-reporter-config-$RunId.json.bak"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
  Set-OwnerOnlyAcl $backup

  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  $canonical = [ordered]@{
    schema_version = [string]$config.schema_version
    host = [ordered]@{
      id = [string]$config.host.id
      profile = [string]$config.host.profile
    }
    collection = [ordered]@{
      enabled = [bool]$config.collection.enabled
    }
    reporting = [ordered]@{
      enabled = [bool]$config.reporting.enabled
      endpoint = [string]$config.reporting.endpoint
      credential_file = [string]$config.reporting.credential_file
    }
  }
  $temporary = "$ConfigPath.$RunId.tmp"
  [IO.File]::WriteAllText(
    $temporary,
    (($canonical | ConvertTo-Json -Depth 10) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
  Set-OwnerOnlyAcl $ConfigPath
  Set-OwnerOnlyAcl ([string]$canonical.reporting.credential_file)

  $bytes = [IO.File]::ReadAllBytes($ConfigPath)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw 'factory reporter config still has a UTF-8 BOM'
  }
  Assert-ReporterConfig
}

function Invoke-BootstrapUpdate([string]$UpdateScript) {
  Write-Step 'factory-products-bootstrap: agents-update.sh'
  $previousRunner = $env:FACTORY_REPORTER_RUNNER
  $env:FACTORY_REPORTER_RUNNER = Convert-ToGitBashPath (Join-Path $env:USERPROFILE '.local\bin\factory-reporter-v7-schedule-runner')
  try {
    & $GitBash $UpdateScript
    $code = $LASTEXITCODE
  } finally {
    $env:FACTORY_REPORTER_RUNNER = $previousRunner
  }
  if ($code -eq 0) { return }
  $log = Join-Path $env:LOCALAPPDATA 'dotagents\agents-update\agents-update.log'
  if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { throw "Bootstrap agents-update failed with exit $code and produced no result log" }
  $matches = [regex]::Matches((Get-Content -Raw -LiteralPath $log), 'agents-update result: update=(success|failed) report=(success|failed)')
  if ($matches.Count -eq 0 -or $matches[$matches.Count - 1].Groups[1].Value -ne 'success') {
    throw "Bootstrap agents-update product installation failed with exit $code"
  }
  Write-Warning 'Bootstrap installed the products but the pre-wiring post-update gate failed. A green fresh run remains mandatory.'
}

function Remove-WindowsGlobalNpmLink([string]$PackageName) {
  $globalRootOutput = & npm root --global
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "Cannot resolve the global npm root for $PackageName" }
  $globalRoot = [string]$globalRootOutput
  if ([string]::IsNullOrWhiteSpace($globalRoot) -or -not [IO.Path]::IsPathRooted($globalRoot.Trim())) {
    throw "Global npm root is invalid for $PackageName"
  }
  $packagePath = Join-Path $globalRoot.Trim() $PackageName
  if (-not (Test-Path -LiteralPath $packagePath)) { return }
  $package = Get-Item -LiteralPath $packagePath -Force
  if ([string]::IsNullOrWhiteSpace([string]$package.LinkType)) { return }

  Write-Step "factory-products-bootstrap: retire global npm link $PackageName"
  & npm unlink --global $PackageName | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "npm unlink failed for $PackageName" }
  if (Test-Path -LiteralPath $packagePath) { throw "Global npm link remains for $PackageName" }
}

function Update-WindowsNativeClaude {
  $nativeClaude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (-not (Test-Path -LiteralPath $nativeClaude -PathType Leaf)) { return }
  Invoke-Checked -File $nativeClaude -Arguments @('update') -Label 'factory-products-bootstrap: Claude native update'
}

function Set-ToolchainPostGateSuccess([string]$LedgerHelper) {
  Write-Step 'toolchain-finalization: post-gate success'
  $ledgerPath = Join-Path $env:LOCALAPPDATA 'dotagents\agents-update\toolchain-ledger.json'
  if (-not (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) { throw 'toolchain update ledger is missing' }
  $ledger = Get-Content -Raw -LiteralPath $ledgerPath | ConvertFrom-Json
  if ($ledger.schema_version -ne 'dotagents.toolchain-update.v1') { throw 'toolchain update ledger schema is invalid' }
  $expected = @('claude-code', 'codex-cli', 'grok-build')
  $actual = @($ledger.products.PSObject.Properties.Name | Sort-Object)
  if (@(Compare-Object -ReferenceObject ($expected | Sort-Object) -DifferenceObject $actual).Count -ne 0) {
    throw 'toolchain update ledger does not contain the exact product set'
  }
  $observedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  foreach ($product in $expected) {
    $record = $ledger.products.$product
    if ([string]$record.operation_status -notin @('success', 'skipped')) {
      throw "$product update operation is not successful"
    }
    $arguments = @(
      $LedgerHelper, 'record', '--file', $ledgerPath, '--product', $product,
      '--before', $(if ($null -eq $record.before_version) { 'none' } else { [string]$record.before_version }),
      '--latest', $(if ($null -eq $record.latest_version) { 'none' } else { [string]$record.latest_version }),
      '--operation', [string]$record.operation_status,
      '--after', $(if ($null -eq $record.after_version) { 'none' } else { [string]$record.after_version }),
      '--post-gate', 'success', '--reason', [string]$record.reason_code, '--observed-at', $observedAt
    )
    Invoke-Checked -File 'node' -Arguments $arguments -Label "toolchain-finalization: $product"
  }
}

function Invoke-FreshDelivery([string]$Runner, [string]$LedgerHelper, [string]$ProductSmoke) {
  Write-Step 'fresh-bughub-delivery: factory-reporter-v7-schedule-runner.mjs'
  $state = Join-Path $env:LOCALAPPDATA 'dotagents\factory-reporter-v7'
  $reportPath = Join-Path $state 'latest-report.json'
  $deliveryPath = Join-Path $state 'delivery-receipt.json'
  $priorReportId = $null
  if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
    try { $priorReportId = [string](Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json).report_id } catch {}
  }
  $batchToken = [guid]::NewGuid().ToString()
  $previousPreference = $ErrorActionPreference
  $previousHome = $env:HOME
  $previousCodexHome = $env:CODEX_HOME
  $previousBatchToken = $env:AGENTS_UPDATE_BATCH_TOKEN
  $previousThroughlineThread = $env:THROUGHLINE_CODEX_THREAD_ID
  $previousCodexThread = $env:CODEX_THREAD_ID
  $ErrorActionPreference = 'Continue'
  $env:HOME = $env:USERPROFILE
  $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
  $env:AGENTS_UPDATE_BATCH_TOKEN = $batchToken
  $env:THROUGHLINE_CODEX_THREAD_ID = $null
  $env:CODEX_THREAD_ID = $null
  try {
    $postOutput = & node $Runner '--config' $ConfigPath '--post-update' 2>&1
    $postCode = $LASTEXITCODE
    $postOutput | ForEach-Object { Write-Host $_ }
    if ($postCode -ne 0) { throw "Fresh factory post-update gate failed with exit $postCode" }
    Set-ToolchainPostGateSuccess $LedgerHelper
    $finalOutput = & node $Runner '--config' $ConfigPath '--finalize-update' 2>&1
    $finalCode = $LASTEXITCODE
    $finalOutput | ForEach-Object { Write-Host $_ }
    if ($finalCode -ne 0) { throw "Fresh BugHub finalize delivery failed with exit $finalCode" }
  } finally {
    $ErrorActionPreference = $previousPreference
    $env:HOME = $previousHome
    $env:CODEX_HOME = $previousCodexHome
    $env:AGENTS_UPDATE_BATCH_TOKEN = $previousBatchToken
    $env:THROUGHLINE_CODEX_THREAD_ID = $previousThroughlineThread
    $env:CODEX_THREAD_ID = $previousCodexThread
  }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf) -or -not (Test-Path -LiteralPath $deliveryPath -PathType Leaf)) {
    throw 'Fresh BugHub report or delivery receipt is missing'
  }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  $receipt = Get-Content -Raw -LiteralPath $deliveryPath | ConvertFrom-Json
  if ($report.schema_version -ne '7.0' -or [string]$report.report_id -eq $priorReportId -or
      $receipt.schema -ne 'dotagents.factory-delivery-receipt.v1' -or
      $receipt.report_id -ne $report.report_id -or $receipt.batch_token -ne $batchToken) {
    throw 'Fresh BugHub delivery receipt does not match this v7 batch'
  }
  $smokeOutput = & node $ProductSmoke '--report' $reportPath 2>&1
  $smokeCode = $LASTEXITCODE
  $smokeOutput | ForEach-Object { Write-Host $_ }
  if ($smokeCode -ne 0) { throw "All-product smoke failed with exit $smokeCode" }
  $smoke = ($smokeOutput | Select-Object -Last 1) | ConvertFrom-Json
  if ($smoke.schema -ne 'dotagents.windows-native-product-smoke.v1' -or $smoke.status -ne 'passed' -or $smoke.checked_products -ne 14) {
    throw 'All-product smoke receipt is invalid'
  }
  return [pscustomobject]@{ delivery_acknowledged = $true; report = 'v7'; product_smoke = $smoke }
}

function Remove-LegacyCron {
  $program = @'
if ! command -v crontab >/dev/null 2>&1; then exit 0; fi
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | awk '!/dotagents-factory-reporter/ && !/(^|[[:space:]\/])(agents-update|factory-reporter)([[:space:]]|$)/')"
if [ "$filtered" != "$current" ]; then printf '%s\n' "$filtered" | crontab -; fi
'@
  Invoke-Checked -File $GitBash -Arguments @('-lc', $program) -Label 'retire-legacy-cron'
}

function Invoke-LatticeHookInstall([string]$HostName) {
  $label = "lattice hooks install --host $HostName"
  Write-Step $label
  $output = & lattice hooks install --host $HostName 2>&1
  $code = $LASTEXITCODE
  $text = (@($output) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  if ($code -eq 0) {
    $output | ForEach-Object { Write-Host $_ }
    return
  }
  if ($text -match 'HOST_PLATFORM_UNSUPPORTED') {
    $script:LatticeUnsupported[$HostName] = $true
    Write-Warning "${label}: native Windows is structurally unsupported; dotagents-owned hooks remain active"
    return
  }
  $output | ForEach-Object { Write-Host $_ }
  throw "$label failed with exit $code"
}

function Normalize-WindowsCodexHooks {
  $path = Join-Path $env:USERPROFILE '.codex\hooks.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Codex hooks are missing: $path" }
  $backup = Join-Path $StateDirectory "hooks-$RunId.json.bak"
  Copy-Item -LiteralPath $path -Destination $backup -Force
  Set-OwnerOnlyAcl $backup
  $data = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  foreach ($eventProperty in @($data.hooks.PSObject.Properties)) {
    $entries = @($eventProperty.Value)
    foreach ($owned in @('codex-callout-hook', 'orchestrate-advisory-hook', 'codex-lattice-gantt-hook')) {
      $occurrences = @()
      for ($entryIndex = 0; $entryIndex -lt $entries.Count; $entryIndex++) {
        $hooks = @($entries[$entryIndex].hooks)
        for ($hookIndex = 0; $hookIndex -lt $hooks.Count; $hookIndex++) {
          if ([string]$hooks[$hookIndex].command -like "*$owned*") {
            $occurrences += [pscustomobject]@{ entry = $entryIndex; hook = $hookIndex }
          }
        }
      }
      if ($occurrences.Count -le 1) { continue }
      $keep = $occurrences[$occurrences.Count - 1]
      for ($entryIndex = 0; $entryIndex -lt $entries.Count; $entryIndex++) {
        $hooks = @($entries[$entryIndex].hooks)
        $normalized = @()
        for ($hookIndex = 0; $hookIndex -lt $hooks.Count; $hookIndex++) {
          $isOwned = [string]$hooks[$hookIndex].command -like "*$owned*"
          if (-not $isOwned -or ($entryIndex -eq $keep.entry -and $hookIndex -eq $keep.hook)) {
            $normalized += $hooks[$hookIndex]
          }
        }
        $entries[$entryIndex].hooks = @($normalized)
      }
    }
    $eventProperty.Value = @($entries | Where-Object {
      @($_.hooks).Count -gt 0 -or @($_.PSObject.Properties).Count -gt 1
    })
  }
  $temporary = "$path.$RunId.tmp"
  [IO.File]::WriteAllText($temporary, (($data | ConvertTo-Json -Depth 100) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $path -Force
  Set-OwnerOnlyAcl $path
}

function Invoke-VerifyInstall([string]$VerifyScript) {
  Write-Step 'verify-install: verify-install.sh'
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $GitBash $VerifyScript '--profile' 'official' 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $output | ForEach-Object { Write-Host $_ }
  if ($code -eq 0) { return 'passed' }
  $text = (@($output) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  $failureMarkers = [regex]::Matches($text, 'FAIL: ')
  $latticeFailures = [regex]::Matches($text, 'FAIL: Lattice (claude|codex) hooks status ')
  $latticeHosts = @($latticeFailures | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
  if ($failureMarkers.Count -eq 2 -and $latticeFailures.Count -eq 2 -and
      $latticeHosts.Count -eq 2 -and $latticeHosts -contains 'claude' -and $latticeHosts -contains 'codex' -and
      $LatticeUnsupported.claude -eq $true -and $LatticeUnsupported.codex -eq $true) {
    Write-Warning 'verify-install reported only the known Lattice native-Windows status/install contract mismatch; structural unsupported was independently observed'
    return 'lattice-platform-unsupported'
  }
  throw "verify-install failed with exit $code"
}

function Assert-DailyTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.Settings.Enabled -ne $true) { throw "$TaskName is disabled" }
  $trigger = @($task.Triggers)[0]
  if (@($task.Triggers).Count -ne 1 -or $trigger.DaysInterval -ne 1 -or ([datetime]$trigger.StartBoundary).TimeOfDay -ne [timespan]::FromHours(2)) {
    throw "$TaskName is not scheduled daily at 02:00"
  }
  $action = @($task.Actions)[0]
  if (@($task.Actions).Count -ne 1 -or $action.Execute -notmatch 'powershell\.exe$' -or $action.Arguments -notlike '*setup-windows-native-factory.ps1*' -or $action.Arguments -notlike '*-ScheduledRun*') {
    throw "$TaskName action is not the Windows one-shot setup"
  }
}

function Write-Receipt([object]$Delivery, [bool]$ScheduledSmoke, [string]$VerifyStatus) {
  $value = [ordered]@{
    schema = 'dotagents.windows-native-factory-setup-receipt.v1'
    run_id = $RunId
    completed_at = [DateTimeOffset]::UtcNow.ToString('o')
    scheduled_run = [bool]$ScheduledRun
    scheduled_smoke = $ScheduledSmoke
    delivery_acknowledged = [bool]$Delivery.delivery_acknowledged
    verify_install = $VerifyStatus
    report = [string]$Delivery.report
    product_smoke = $Delivery.product_smoke
    daily_task = $TaskName
    daily_time = '02:00'
  }
  $temporary = "$ReceiptPath.$RunId.tmp"
  [IO.File]::WriteAllText($temporary, (($value | ConvertTo-Json -Depth 10 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $ReceiptPath -Force
  Set-OwnerOnlyAcl $ReceiptPath
  return [pscustomobject]$value
}

function Wait-ScheduledSmoke([string]$PriorRunId) {
  Write-Step 'scheduled-task-smoke'
  $priorLastRunTime = (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime
  Start-ScheduledTask -TaskName $TaskName
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task.State -eq 'Ready') {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      if ($info.LastRunTime -le $priorLastRunTime) { continue }
      if ($info.LastTaskResult -ne 0) { throw "scheduled task LastTaskResult=$($info.LastTaskResult)" }
      if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { throw 'scheduled task completed without a receipt' }
      try {
        $receipt = Get-Content -Raw -LiteralPath $ReceiptPath | ConvertFrom-Json
        if ($receipt.run_id -ne $PriorRunId -and $receipt.scheduled_run -eq $true -and $receipt.delivery_acknowledged -eq $true) {
          return $receipt
        }
      } catch {}
      throw 'scheduled task completed without a fresh acknowledged receipt'
    }
  }
  throw 'The daily 02:00 task smoke did not complete within 20 minutes'
}

if (-not (Test-Path -LiteralPath $GitBash -PathType Leaf)) { throw "Git Bash is missing: $GitBash" }
foreach ($command in @('git', 'node', 'npm', 'python', 'uv')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is missing: $command" }
}
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw "Cannot resolve the dotagents repository: $RepoRoot" }

New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
Set-OwnerOnlyAcl $StateDirectory
Start-Transcript -LiteralPath $TranscriptPath -Force | Out-Null
Set-OwnerOnlyAcl $TranscriptPath
try {
  $RunLock = [IO.File]::Open((Join-Path $StateDirectory 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  throw 'Windows-native factory setup is already running'
}

try {
  Normalize-WindowsReporterConfig
  $install = Convert-ToGitBashPath (Join-Path $RepoRoot 'install.sh')
  $update = Convert-ToGitBashPath (Join-Path $RepoRoot 'bin\agents-update.sh')
  $applyCodex = Convert-ToGitBashPath (Join-Path $RepoRoot 'bin\apply-codex-config.sh')
  $applyClaude = Convert-ToGitBashPath (Join-Path $RepoRoot 'bin\apply-claude-config.sh')
  $applyGrok = Join-Path $RepoRoot 'bin\apply-grok-config.sh'
  $verify = Convert-ToGitBashPath (Join-Path $RepoRoot 'bin\verify-install.sh')
  $deliveryRunner = Join-Path $RepoRoot 'bin\factory-reporter-v7-schedule-runner.mjs'
  $ledgerHelper = Join-Path $RepoRoot 'bin\factory-toolchain-ledger.mjs'
  $productSmoke = Join-Path $RepoRoot 'lib\factory\windows-native-product-smoke.mjs'
  $reporterScheduler = Join-Path $RepoRoot 'bin\factory-reporter-scheduler.mjs'
  $dailyScheduler = Join-Path $RepoRoot 'bin\agents-update-scheduler.mjs'

  $legacyReporterTask = Get-ScheduledTask -TaskName $ReporterTaskName -ErrorAction SilentlyContinue
  if ($legacyReporterTask -and $legacyReporterTask.State -ne 'Ready') {
    Write-Step 'retire-hourly-reporter-task: stop running instance'
    Stop-ScheduledTask -TaskName $ReporterTaskName
  }
  # factory-reporter-scheduler.mjs uninstall --apply
  Invoke-Checked -File 'node' -Arguments @($reporterScheduler, 'uninstall', '--apply', '--platform', 'win32') -Label 'retire-hourly-reporter-task'
  Remove-LegacyCron

  # install.sh
  Invoke-Checked -File $GitBash -Arguments @($install, '--profile', 'official') -Label 'dotagents-links: install.sh'
  Update-WindowsNativeClaude
  Remove-WindowsGlobalNpmLink 'aiterm-mcp'
  # agents-update.sh
  Invoke-BootstrapUpdate $update
  # apply-codex-config.sh
  Invoke-Checked -File $GitBash -Arguments @('-lc', 'python3 "$1" --apply', 'dotagents-apply-codex', $applyCodex) -Label 'codex-config: apply-codex-config.sh'
  Normalize-WindowsCodexHooks
  # verify-install は既存の Claude settings.json がある時だけ Claude hook を必須検査する。
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.claude\settings.json') -PathType Leaf) {
    Invoke-Checked -File $GitBash -Arguments @('-lc', 'python3 "$1" --apply', 'dotagents-apply-claude', $applyClaude) -Label 'claude-config: apply-claude-config.sh'
  }
  $grokAuth = Join-Path $env:USERPROFILE '.grok\auth.json'
  $grokLoggedIn = -not [string]::IsNullOrWhiteSpace($env:XAI_API_KEY)
  if (-not $grokLoggedIn -and (Test-Path -LiteralPath $grokAuth -PathType Leaf)) {
    $grokLoggedIn = (Get-Item -LiteralPath $grokAuth).Length -gt 0
  }
  if (-not $grokLoggedIn) {
    Write-Host 'INFO: Grok not logged in. Skipping apply-grok-config (toolchain optional)'
  } else {
    $previousGrokHome = $env:HOME
    $env:HOME = $env:USERPROFILE
    try {
      Invoke-Checked -File 'python' -Arguments @($applyGrok, '--apply') -Label 'grok-config: apply-grok-config.sh'
    } finally {
      $env:HOME = $previousGrokHome
    }
  }
  $previousHome = $env:HOME
  $previousCodexHome = $env:CODEX_HOME
  $env:HOME = $env:USERPROFILE
  $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
  try {
    Invoke-Checked -File 'caveat' -Arguments @('init') -ClosedStdin -Label 'native-product-wiring: caveat init'
    Invoke-Checked -File 'throughline' -Arguments @('install') -Label 'native-product-wiring: throughline'
    Invoke-Checked -File 'caveat' -Arguments @('codex-hook', 'install') -Label 'native-product-wiring: caveat codex-hook'
  } finally {
    $env:HOME = $previousHome
    $env:CODEX_HOME = $previousCodexHome
  }
  $legacyUndefined = Join-Path $RepoRoot 'undefined'
  if (Test-Path -LiteralPath $legacyUndefined -PathType Container) {
    $allowedLegacy = @('undefined\.codex\config.toml', 'undefined\.codex\hooks.json')
    $unexpectedLegacy = @(Get-ChildItem -LiteralPath $legacyUndefined -Recurse -File -Force | Where-Object {
      $relative = $_.FullName.Substring($RepoRoot.Length + 1)
      $relative -notin $allowedLegacy
    })
    if ($unexpectedLegacy.Count -gt 0) { throw 'Refusing to remove unexpected files from the legacy undefined HOME' }
    Remove-Item -LiteralPath $legacyUndefined -Recurse -Force
  }
  if (-not (Test-External -File 'markitdown' -Arguments @('--version'))) {
    Invoke-Checked -File 'uv' -Arguments @('tool', 'install', 'markitdown', '--reinstall') -Label 'native-product-wiring: markitdown'
  }
  # lattice hooks install --host claude
  Invoke-LatticeHookInstall -HostName 'claude'
  # lattice hooks install --host codex
  Invoke-LatticeHookInstall -HostName 'codex'
  # spotter install -y
  Invoke-Checked -File 'spotter' -Arguments @('install', '-y') -Label 'spotter install -y'

  Ensure-ClaudeMcp -Name 'aiterm' -Command 'aiterm-mcp'
  Ensure-ClaudeMcp -Name 'caveat' -Command 'caveat' -Arguments @('mcp-server')
  Ensure-ClaudeMcp -Name 'lattice' -Command 'lattice-mcp'
  Ensure-ClaudeMcp -Name 'codex-sidecar' -Command 'codex-sidecar-mcp'
  Ensure-ClaudeMcp -Name 'gpt_connector' -Command 'gpt-connector-mcp'
  Ensure-CodexMcp -Name 'aiterm' -Command 'aiterm-mcp'
  Ensure-CodexMcp -Name 'codex-sidecar' -Command 'codex-sidecar-mcp'
  Ensure-CodexMcp -Name 'gpt_connector' -Command 'gpt-connector-mcp'
  Ensure-CodexMcp -Name 'lattice' -Command 'lattice-mcp'

  $caveatOwn = Join-Path $env:USERPROFILE '.caveat\own\.git'
  if (Test-Path -LiteralPath $caveatOwn -PathType Container) {
    Invoke-Checked -File 'caveat' -Arguments @('sync') -Label 'caveat-sync'
  } else {
    Invoke-Checked -File 'caveat' -Arguments @('sync', '--init', '--repo', 'https://github.com/kitepon-rgb/Caveat-Private.git') -Label 'caveat-sync-init'
  }

  # verify-install.sh
  $verifyStatus = Invoke-VerifyInstall $verify
  # factory-reporter-v7-schedule-runner.mjs
  $delivery = Invoke-FreshDelivery $deliveryRunner $ledgerHelper $productSmoke
  # agents-update-scheduler.mjs install --apply
  if (-not $ScheduledRun) {
    Invoke-Checked -File 'node' -Arguments @($dailyScheduler, 'install', '--apply') -Label 'daily-0200-task'
  }
  Assert-DailyTask
  if (Get-ScheduledTask -TaskName $ReporterTaskName -ErrorAction SilentlyContinue) { throw "$ReporterTaskName still exists" }

  $receipt = Write-Receipt -Delivery $delivery -ScheduledSmoke:$ScheduledRun -VerifyStatus $verifyStatus
} finally {
  if ($null -ne $RunLock) { $RunLock.Dispose() }
}

if (-not $ScheduledRun) {
  $scheduledReceipt = Wait-ScheduledSmoke -PriorRunId $receipt.run_id
  $result = [pscustomobject]@{
    schema = 'dotagents.windows-native-factory-setup-result.v1'
    ok = $true
    initial_run_id = $receipt.run_id
    scheduled_run_id = $scheduledReceipt.run_id
    delivery_acknowledged = $true
    products_checked = $scheduledReceipt.product_smoke.checked_products
    daily_task = $TaskName
    daily_time = '02:00'
  }
} else {
  $result = $receipt
}
Stop-Transcript | Out-Null
$result | ConvertTo-Json -Depth 10 -Compress
