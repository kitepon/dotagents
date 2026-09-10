#!/usr/bin/env bash
# 公式installerの成功・失敗を保持し、工場で内部診断を繰り返さない。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/home" "$fixture/installer"
cat >"$fixture/installer/install.sh" <<'INSTALLER'
#!/usr/bin/env bash
echo '公式installer公開結果'
exit "${UNAI_TEST_EXIT:-0}"
INSTALLER
cat >"$fixture/installer/install.ps1" <<'INSTALLER'
Write-Output '公式installer公開結果'
if ($env:UNAI_TEST_EXIT) { exit [int]$env:UNAI_TEST_EXIT }
exit 0
INSTALLER
case "${OS:-$(uname -s)}" in
  MINGW*|MSYS*|Windows_NT) base="file:///$(cygpath -m "$fixture/installer")" ;;
  *) base="file://$fixture/installer" ;;
esac
HOME="$fixture/home" UNAI_INSTALLER_BASE_URL="$base" "$ROOT/bin/install-unai.sh" >"$fixture/ok"
grep -Fq '公式installer公開結果' "$fixture/ok"
if HOME="$fixture/home" UNAI_TEST_EXIT=7 UNAI_INSTALLER_BASE_URL="$base" "$ROOT/bin/install-unai.sh" >"$fixture/failed" 2>&1; then
  echo 'FAIL: 公式installerの失敗を成功扱いした' >&2
  exit 1
else
  rc=$?
  [ "$rc" -eq 7 ] || { echo 'FAIL: 公式installerの終了コードを変更した' >&2; exit 1; }
fi
echo 'install-unai official result: OK'
