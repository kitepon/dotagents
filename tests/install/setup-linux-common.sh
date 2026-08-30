#!/usr/bin/env bash
# native Linux共通一撃展開の順序、冪等cron、fresh delivery receiptを隔離fixtureで検証する。
set -euo pipefail

# Windows native（Git Bash/MSYS）には/usr/bin/gitが無く、POSIX固定PATHのfixtureが
# 成立しない。検証対象のnative Linux展開自体がWindows nativeを対象にしないため明示SKIPする。
if [ "${OS:-}" = "Windows_NT" ]; then
  echo "SKIP: Windows nativeは対象外（POSIX PATH fixture不成立・検証対象はnative Linux展開）"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_VARIANT="${DOTAGENTS_SETUP_TEST_VARIANT:-linux}"
case "$SETUP_VARIANT" in
  server) SETUP_COMMAND=setup-linux-factory; HOST_PROFILE=server; CRON_SUFFIX=linux ;;
  linux) SETUP_COMMAND=setup-linux-workstation-factory; HOST_PROFILE=linux; CRON_SUFFIX=linux-workstation ;;
  *) echo "FAIL: 未対応のtest variant: $SETUP_VARIANT" >&2; exit 1 ;;
esac
export SETUP_COMMAND
export CRON_SUFFIX
SOURCE="$ROOT/bin/$SETUP_COMMAND.sh"
[ -x "$SOURCE" ] || { echo "FAIL: $SETUP_VARIANT一撃展開スクリプトがない: $SOURCE" >&2; exit 1; }

FIXTURE="$(mktemp -d)"
HOME_DIR="$FIXTURE/home"
FIXTURE_ROOT="$FIXTURE/repo"
STUB_BIN="$FIXTURE/bin"
CALLS="$FIXTURE/calls.log"
CRONTAB="$FIXTURE/crontab"
NODE_BIN="$(command -v node)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$HOME_DIR" "$FIXTURE_ROOT/bin" "$FIXTURE_ROOT/lib/factory" "$STUB_BIN"
cp "$ROOT/bin/setup-linux-common.sh" "$FIXTURE_ROOT/bin/setup-linux-common.sh"
cp "$SOURCE" "$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh"
cp "$ROOT/lib/factory/delivery-receipt.mjs" "$FIXTURE_ROOT/lib/factory/delivery-receipt.mjs"
cp "$ROOT/lib/factory/deployment-contract.mjs" "$FIXTURE_ROOT/lib/factory/deployment-contract.mjs"
chmod +x "$FIXTURE_ROOT/bin/setup-linux-common.sh" "$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh"
ln -s "$NODE_BIN" "$STUB_BIN/node"

# 中断された caveat init が残す公式scaffoldを再現する。setupは内容一致を確認し、
# backupしてからsync --initを先行させなければならない。
mkdir -p "$HOME_DIR/.caveat/own/entries"
cat >"$HOME_DIR/.caveat/own/.gitignore" <<'EOF'
# Private entries DO sync to your private remote (Caveat-Private) — that is the
# intended sharing boundary. The public boundary is enforced by `caveat publish`.

# Obsidian per-user config: workspace layout, theme, plugin state, cache.
.obsidian/

# Editor / OS scratch files that should never sync.
.DS_Store
*.swp
*~
EOF

fail() { echo "FAIL: $*" >&2; exit 1; }

cat >"$FIXTURE_ROOT/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
mkdir -p "$HOME/.local/bin"
ln -sfn "$DOTAGENTS_SETUP_TEST_ROOT/bin/$SETUP_COMMAND.sh" "$HOME/.local/bin/$SETUP_COMMAND"
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
  'aiterm-mcp', 'codex-sidecar', 'peertable', 'unai', 'claude-code', 'codex-cli', 'grok-build',
];
const products = Object.fromEntries(required.map((id) => [id, {
  presence_status: 'installed', compatibility_status: 'compatible', checks: [],
}]));
products.servermanager = process.env.DOTAGENTS_SETUP_TEST_HOST_PROFILE === 'server'
  ? { presence_status: 'installed', compatibility_status: 'compatible', checks: [] }
  : { presence_status: 'not_applicable', checks: [] };
products.aishell = {
  presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [],
};
if (process.env.DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT) {
  products[process.env.DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT].presence_status = 'missing';
}
fs.writeFileSync(output, `${JSON.stringify({
  schema_version: '8.0', report_id: reportId, host_profile: process.env.DOTAGENTS_SETUP_TEST_HOST_PROFILE,
  platform: { os: 'linux', arch: 'x64' }, products,
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
chmod +x "$FIXTURE_ROOT/install.sh" "$FIXTURE_ROOT/bin/"*.sh

cat >"$STUB_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -e
[ "${1:-}" != -n ] || shift
exec "$@"
EOF
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
cat >"$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$DOTAGENTS_SETUP_TEST_CALLS"
EOF
cat >"$STUB_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -l ]; then
  [ -f "$DOTAGENTS_SETUP_TEST_CRONTAB" ] || exit 1
  cat "$DOTAGENTS_SETUP_TEST_CRONTAB"
else
  cp "$1" "$DOTAGENTS_SETUP_TEST_CRONTAB"
fi
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
elif [ "${1:-} ${2:-}" = 'mcp remove' ]; then
  exit 0
elif [ "${1:-} ${2:-}" = 'mcp add' ]; then
  name=''
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in --scope) shift 2 ;; --) shift; break ;; *) name="$1"; shift ;; esac
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
if [ "${1:-} ${2:-}" = 'mcp get' ]; then
  grep -Fqx "$3" "$state" 2>/dev/null || exit 1
  command_name="$(awk -F= -v name="$3" '$1 == name { print $2 }' "$state.commands")"
  printf '{"name":"%s","enabled":true,"transport":{"type":"stdio","command":"%s","args":[]}}\n' "$3" "$command_name"
elif [ "${1:-} ${2:-}" = 'mcp remove' ]; then
  exit 0
elif [ "${1:-} ${2:-}" = 'mcp add' ]; then
  name="$3"
  command_name="$5"
  printf '%s\n' "$name" >>"$state"
  printf '%s=%s\n' "$name" "$command_name" >>"$state.commands"
  printf 'codex-mcp-add %s %s\n' "$name" "$command_name" >>"$DOTAGENTS_SETUP_TEST_CALLS"
else
  exit 0
fi
EOF
for command_name in npm uv gpt-connector gpt-connector-mcp lattice-mcp aiterm-mcp codex-sidecar codex-sidecar-mcp peertable-client; do
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
chmod +x "$STUB_BIN/throughline"
chmod +x "$STUB_BIN/"*

mkdir -p "$HOME_DIR/.config/dotagents"
printf '%s\n' '.fixture-user-ignore' >"$HOME_DIR/.gitignore_global"
printf '{"host":{"id":"fixture","profile":"%s"},"reporting":{"enabled":true,"endpoint":"https://example.invalid/api/factory/v8/reports"}}\n' "$HOST_PROFILE" \
  >"$HOME_DIR/.config/dotagents/factory-reporter.json"
{
  printf '%s\n' "17 * * * * /usr/bin/node /fixture/factory-reporter # dotagents-factory-reporter"
  printf '%s\n' "0 4 * * 1 '$HOME_DIR/.local/bin/agents-update' # legacy-dotagents-update"
  printf '%s\n' "30 3 * * * '$HOME_DIR/.local/bin/update-npm-globals.sh'"
} >"$CRONTAB"

# shellcheck disable=SC2016 # setup側へ literal `$HOME` が書かれていることを検査する＝展開させない。
grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'setupが ~/.local/bin をPATH先頭へ置かない'
# shellcheck disable=SC2016 # setup側のliteral変数名を含む射影行を検査するため展開させない。
grep -Fq 'ln -s "/snap/bin/$command_path" "$snap_node_bin/$command_path"' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'setupが公式SnapのNode系commandだけを専用dirへ射影しない'
# shellcheck disable=SC2016 # 禁止するliteral PATH行を検査するため展開させない。
if grep -Fq 'export PATH="$HOME/.local/bin:/snap/bin:$PATH"' "$ROOT/bin/setup-linux-common.sh"; then
  fail 'setupが/snap/bin全体をPATH先頭へ出す'
fi
grep -Fq "[ \"\$node_major\" -ge 24 ]" "$ROOT/bin/setup-linux-common.sh" \
  || fail 'setupがNode.js 24契約を強制しない'
node - "$ROOT/bin/setup-linux-common.sh" <<'NODE'
const source = require('fs').readFileSync(process.argv[2], 'utf8');
if (!(source.indexOf('ensure_toolchain_bootstrap') < source.indexOf('"$ROOT/bin/apply-codex-config.sh" --apply'))
  || !source.includes('npm install -g @openai/codex@latest')) process.exit(1);
NODE

export HOME="$HOME_DIR"
export PATH="$STUB_BIN:/usr/bin:/bin"
unset XAI_API_KEY
export DOTAGENTS_SETUP_LINUX_FORCE=1
export DOTAGENTS_SETUP_SKIP_PREREQUISITES=1
export DOTAGENTS_SETUP_SKIP_ENROLLMENT=1
export DOTAGENTS_SETUP_SKIP_REPO_RELOCATION=1
export DOTAGENTS_SETUP_SKIP_ACTIONS_RUNNER=1
export DOTAGENTS_SETUP_TEST_HOST_PROFILE="$HOST_PROFILE"
export DOTAGENTS_SETUP_TEST_CALLS="$CALLS"
export DOTAGENTS_SETUP_TEST_CRONTAB="$CRONTAB"
export DOTAGENTS_SETUP_TEST_ROOT="$FIXTURE_ROOT"

"$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh"
"$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh"

[ "$(grep -Fxc '.fixture-user-ignore' "$HOME_DIR/.gitignore_global")" -eq 1 ] \
  || fail '既存global gitignoreを保持しない'
[ "$(grep -Fxc '.DS_Store' "$HOME_DIR/.gitignore_global")" -eq 1 ] \
  || fail '.DS_Storeを冪等に補完しない'
[ "$(grep -Fc "# dotagents-agents-update-$CRON_SUFFIX" "$CRONTAB")" -eq 1 ] || fail 'cron管理行が1件でない'
grep -Fq '# dotagents-factory-reporter' "$CRONTAB" || fail '既存のfactory reporter cronを保持しない'
if grep -E 'agents-update|update-npm-globals' "$CRONTAB" | grep -Fv "$SETUP_COMMAND" >/dev/null; then
  fail '旧update cronを残した'
fi
find "$HOME_DIR/.local/state/dotagents/backups" -name "crontab-pre-$SETUP_VARIANT-setup-*" -type f | grep -q . \
  || fail '変更前crontabをbackupしない'
grep -Fq "0 2 * * * '$HOME_DIR/.local/bin/$SETUP_COMMAND' --scheduled-update" "$CRONTAB" \
  || fail '毎日2:00のscheduled updateを登録しない'
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
grep -Fq 'caveat init </dev/null' "$ROOT/bin/setup-linux-common.sh" || fail 'caveat init を非対話にしない'
[ "$(grep -n '^caveat sync --init ' "$CALLS" | head -1 | cut -d: -f1)" -lt \
  "$(grep -n '^caveat init$' "$CALLS" | head -1 | cut -d: -f1)" ] \
  || fail 'Caveat初回syncがinitより先でない'
find "$HOME_DIR/.local/state/dotagents/backups" -path '*/caveat-init-scaffold-*/.gitignore' -type f | grep -q . \
  || fail '中断されたCaveat初期scaffoldをbackupしない'
grep -Fq 'npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest' \
  "$ROOT/bin/setup-linux-common.sh" || fail 'Claude Code公式lifecycle scriptを限定許可しない'
grep -Fq 'npm install -g --allow-scripts=claude-spotter' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'Spotter公式lifecycle scriptを限定許可しない'
grep -Fq 'env -u THROUGHLINE_CODEX_THREAD_ID -u CODEX_THREAD_ID' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'factory batchへ対話中Codex thread identityを混入させる'
grep -Fq 'ACTIONS_RUNNER_LABEL='"'"'linux-server'"'" "$ROOT/bin/setup-linux-common.sh" \
  || fail 'main-server runner labelを役割別に定義しない'
grep -Fq 'ACTIONS_RUNNER_LABEL='"'"'linux-workstation'"'" "$ROOT/bin/setup-linux-common.sh" \
  || fail 'rabbit runner labelを役割別に定義しない'
# shellcheck disable=SC2016 # setup側のliteral変数参照を検査するため展開させない。
grep -Fq -- '--labels "factory,$ACTIONS_RUNNER_LABEL"' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'host別labelでrunnerを登録しない'
grep -Fq 'set_org_runner_labels factory-linux-main linux-server' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'rabbit一撃展開からmain-serverの旧Linux labelを移行しない'
# shellcheck disable=SC2016 # setup側のliteral変数参照を検査するため展開させない。
grep -Fq 'cd "$ACTIONS_RUNNER_ROOT"' "$ROOT/bin/setup-linux-common.sh" \
  || fail '公式runner serviceをrunner root内から操作しない'
# shellcheck disable=SC2016 # setup側のliteral変数参照を検査するため展開させない。
grep -Fq 'sudo ./svc.sh install "$USER"' "$ROOT/bin/setup-linux-common.sh" \
  || fail '公式runner service installerを使用しない'
grep -Fq 'replace(/^\uFEFF/, "")' "$ROOT/bin/setup-linux-common.sh" \
  || fail '公式runner metadataのUTF-8 BOMを受理しない'
grep -Eq 'ripgrep shellcheck tmux xz-utils' "$ROOT/bin/setup-linux-prerequisites-root.sh" \
  || fail 'Aitermのnative Linux前提tmuxを一撃展開へ含めない'
grep -Fq 'gh auth switch --hostname github.com --user quolu' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'Caveat-Private同期前に工場ownerへ切り替えない'
grep -Fq 'gh auth setup-git' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'Caveat-Private同期前にGitHub HTTPS credential helperを配線しない'
grep -Fq 'caveat sync --init --repo https://github.com/quolu/Caveat-Private.git' "$ROOT/bin/setup-linux-common.sh" \
  || fail 'Caveat-Privateの初回同期が公式HTTPS経路でない'
grep -Fq 'throughline install' "$CALLS" || fail 'Throughline製品管理hookを導入しない'
grep -Fq 'caveat codex-hook install' "$CALLS" || fail 'Caveat Codex hookを導入しない'
grep -Fq 'lattice hooks install --host claude' "$CALLS" || fail 'Claude Lattice hookを配線しない'
grep -Fq 'lattice hooks install --host codex' "$CALLS" || fail 'Codex Lattice hookを配線しない'
grep -Fq 'lattice hooks install --host cursor' "$CALLS" || fail 'Cursor Lattice hookを配線しない'
grep -Fq 'spotter install -y' "$CALLS" || fail 'Spotterを配線しない'
grep -Fq 'verify-install --profile official' "$CALLS" || fail '最終verifyを実行しない'
[ "$(grep -Fc 'claude-mcp-add gpt_connector gpt-connector-mcp' "$CALLS")" -eq 1 ] \
  || fail 'Claude gpt_connectorを一度だけ補完しない'
[ "$(grep -Fc 'codex-mcp-add codex-sidecar codex-sidecar-mcp' "$CALLS")" -eq 1 ] \
  || fail 'Codex sidecarを一度だけ補完しない'
[ "$(grep -Fc 'agents-update ' "$CALLS")" -eq 2 ] || fail '各setup runでfresh updateを1回だけ実行しない'

latest_report="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report_id)' \
  "$HOME_DIR/.local/state/dotagents/factory-reporter-v8/latest-report.json")"
[ "$latest_report" = fixture-report-2 ] || fail '2回目のfresh reportが作られていない'

minimal_output="$(env -i \
  HOME="$HOME_DIR" \
  PATH="$STUB_BIN:/usr/bin:/bin" \
  DOTAGENTS_SETUP_LINUX_FORCE=1 \
  DOTAGENTS_SETUP_SKIP_PREREQUISITES=1 \
  DOTAGENTS_SETUP_SKIP_ENROLLMENT=1 \
  DOTAGENTS_SETUP_SKIP_REPO_RELOCATION=1 \
  DOTAGENTS_SETUP_TEST_HOST_PROFILE="$HOST_PROFILE" \
  DOTAGENTS_SETUP_TEST_CALLS="$CALLS" \
  "$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh" --scheduled-update)"
grep -Fq '"delivery_acknowledged":true' <<<"$minimal_output" \
  || fail 'cron最小環境でdelivery receiptを確認しない'
grep -Fq '"factory_products_checked":15' <<<"$minimal_output" \
  || fail 'cron最小環境で全15製品を確認しない'
latest_report="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report_id)' \
  "$HOME_DIR/.local/state/dotagents/factory-reporter-v8/latest-report.json")"
[ "$latest_report" = fixture-report-3 ] || fail 'cron最小環境でfresh reportが作られていない'

if DOTAGENTS_SETUP_TEST_BROKEN_PRODUCT=caveat \
  "$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh" --scheduled-update >/dev/null 2>&1; then
  fail 'required製品欠落を成功扱いした'
fi

if "$FIXTURE_ROOT/bin/$SETUP_COMMAND.sh" --unknown >/dev/null 2>&1; then
  fail '未知引数を受理した'
fi

echo "$SETUP_COMMAND install test: OK"
