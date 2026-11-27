#!/bin/sh
# main-serverの呼び手が、端末のreporter credential fileへBugHubのtokenを置く（認証仲介の `auth exec` の子として走る）。
# 使い方: auth exec sh <このfile> <rabbit|mac-kite|fox|main-server>   tokenは環境変数DOTAGENTS_REPORTER_TOKENで受け、sshの標準入力でだけ渡す。
set -eu
host="${1:-}"
[ -n "${DOTAGENTS_REPORTER_TOKEN:-}" ] || { echo 'DOTAGENTS_REPORTER_TOKEN is empty' >&2; exit 2; }
# shortcut: 端末ごとのssh名と遠隔shellをここへ固定、端末が増えたらこのcaseへ足す。
case "$host" in
  rabbit) target=rabbit; remote='bash -lc '"'"'node "$HOME/.local/bin/factory-reporter-credential-store"'"'" ;;
  mac-kite) target=macbook; remote='bash -lc '"'"'node "$HOME/.local/bin/factory-reporter-credential-store"'"'" ;;
  fox) target=fox; remote='node $HOME/.local/bin/factory-reporter-credential-store' ;;
  main-server) printf %s "$DOTAGENTS_REPORTER_TOKEN" | bash -lc 'exec node "$1"' _ "$(dirname -- "$0")/factory-reporter-credential-store.mjs"; exit $? ;;
  *) echo 'usage: factory-reporter-credential-push.sh rabbit|mac-kite|fox|main-server' >&2; exit 2 ;;
esac
printf %s "$DOTAGENTS_REPORTER_TOKEN" | exec ssh -o BatchMode=yes -o ConnectTimeout=15 "$target" "$remote"
