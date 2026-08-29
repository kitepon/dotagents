#!/usr/bin/env bash
# macOSへdotagents工場を一撃展開し、全製品のfresh delivery receiptまで検証する。
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
while [ -L "$script_source" ]; do
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  script_source="$(readlink "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_dir/$script_source" ;; esac
done
ROOT="$(cd "$(dirname "$script_source")/.." && pwd)"
REPORT_CONFIG="${FACTORY_REPORTER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dotagents/factory-reporter.json}"
REPORT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/dotagents/factory-reporter-v8"
UPDATE_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update/agents-update.log"
LAUNCH_AGENT_LABEL='com.kite.agents-update'
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"

die() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "必須commandがない: $1"; }

is_macos() {
  [ "${DOTAGENTS_SETUP_MACOS_FORCE:-0}" = 1 ] && return 0
  [ "$(uname -s 2>/dev/null || true)" = Darwin ]
}

macos_major() {
  local major
  major="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 1 ] || die 'macOS majorを取得できない'
  printf '%s\n' "$major"
}

supports_aishell() {
  [ "${DOTAGENTS_SETUP_MACOS_ARCH:-$(uname -m)}" = arm64 ] && [ "$(macos_major)" -ge 15 ]
}

validate_report_config() {
  [ -f "$REPORT_CONFIG" ] || die "factory reporter configがない: $REPORT_CONFIG"
  node - "$REPORT_CONFIG" <<'NODE' || exit 1
const fs = require('fs');
const path = process.argv[2];
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); }
catch (error) { process.stderr.write(`FAIL: factory reporter configを読めない: ${error.message}\n`); process.exit(1); }
let endpoint;
try { endpoint = new URL(value?.reporting?.endpoint); }
catch { process.stderr.write('FAIL: factory reporter endpointが不正\n'); process.exit(1); }
if (value?.host?.profile !== 'mac' || value?.reporting?.enabled !== true
  || endpoint.pathname !== '/api/factory/v8/reports') {
  process.stderr.write('FAIL: factory reporterはmac profileのenabledなwire v8でなければならない\n');
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
  python3 -c 'import uuid; print(uuid.uuid4())'
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
  local major="$1"
  node --input-type=module - \
    "$ROOT/lib/factory/deployment-contract.mjs" \
    "$REPORT_STATE/latest-report.json" "$major" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, reportPath, majorText] = process.argv.slice(2);
const { CURRENT_WIRE_PRODUCT_IDS, hostProjection, postUpdateFailures } =
  await import(pathToFileURL(contractPath).href);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const facts = {
  profile: report.host_profile,
  os: report.platform?.os,
  arch: report.platform?.arch,
  macosMajor: Number(majorText),
};
if (report.schema_version !== '8.0' || facts.profile !== 'mac' || facts.os !== 'darwin') {
  throw new Error('macOS wire v8 reportでない');
}
const actualIds = Object.keys(report.products ?? {}).sort();
const expectedIds = [...CURRENT_WIRE_PRODUCT_IDS].sort();
if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
  throw new Error('factory reportが固定15製品をすべて含まない');
}
const projection = hostProjection(facts);
const failures = postUpdateFailures(report, facts, { postUpdate: false });
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

run_factory_update() {
  validate_report_config
  local prior_report_id batch_token report_id checked_products major
  prior_report_id="$(fresh_report_id)"
  batch_token="$(new_batch_token)"
  major="$(macos_major)"
  AGENTS_UPDATE_BATCH_TOKEN="$batch_token" \
    FACTORY_REPORTER_RUNNER="$HOME/.local/bin/factory-reporter-v8-schedule-runner" \
    "$ROOT/bin/agents-update.sh"
  [ -f "$UPDATE_LOG" ] || die "agents-update logがない: $UPDATE_LOG"
  grep -Fq "agents-update batch-token: $batch_token" "$UPDATE_LOG" \
    || die '今回のbatch tokenがagents-update logにない'
  grep -Fq 'agents-update end:' "$UPDATE_LOG" || die 'agents-update完了行がlogにない'
  report_id="$(validate_delivery_receipt "$prior_report_id" "$batch_token")" \
    || die 'fresh v8 reportとBugHub delivery receiptが一致しない'
  checked_products="$(validate_factory_products "$major")" \
    || die 'factory全製品の正規診断が受入条件を満たさない'
  printf '{"ok":true,"mode":"macos-setup","batch_token":"%s","report_id":"%s","delivery_acknowledged":true,"factory_products_checked":%s}\n' \
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
  backup_file="$(mktemp "$backup_dir/dotagents-pre-macos-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX.tar.gz")"
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

ensure_claude_aishell() {
  local output=''
  if output="$(NO_COLOR=1 TERM=dumb claude mcp get aishell 2>&1)" \
    && grep -Eq '^  Scope: User config' <<<"$output" \
    && grep -Eq '^  Status: .*Connected$' <<<"$output" \
    && grep -Eq '^  Command: aishell-mcp$' <<<"$output" \
    && grep -Eq '^    AISHELL_CAPABILITY_SET=expanded-v1$' <<<"$output"; then
    return 0
  fi
  claude mcp remove --scope user aishell >/dev/null 2>&1 || true
  claude mcp add --scope user aishell --env AISHELL_CAPABILITY_SET=expanded-v1 -- aishell-mcp
  output="$(NO_COLOR=1 TERM=dumb claude mcp get aishell 2>&1)" \
    || die 'Claude AIShell MCPを取得できない'
  if ! grep -Eq '^  Status: .*Connected$' <<<"$output" \
    || ! grep -Eq '^  Command: aishell-mcp$' <<<"$output" \
    || ! grep -Eq '^    AISHELL_CAPABILITY_SET=expanded-v1$' <<<"$output"; then
    die 'Claude AIShell MCPがcanonicalでない'
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

codex_aishell_matches() {
  codex mcp get aishell --json 2>/dev/null | node -e '
    let value;
    try { value = JSON.parse(require("fs").readFileSync(0, "utf8")); }
    catch { process.exit(1); }
    const transport = value?.transport;
    process.exit(value?.enabled === true && transport?.type === "stdio"
      && transport?.command === "aishell-mcp"
      && Array.isArray(transport?.args) && transport.args.length === 0
      && transport?.env?.AISHELL_CAPABILITY_SET === "expanded-v1" ? 0 : 1);
  '
}

ensure_codex_aishell() {
  if codex_aishell_matches; then
    return 0
  fi
  codex mcp remove aishell >/dev/null 2>&1 || true
  codex mcp add aishell --env AISHELL_CAPABILITY_SET=expanded-v1 -- aishell-mcp
  codex_aishell_matches || die 'Codex AIShell MCPがcanonicalでない'
}

ensure_managed_commands() {
  local -a commands=(caveat throughline spotter lattice markitdown gpt-connector
    aiterm-mcp codex-sidecar-mcp peertable-client unai)
  supports_aishell && commands+=(aishell-mcp)
  local command_name package_name npm_bin npm_prefix
  for command_name in "${commands[@]}"; do
    command -v "$command_name" >/dev/null 2>&1 && continue
    echo "INFO: factory managed commandを公式経路で補完する: $command_name"
    case "$command_name" in
      caveat) package_name=caveat-cli ;;
      throughline) package_name=throughline ;;
      spotter) package_name=claude-spotter ;;
      lattice) package_name=@quolu/lattice ;;
      gpt-connector) package_name=gpt-connector ;;
      aiterm-mcp) package_name=aiterm-mcp ;;
      codex-sidecar-mcp) package_name=codex-sidecar-mcp ;;
      peertable-client) package_name=peertable ;;
      aishell-mcp) package_name=@quolu/aishell ;;
      markitdown) uv tool install markitdown; continue ;;
      unai) "$ROOT/bin/install-unai.sh"; continue ;;
    esac
    npm install -g "$package_name"
  done
  npm_prefix="$(npm prefix -g)" || die 'npm global prefixを取得できない'
  case "$npm_prefix" in /*) ;; *) die 'npm global prefixが絶対pathでない' ;; esac
  npm_bin="$npm_prefix/bin"
  [ -d "$npm_bin" ] || die "npm global binがない: $npm_bin"
  export PATH="$npm_bin:$PATH"
  for command_name in "${commands[@]}"; do
    need "$command_name"
  done
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
  if supports_aishell; then
    ensure_claude_aishell
    ensure_codex_aishell
  fi
}

install_launch_agent() {
  local agent_dir setup_bin candidate domain backup='' was_loaded=0
  agent_dir="$(dirname "$LAUNCH_AGENT_PLIST")"
  setup_bin="$HOME/.local/bin/agents-update"
  domain="gui/$(id -u)"
  mkdir -p "$agent_dir" "$(dirname "$UPDATE_LOG")"
  candidate="$(mktemp "$agent_dir/.$LAUNCH_AGENT_LABEL.XXXXXX")"
  python3 - "$candidate" "$setup_bin" <<'PY'
import plistlib
import sys

target, update = sys.argv[1:]
value = {
    'Label': 'com.kite.agents-update',
    'ProgramArguments': ['/bin/bash', update],
    'StartCalendarInterval': {'Weekday': 1, 'Hour': 4, 'Minute': 0},
    'RunAtLoad': False,
}
with open(target, 'wb') as handle:
    plistlib.dump(value, handle, sort_keys=False)
PY
  plutil -lint "$candidate" >/dev/null || { rm -f "$candidate"; die 'LaunchAgent plistが不正'; }
  if launchctl print "$domain/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
    was_loaded=1
  fi
  if [ -f "$LAUNCH_AGENT_PLIST" ] && cmp -s "$candidate" "$LAUNCH_AGENT_PLIST"; then
    rm -f "$candidate"
    if [ "$was_loaded" -eq 0 ]; then
      launchctl bootstrap "$domain" "$LAUNCH_AGENT_PLIST" \
        || die '既存LaunchAgentをbootstrapできない'
    fi
    launchctl print "$domain/$LAUNCH_AGENT_LABEL" >/dev/null \
      || die 'LaunchAgentを読み戻せない'
    return 0
  fi
  if [ -f "$LAUNCH_AGENT_PLIST" ]; then
    mkdir -p "$HOME/Archives"
    backup="$(mktemp "$HOME/Archives/$LAUNCH_AGENT_LABEL-pre-macos-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX.plist")"
    cp "$LAUNCH_AGENT_PLIST" "$backup"
  fi
  if [ "$was_loaded" -eq 1 ]; then
    launchctl bootout "$domain/$LAUNCH_AGENT_LABEL" || { rm -f "$candidate"; die '旧LaunchAgentを停止できない'; }
  fi
  chmod 600 "$candidate"
  mv "$candidate" "$LAUNCH_AGENT_PLIST"
  if ! launchctl bootstrap "$domain" "$LAUNCH_AGENT_PLIST"; then
    rm -f "$LAUNCH_AGENT_PLIST"
    if [ -n "$backup" ]; then
      cp "$backup" "$LAUNCH_AGENT_PLIST"
      [ "$was_loaded" -eq 0 ] || launchctl bootstrap "$domain" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
    fi
    die 'LaunchAgentの適用に失敗したため変更を戻した'
  fi
  launchctl print "$domain/$LAUNCH_AGENT_LABEL" >/dev/null \
    || die '適用したLaunchAgentを読み戻せない'
}

run_setup() {
  is_macos || die 'このスクリプトはmacOS専用'
  # 親AI sessionは ~/.local/bin を持たないことがある。uv tool（markitdown）と
  # install.sh の配布面はここへ置くので、入口自身が PATH を完結させる。
  export PATH="$HOME/.local/bin:$PATH"
  local command_name
  for command_name in git gh node npm docker python3 claude codex uv plutil launchctl sw_vers; do
    need "$command_name"
  done
  local node_major
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$node_major" -ge 24 ] || die 'Node.js 24以上が必要'
  python3 -c 'print(1)' >/dev/null || die 'python3を実行できない'
  docker info >/dev/null 2>&1 || die 'docker daemonへ接続できない'
  gh auth status >/dev/null 2>&1 || die 'GitHub CLIが未認証'
  macos_major >/dev/null

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
  spotter install -y
  install_launch_agent
  "$ROOT/bin/verify-install.sh" --profile official
  run_factory_update
  echo 'setup-macos-factory: OK'
}

[ "$#" -eq 0 ] || die '使い方: setup-macos-factory.sh'
run_setup
