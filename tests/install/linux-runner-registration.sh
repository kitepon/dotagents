#!/usr/bin/env bash
# runnerの公開応答だけを置き換え、GitHubへ書き込まず再設定条件を検証する。
# shellcheck disable=SC2329,SC2034 # sourceする製品関数がfixtureを消費する。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
awk '/^org_runner_id\(\)|^org_runner_record\(\)/ { capture=1 } /^ensure_github_actions_runner\(\)/ { capture=0 } capture' \
  "$ROOT/bin/setup-linux-common.sh" >"$fixture/runner.sh"
die() { echo "FAIL: $*" >&2; exit 1; }
sleep() { echo 'FAIL: APIエラー時に待機した' >&2; return 1; }
gh() {
  if [[ "$*" = *'--method PUT'* ]]; then
    printf '%s\n' "$*" >>"$fixture/writes"
    cat >/dev/null
    return 0
  fi
  if [ "${api_failure:-0}" = 1 ]; then echo 'HTTP 403: admin:orgが必要' >&2; return 1; fi
  printf '{"runners":[{"id":7,"name":"factory-linux-main","status":"online","labels":[{"name":"factory"},{"name":"%s"}]}]}\n' "$fixture_label"
}
# shellcheck disable=SC1091 # 検査対象の実関数。
source "$fixture/runner.sh"
fixture_label=linux-server
set_org_runner_labels factory-linux-main linux-server
[ ! -e "$fixture/writes" ] || { echo 'FAIL: 同じlabelを再設定した' >&2; exit 1; }
fixture_label=linux-native
set_org_runner_labels factory-linux-main linux-server
[ "$(wc -l <"$fixture/writes")" -eq 1 ]
api_failure=1
if (set_org_runner_labels factory-linux-main linux-server) 2>"$fixture/error"; then
  echo 'FAIL: API失敗を成功扱いした' >&2; exit 1
fi
if (verify_org_runner_online factory-linux-main linux-server) 2>"$fixture/verify-error"; then
  echo 'FAIL: 状態照会のAPI失敗を成功扱いした' >&2; exit 1
fi
grep -Fq 'HTTP 403' "$fixture/verify-error"
if grep -Fq '待機した' "$fixture/verify-error"; then cat "$fixture/verify-error" >&2; exit 1; fi
grep -Fq 'HTTP 403' "$fixture/error"
if grep -Eq 'TypeError|SyntaxError' "$fixture/error"; then
  cat "$fixture/error" >&2; exit 1
fi
echo 'linux-runner-registration: OK（再設定条件・API失敗）'
