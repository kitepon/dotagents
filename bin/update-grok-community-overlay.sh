#!/usr/bin/env bash
# 工場は接続だけを所有し、更新処理は各製品の正規入口へ委ねる。
set -euo pipefail

DESKTOP_ROOT="${GROK_COMMUNITY_DESKTOP:-$HOME/Developer/grok-build-vscode}"
AFK_ROOT="${GROK_COMMUNITY_AFK:-$HOME/Developer/afkpilot}"
PUSH_REQUESTED=false

usage() {
  cat <<'EOF'
update-grok-community-overlay — 両製品の正規更新入口を呼ぶ

  update-grok-community-overlay
  update-grok-community-overlay --push

環境変数:
  GROK_COMMUNITY_DESKTOP  既定: ~/Developer/grok-build-vscode
  GROK_COMMUNITY_AFK      既定: ~/Developer/afkpilot

更新・検証・pushの契約は、各repoの scripts/update-overlay.sh が所有する。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH_REQUESTED=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未対応の引数です: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

run_product_entrypoint() {
  local product_root="$1"
  local product_name="$2"
  local entrypoint="$product_root/scripts/update-overlay.sh"

  if [ ! -x "$entrypoint" ]; then
    echo "$product_name の正規更新入口がありません: $entrypoint" >&2
    exit 1
  fi

  echo "=== $product_name ==="
  if [ "$PUSH_REQUESTED" = true ]; then
    "$entrypoint" --push
  else
    "$entrypoint"
  fi
}

run_product_entrypoint "$DESKTOP_ROOT" "grok-build-desktop-kitepon"
run_product_entrypoint "$AFK_ROOT" "afkpilot-kitepon"
