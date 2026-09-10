[CmdletBinding()]
param(
  [switch]$ScheduledRun,
  [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Plan = @(
  'prerequisite-packages',
  'factory-reporter-config',
  'retire-legacy-schedulers',
  'dotagents-links',
  'factory-config',
  'main-server-ssh',
  'daily-0200-task',
  'product-update-and-setup',
  'fresh-bughub-delivery',
  'all-product-smoke',
  'verify-install'
)

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'setup-windows-native-factory.ps1 is Windows-native only'
}

if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
  $powerShellMessage = 'PowerShell 7 is required. Install the official GitHub release win-x64 MSI at machine scope.'
  if ($PlanOnly) { throw $powerShellMessage }
  $officialPowerShell = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
  if (-not (Test-Path -LiteralPath $officialPowerShell -PathType Leaf)) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) { throw "$powerShellMessage winget.exe is also missing." }
    Write-Host '[windows-native-factory] prerequisite-package: Microsoft.PowerShell'
    & $winget.Source install --exact --id Microsoft.PowerShell --scope machine --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $officialPowerShell -PathType Leaf)) {
      throw "$powerShellMessage winget installation failed."
    }
  }
  $relayArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($ScheduledRun) { $relayArguments += '-ScheduledRun' }
  & $officialPowerShell @relayArguments
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
$MainServerHost = '192.168.1.2'
$MainServerUser = 'kite'
$MainServerAlias = 'main-server'
$MainServerKeyComment = 'quolu@windows-main-server-20260830'
$MainServerHostKey = '192.168.1.2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIWU1zJ02l+o/J1g+LJEAZSPV/BUcXJZJf9hIPnNCxlG'
$MainServerHostKeyFingerprint = 'SHA256:TLhN/5MaQ7MR2Y0E6c9G1ZQK23UfidDZlsdCjLVCOWs'
$RunId = [guid]::NewGuid().ToString()
$RunLock = $null
$RunClock = [Diagnostics.Stopwatch]::StartNew()
$TranscriptPath = Join-Path $StateDirectory "run-$RunId.log"

function Write-Step([string]$Name) {
  Write-Host "[windows-native-factory] $Name ($([int]$RunClock.Elapsed.TotalSeconds)秒)"
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machinePath, $userPath) -join ';'
}

function Invoke-WingetPackage([string]$Id, [switch]$Upgrade) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($null -eq $winget) { throw "Required package $Id is missing and winget.exe is unavailable" }
  $verb = if ($Upgrade) { 'upgrade' } else { 'install' }
  Write-Step "prerequisite-package: $Id"
  & $winget.Source $verb --exact --id $Id --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget $verb failed for $Id with exit $LASTEXITCODE" }
  Refresh-ProcessPath
}

function Ensure-WingetCommand([string]$Command, [string]$PackageId) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  Invoke-WingetPackage -Id $PackageId
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "Package $PackageId was installed but command $Command is still unavailable"
  }
}

function Ensure-WindowsPrerequisites {
  Refresh-ProcessPath
  Ensure-WingetCommand -Command 'git' -PackageId 'Git.Git'
  Ensure-WingetCommand -Command 'node' -PackageId 'OpenJS.NodeJS.LTS'
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24) {
    Invoke-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Upgrade
  }
  Ensure-WingetCommand -Command 'npm' -PackageId 'OpenJS.NodeJS.LTS'
  Ensure-WingetCommand -Command 'gh' -PackageId 'GitHub.cli'
  Ensure-WingetCommand -Command 'python' -PackageId 'Python.Python.3.13'
  Ensure-WingetCommand -Command 'uv' -PackageId 'astral-sh.uv'
  Ensure-WingetCommand -Command 'make' -PackageId 'ezwinports.make'
  Ensure-WingetCommand -Command 'shellcheck' -PackageId 'koalaman.shellcheck'
  Ensure-WingetCommand -Command 'rg' -PackageId 'BurntSushi.ripgrep.MSVC'
  foreach ($sshCommand in @('ssh', 'ssh-keygen', 'ssh-keyscan')) {
    if (-not (Get-Command $sshCommand -ErrorAction SilentlyContinue)) {
      Invoke-WingetPackage -Id 'Git.Git' -Upgrade
      if (-not (Get-Command $sshCommand -ErrorAction SilentlyContinue)) {
        throw "Git.Git was installed but required OpenSSH command $sshCommand is unavailable"
      }
    }
  }
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

function Set-OwnerOnlyAcl([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $Path
  $existingAcl = Get-Acl -LiteralPath $Path
  $existingOwnerSid = ($existingAcl.GetOwner([Security.Principal.SecurityIdentifier])).Value
  if ($item.PSIsContainer) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  if ($existingOwnerSid -ne $sid.Value) { $acl.SetOwner($sid) }
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)

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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Test-MainServerSsh {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & ssh -o BatchMode=yes -o ConnectTimeout=10 $MainServerAlias "printf 'dotagents-main-server-ssh-ok'" 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return $code -eq 0 -and $output -eq 'dotagents-main-server-ssh-ok'
}

function Ensure-MainServerKnownHost([string]$SshDirectory) {
  $knownHosts = Join-Path $SshDirectory 'known_hosts'
  $scan = (& ssh-keyscan -T 5 -t ed25519 $MainServerHost 2>$null | Where-Object { $_ -notmatch '^#' }) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $scan.Trim() -ne $MainServerHostKey) {
    throw "main-server host key does not match pinned fingerprint $MainServerHostKeyFingerprint"
  }
  $existing = if (Test-Path -LiteralPath $knownHosts -PathType Leaf) { Get-Content -LiteralPath $knownHosts } else { @() }
  if ($existing -notcontains $MainServerHostKey) {
    $updated = @($existing | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) + $MainServerHostKey
    Write-Utf8NoBom -Path $knownHosts -Content (($updated -join "`n") + "`n")
  }
  $fingerprint = (& ssh-keygen -lf $knownHosts -F $MainServerHost 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $fingerprint -notmatch [regex]::Escape($MainServerHostKeyFingerprint)) {
    throw "main-server pinned host key readback failed: $MainServerHostKeyFingerprint"
  }
}

function Ensure-MainServerSshConfig([string]$SshDirectory, [string]$PrivateKey) {
  $configPath = Join-Path $SshDirectory 'config'
  $begin = '# dotagents main-server begin'
  $end = '# dotagents main-server end'
  $managed = @(
    $begin,
    "Host $MainServerAlias $MainServerHost",
    "    HostName $MainServerHost",
    "    User $MainServerUser",
    "    IdentityFile $($PrivateKey.Replace('\', '/'))",
    '    IdentitiesOnly yes',
    '    PreferredAuthentications publickey',
    '    StrictHostKeyChecking yes',
    '    ServerAliveInterval 30',
    '    ServerAliveCountMax 3',
    $end
  ) -join "`n"
  $current = if (Test-Path -LiteralPath $configPath -PathType Leaf) { Get-Content -Raw -LiteralPath $configPath } else { '' }
  $pattern = "(?ms)^$([regex]::Escape($begin))\r?\n.*?^$([regex]::Escape($end))\r?\n?"
  $withoutManaged = ([regex]::Replace($current, $pattern, '')).TrimEnd()
  $next = if ([string]::IsNullOrWhiteSpace($withoutManaged)) { "$managed`n" } else { "$withoutManaged`n`n$managed`n" }
  Write-Utf8NoBom -Path $configPath -Content $next
  Set-OwnerOnlyAcl $configPath

  $effective = & ssh -G $MainServerAlias 2>$null
  $expected = @(
    "hostname $MainServerHost",
    "user $MainServerUser",
    "identityfile $($PrivateKey.Replace('\', '/'))",
    'identitiesonly yes',
    'stricthostkeychecking true'
  )
  foreach ($entry in $expected) {
    if ($effective -notcontains $entry) { throw "main-server SSH config readback is missing: $entry" }
  }
  $directEffective = & ssh -G $MainServerHost 2>$null
  foreach ($entry in $expected) {
    if ($directEffective -notcontains $entry) { throw "direct-IP main-server SSH config readback is missing: $entry" }
  }
}

function Invoke-MainServerKeyEnrollment([string]$PublicKey) {
  Write-Step 'main-server-ssh: enroll permanent public key'
  $workflow = 'enroll-windows-main-server-ssh.yml'
  $repo = 'kitepon/dotagents'
  $prior = & gh run list --repo $repo --workflow $workflow --event workflow_dispatch --limit 10 --json databaseId 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the main-server SSH enrollment workflow' }
  $priorIds = @($prior | ForEach-Object { [string]$_.databaseId })
  & gh secret set MAIN_SERVER_WINDOWS_PUBLIC_KEY --repo $repo --body $PublicKey
  if ($LASTEXITCODE -ne 0) { throw 'Cannot set MAIN_SERVER_WINDOWS_PUBLIC_KEY for permanent enrollment' }
  & gh workflow run $workflow --repo $repo --ref main
  if ($LASTEXITCODE -ne 0) { throw 'Cannot dispatch the main-server SSH enrollment workflow' }

  $runId = $null
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
  do {
    Start-Sleep -Seconds 2
    $runs = & gh run list --repo $repo --workflow $workflow --event workflow_dispatch --limit 5 --json databaseId 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the dispatched main-server SSH enrollment run' }
    $candidate = @($runs | Where-Object { [string]$_.databaseId -notin $priorIds } | Select-Object -First 1)
    if ($candidate.Count -gt 0) { $runId = [string]$candidate[0].databaseId }
  } until ($null -ne $runId -or [DateTimeOffset]::UtcNow -ge $deadline)
  if ($null -eq $runId) { throw 'The dispatched main-server SSH enrollment run was not found' }

  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
  $lastStatus = ''
  do {
    $run = & gh run view $runId --repo $repo --json status,conclusion,url 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect main-server SSH enrollment run $runId" }
    if ($run.status -ne $lastStatus) {
      Write-Step "main-server-ssh: enrollment $($run.status) $($run.url)"
      $lastStatus = $run.status
    }
    if ($run.status -eq 'completed') {
      if ($run.conclusion -ne 'success') { throw "main-server SSH enrollment failed: $($run.url) conclusion=$($run.conclusion)" }
      return
    }
    Start-Sleep -Seconds 5
  } until ([DateTimeOffset]::UtcNow -ge $deadline)
  throw "main-server SSH enrollment did not complete within 20 minutes: $($run.url)"
}

function Ensure-MainServerSsh {
  Write-Step 'main-server-ssh'
  $sshDirectory = Join-Path $env:USERPROFILE '.ssh'
  $privateKey = Join-Path $sshDirectory 'id_ed25519_main_server'
  $publicKeyPath = "$privateKey.pub"
  New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null

  if (-not (Test-Path -LiteralPath $privateKey -PathType Leaf) -and -not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
    & ssh-keygen -q -t ed25519 -N '' -C $MainServerKeyComment -f $privateKey
    if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the permanent main-server SSH key' }
  } elseif (-not (Test-Path -LiteralPath $privateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
    throw 'The permanent main-server SSH key pair is incomplete; refusing to replace either half'
  }

  Set-OwnerOnlyAcl $privateKey
  $publicKey = (Get-Content -Raw -LiteralPath $publicKeyPath).Trim()
  if ($publicKey -notmatch "^ssh-ed25519 [A-Za-z0-9+/]+={0,3} $([regex]::Escape($MainServerKeyComment))$") {
    throw "Unexpected permanent main-server public key format or comment: $publicKeyPath"
  }
  $derived = (& ssh-keygen -y -P '' -f $privateKey 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $publicKey.Split(' ')[1] -ne $derived.Split(' ')[1]) {
    throw 'The permanent main-server key is passphrase-protected or its public half does not match'
  }

  Ensure-MainServerKnownHost -SshDirectory $sshDirectory
  Ensure-MainServerSshConfig -SshDirectory $sshDirectory -PrivateKey $privateKey
  if (-not (Test-MainServerSsh)) {
    Invoke-MainServerKeyEnrollment -PublicKey $publicKey
  }
  foreach ($attempt in 1..3) {
    if (-not (Test-MainServerSsh)) { throw "Permanent main-server SSH verification failed on attempt $attempt" }
  }
  $directOutput = & ssh -o BatchMode=yes -o ConnectTimeout=10 "$MainServerUser@$MainServerHost" "printf 'dotagents-main-server-direct-ssh-ok'"
  if ($LASTEXITCODE -ne 0 -or $directOutput -ne 'dotagents-main-server-direct-ssh-ok') {
    throw 'Permanent direct-IP main-server SSH verification failed'
  }
  Write-Step 'main-server-ssh: three reconnects passed'
}

function Assert-ReporterConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Windows factory reporter config is missing: $ConfigPath"
  }
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  if ($config.host.profile -ne 'windows-native') { throw 'factory reporter host.profile must be windows-native' }
  if ($config.collection.enabled -ne $true -or $config.reporting.enabled -ne $true) { throw 'factory collection and reporting must be enabled' }
  $endpoint = [uri]$config.reporting.endpoint
  if ($endpoint.AbsolutePath -ne '/api/factory/v8/reports') { throw 'factory reporter endpoint must use wire v8' }
  $credential = [string]$config.reporting.credential_file
  if ([string]::IsNullOrWhiteSpace($credential) -or -not (Test-Path -LiteralPath $credential -PathType Leaf)) {
    throw 'Windows-native BugHub credential is missing'
  }
}

function Restore-ScheduledReporterConfigFromCodexCache {
  if (-not $ScheduledRun -or (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return }
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  if (-not (Test-Path -LiteralPath $packages -PathType Container)) { return }
  $candidates = @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'OpenAI.Codex_*' | ForEach-Object {
    $candidate = Join-Path $_.FullName 'LocalCache\Local\dotagents\factory-reporter\config.json'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
  })
  if ($candidates.Count -eq 0) { return }
  if ($candidates.Count -ne 1) { throw 'Multiple Codex AppContainer factory reporter configs were found' }

  $sourceConfig = $candidates[0].FullName
  $sourceDirectory = Split-Path -Parent $sourceConfig
  $sourceCredential = Join-Path $sourceDirectory 'credential'
  if (-not (Test-Path -LiteralPath $sourceCredential -PathType Leaf) -or (Get-Item -LiteralPath $sourceCredential).Length -lt 1) {
    throw 'Codex AppContainer BugHub credential is missing'
  }
  $destinationDirectory = Split-Path -Parent $ConfigPath
  $destinationCredential = Join-Path $destinationDirectory 'credential'
  $sourceValue = Get-Content -Raw -LiteralPath $sourceConfig | ConvertFrom-Json
  if ([IO.Path]::GetFullPath([string]$sourceValue.reporting.credential_file) -ne [IO.Path]::GetFullPath($destinationCredential)) {
    throw 'Codex AppContainer factory reporter credential path is not canonical'
  }

  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  Copy-Item -LiteralPath $sourceCredential -Destination $destinationCredential -Force
  Copy-Item -LiteralPath $sourceConfig -Destination $ConfigPath -Force
  Set-OwnerOnlyAcl $destinationDirectory
  Set-OwnerOnlyAcl $destinationCredential
  Set-OwnerOnlyAcl $ConfigPath
  Write-Step 'factory-reporter-config: restored from Codex AppContainer cache'
}

function Restore-ScheduledGitHubCliConfigFromCodexCache {
  if (-not $ScheduledRun -or (Test-External -File 'gh' -Arguments @('auth', 'status', '--hostname', 'github.com'))) { return }
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  if (-not (Test-Path -LiteralPath $packages -PathType Container)) { throw 'GitHub CLI is not authenticated for the scheduled task' }
  $candidates = @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'OpenAI.Codex_*' | ForEach-Object {
    $candidate = Join-Path $_.FullName 'LocalCache\Roaming\GitHub CLI\hosts.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
  })
  if ($candidates.Count -ne 1) { throw 'A unique Codex AppContainer GitHub CLI config was not found' }
  $destinationDirectory = Join-Path $env:APPDATA 'GitHub CLI'
  $destination = Join-Path $destinationDirectory 'hosts.yml'
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  Copy-Item -LiteralPath $candidates[0].FullName -Destination $destination -Force
  Set-OwnerOnlyAcl $destinationDirectory
  Set-OwnerOnlyAcl $destination
  if (-not (Test-External -File 'gh' -Arguments @('auth', 'status', '--hostname', 'github.com'))) {
    throw 'GitHub CLI authentication was not restored for the scheduled task'
  }
  Write-Step 'github-cli-config: restored from Codex AppContainer cache'
}

function Normalize-WindowsReporterConfig {
  Write-Step 'factory-reporter-config: UTF-8 without BOM'
  Restore-ScheduledReporterConfigFromCodexCache
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

function Invoke-FactoryUpdate([string]$UpdateScript, [string]$ProductSmoke) {
  Write-Step '製品更新・公開入口の実行・fresh BugHub配送'
  $state = Join-Path $env:LOCALAPPDATA 'dotagents\factory-reporter-v8'
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
  $previousRunner = $env:FACTORY_REPORTER_RUNNER
  $previousBatchToken = $env:AGENTS_UPDATE_BATCH_TOKEN
  $previousThroughlineThread = $env:THROUGHLINE_CODEX_THREAD_ID
  $previousCodexThread = $env:CODEX_THREAD_ID
  $ErrorActionPreference = 'Continue'
  $env:HOME = $env:USERPROFILE
  $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
  $env:FACTORY_REPORTER_RUNNER = Convert-ToGitBashPath (Join-Path $env:USERPROFILE '.local\bin\factory-reporter-v8-schedule-runner')
  $env:AGENTS_UPDATE_BATCH_TOKEN = $batchToken
  $env:THROUGHLINE_CODEX_THREAD_ID = $null
  $env:CODEX_THREAD_ID = $null
  try {
    $updateArguments = @($UpdateScript)
    if (-not $ScheduledRun) { $updateArguments += '--setup' }
    & $GitBash @updateArguments | ForEach-Object { Write-Host $_ }
    $updateCode = $LASTEXITCODE
    if ($updateCode -ne 0) { throw "工場更新・製品setup・配送が失敗しました: exit $updateCode" }
  } finally {
    $ErrorActionPreference = $previousPreference
    $env:HOME = $previousHome
    $env:CODEX_HOME = $previousCodexHome
    $env:FACTORY_REPORTER_RUNNER = $previousRunner
    $env:AGENTS_UPDATE_BATCH_TOKEN = $previousBatchToken
    $env:THROUGHLINE_CODEX_THREAD_ID = $previousThroughlineThread
    $env:CODEX_THREAD_ID = $previousCodexThread
  }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf) -or -not (Test-Path -LiteralPath $deliveryPath -PathType Leaf)) {
    throw 'Fresh BugHub report or delivery receipt is missing'
  }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  $receipt = Get-Content -Raw -LiteralPath $deliveryPath | ConvertFrom-Json
  if ($report.schema_version -ne '8.0' -or [string]$report.report_id -eq $priorReportId -or
      $receipt.schema -ne 'dotagents.factory-delivery-receipt.v1' -or
      $receipt.report_id -ne $report.report_id -or $receipt.batch_token -ne $batchToken) {
    throw 'Fresh BugHub delivery receipt does not match this v8 batch'
  }
  $smokeOutput = & node $ProductSmoke '--report' $reportPath 2>&1
  $smokeCode = $LASTEXITCODE
  $smokeOutput | ForEach-Object { Write-Host $_ }
  if ($smokeCode -ne 0) { throw "All-product smoke failed with exit $smokeCode" }
  $smoke = ($smokeOutput | Select-Object -Last 1) | ConvertFrom-Json
  if ($smoke.schema -ne 'dotagents.windows-native-product-smoke.v1' -or $smoke.status -ne 'passed' -or $smoke.checked_products -ne 15) {
    throw 'All-product smoke receipt is invalid'
  }
  return [pscustomobject]@{ delivery_acknowledged = $true; report = 'v8'; product_smoke = $smoke }
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
  if ($code -ne 0) { throw "verify-install failed with exit $code" }
  return 'passed'
}

function Assert-DailyTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.Settings.Enabled -ne $true) { throw "$TaskName is disabled" }
  $trigger = @($task.Triggers)[0]
  if (@($task.Triggers).Count -ne 1 -or $trigger.DaysInterval -ne 1 -or ([datetime]$trigger.StartBoundary).TimeOfDay -ne [timespan]::FromHours(2)) {
    throw "$TaskName is not scheduled daily at 02:00"
  }
  $action = @($task.Actions)[0]
  if (@($task.Actions).Count -ne 1 -or $action.Execute -notmatch 'pwsh\.exe$' -or $action.Arguments -notlike '*setup-windows-native-factory.ps1*' -or $action.Arguments -notlike '*-ScheduledRun*') {
    throw "$TaskName action is not the Windows one-shot setup"
  }
}

function Get-CodexReceiptMirrorPaths {
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  $paths = @()
  if (-not (Test-Path -LiteralPath $packages -PathType Container)) { return $paths }
  foreach ($directory in @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'OpenAI.Codex_*')) {
    if ($directory.Name -notmatch '^OpenAI\.Codex_[A-Za-z0-9]+$' -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $paths += Join-Path $directory.FullName 'LocalCache\Local\dotagents\windows-native-factory-setup\scheduled-receipt.json'
  }
  return $paths
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
  # Codex Desktop (MSIX/AppContainer) から開始した親プロセスでは LocalAppData の
  # virtual overlay がphysical receiptを隠す。scheduled processが同じ受領票を
  # Codex cacheへ明示公開し、親が実行IDと配送ackを検証できるようにする。
  if (-not $ScheduledRun) { return [pscustomobject]$value }
  $mirrorPaths = @(Get-CodexReceiptMirrorPaths)
  foreach ($mirror in $mirrorPaths) {
    $mirrorDirectory = Split-Path -Parent $mirror
    New-Item -ItemType Directory -Force -Path $mirrorDirectory | Out-Null
    Set-OwnerOnlyAcl $mirrorDirectory
    $mirrorTemporary = "$mirror.$RunId.tmp"
    [IO.File]::WriteAllText($mirrorTemporary, (($value | ConvertTo-Json -Depth 10 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $mirrorTemporary -Destination $mirror -Force
    Set-OwnerOnlyAcl $mirror
  }
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
      $candidates = @($ReceiptPath) + @(Get-CodexReceiptMirrorPaths)
      foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
          $receipt = Get-Content -Raw -LiteralPath $candidate | ConvertFrom-Json
          if ($receipt.schema -eq 'dotagents.windows-native-factory-setup-receipt.v1' -and $receipt.run_id -ne $PriorRunId -and $receipt.scheduled_run -eq $true -and $receipt.delivery_acknowledged -eq $true) {
            return $receipt
          }
        } catch {}
      }
      throw 'scheduled task completed without a fresh acknowledged receipt'
    }
  }
  throw 'The daily 02:00 task smoke did not complete within 20 minutes'
}

if (-not $ScheduledRun) { Ensure-WindowsPrerequisites } else { Refresh-ProcessPath }
if (-not (Test-Path -LiteralPath $GitBash -PathType Leaf)) { throw "Git Bash is missing after Git.Git installation: $GitBash" }
foreach ($command in @('git', 'node', 'npm', 'gh', 'python', 'uv', 'make', 'shellcheck', 'rg')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is missing: $command" }
}
$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24) {
  throw 'Node.js 24以上が必要です。公式installerまたはwingetで更新してください'
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
  $applyCursor = Join-Path $RepoRoot 'bin\apply-cursor-config.sh'
  $verify = Convert-ToGitBashPath (Join-Path $RepoRoot 'bin\verify-install.sh')
  $productSmoke = Join-Path $RepoRoot 'lib\factory\windows-native-product-smoke.mjs'
  $reporterScheduler = Join-Path $RepoRoot 'bin\factory-reporter-scheduler.mjs'
  $dailyScheduler = Join-Path $RepoRoot 'bin\agents-update-scheduler.mjs'

  if (-not $ScheduledRun) {
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
  Remove-WindowsGlobalNpmLink 'aiterm-mcp'
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
  $previousCursorHome = $env:HOME
  $env:HOME = $env:USERPROFILE
  try {
    Invoke-Checked -File 'python' -Arguments @($applyCursor, '--apply') -Label 'cursor-config: apply-cursor-config.sh'
  } finally {
    $env:HOME = $previousCursorHome
  }
  Restore-ScheduledGitHubCliConfigFromCodexCache
  Invoke-Checked -File 'gh' -Arguments @('auth', 'switch', '--hostname', 'github.com', '--user', 'quolu') -Label 'github-auth-switch'
  Invoke-Checked -File 'gh' -Arguments @('auth', 'setup-git') -Label 'github-auth-setup-git'
  Ensure-MainServerSsh
  Invoke-Checked -File 'node' -Arguments @($dailyScheduler, 'install', '--apply') -Label 'daily-0200-task'
  }
  Assert-DailyTask
  if (Get-ScheduledTask -TaskName $ReporterTaskName -ErrorAction SilentlyContinue) { throw "$ReporterTaskName still exists" }
  Update-WindowsNativeClaude
  $delivery = Invoke-FactoryUpdate $update $productSmoke
  # verify-install.sh
  $verifyStatus = Invoke-VerifyInstall $verify
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
