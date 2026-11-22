#!/usr/bin/env bash
# Mac scaler LaunchDaemon: jobs run under umask 022 (Umask 18), as on GitHub-hosted runners (docs/feature-map/runner-capacity.md).
# shellcheck disable=SC2016 # grepが探す文字列は$RUNNER_USERを展開させない
# Roots stay private because the apply creates them under an explicit `umask 077`, not through the daemon's umask.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$ROOT/bin/mac-factory-runner-pool.sh"
plist="$(awk '/^<\?xml/ { capture=1 } capture { print } /^<\/plist>/ { capture=0 }' "$script")"
[ -n "$plist" ] || { echo 'FAIL: LaunchDaemon plistが見つかりません' >&2; exit 1; }
grep -Fq '<key>Umask</key><integer>18</integer>' <<<"$plist" || { echo 'FAIL: Umask 18 (022) ではない' >&2; exit 1; }
[ "$(grep -c '<key>Umask</key>' <<<"$plist")" -eq 1 ] || { echo 'FAIL: Umaskが複数' >&2; exit 1; }
grep -Fq "umask 077 && mkdir -p" "$script" || { echo 'FAIL: pool rootの明示umask 077が消えた' >&2; exit 1; }
# Listeners started under the old umask are recycled only while no Worker runs.
recycle="$(awk '/^recycle_pending=/ { capture=1 } /^# 5\. Readback/ { capture=0 } capture' "$script")"
grep -Fq 'pgrep -u "$RUNNER_USER" -x Runner.Worker' <<<"$recycle"
grep -Fq 'else' <<<"$recycle"
grep -Fq 'pkill -u "$RUNNER_USER" -INT -x Runner.Listener' <<<"$recycle"
[ "$(grep -n 'pgrep' <<<"$recycle" | head -1 | cut -d: -f1)" -lt "$(grep -n 'pkill' <<<"$recycle" | head -1 | cut -d: -f1)" ]
echo 'mac-runner-umask: OK（Umask 022・pool rootは明示077・Workerが居ない時だけlistener再起動）'
