#!/usr/bin/env bash
set -euo pipefail

PATH="$HOME/.local/bin:/opt/homebrew/bin:/snap/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
installer_base="${UNAI_INSTALLER_BASE_URL:-https://raw.githubusercontent.com/kitepon/unai/main}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

case "${OS:-$(uname -s)}" in
  MINGW*|MSYS*|Windows_NT)
    command -v curl >/dev/null 2>&1 || { echo 'FAIL: unai公式installer取得にcurlが必要です' >&2; exit 1; }
    command -v pwsh.exe >/dev/null 2>&1 || { echo 'FAIL: unai公式installerにはPowerShell 7が必要です' >&2; exit 1; }
    curl -fsSL "$installer_base/install.ps1" -o "$temporary_dir/install.ps1"
    windows_installer="$(cygpath -w "$temporary_dir/install.ps1")"
    pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$windows_installer"
    ;;
  *)
    command -v curl >/dev/null 2>&1 || { echo 'FAIL: unai公式installer取得にcurlが必要です' >&2; exit 1; }
    curl -fsSL "$installer_base/install.sh" -o "$temporary_dir/install.sh"
    "$BASH" "$temporary_dir/install.sh"
    ;;
esac

command -v unai >/dev/null 2>&1 || { echo 'FAIL: unai公式installer後もCLIが見つかりません' >&2; exit 1; }
diagnostic="$(unai factory-diagnostics --json)"
printf '%s' "$diagnostic" | node -e '
  let value;
  try { value = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(1); }
  const checks = value?.checks;
  process.exit(value?.schema === "unai.native_factory_diagnostics.v1"
    && value?.product?.name === "unai"
    && value?.overall === "ready"
    && checks?.manifest_consistency === "pass"
    && checks?.node_runtime === "pass"
    && checks?.skill_bundle === "pass" ? 0 : 1);
' || { echo 'FAIL: unai native diagnosticsがreadyではありません' >&2; exit 1; }
printf 'unai: %s / ready\n' "$(unai --version)"
