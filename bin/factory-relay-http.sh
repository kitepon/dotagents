#!/bin/sh
# main-serverで認証仲介の `auth http` を呼ぶ中継。鍵はmoduleの中にだけあり、端末へは応答だけを返す。
# 使い方: factory-relay-http.sh <bughub-reporter-HOST|typesafe> <METHOD> </path[?query]> [SENT_AT]   本文は標準入力（JSON）。
# SENT_AT（ISO UTC・ミリ秒）は端末が付けた送信時刻。BugHubは報告の作成時刻より前のsent_atを拒否するので、端末の時計の値をそのまま渡す（省略時はこの機械の現在時刻）。
# 呼び手の身元はこのclone（main-serverの/home/kite/Developer/dotagents）の作業folderで決まる。
set -eu
case "${1:-}" in bughub-reporter-[a-z0-9]*|typesafe) ;; *) echo 'unknown item' >&2; exit 2 ;; esac
case "${2:-}" in GET|POST) ;; *) echo 'unknown method' >&2; exit 2 ;; esac
case "${3:-}" in /*) ;; *) echo 'path must start with /' >&2; exit 2 ;; esac
case "${4:-}" in '') sent_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" ;; [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z) sent_at="$4" ;; *) echo 'bad sent_at' >&2; exit 2 ;; esac
cd "$(dirname -- "$0")/.."
exec "${DOTAGENTS_AUTH_CLIENT:-$HOME/.local/bin/auth}" http "$1" "$2" "$3" \
  -H 'content-type: application/json' -H "x-factory-sent-at: $sent_at" --data-file -
