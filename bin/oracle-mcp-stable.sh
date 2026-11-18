#!/usr/bin/env bash
# oracle-mcp を Node undici の setTypeOfService EINVAL クラッシュから守るラッパー。
# 根本原因: undici が全 HTTP/1.1 リクエストで socket.setTypeOfService(0) を無条件に呼び、
# macOS で特定ソケット状態だと EINVAL が未捕捉例外となりプロセスごと死ぬ
# (Node 24.18/26.4 で実測・oracle 0.15.2 の MCP/CLI 両方が被弾)。
# これは upstream(undici) 修正までの明示的・一時的ガード。発動時は stderr に1回記録する。
# 使い方: oracle-mcp-stable        → MCP サーバー起動（claude mcp 登録用）
#         oracle-mcp-stable cli …  → oracle CLI をガード付きで起動（保守用）
set -euo pipefail

normalize_path() {
  case "$1" in
    [A-Za-z]:\\* | [A-Za-z]:/*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -u "$1"
      else
        printf '%s\n' "$1"
      fi
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}

NODE_BIN="${ORACLE_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  printf 'FATAL: node が PATH にない\n' >&2
  exit 1
fi

if [ -z "${ORACLE_DIST:-}" ]; then
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [ -z "$npm_root" ]; then
    printf 'FATAL: npm global root を解決できない\n' >&2
    exit 1
  fi
  npm_root="$(normalize_path "$npm_root")"
  ORACLE_DIST="$npm_root/@steipete/oracle/dist/bin"
fi
# shellcheck disable=SC2016  # JS テンプレートリテラル(${e.code})を含む＝シェル展開させない意図の single quote
GUARD='data:text/javascript,
import net from "node:net";
const orig = net.Socket.prototype.setTypeOfService;
if (orig) {
  let warned = false;
  net.Socket.prototype.setTypeOfService = function (v) {
    try { return orig.call(this, v); } catch (e) {
      if (!warned) { warned = true; console.error(`[oracle-mcp-stable] setTypeOfService guard: ${e.code} を無害化 (undici QoS ヒント)`); }
      return this;
    }
  };
}'

ENTRY="$ORACLE_DIST/oracle-mcp.js"
if [ "${1:-}" = "cli" ]; then
  ENTRY="$ORACLE_DIST/oracle-cli.js"
  shift
fi

if [ ! -f "$ENTRY" ]; then
  printf 'FATAL: Oracle entry がない: %s\n' "$ENTRY" >&2
  exit 1
fi

# ChromeはOracle rollback互換shim経由で起動。hideWindowは送信を壊し、固定負座標も
# 複数displayでは非可視を保証しないため、通常運用の入口は無い（gpt-connectorは2026-11-18に廃止）。
export CHROME_PATH="${CHROME_PATH:-$HOME/.local/bin/oracle-chrome-shim}"

exec "$NODE_BIN" --import "$GUARD" "$ENTRY" "$@"
