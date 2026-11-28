#!/bin/sh
# main-serverで認証仲介の `auth http` を呼ぶ中継。鍵はmoduleの中にだけあり、端末へは応答だけを返す。
# 使い方: factory-relay-http.sh <bughub-reporter|typesafe> <METHOD> </path[?query]>   本文は標準入力（JSON）。
# 呼び手の身元はこのclone（main-serverの/home/kite/Developer/dotagents）の作業folderで決まる。
set -eu
case "${1:-}" in bughub-reporter|typesafe) ;; *) echo 'unknown item' >&2; exit 2 ;; esac
case "${2:-}" in GET|POST) ;; *) echo 'unknown method' >&2; exit 2 ;; esac
case "${3:-}" in /*) ;; *) echo 'path must start with /' >&2; exit 2 ;; esac
cd "$(dirname -- "$0")/.."
exec "${DOTAGENTS_AUTH_CLIENT:-$HOME/.local/bin/auth}" http "$1" "$2" "$3" \
  -H 'content-type: application/json' -H "x-factory-sent-at: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --data-file -
