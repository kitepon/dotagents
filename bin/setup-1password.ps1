# Windows nativeの正規入口。OS適合だけを持ち、本処理は共通Pythonへ渡す。
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'PowerShell 7から実行してください'
}
$python = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
& $python.Source (Join-Path $PSScriptRoot 'setup-1password.sh') --profile windows-native @args
exit $LASTEXITCODE
