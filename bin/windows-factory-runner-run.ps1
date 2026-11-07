#Requires -Version 7.0
# One runner instance, started by the task entry. Host copy: C:\ProgramData\dotagents\factory-tools\run-dedicated.ps1.
# -Register reads the registration token from stdin and configures this root; otherwise runs the listener.
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Name, [switch]$Register)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $Root
$env:HOME = $env:USERPROFILE
if ($Register) {
  $env:ACTIONS_RUNNER_INPUT_TOKEN = [Console]::In.ReadLine()
  try {
    if (!$env:ACTIONS_RUNNER_INPUT_TOKEN) { throw 'No registration token' }
    & .\config.cmd --unattended --url https://github.com/kitepon --name $Name --labels factory,windows-native --work _work
    exit $LASTEXITCODE
  } finally { Remove-Item Env:ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue }
}
& .\run.cmd
exit $LASTEXITCODE
