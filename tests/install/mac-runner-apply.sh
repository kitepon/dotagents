#!/usr/bin/env bash
# Mac apply, steps 3-4b against stubs (nothing touches the host): the listener recycle must call BSD-style `pkill -INT -u ...`
# (signal first) and surface real errors; the bootstrap after bootout must wait for the label to vanish, retry, and fail loudly.
# Origin: Trina's 2026-11-22 Mac install of 52d949d0 (pkill "illegal option -- N" hidden by `|| true`; bootstrap rc=5 after bootout).
# shellcheck disable=SC2329,SC2317,SC2034,SC2154 # sourceするapply処理がfixtureの関数と変数を消費する。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$ROOT/bin/mac-factory-runner-pool.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
awk '/^recycle_pending=/ { capture=1 } /^# 5\. Readback/ { capture=0 } capture' "$script" >"$fixture/recycle.sh"
awk '/^launchctl bootout "system\/\$LABEL"/ { capture=1 } /^# 4b\./ { capture=0 } capture' "$script" >"$fixture/bootstrap.sh"
[ -s "$fixture/recycle.sh" ] && [ -s "$fixture/bootstrap.sh" ] || { echo 'FAIL: apply処理が見つかりません' >&2; exit 1; }

recycle() { # name; env: worker (1 = a Runner.Worker runs), pkill_rc
  local calls="$fixture/$1.calls"; : >"$calls"
  (
    RUNNER_USER=factory-runner
    pgrep() { [ "${worker:-0}" = 1 ]; }
    # BSD pkill: the signal must be the first argument.
    pkill() {
      printf 'pkill %s\n' "$*" >>"$calls"
      case "$1" in -INT) return "${pkill_rc:-0}" ;; *) echo "pkill: illegal option -- ${1#-?}" >&2; return 2 ;; esac
    }
    # shellcheck disable=SC1091 # 検査対象から取り出した実処理。
    source "$fixture/recycle.sh"
    echo "pending=${recycle_pending}" >>"$calls"
  )
}
recycle ok
grep -Fxq 'pkill -INT -u factory-runner -x Runner.Listener' "$fixture/ok.calls" || { echo 'FAIL: pkillのargvが違う' >&2; cat "$fixture/ok.calls" >&2; exit 1; }
grep -Fxq 'pending=' "$fixture/ok.calls"
pkill_rc=1 recycle nomatch   # no listener running is fine
rc=0; (pkill_rc=2 recycle broken) 2>"$fixture/broken.err" || rc=$?
if [ "$rc" -ne 1 ] || ! grep -Fq 'pkill Runner.Listener failed (2)' "$fixture/broken.err"; then echo 'FAIL: pkillの実エラーを握りつぶした' >&2; exit 1; fi
worker=1 recycle busy
! grep -q '^pkill' "$fixture/busy.calls" || { echo 'FAIL: Worker実行中にlistenerを止めた' >&2; exit 1; }
grep -Fxq 'pending=1' "$fixture/busy.calls"

bootstrap() { # name; env: still_up (print succeeds this many times), fail_first (bootstrap fails this many times)
  local calls="$fixture/$1.calls"; : >"$calls"; echo 0 >"$fixture/$1.up"; echo 0 >"$fixture/$1.tries"
  (
    LABEL=com.kitepon.factory-runner-scaler PLIST="$fixture/plist"
    sleep() { :; }
    mv() { printf 'mv\n' >>"$calls"; }
    launchctl() {
      printf 'launchctl %s\n' "$1" >>"$calls"
      case "$1" in
        bootout) return 0 ;;
        print) local n; n=$(<"$fixture/$name.up"); echo $((n + 1)) >"$fixture/$name.up"; [ "$n" -lt "${still_up:-0}" ] ;;
        bootstrap) local t; t=$(<"$fixture/$name.tries"); echo $((t + 1)) >"$fixture/$name.tries"; [ "$t" -ge "${fail_first:-0}" ] || { echo 'Bootstrap failed: 5: Input/output error' >&2; return 5; } ;;
      esac
    }
    name="$1"
    # shellcheck disable=SC1091 # 検査対象から取り出した実処理。
    source "$fixture/bootstrap.sh"
  ) 2>>"$fixture/$1.err"
}
bootstrap plain
still_up=3 bootstrap waits
[ "$(grep -c 'launchctl print' "$fixture/waits.calls")" -eq 4 ] || { echo 'FAIL: bootout後に消えるまで待たない' >&2; exit 1; }
fail_first=2 bootstrap retries
[ "$(grep -c 'launchctl bootstrap' "$fixture/retries.calls")" -eq 3 ]
rc=0; fail_first=99 bootstrap loud || rc=$?
if [ "$rc" -ne 1 ] || [ "$(grep -c 'launchctl bootstrap' "$fixture/loud.calls")" -ne 5 ] || ! grep -Fq 'failed after 5 tries' "$fixture/loud.err"; then
  echo 'FAIL: bootstrapの失敗が大声で終わらない' >&2; exit 1
fi
# A label that never goes away still ends: the wait is bounded (30 looks), then bootstrap is tried and reported.
rc=0; still_up=999 fail_first=99 bootstrap stuck || rc=$?
[ "$rc" -eq 1 ] && [ "$(grep -c 'launchctl print' "$fixture/stuck.calls")" -eq 30 ]
echo 'mac-runner-apply: OK（pkillは信号が先・実エラーは失敗・bootout後は消えるまで待ち、再試行し、最後は失敗）'
