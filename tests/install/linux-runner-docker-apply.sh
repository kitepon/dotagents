#!/usr/bin/env bash
# Rabbit rootless-Docker apply, step 1 (Engine choice + package precheck) against stubs: the real script block runs, apt/dpkg/sudo
# are fixtures. Nothing touches the host. Contract: docs/feature-map/runner-capacity.md ("Rootless Docker").
# shellcheck disable=SC2329,SC2317,SC2034,SC2154 # sourceするapply処理がfixtureの関数と変数を消費する。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
awk '/^# 1\. Engine and packages/ { capture=1 } /^# 2\. subuid/ { capture=0 } capture' "$ROOT/bin/linux-factory-runner-docker.sh" >"$fixture/step1.sh"
[ -s "$fixture/step1.sh" ] || { echo 'FAIL: step 1が見つかりません' >&2; exit 1; }
mkdir -p "$fixture/bin"
printf '#!/bin/sh\n' >"$fixture/bin/rootlesskit"; chmod +x "$fixture/bin/rootlesskit"
printf '#!/bin/sh\n' >"$fixture/ce"; printf '#!/bin/sh\n' >"$fixture/io"; chmod +x "$fixture/ce" "$fixture/io"

run_case() { # name; env: installed, nocandidate, no_binfmt_pkg, launcher_io
  local name="$1" calls="$fixture/$1.calls"
  : >"$calls"
  (
    HELPER="$ROOT/bin/factory-runner-docker.mjs"
    PATH="$fixture/bin:$PATH"
    dpkg_ok() { [[ " $installed " == *" $1 "* ]]; }
    dpkg-query() { printf '5:29.0.0-1\n'; }
    node() { if [ "${2:-}" = scripts ]; then printf 'docker-ce\t%s\ndocker.io\t%s\n' "$fixture/ce" "${launcher_io:-$fixture/io}"; else command node "$@"; fi; }
    apt-cache() {
      case "$1" in
        show) [ "${no_binfmt_pkg:-0}" != 1 ] ;;
        policy) printf '%s:\n  Installed: (none)\n  Candidate: %s\n' "$2" "$([[ " ${nocandidate:-} " == *" $2 "* ]] && echo '(none)' || echo 1.0)" ;;
      esac
    }
    sudo() { printf '%s\n' "$*" >>"$calls"; }
    # shellcheck disable=SC1091 # 検査対象から取り出した実処理。
    source "$fixture/step1.sh"
    printf 'engine=%s launcher=%s\n' "$engine" "$launcher" >>"$calls"
  ) 2>"$fixture/$name.err"
}
expect_fail() { # name, message fragment: refused with exit 2, names the piece, and nothing but the index refresh ran
  local name="$1" rc=0
  run_case "$name" || rc=$?
  [ "$rc" -eq 2 ] || { echo "FAIL: $name: exit $rc (2を期待)" >&2; exit 1; }
  grep -Fq -- "$2" "$fixture/$name.err" || { echo "FAIL: $name: '$2'が出ない" >&2; cat "$fixture/$name.err" >&2; exit 1; }
  if grep -Fq 'apt-get install' "$fixture/$name.calls"; then echo "FAIL: $name: 失敗前にinstallした" >&2; exit 1; fi
}
expect_install() { # name, install line
  run_case "$1"
  grep -Fxq -- "-n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-remove $2" "$fixture/$1.calls" \
    || { echo "FAIL: $1: install行が違う" >&2; cat "$fixture/$1.calls" >&2; exit 1; }
}

# Ubuntu docker.io: Ubuntu's own rootlesskit and docker-buildx, launcher from /usr/share/docker.io/contrib.
installed='docker.io uidmap' expect_install io-fresh 'slirp4netns qemu-user-binfmt rootlesskit docker-buildx'
grep -Fxq "engine=docker.io launcher=$fixture/io" "$fixture/io-fresh.calls"
# Everything already there: no apt call at all.
installed='docker.io uidmap slirp4netns qemu-user-binfmt rootlesskit docker-buildx'; run_case io-done
! grep -Fq 'apt-get' "$fixture/io-done.calls" || { echo 'FAIL: 揃っているのにaptを呼んだ' >&2; exit 1; }
# Older Ubuntu: a real qemu-user-static package, a docker-buildx-plugin counts as buildx.
installed='docker.io uidmap slirp4netns rootlesskit docker-buildx-plugin' no_binfmt_pkg=1 expect_install io-old 'qemu-user-static'
# docker-ce keeps its path: extras pinned to the Engine's version.
installed='docker-ce uidmap slirp4netns qemu-user-static' expect_install ce 'docker-ce-rootless-extras=5:29.0.0-1'
grep -Fxq "engine=docker-ce launcher=$fixture/ce" "$fixture/ce.calls"
# Missing pieces are named before any change; the index is refreshed once, then the second look is final.
installed='docker.io uidmap' nocandidate='docker-buildx' expect_fail io-nobuildx 'docker-buildx'
[ "$(grep -c 'apt-get update' "$fixture/io-nobuildx.calls")" -eq 1 ]
installed='docker.io uidmap' nocandidate='rootlesskit slirp4netns' expect_fail io-norootlesskit 'slirp4netns rootlesskit'
installed='docker.io uidmap slirp4netns qemu-user-binfmt rootlesskit docker-buildx' launcher_io="$fixture/absent" expect_fail io-nolauncher 'does not ship'
installed='uidmap' expect_fail none 'neither docker-ce nor docker.io'
# Listener recycle: signal first, no match is fine, a real pkill error fails, a running Worker stops it before any signal.
awk '/^recycle_listeners\(\)/ { capture=1 } capture { print } capture && /^}/ { capture=0 }' "$ROOT/bin/linux-factory-runner-docker.sh" >"$fixture/recycle.sh"
[ -s "$fixture/recycle.sh" ] || { echo 'FAIL: recycle_listenersが見つかりません' >&2; exit 1; }
recycle() { # name; env: worker, pkill_rc
  local calls="$fixture/$1.calls"; : >"$calls"
  (
    RUNNER_USER=factory-runner
    workers_running() { [ "${worker:-0}" = 1 ]; }
    sudo() { shift; "$@"; }
    pkill() { printf 'pkill %s\n' "$*" >>"$calls"; case "$1" in -INT) return "${pkill_rc:-0}" ;; *) echo "pkill: invalid option" >&2; return 2 ;; esac; }
    # shellcheck disable=SC1091 # 検査対象から取り出した実処理。
    source "$fixture/recycle.sh"
    recycle_listeners
  ) 2>"$fixture/$1.err"
}
recycle r-ok
grep -Fxq 'pkill -INT -u factory-runner -x Runner.Listener' "$fixture/r-ok.calls"
pkill_rc=1 recycle r-nomatch
rc=0; pkill_rc=2 recycle r-broken || rc=$?
[ "$rc" -eq 1 ] || { echo 'FAIL: pkillの実エラーを握りつぶした' >&2; exit 1; }
rc=0; worker=1 recycle r-busy || rc=$?
[ "$rc" -eq 3 ] && [ ! -s "$fixture/r-busy.calls" ] || { echo 'FAIL: Worker実行中にlistenerへ信号を送った' >&2; exit 1; }
echo 'linux-runner-docker-apply: OK（docker.io/docker-ceの選択・Ubuntu archiveの部品・欠品は名指しで変更前に停止）'
