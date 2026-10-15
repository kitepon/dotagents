#!/usr/bin/env bash
# runnerの公開応答だけを置き換え、GitHubへ書き込まず再設定条件を検証する。
# shellcheck disable=SC2329,SC2317,SC2034 # sourceする製品関数がfixtureを消費する。SC2317は旧shellcheck用。
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

# serverのsetupは停止済みのrunnerへ触れない（登録・起動・online確認をしない）。
awk '/^ensure_github_actions_runner\(\)/ { capture=1 } /^linux_root_prerequisites_ready\(\)/ { capture=0 } capture' \
  "$ROOT/bin/setup-linux-common.sh" >"$fixture/ensure.sh"
# shellcheck disable=SC1091 # 検査対象の実関数。
source "$fixture/ensure.sh"
gh() { printf 'gh %s\n' "$*" >>"$fixture/server-calls"; }
sudo() { printf 'sudo %s\n' "$*" >>"$fixture/server-calls"; }
(
  unset ACTIONS_RUNNER_ROOT ACTIONS_RUNNER_NAME ACTIONS_RUNNER_LABEL DOTAGENTS_SETUP_SKIP_ACTIONS_RUNNER
  HOST_PROFILE=server
  ensure_github_actions_runner
) || { echo 'FAIL: server setupのrunner工程が失敗した' >&2; exit 1; }
[ ! -e "$fixture/server-calls" ] || { echo 'FAIL: server setupが停止済みのrunnerを操作した' >&2; cat "$fixture/server-calls" >&2; exit 1; }

# 移行済みのworkstationでsetupを再実行しても、旧利用者のrunnerを起こさない。
dedicated_runner_profile() {
  printf '{"mode":"dedicated","name":"factory-linux-rabbit-u","service":"actions.runner.kitepon.factory-linux-rabbit-u.service","user":"factory-runner"}\n'
}
verify_org_runner_online() { printf 'verify %s\n' "$*" >>"$fixture/dedicated-calls"; }
id() { printf '%s\n' "${fixture_groups:-factory-runner}"; }
systemctl() {
  printf 'systemctl %s\n' "$*" >>"$fixture/dedicated-calls"
  case "$*" in
    *--property=User*) printf '%s\n' "${fixture_service_user:-factory-runner}" ;;
    *--property=Group*) printf '%s\n' factory-runner ;;
    *--property=NoNewPrivileges*) printf '%s\n' yes ;;
    *--property=CapabilityBoundingSet*)
      [ "${fixture_cap_read_error:-0}" != 1 ] || return 1
      printf '%s' "${fixture_capabilities:-}" ;;
    is-active*) [ "${fixture_service_stopped:-0}" != 1 ] ;;
    *) echo 'FAIL: 専用runnerへの変更命令' >&2; return 1 ;;
  esac
}
(
  HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation
  unset ACTIONS_RUNNER_ROOT ACTIONS_RUNNER_NAME DOTAGENTS_SETUP_SKIP_ACTIONS_RUNNER
  ensure_github_actions_runner
)
grep -Fq 'verify factory-linux-rabbit-u linux-workstation' "$fixture/dedicated-calls"
[ ! -e "$fixture/server-calls" ] || { echo 'FAIL: 専用runnerの確認でgh/sudoによる変更を行った' >&2; exit 1; }
if (HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation fixture_service_user=kite ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: 旧利用者のserviceを許容した' >&2; exit 1
fi
if (HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation fixture_service_stopped=1 ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: 停止中の専用runnerを許容した' >&2; exit 1
fi
if (HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation fixture_groups='factory-runner sudo' ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: 管理者の群に属する専用runnerを許容した' >&2; exit 1
fi
if (HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation fixture_capabilities=cap_sys_admin ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: capabilityの残る専用runnerを許容した' >&2; exit 1
fi
if (HOST_PROFILE=linux ACTIONS_RUNNER_LABEL=linux-workstation fixture_cap_read_error=1 ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: capabilityを読めないのに許容した' >&2; exit 1
fi
dedicated_runner_profile() { return 1; }
if (HOST_PROFILE=linux ensure_github_actions_runner) 2>"$fixture/dedicated-error"; then
  echo 'FAIL: 不正な専用profileから旧runnerへ戻した' >&2; exit 1
fi
[ ! -e "$fixture/server-calls" ] || { echo 'FAIL: 不正なprofileから旧runnerを操作した' >&2; exit 1; }
echo 'linux-runner-registration: OK（再設定条件・API失敗・server非操作・専用runnerの再作成防止）'
