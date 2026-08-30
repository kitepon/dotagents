#!/usr/bin/env bash
# native Linux（main-server）向け一撃展開入口。Linux共通本体へserver roleを明示する。
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
while [ -L "$script_source" ]; do
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  script_source="$(readlink "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_dir/$script_source" ;; esac
done
ROOT="$(cd "$(dirname "$script_source")/.." && pwd)"

export DOTAGENTS_SETUP_VARIANT=server
exec "$ROOT/bin/setup-linux-common.sh" "$@"
