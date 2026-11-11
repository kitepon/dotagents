#!/usr/bin/env bash
# SSH鍵の受け入れ: 通る経路・公開鍵だけ（agent）・組を受け、鍵が無い時だけ従来どおり作る（1Passwordは任意）。
# shellcheck disable=SC2329,SC2317,SC2034,SC2016,SC2088 # sourceする製品関数がfixtureを消費する。~と$HOMEはremoteのliteral。SC2317は旧shellcheck用。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# Git BashはNTFS上のdirectoryの権限を変えられない。権限ではなく鍵の選び方を検査する。
case "$(uname -s)" in MINGW*|MSYS*) install() { mkdir -p "${@: -1}"; }; export -f install ;; esac

# rabbit側: ensure_main_server_ssh
awk '/^ensure_main_server_ssh\(\)/ { capture=1 } /^ensure_main_server_reverse_ssh\(\)/ { capture=0 } capture' \
  "$ROOT/bin/setup-linux-common.sh" >"$fixture/forward.sh"
# shellcheck source=/dev/null
source "$fixture/forward.sh"
HOST_PROFILE=linux
USER="${USER:-test}" # Git BashはUSERを持たない。
MAIN_SERVER_SSH_TARGET=kite@main-server.invalid
die() { printf '%s\n' "$*" >"$fixture/died"; exit 1; }
ssh() { [ "${route_ok:-0}" = 1 ]; }
ssh-keygen() { fail '鍵を生成した'; }

HOME="$fixture/home-route"; mkdir -p "$HOME"
(route_ok=1 ensure_main_server_ssh) || fail '通る経路を受け入れない'
[ ! -e "$HOME/.ssh/id_ed25519" ] && [ ! -e "$HOME/.ssh/id_ed25519.pub" ] || fail '通る経路で鍵fileを作った'

HOME="$fixture/home-pub"; mkdir -p "$HOME/.ssh"; echo 'ssh-ed25519 AAAA agent' >"$HOME/.ssh/id_ed25519.pub"
if (route_ok=0 ensure_main_server_ssh) </dev/null >/dev/null; then fail '未登録の公開鍵で成功した'; fi
grep -Fq '対話作業' "$fixture/died" || fail '公開鍵だけの時に登録の対話へ進まない'
[ ! -e "$HOME/.ssh/id_ed25519" ] || fail '公開鍵だけの時に秘密鍵を作った'

HOME="$fixture/home-none"; mkdir -p "$HOME"; rm -f "$fixture/died"
ssh-keygen() { : >"${*: -1}"; echo 'ssh-ed25519 AAAA generated' >"${*: -1}.pub"; }
if (route_ok=0 ensure_main_server_ssh) </dev/null >/dev/null; then fail '未登録の鍵で成功した'; fi
grep -Fq '対話作業' "$fixture/died" || fail '鍵を作った後に登録の対話へ進まない'
[ -e "$HOME/.ssh/id_ed25519" ] && [ -s "$HOME/.ssh/id_ed25519.pub" ] || fail '鍵も経路も無い時に従来どおり鍵を作らない'

# main-server側: rabbit専用鍵の準備（remote script）
awk '/^key="\$ssh_dir\/id_ed25519_rabbit"$/ { capture=1 } capture && /^REMOTE$/ { exit } capture' \
  "$ROOT/bin/setup-linux-common.sh" >"$fixture/remote-body.sh"
{ printf '%s\n' 'set -euo pipefail' 'ssh_dir="$HOME/.ssh"'; cat "$fixture/remote-body.sh"; } >"$fixture/remote.sh"
unset -f ssh-keygen
remote() { HOME="$1" bash "$fixture/remote.sh" 2>"$fixture/remote.err"; }

mkdir -p "$fixture/m-pub/.ssh"
command ssh-keygen -q -t ed25519 -N '' -C test -f "$fixture/key"
cp "$fixture/key.pub" "$fixture/m-pub/.ssh/id_ed25519_rabbit.pub"
out="$(remote "$fixture/m-pub")" || fail '公開鍵だけの形を受け入れない'
[[ "$out" == '~/.ssh/id_ed25519_rabbit.pub ssh-ed25519 '* ]] || fail "公開鍵だけの時にIdentityFileを公開鍵へ向けない: $out"
[ ! -e "$fixture/m-pub/.ssh/id_ed25519_rabbit" ] || fail '公開鍵だけの時に秘密鍵を作った'

mkdir -p "$fixture/m-pair/.ssh"
cp "$fixture/key" "$fixture/m-pair/.ssh/id_ed25519_rabbit"; cp "$fixture/key.pub" "$fixture/m-pair/.ssh/id_ed25519_rabbit.pub"
out="$(remote "$fixture/m-pair")" || fail '鍵の組を受け入れない'
[[ "$out" == '~/.ssh/id_ed25519_rabbit ssh-ed25519 '* ]] || fail "鍵の組でIdentityFileを秘密鍵へ向けない: $out"

mkdir -p "$fixture/m-none"
out="$(remote "$fixture/m-none")" || fail '鍵が無い時に従来どおり鍵の組を作らない'
[[ "$out" == '~/.ssh/id_ed25519_rabbit ssh-ed25519 '* ]] || fail "作った鍵の組でIdentityFileを秘密鍵へ向けない: $out"

mkdir -p "$fixture/m-private/.ssh"
cp "$fixture/key" "$fixture/m-private/.ssh/id_ed25519_rabbit"
if remote "$fixture/m-private" >/dev/null; then fail '秘密鍵だけの形を受け入れた'; fi

echo 'PASS: linux ssh keys'
