#!/usr/bin/env bash
# Mac一撃展開の順序、冪等launchd、fresh delivery receiptを隔離fixtureで検証する。
set -euo pipefail

# Windows native（Git Bash/MSYS）には/usr/bin/gitが無く、POSIX固定PATHのfixtureが
# 成立しない。検証対象のmacOS展開自体がWindowsを対象にしないため明示SKIPする。
if [ "${OS:-}" = "Windows_NT" ]; then
  echo "SKIP: Windows nativeは対象外（POSIX PATH fixture不成立・検証対象はmacOS展開）"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$ROOT/bin/setup-macos-factory.sh"
[ -x "$SOURCE" ] || { echo "FAIL: Mac一撃展開スクリプトがない: $SOURCE" >&2; exit 1; }

FIXTURE="$(mktemp -d)"
HOME_DIR="$FIXTURE/home"
FIXTURE_ROOT="$FIXTURE/repo"
STUB_BIN="$FIXTURE/bin"
CALLS="$FIXTURE/calls.log"
LAUNCH_STATE="$FIXTURE/launch-state"
NODE_BIN="$(command -v node)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$HOME_DIR" "$FIXTURE_ROOT/bin" "$FIXTURE_ROOT/lib/factory" "$STUB_BIN"
cp "$SOURCE" "$FIXTURE_ROOT/bin/setup-macos-factory.sh"
cp "$ROOT/lib/factory/delivery-receipt.mjs" "$FIXTURE_ROOT/lib/factory/delivery-receipt.mjs"
cp "$ROOT/lib/factory/deployment-contract.mjs" "$FIXTURE_ROOT/lib/factory/deployment-contract.mjs"
chmod +x "$FIXTURE_ROOT/bin/setup-macos-factory.sh"
ln -s "$NODE_BIN" "$STUB_BIN/node"

fail() { echo "FAIL: $*" >&2; exit 1; }

cat >"$FIXTURE_ROOT/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
mkdir -p "$HOME/.local/bin"
ln -sfn "$DOTAGENTS_SETUP_TEST_ROOT/bin/setup-macos-factory.sh" "$HOME/.local/bin/setup-macos-factory"
ln -sfn "$DOTAGENTS_SETUP_TEST_ROOT/bin/agents-update.sh" "$HOME/.local/bin/agents-update"
ln -sfn "$DOTAGENTS_SETUP_TEST_ROOT/bin/factory-reporter-v8-schedule-runner" "$HOME/.local/bin/factory-reporter-v8-schedule-runner"
# uv tool 面だけ ~/.local/bin に置く。親 PATH に無い状態を再現する。
cat >"$HOME/.local/bin/markitdown" <<'MARKITDOWN'
#!/usr/bin/env bash
exit 0
MARKITDOWN
chmod +x "$HOME/.local/bin/markitdown"
EOF
cat >"$FIXTURE_ROOT/bin/apply-codex-config.sh" <<'EOF'
#!/usr/bin/env bash
printf 'apply-codex-config %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
mkdir -p "$HOME/.codex"
printf '{}\n' >"$HOME/.codex/hooks.json"
EOF
cat >"$FIXTURE_ROOT/bin/apply-claude-config.sh" <<'EOF'
#!/usr/bin/env bash
printf 'apply-claude-config %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$FIXTURE_ROOT/bin/apply-grok-config.sh" <<'EOF'
#!/usr/bin/env bash
printf 'apply-grok-config %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$FIXTURE_ROOT/bin/apply-cursor-config.sh" <<'EOF'
#!/usr/bin/env bash
printf 'apply-cursor-config %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$FIXTURE_ROOT/bin/verify-install.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-install %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
printf 'verify-install: OK\n'
EOF
cat >"$FIXTURE_ROOT/bin/factory-reporter-v8-schedule-runner" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$FIXTURE_ROOT/bin/install-unai.sh" <<'EOF'
#!/usr/bin/env bash
mkdir -p "$HOME/.local/bin"
printf 'install-unai\n' >>"$DOTAGENTS_SETUP_TEST_CALLS"
cat >"$HOME/.local/bin/unai" <<'UNAI'
#!/usr/bin/env bash
exit 0
UNAI
chmod +x "$HOME/.local/bin/unai"
EOF
cat >"$FIXTURE_ROOT/bin/agents-update.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="$HOME/.local/state/dotagents/factory-reporter-v8"
log_dir="$HOME/.local/state/agents-update"
mkdir -p "$state" "$log_dir"
sequence_file="$state/fixture-sequence"
sequence=0
[ ! -f "$sequence_file" ] || sequence="$(cat "$sequence_file")"
sequence=$((sequence + 1))
printf '%s\n' "$sequence" >"$sequence_file"
report_id="fixture-report-$sequence"
node - "$state/latest-report.json" "$report_id" <<'NODE'
const fs = require('fs');
const [output, reportId] = process.argv.slice(2);
const required = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector',
  'aiterm-mcp', 'codex-sidecar', 'aishell', 'peertable', 'unai',
  'claude-code', 'codex-cli',
];
const products = Object.fromEntries(required.map((id) => [id, {
  presence_status: 'installed', compatibility_status: 'compatible', checks: [],
}]));
products.servermanager = { presence_status: 'not_applicable', checks: [] };
products['grok-build'] = { presence_status: 'not_applicable', checks: [] };
if (process.env.DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT) {
  products[process.env.DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT].presence_status = 'missing';
}
fs.writeFileSync(output, `${JSON.stringify({
  schema_version: '8.0', report_id: reportId, host_profile: 'mac',
  platform: { os: 'darwin', arch: 'arm64' }, products,
})}\n`);
NODE
printf '{"schema":"dotagents.factory-delivery-receipt.v1","report_id":"%s","batch_token":"%s"}\n' \
  "$report_id" "$AGENTS_UPDATE_BATCH_TOKEN" >"$state/delivery-receipt.json"
{
  printf 'agents-update batch-token: %s\n' "$AGENTS_UPDATE_BATCH_TOKEN"
  printf 'agents-update end: fixture\n'
} >>"$log_dir/agents-update.log"
printf 'agents-update %s\n' "$AGENTS_UPDATE_BATCH_TOKEN" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
chmod +x "$FIXTURE_ROOT/install.sh" "$FIXTURE_ROOT/bin/"*

cat >"$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = info ]
EOF
cat >"$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
case "${1:-} ${2:-}" in
  'auth status'|'auth switch'|'auth setup-git') exit 0 ;;
  *) exit 1 ;;
esac
EOF
cat >"$STUB_BIN/sw_vers" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -productVersion ] && printf '15.6.1\n'
EOF
cat >"$STUB_BIN/plutil" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -lint ] && [ -f "${2:-}" ]
EOF
cat >"$STUB_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'launchctl %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
case "${1:-}" in
  print) [ -f "$DOTAGENTS_SETUP_TEST_LAUNCH_STATE" ] ;;
  bootstrap) printf 'loaded\n' >"$DOTAGENTS_SETUP_TEST_LAUNCH_STATE" ;;
  bootout) rm -f "$DOTAGENTS_SETUP_TEST_LAUNCH_STATE" ;;
  *) exit 1 ;;
esac
EOF
cat >"$STUB_BIN/lattice" <<'EOF'
#!/usr/bin/env bash
printf 'lattice %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$STUB_BIN/spotter" <<'EOF'
#!/usr/bin/env bash
printf 'spotter %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$STUB_BIN/caveat" <<'EOF'
#!/usr/bin/env bash
set -e
printf 'caveat %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
mkdir -p "$HOME/.caveat/own/.git"
EOF
cat >"$STUB_BIN/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="$HOME/.fixture-claude-mcp"
if [ "${1:-} ${2:-}" = 'mcp get' ]; then
  grep -Fqx "$3" "$state" 2>/dev/null || exit 1
  printf '%s:\n  Scope: User config\n  Status: ✔ Connected\n' "$3"
  if [ "$3" = aishell ]; then
    printf '  Type: stdio\n  Command: aishell-mcp\n  Args:\n  Environment:\n    AISHELL_CAPABILITY_SET=expanded-v1\n'
  fi
elif [ "${1:-} ${2:-}" = 'mcp remove' ]; then
  exit 0
elif [ "${1:-} ${2:-}" = 'mcp add' ]; then
  name=''
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --scope|--env) shift 2 ;;
      --) shift; break ;;
      *) name="$1"; shift ;;
    esac
  done
  printf '%s\n' "$name" >>"$state"
  printf 'claude-mcp-add %s %s\n' "$name" "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
else
  exit 0
fi
EOF
cat >"$STUB_BIN/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="$HOME/.fixture-codex-mcp"
commands="$state.commands"
envs="$state.envs"
if [ "${1:-} ${2:-}" = 'mcp get' ]; then
  grep -Fqx "$3" "$state" 2>/dev/null || exit 1
  command_name="$(awk -F= -v name="$3" '$1 == name { print $2 }' "$commands")"
  env_value="$(awk -F= -v name="$3" '$1 == name { print $2 }' "$envs" 2>/dev/null || true)"
  if [ -n "$env_value" ]; then
    printf '{"name":"%s","enabled":true,"transport":{"type":"stdio","command":"%s","args":[],"env":{"AISHELL_CAPABILITY_SET":"%s"}}}\n' "$3" "$command_name" "$env_value"
  else
    printf '{"name":"%s","enabled":true,"transport":{"type":"stdio","command":"%s","args":[],"env":{}}}\n' "$3" "$command_name"
  fi
elif [ "${1:-} ${2:-}" = 'mcp remove' ]; then
  exit 0
elif [ "${1:-} ${2:-}" = 'mcp add' ]; then
  shift 2
  name="$1"
  shift
  env_value=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env) env_value="${2#*=}"; shift 2 ;;
      --) shift; break ;;
      *) shift ;;
    esac
  done
  command_name="$1"
  printf '%s\n' "$name" >>"$state"
  printf '%s=%s\n' "$name" "$command_name" >>"$commands"
  [ -z "$env_value" ] || printf '%s=%s\n' "$name" "$env_value" >>"$envs"
  printf 'codex-mcp-add %s %s\n' "$name" "$command_name" >>"$DOTAGENTS_SETUP_TEST_CALLS"
else
  exit 0
fi
EOF
for command_name in npm uv gpt-connector aiterm-mcp codex-sidecar-mcp \
  peertable-client aishell-mcp; do
  cat >"$STUB_BIN/$command_name" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
done
cat >"$STUB_BIN/npm" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = prefix ] && [ "${2:-}" = -g ]; then
  CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd
fi
exit 0
EOF
cat >"$STUB_BIN/throughline" <<'EOF'
#!/usr/bin/env bash
printf 'throughline %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
chmod +x "$STUB_BIN/"*

mkdir -p "$HOME_DIR/.config/dotagents" "$HOME_DIR/Library/LaunchAgents"
printf '%s\n' '.fixture-user-ignore' >"$HOME_DIR/.gitignore_global"
printf '%s\n' '{"host":{"profile":"mac"},"reporting":{"enabled":true,"endpoint":"https://example.invalid/api/factory/v8/reports"}}' \
  >"$HOME_DIR/.config/dotagents/factory-reporter.json"
printf 'legacy launch agent\n' >"$HOME_DIR/Library/LaunchAgents/com.kite.agents-update.plist"
printf 'loaded\n' >"$LAUNCH_STATE"

export HOME="$HOME_DIR"
export PATH="$STUB_BIN:/usr/bin:/bin"
unset XAI_API_KEY
export DOTAGENTS_SETUP_MACOS_FORCE=1
export DOTAGENTS_SETUP_MACOS_ARCH=arm64
export DOTAGENTS_SETUP_TEST_CALLS="$CALLS"
export DOTAGENTS_SETUP_TEST_LAUNCH_STATE="$LAUNCH_STATE"
export DOTAGENTS_SETUP_TEST_ROOT="$FIXTURE_ROOT"

# shellcheck disable=SC2016 # setup側へ literal `$HOME` が書かれていることを検査する＝展開させない。
grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$SOURCE" \
  || fail 'setupが ~/.local/bin を PATH 先頭へ置かない'
grep -Fq "[ \"\$node_major\" -ge 24 ]" "$SOURCE" \
  || fail 'setupがNode.js 24契約を強制しない'
node - "$SOURCE" <<'NODE'
const source = require('fs').readFileSync(process.argv[2], 'utf8');
if (!(source.indexOf('ensure_toolchain_bootstrap') < source.indexOf('"$ROOT/bin/apply-codex-config.sh" --apply'))
  || !source.includes('npm install -g @openai/codex@latest')) process.exit(1);
NODE

"$FIXTURE_ROOT/bin/setup-macos-factory.sh"
"$FIXTURE_ROOT/bin/setup-macos-factory.sh"

[ "$(grep -Fxc '.fixture-user-ignore' "$HOME_DIR/.gitignore_global")" -eq 1 ] \
  || fail '既存global gitignoreを保持しない'
[ "$(grep -Fxc '.DS_Store' "$HOME_DIR/.gitignore_global")" -eq 1 ] \
  || fail '.DS_Storeを冪等に補完しない'
find "$HOME_DIR/Archives" -name 'com.kite.agents-update-pre-macos-setup-*' -type f | grep -q . \
  || fail '変更前LaunchAgentをbackupしない'
[ "$(grep -Fc 'launchctl bootout ' "$CALLS")" -eq 1 ] || fail '旧LaunchAgentの停止が一度でない'
[ "$(grep -Fc 'launchctl bootstrap ' "$CALLS")" -eq 1 ] || fail 'LaunchAgentの登録が一度でない'
python3 - "$HOME_DIR/Library/LaunchAgents/com.kite.agents-update.plist" "$HOME_DIR/.local/bin/agents-update" <<'PY'
import plistlib
import sys

with open(sys.argv[1], 'rb') as handle:
    value = plistlib.load(handle)
assert value['Label'] == 'com.kite.agents-update'
assert value['ProgramArguments'] == ['/bin/bash', sys.argv[2]]
assert value['StartCalendarInterval'] == {'Weekday': 1, 'Hour': 4, 'Minute': 0}
PY
grep -Fq 'apply-codex-config --apply' "$CALLS" || fail 'Codex設定を適用しない'
grep -Fq 'apply-claude-config --apply' "$CALLS" || fail 'Claude設定を適用しない'
if grep -Fq 'apply-grok-config' "$CALLS"; then
  fail 'Grok未loginでapply-grok-configを実行した'
fi
grep -Fq 'apply-cursor-config --apply' "$CALLS" || fail 'Cursor設定を適用しない'
if grep -Fq 'lattice hooks install --host grok' "$CALLS"; then
  fail 'lattice hooks install --host grok を呼んだ'
fi
grep -Fq 'install --profile official' "$CALLS" || fail 'official profileを展開しない'
grep -Fq 'install-unai' "$CALLS" || fail 'unai公式installer入口を実行しない'
grep -Fq 'caveat init' "$CALLS" || fail 'Caveat Claude initを導入しない'
grep -Fq 'caveat init </dev/null' "$ROOT/bin/setup-macos-factory.sh" || fail 'caveat init を非対話にしない'
grep -Fq 'gh auth switch --hostname github.com --user quolu' "$ROOT/bin/setup-macos-factory.sh" \
  || fail 'Caveat-Private同期前に工場ownerへ切り替えない'
grep -Fq 'gh auth setup-git' "$ROOT/bin/setup-macos-factory.sh" \
  || fail 'Caveat-Private同期前にGitHub HTTPS credential helperを配線しない'
grep -Fq 'caveat sync --init --repo https://github.com/quolu/Caveat-Private.git' "$ROOT/bin/setup-macos-factory.sh" \
  || fail 'Caveat-Privateの初回同期が公式HTTPS経路でない'
grep -Fq 'throughline install' "$CALLS" || fail 'Throughline製品管理hookを導入しない'
grep -Fq 'caveat codex-hook install' "$CALLS" || fail 'Caveat Codex hookを導入しない'
grep -Fq 'lattice hooks install --host claude' "$CALLS" || fail 'Claude Lattice hookを配線しない'
grep -Fq 'lattice hooks install --host codex' "$CALLS" || fail 'Codex Lattice hookを配線しない'
grep -Fq 'spotter install -y' "$CALLS" || fail 'Spotterを配線しない'
grep -Fq 'verify-install --profile official' "$CALLS" || fail '最終verifyを実行しない'
[ "$(grep -Fc 'claude-mcp-add aishell aishell-mcp' "$CALLS")" -eq 1 ] \
  || fail 'Claude AIShell MCPを一度だけ補完しない'
[ "$(grep -Fc 'codex-mcp-add aishell aishell-mcp' "$CALLS")" -eq 1 ] \
  || fail 'Codex AIShell MCPを一度だけ補完しない'
[ "$(grep -Fc 'agents-update ' "$CALLS")" -eq 2 ] || fail '各setup runでfresh updateを1回だけ実行しない'

latest_report="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report_id)' \
  "$HOME_DIR/.local/state/dotagents/factory-reporter-v8/latest-report.json")"
[ "$latest_report" = fixture-report-2 ] || fail '2回目のfresh reportが作られていない'

if DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT=peertable \
  "$FIXTURE_ROOT/bin/setup-macos-factory.sh" >/dev/null 2>&1; then
  fail 'Mac required製品欠落を成功扱いした'
fi

if "$FIXTURE_ROOT/bin/setup-macos-factory.sh" --unknown >/dev/null 2>&1; then
  fail '未知引数を受理した'
fi

echo 'setup-macos-factory install test: OK'
