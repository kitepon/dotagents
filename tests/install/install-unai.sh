#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_HOME="$(mktemp -d)"
INSTALLER_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME" "$INSTALLER_ROOT"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

cat >"$INSTALLER_ROOT/install.sh" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/unai" <<'UNAI'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version) printf '0.4.0\n' ;;
  factory-diagnostics)
    projection_status="${UNAI_TEST_PROJECTION_STATUS:-ready}"
    overall=ready
    [ "$projection_status" = ready ] || overall=not_ready
    printf '{"schema":"unai.native_factory_diagnostics.v2","product":{"name":"unai","version":"0.4.0"},"checks":{"manifest_consistency":"pass","node_runtime":"pass","skill_bundle":"pass","skill_projections":{"claude":"ready","codex":"%s","grok":"ready","cursor":"ready"}},"overall":"%s"}\n' "$projection_status" "$overall"
    [ "$overall" = ready ]
    ;;
  *) exit 64 ;;
esac
UNAI
chmod +x "$HOME/.local/bin/unai"
INSTALLER
chmod +x "$INSTALLER_ROOT/install.sh"

cat >"$INSTALLER_ROOT/install.ps1" <<'INSTALLER'
$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:HOME '.local/bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
@'
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CliArgs
)

switch ($CliArgs[0]) {
  '--version' {
    '0.4.0'
    exit 0
  }
  'factory-diagnostics' {
    $projectionStatus = if ($env:UNAI_TEST_PROJECTION_STATUS) {
      $env:UNAI_TEST_PROJECTION_STATUS
    } else {
      'ready'
    }
    $overall = if ($projectionStatus -eq 'ready') { 'ready' } else { 'not_ready' }
    [ordered]@{
      schema = 'unai.native_factory_diagnostics.v2'
      product = [ordered]@{ name = 'unai'; version = '0.4.0' }
      checks = [ordered]@{
        manifest_consistency = 'pass'
        node_runtime = 'pass'
        skill_bundle = 'pass'
        skill_projections = [ordered]@{
          claude = 'ready'
          codex = $projectionStatus
          grok = 'ready'
          cursor = 'ready'
        }
      }
      overall = $overall
    } | ConvertTo-Json -Compress -Depth 4
    if ($overall -ne 'ready') { exit 1 }
    exit 0
  }
  default { exit 64 }
}
'@ | Set-Content -LiteralPath (Join-Path $bin 'unai.ps1') -Encoding utf8
INSTALLER

case "${OS:-$(uname -s)}" in
  MINGW*|MSYS*|Windows_NT) INSTALLER_BASE_URL="file:///$(cygpath -m "$INSTALLER_ROOT")" ;;
  *) INSTALLER_BASE_URL="file://$INSTALLER_ROOT" ;;
esac

HOME="$TEST_HOME" UNAI_INSTALLER_BASE_URL="$INSTALLER_BASE_URL" \
  "$ROOT/bin/install-unai.sh" >/dev/null

if HOME="$TEST_HOME" UNAI_TEST_PROJECTION_STATUS=stale \
  UNAI_INSTALLER_BASE_URL="$INSTALLER_BASE_URL" \
  "$ROOT/bin/install-unai.sh" >"$TEST_HOME/not-ready.out" 2>&1; then
  fail 'unai v2のstale projectionを受理した'
fi
grep -Fq 'unai native diagnosticsがreadyではありません' "$TEST_HOME/not-ready.out" \
  || fail 'unai v2の不合格理由を表示しない'

echo 'install-unai v2 tests: OK'
