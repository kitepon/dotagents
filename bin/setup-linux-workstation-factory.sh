#!/usr/bin/env bash
# native Linux workstation向け一撃展開入口。rabbitをlinux profileとして配備する。
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
while [ -L "$script_source" ]; do
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  script_source="$(readlink "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_dir/$script_source" ;; esac
done
ROOT="$(cd "$(dirname "$script_source")/.." && pwd)"

if [ "${DOTAGENTS_SETUP_SKIP_REPO_RELOCATION:-0}" != 1 ]; then
  canonical_root="$HOME/Developer/dotagent"
  if [ "$ROOT" != "$canonical_root" ]; then
    [ "$ROOT" = "$HOME/Developer/dotagents" ] \
      || { echo "FAIL: dotagents cloneが正規pathでない: $ROOT" >&2; exit 1; }
    [ ! -e "$canonical_root" ] \
      || { echo "FAIL: 正規pathが既に存在する: $canonical_root" >&2; exit 1; }
    echo "INFO: dotagents cloneを正規pathへ移動します: $ROOT -> $canonical_root"
    mkdir -p "$(dirname "$canonical_root")"
    mv "$ROOT" "$canonical_root"
    exec "$canonical_root/bin/setup-linux-workstation-factory.sh" "$@"
  fi
fi

export DOTAGENTS_SETUP_VARIANT=linux
exec "$ROOT/bin/setup-linux-common.sh" "$@"
