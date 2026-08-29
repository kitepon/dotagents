#!/usr/bin/env bash
# WSL2／native Linuxへdotagents工場を一撃展開し、定期更新のdelivery receiptまで検証する。
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
while [ -L "$script_source" ]; do
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  script_source="$(readlink "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_dir/$script_source" ;; esac
done
ROOT="$(cd "$(dirname "$script_source")/.." && pwd)"
SETUP_VARIANT="${DOTAGENTS_SETUP_VARIANT:-wsl}"
case "$SETUP_VARIANT" in
  wsl)
    HOST_PROFILE=wsl
    SETUP_COMMAND=setup-wsl-factory
    CRON_MARKER='# dotagents-agents-update-wsl'
    ;;
  linux)
    HOST_PROFILE=server
    SETUP_COMMAND=setup-linux-factory
    CRON_MARKER='# dotagents-agents-update-linux'
    ;;
  *) echo "FAIL: 未対応のsetup variant: $SETUP_VARIANT" >&2; exit 1 ;;
esac
REPORT_CONFIG="${FACTORY_REPORTER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dotagents/factory-reporter.json}"
REPORT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/dotagents/factory-reporter-v8"
UPDATE_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update/agents-update.log"

die() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "必須commandがない: $1"; }

is_target_host() {
  [ "${DOTAGENTS_SETUP_WSL_FORCE:-0}" = 1 ] && return 0
  [ "${DOTAGENTS_SETUP_LINUX_FORCE:-0}" = 1 ] && [ "$SETUP_VARIANT" = linux ] && return 0
  [ "$(uname -s 2>/dev/null || true)" = Linux ] || return 1
  if [ "$SETUP_VARIANT" = wsl ]; then
    grep -qiE '(microsoft|wsl)' /proc/sys/kernel/osrelease 2>/dev/null
  else
    if grep -qiE '(microsoft|wsl)' /proc/sys/kernel/osrelease 2>/dev/null; then
      return 1
    fi
    return 0
  fi
}

validate_report_config() {
  [ -f "$REPORT_CONFIG" ] || die "factory reporter configがない: $REPORT_CONFIG"
  node - "$REPORT_CONFIG" "$HOST_PROFILE" <<'NODE' || exit 1
const fs = require('fs');
const path = process.argv[2];
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); }
catch (error) { process.stderr.write(`FAIL: factory reporter configを読めない: ${error.message}\n`); process.exit(1); }
let endpoint;
try { endpoint = new URL(value?.reporting?.endpoint); }
catch { process.stderr.write('FAIL: factory reporter endpointが不正\n'); process.exit(1); }
if (value?.host?.profile !== process.argv[3]
  || value?.reporting?.enabled !== true || endpoint.pathname !== '/api/factory/v8/reports') {
  process.stderr.write(`FAIL: factory reporterは${process.argv[3]} profileのenabledなwire v8でなければならない\n`);
  process.exit(1);
}
NODE
}

fresh_report_id() {
  node -e '
    try {
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof value.report_id === "string") process.stdout.write(value.report_id);
    } catch {}
  ' "$REPORT_STATE/latest-report.json" 2>/dev/null || true
}

new_batch_token() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\r\n' </proc/sys/kernel/random/uuid
  else
    python3 -c 'import uuid; print(uuid.uuid4())'
  fi
}

validate_delivery_receipt() {
  local prior_report_id="$1" batch_token="$2"
  node --input-type=module - \
    "$ROOT/lib/factory/delivery-receipt.mjs" \
    "$REPORT_STATE/latest-report.json" \
    "$REPORT_STATE/delivery-receipt.json" \
    "$prior_report_id" "$batch_token" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, reportPath, receiptPath, priorReportId, batchToken] = process.argv.slice(2);
const { assertDeliveryReceipt } = await import(pathToFileURL(contractPath).href);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
assertDeliveryReceipt({ report, priorReportId: priorReportId || null, receipt, batchToken });
process.stdout.write(`${report.report_id}\n`);
NODE
}

validate_factory_products() {
  node --input-type=module - \
    "$ROOT/lib/factory/deployment-contract.mjs" \
    "$REPORT_STATE/latest-report.json" "$HOST_PROFILE" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, reportPath, expectedProfile] = process.argv.slice(2);
const { CURRENT_WIRE_PRODUCT_IDS, hostProjection, postUpdateFailures } =
  await import(pathToFileURL(contractPath).href);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const facts = { profile: report.host_profile, os: report.platform?.os, arch: report.platform?.arch };
if (report.schema_version !== '8.0' || facts.profile !== expectedProfile || facts.os !== 'linux') {
  throw new Error(`${expectedProfile} wire v8 reportでない`);
}
const actualIds = Object.keys(report.products ?? {}).sort();
const expectedIds = [...CURRENT_WIRE_PRODUCT_IDS].sort();
if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
  throw new Error('factory reportが固定15製品をすべて含まない');
}
const projection = hostProjection(facts);
let failures = postUpdateFailures(report, facts, { postUpdate: false });
if (expectedProfile === 'server') {
  // self-ingest鮮度はdelivery後のverify-installがloopback readinessで受け入れる。
  failures = failures.filter((failure) => failure !== 'servermanager:compatibility'
    && failure !== 'servermanager:readiness_factory_ingest');
}
for (const [id, expectation] of Object.entries(projection.expected)) {
  const product = report.products[id];
  if (expectation === 'unsupported'
    && (product.presence_status !== 'not_applicable' || product.compatibility_status !== 'unsupported')) {
    failures.push(`${id}:unsupported_projection`);
  }
  if (expectation === 'not_applicable' && product.presence_status !== 'not_applicable') {
    failures.push(`${id}:not_applicable_projection`);
  }
}
const grok = report.products['grok-build'];
if (!['installed', 'not_applicable'].includes(grok.presence_status)
  || grok.compatibility_status === 'incompatible'
  || grok.checks.some((item) => item.status === 'fail')) {
  failures.push('grok-build:optional_health');
}
if (failures.length) throw new Error(`factory product verification failed: ${failures.join(',')}`);
process.stdout.write(String(actualIds.length));
NODE
}

run_scheduled_update() {
  need node
  need python3
  validate_report_config
  local prior_report_id batch_token report_id checked_products
  prior_report_id="$(fresh_report_id)"
  batch_token="$(new_batch_token)"
  AGENTS_UPDATE_BATCH_TOKEN="$batch_token" \
    FACTORY_REPORTER_RUNNER="$HOME/.local/bin/factory-reporter-v8-schedule-runner" \
    "$ROOT/bin/agents-update.sh"
  [ -f "$UPDATE_LOG" ] || die "agents-update logがない: $UPDATE_LOG"
  grep -Fq "agents-update batch-token: $batch_token" "$UPDATE_LOG" \
    || die '今回のbatch tokenがagents-update logにない'
  grep -Fq 'agents-update end:' "$UPDATE_LOG" || die 'agents-update完了行がlogにない'
  report_id="$(validate_delivery_receipt "$prior_report_id" "$batch_token")" \
    || die 'fresh v8 reportとBugHub delivery receiptが一致しない'
  checked_products="$(validate_factory_products)" \
    || die 'factory全製品の正規診断が受入条件を満たさない'
  printf '{"ok":true,"mode":"scheduled-update","batch_token":"%s","report_id":"%s","delivery_acknowledged":true,"factory_products_checked":%s}\n' \
    "$batch_token" "$report_id" "$checked_products"
}

backup_managed_config() {
  local -a paths=()
  local path
  for path in .gitconfig .gitignore_global .claude.json .claude/settings.json \
    .codex/config.toml .codex/hooks.json .grok/config.toml; do
    [ ! -e "$HOME/$path" ] || paths+=("$path")
  done
  [ "${#paths[@]}" -gt 0 ] || return 0
  local backup_dir="$HOME/Archives"
  local backup_file
  mkdir -p "$backup_dir"
  backup_file="$(mktemp "$backup_dir/dotagents-pre-wsl-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX.tar.gz")"
  tar -czf "$backup_file" -C "$HOME" "${paths[@]}"
}

ensure_git_identity() {
  git config --global user.name kitepon-rgb
  git config --global user.email kitepon-rgb@users.noreply.github.com
  git config --global init.defaultBranch main
  if [ ! -f "$HOME/.gitignore_global" ] || ! grep -Fqx '.DS_Store' "$HOME/.gitignore_global"; then
    printf '.DS_Store\n' >>"$HOME/.gitignore_global"
  fi
  git config --global core.excludesfile "$HOME/.gitignore_global"
}

ensure_claude_mcp() {
  local name="$1"
  shift
  local output=''
  if output="$(NO_COLOR=1 TERM=dumb claude mcp get "$name" 2>&1)" \
    && grep -Eq '^  Scope: User config' <<<"$output" \
    && grep -Eq '^  Status: .*Connected$' <<<"$output"; then
    return 0
  fi
  claude mcp remove --scope user "$name" >/dev/null 2>&1 || true
  claude mcp add --scope user "$name" -- "$@"
  output="$(NO_COLOR=1 TERM=dumb claude mcp get "$name" 2>&1)" \
    || die "Claude MCPを取得できない: $name"
  if ! grep -Eq '^  Scope: User config' <<<"$output" \
    || ! grep -Eq '^  Status: .*Connected$' <<<"$output"; then
    die "Claude MCPがuser scopeでConnectedでない: $name"
  fi
}

codex_mcp_matches() {
  local name="$1" command_name="$2"
  codex mcp get "$name" --json 2>/dev/null | node -e '
    let value;
    try { value = JSON.parse(require("fs").readFileSync(0, "utf8")); }
    catch { process.exit(1); }
    const transport = value?.transport;
    process.exit(value?.enabled === true && transport?.type === "stdio"
      && transport?.command === process.argv[1]
      && Array.isArray(transport?.args) && transport.args.length === 0 ? 0 : 1);
  ' "$command_name"
}

ensure_codex_mcp() {
  local name="$1" command_name="$2"
  if codex_mcp_matches "$name" "$command_name"; then
    return 0
  fi
  codex mcp remove "$name" >/dev/null 2>&1 || true
  codex mcp add "$name" -- "$command_name"
  codex_mcp_matches "$name" "$command_name" \
    || die "Codex MCPがcanonicalでない: $name"
}

ensure_managed_commands() {
  local command_name missing=0
  for command_name in caveat throughline spotter lattice markitdown gpt-connector \
    aiterm-mcp codex-sidecar-mcp peertable-client unai; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "INFO: factory managed commandを更新で補完する: $command_name"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    "$ROOT/bin/agents-update.sh"
  fi
  for command_name in caveat throughline spotter lattice markitdown gpt-connector \
    aiterm-mcp codex-sidecar-mcp peertable-client unai; do
    need "$command_name"
  done
}

ensure_toolchain_bootstrap() {
  if ! claude --version >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code@latest
  fi
  if ! codex --version >/dev/null 2>&1; then
    npm install -g @openai/codex@latest
  fi
  claude --version >/dev/null 2>&1 || die 'Claude Codeを公式npm経路で復旧できない'
  codex --version >/dev/null 2>&1 || die 'Codex CLIを公式npm経路で復旧できない'
}

ensure_caveat_sync() {
  if [ -d "$HOME/.caveat/own/.git" ]; then
    caveat sync
  else
    caveat sync --init --repo https://github.com/kitepon-rgb/Caveat-Private.git
  fi
}

grok_is_logged_in() {
  [ -n "${XAI_API_KEY:-}" ] && return 0
  [ -s "$HOME/.grok/auth.json" ]
}

maybe_apply_grok_config() {
  if ! grok_is_logged_in; then
    echo "INFO: Grok未login。apply-grok-config をスキップする（toolchain optional）"
    return 0
  fi
  "$ROOT/bin/apply-grok-config.sh" --apply
}

apply_cursor_config() {
  "$ROOT/bin/apply-cursor-config.sh" --apply
}

ensure_mcp() {
  ensure_claude_mcp aiterm aiterm-mcp
  ensure_claude_mcp caveat caveat mcp-server
  ensure_claude_mcp lattice lattice-mcp
  ensure_claude_mcp codex-sidecar codex-sidecar-mcp
  ensure_claude_mcp gpt_connector gpt-connector-mcp
  ensure_codex_mcp aiterm aiterm-mcp
  ensure_codex_mcp lattice lattice-mcp
  ensure_codex_mcp codex-sidecar codex-sidecar-mcp
  ensure_codex_mcp gpt_connector gpt-connector-mcp
}

cron_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

install_cron() {
  mkdir -p "$(dirname "$UPDATE_LOG")"
  if ! systemctl is-enabled cron >/dev/null 2>&1 \
    || ! systemctl is-active cron >/dev/null 2>&1; then
    sudo -n systemctl enable --now cron
  fi
  local cron_tmp current candidate installed backup_dir backup_file setup_bin scheduler_log line
  cron_tmp="$(mktemp -d)"
  current="$cron_tmp/current"
  candidate="$cron_tmp/candidate"
  installed="$cron_tmp/installed"
  trap 'rm -rf "${cron_tmp:-}"' RETURN
  crontab -l >"$current" 2>/dev/null || true
  backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/dotagents/backups"
  mkdir -p "$backup_dir"
  backup_file="$(mktemp "$backup_dir/crontab-pre-$SETUP_VARIANT-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  cp "$current" "$backup_file"
  awk -v marker="$CRON_MARKER" '
    index($0, marker) { next }
    $0 ~ /(^|[[:space:]\047"])([^[:space:]\047"]*\/)?agents-update(\.sh)?([[:space:]\047"]|$)/ { next }
    $0 ~ /(^|[[:space:]\047"])([^[:space:]\047"]*\/)?update-npm-globals(\.sh)?([[:space:]\047"]|$)/ { next }
    { print }
  ' "$current" >"$candidate"
  setup_bin="$HOME/.local/bin/$SETUP_COMMAND"
  scheduler_log="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update/scheduler.log"
  line="0 2 * * * $(cron_quote "$setup_bin") --scheduled-update >> $(cron_quote "$scheduler_log") 2>&1 $CRON_MARKER"
  printf '%s\n' "$line" >>"$candidate"
  crontab "$candidate"
  crontab -l >"$installed"
  [ "$(grep -Fxc "$line" "$installed")" -eq 1 ] \
    || die '毎日2:00のagents-update cronを読み戻せない'
}

run_setup() {
  is_target_host || die "このスクリプトは$SETUP_VARIANT専用"
  # 親AI sessionは ~/.local/bin を持たないことがある。uv tool（markitdown）と
  # install.sh の配布面はここへ置くので、入口自身が PATH を完結させる。
  # Ubuntu aptのNode 22より、工場契約のOpenJS公式Snap Node 24を先に解決する。
  export PATH="$HOME/.local/bin:/snap/bin:$PATH"
  local command_name
  for command_name in git gh node npm docker python3 claude codex uv crontab sudo systemctl; do
    need "$command_name"
  done
  local node_major
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$node_major" -ge 24 ] || die 'Node.js 24以上が必要（WSLはOpenJS公式Snapの24/stableを使う）'
  python3 -c 'print(1)' >/dev/null || die 'python3を実行できない'
  docker info >/dev/null 2>&1 || die 'docker daemonへ接続できない'
  gh auth status >/dev/null 2>&1 || die 'GitHub CLIが未認証'
  sudo -n true >/dev/null 2>&1 || die '非対話sudoを利用できない'

  backup_managed_config
  ensure_git_identity
  ensure_toolchain_bootstrap
  "$ROOT/bin/apply-codex-config.sh" --apply
  "$ROOT/bin/apply-claude-config.sh" --apply
  maybe_apply_grok_config
  apply_cursor_config
  "$ROOT/install.sh" --profile official
  "$ROOT/bin/install-unai.sh"
  ensure_managed_commands
  # Caveat Claude は init（MCP＋4 hooks）。Codex は native hook。Grok は MCP のみ（apply-grok-config）。Cursor は MCP＋工場hook（apply-cursor-config）。
  # init は TTY だと公開ミラー確認で止まるので stdin を閉じる。
  caveat init </dev/null
  ensure_caveat_sync
  throughline install
  caveat codex-hook install
  ensure_mcp
  lattice hooks install --host claude
  lattice hooks install --host codex
  lattice hooks install --host cursor
  spotter install -y
  install_cron
  if [ "$HOST_PROFILE" = server ]; then
    # server readinessはfactory ingest鮮度も含む。先に今回のreportを届けてから検証する。
    run_scheduled_update
    SERVERMANAGER_READY_URL="${SERVERMANAGER_READY_URL:-http://127.0.0.1:39310/readyz}" \
      DOTAGENTS_FACTORY_HOST_PROFILE=server \
      "$ROOT/bin/verify-install.sh" --profile official
  else
    "$ROOT/bin/verify-install.sh" --profile official
    run_scheduled_update
  fi
  echo "$SETUP_COMMAND: OK"
}

case "${1:-}" in
  '') run_setup ;;
  --scheduled-update)
    [ "$#" -eq 1 ] || die "使い方: $SETUP_COMMAND.sh [--scheduled-update]"
    is_target_host || die "このスクリプトは$SETUP_VARIANT専用"
    run_scheduled_update
    ;;
  *) die "使い方: $SETUP_COMMAND.sh [--scheduled-update]" ;;
esac
