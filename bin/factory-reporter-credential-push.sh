#!/bin/sh
# main-serverの呼び手が、端末へtokenを置く（認証仲介の `auth exec` の子として走る）。tokenはsshの標準入力でだけ渡す（argv・端末の環境へ出さない）。
# BugHub reporter: auth exec sh <このfile> <rabbit|mac-kite|fox|main-server>              tokenは環境変数DOTAGENTS_REPORTER_TOKEN
# TypeSafe(api.env): auth exec sh <このfile> typesafe -- <rabbit|mac-kite|fox|main-server>  tokenは環境変数TYPESAFE_API_KEY、端末は`--`の後ろ
set -eu
flag=''
if [ "${1:-}" = typesafe ]; then flag=--typesafe; token="${TYPESAFE_API_KEY:-}"; shift; else token="${DOTAGENTS_REPORTER_TOKEN:-}"; fi
host="${1:-}"
[ -n "$token" ] || { echo 'token variable is empty' >&2; exit 2; }
# shortcut: 端末ごとのssh名と遠隔shellをここへ固定、端末が増えたらこのcaseへ足す。
case "$host" in
  rabbit) target=rabbit; remote="bash -lc 'node \"\$HOME/.local/bin/factory-reporter-credential-store\" $flag'" ;;
  mac-kite) target=macbook; remote="bash -lc 'node \"\$HOME/.local/bin/factory-reporter-credential-store\" $flag'" ;;
  fox) target=fox; remote="node \$HOME/.local/bin/factory-reporter-credential-store $flag" ;;
  main-server) printf %s "$token" | bash -lc 'exec node "$1" $2' _ "$(dirname -- "$0")/factory-reporter-credential-store.mjs" "$flag"; exit $? ;;
  *) echo 'usage: factory-reporter-credential-push.sh [typesafe --] rabbit|mac-kite|fox|main-server' >&2; exit 2 ;;
esac
printf %s "$token" | exec ssh -o BatchMode=yes -o ConnectTimeout=15 "$target" "$remote"
