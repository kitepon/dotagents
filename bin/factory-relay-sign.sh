#!/bin/sh
# main-serverで認証仲介の `auth sign` を呼ぶ中継。鍵はmoduleの中にだけあり、端末へは署名（base64）だけを返す。
# 使い方: factory-relay-sign.sh <bughub-product-dotagents-HOST>   署名する本文は標準入力。
# 呼び手の身元はこのclone（main-serverの/home/kite/Developer/dotagents）の作業folder。
set -eu
case "${1:-}" in bughub-product-dotagents-[a-z0-9]*) ;; *) echo 'unknown item' >&2; exit 2 ;; esac
cd "$(dirname -- "$0")/.."
exec "${DOTAGENTS_AUTH_CLIENT:-$HOME/.local/bin/auth}" sign "$1"
