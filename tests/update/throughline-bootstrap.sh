#!/usr/bin/env bash
# 初回と更新を製品の正規入口だけで完結させる。
# shellcheck disable=SC2329 # 抽出した関数がfixture関数を呼ぶ。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
awk '/^update_throughline\(\)/ { capture=1 } capture { print } capture && /^}/ { exit }' "$ROOT/bin/agents-update.sh" >"$fixture/entry.sh"
# shellcheck disable=SC1091
source "$fixture/entry.sh"
command() { if [[ "$*" = '-v throughline' ]]; then [[ "$installed" = yes ]]; else builtin command "$@"; fi; }
npm_install_spec() { printf '%s@latest' "$1"; }
npm_install_global() { echo "npm:$*" >>"$fixture/calls"; [[ "${install_failure:-0}" = 0 ]]; }
throughline() { echo "throughline:$*" >>"$fixture/calls"; }
installed=no
update_throughline
printf 'npm:throughline throughline@latest\nthroughline:install\n' >"$fixture/expected"
diff -u "$fixture/expected" "$fixture/calls"
: >"$fixture/calls"
installed=yes
update_throughline
printf 'throughline:self-update --json\n' >"$fixture/expected"
diff -u "$fixture/expected" "$fixture/calls"
: >"$fixture/calls"
installed=no
install_failure=1
if update_throughline; then echo 'FAIL: npm失敗を成功扱いした' >&2; exit 1; fi
printf 'npm:throughline throughline@latest\n' >"$fixture/expected"
diff -u "$fixture/expected" "$fixture/calls"
echo 'throughline-bootstrap: OK'
