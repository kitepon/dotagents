#!/usr/bin/env bash
# Auto-update curated NPM-installed CLIs and tools used across this user's
# development machines. Idempotent; safe to re-run.
#
# 注意: `npm link` や `npm install -g .`（ローカル版のグローバル導入）中の package を
# このリストに残すと registry 版で上書きされる。ローカル開発に切り替える時は先にリストから外すこと。
# codex-sidecar-cli/core は registry 運用で確定（2026-07-04 オーナー裁定「そのままで」）。
# link 開発へ戻す場合は先にこのリストから外して npm link する（将来の任意事項）。

set -uo pipefail

# launchd / cron は最小 PATH で起動する（npm が /opt/homebrew 等にあると見つからず静かに失敗する）。
PATH="${AGENTS_UPDATE_PATH_PREFIX:-$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/snap/bin:/usr/local/bin}:$PATH"

# Linux / WSL2 の cron は NVM の選択済み Node を PATH に含めない。
# system npmがPATHにあっても選ばず、NVMがある端末では正規入口から必ず復元する。
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1090,SC1091
  . "$NVM_DIR/nvm.sh"
fi

runtime_os="${OS:-}"
runtime_arch='unknown'
if command -v uname >/dev/null 2>&1; then
  runtime_os="$(uname -s)"
  runtime_arch="$(uname -m)"
fi
case "$runtime_os" in
  MINGW*|MSYS*|Windows_NT)
    LOG_DIR="${LOCALAPPDATA:-$HOME/AppData/Local}/dotagents/agents-update"
    FACTORY_REPORTER_CONFIG="${FACTORY_REPORTER_CONFIG:-${LOCALAPPDATA:-$HOME/AppData/Local}/dotagents/factory-reporter/config.json}"
    ;;
  *)
    LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update"
    FACTORY_REPORTER_CONFIG="${FACTORY_REPORTER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dotagents/factory-reporter.json}"
    ;;
esac
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/agents-update.log"
# post-update gateのrunnerは、hostの実configが指すwire majorへ追従させる（env明示が最優先）。
# 固定既定にするとhost別段階cutover中のhostでrunnerとendpointのmajorが食い違う
# （2026-08-10実測: mac-kiteをv7へcutover後、v6固定既定のままだとflushがendpoint不一致で落ちる）。
# configが無い・endpointが読めない場合は現役v8 runnerを選ぶ。runner側はconfig欠落を
# 明示失敗にするため、旧majorへ暗黙fallbackしない。
if [ -z "${FACTORY_REPORTER_RUNNER:-}" ]; then
  reporter_wire_major="$(node -e '
    try {
      const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const match = /^\/api\/factory\/(v[0-9]+)\/reports$/.exec(new URL(config.reporting.endpoint).pathname);
      if (match) { process.stdout.write(match[1]); process.exit(0); }
    } catch {}
    process.exit(1);
  ' "$FACTORY_REPORTER_CONFIG" 2>/dev/null)" || reporter_wire_major=""
  [ -z "$reporter_wire_major" ] && reporter_wire_major=v8
  FACTORY_REPORTER_RUNNER="$HOME/.local/bin/factory-reporter-${reporter_wire_major}-schedule-runner"
fi
script_source="${BASH_SOURCE[0]}"
while [ -h "$script_source" ]; do
  case "$script_source" in */*) script_parent=${script_source%/*} ;; *) script_parent=. ;; esac
  script_parent="$(CDPATH='' cd -P -- "$script_parent" && pwd)"
  script_source="$(readlink -- "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_parent/$script_source" ;; esac
done
case "$script_source" in */*) script_parent=${script_source%/*} ;; *) script_parent=. ;; esac
SCRIPT_DIR="$(CDPATH='' cd -P -- "$script_parent" && pwd)"
TOOLCHAIN_LEDGER_HELPER="${TOOLCHAIN_LEDGER_HELPER:-$SCRIPT_DIR/factory-toolchain-ledger.mjs}"
TOOLCHAIN_CONTRACT_HELPER="${TOOLCHAIN_CONTRACT_HELPER:-$SCRIPT_DIR/factory-toolchain-contract.mjs}"
DEPLOYMENT_CONTRACT_HELPER="${DEPLOYMENT_CONTRACT_HELPER:-$SCRIPT_DIR/factory-deployment-contract.mjs}"
TOOLCHAIN_LEDGER_FILE="${TOOLCHAIN_LEDGER_FILE:-$LOG_DIR/toolchain-ledger.json}"

extract_semver() { node -e 'const s=require("fs").readFileSync(0,"utf8");const m=s.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);if(m)process.stdout.write(m[0]);'; }
json_semver() { node -e 'let v;try{v=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{process.exit(1)};const x=v[process.argv[1]];if(typeof x!=="string"||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(x))process.exit(1);process.stdout.write(x)' "$1"; }
validate_throughline_migration() { node -e '
  let v; try { v = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(1); }
  const exact = ["afterSchemaVersion", "beforeSchemaVersion", "schema", "status", "supportedSchemaVersion"];
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join("\0") !== exact.sort().join("\0") ||
      v.schema !== "throughline.database_migration.v1" || !["migrated", "already_current", "not_applicable"].includes(v.status) ||
      !Number.isInteger(v.supportedSchemaVersion) || v.supportedSchemaVersion < 1) process.exit(1);
  if (v.status === "not_applicable") process.exit(v.beforeSchemaVersion === null && v.afterSchemaVersion === null ? 0 : 1);
  if (!Number.isInteger(v.beforeSchemaVersion) || !Number.isInteger(v.afterSchemaVersion) ||
      v.afterSchemaVersion !== v.supportedSchemaVersion) process.exit(1);
  if (v.status === "already_current") process.exit(v.beforeSchemaVersion === v.afterSchemaVersion ? 0 : 1);
  process.exit(v.beforeSchemaVersion < v.afterSchemaVersion ? 0 : 1);
'; }
resolve_npm_global_bin() {
  local prefix bin
  prefix="$(npm prefix -g)" || return 1
  [[ -n "$prefix" && "$prefix" != *$'\n'* && "$prefix" != *$'\r'* ]] || return 1
  case "$runtime_os" in
    MINGW*|MSYS*|Windows_NT)
      if [[ "$prefix" =~ ^[A-Za-z]:[\\/] ]]; then
        command -v cygpath >/dev/null 2>&1 || return 1
        prefix="$(cygpath -u "$prefix")" || return 1
      fi
      bin="$prefix"
      ;;
    *) bin="$prefix/bin" ;;
  esac
  [[ "$bin" = /* && -d "$bin" ]] || return 1
  printf '%s' "$bin"
}
record_toolchain() {
  node "$TOOLCHAIN_LEDGER_HELPER" record --file "$TOOLCHAIN_LEDGER_FILE" --product "$1" \
    --before "${2:-none}" --latest "${3:-none}" --operation "$4" --after "${5:-none}" \
    --post-gate "$6" --reason "$7" --observed-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
npm_install_spec() {
  case "$1" in
    @*/*@*|[!@]*@*) printf '%s' "$1" ;;
    *) printf '%s@latest' "$1" ;;
  esac
}

# 現役製品のOS/arch別更新集合はdeployment contractだけが所有する。
PACKAGES=()
while IFS= read -r package_line; do
  [[ -n "$package_line" ]] && PACKAGES+=("$package_line")
done < <(node "$DEPLOYMENT_CONTRACT_HELPER" npm-packages --os "$runtime_os" --arch "$runtime_arch")
if [[ "${#PACKAGES[@]}" -eq 0 ]]; then
  printf 'FAILED: deployment contract から更新集合を読めない\n'
  exit 1
fi

{
  update_failed=0
  report_failed=0
  post_gate=failed
  claude_before=none; claude_latest=none; claude_operation=failed; claude_after=none; claude_reason=not_observed
  codex_before=none; codex_latest=none; codex_operation=failed; codex_after=none; codex_reason=not_observed
  grok_before=none; grok_latest=none; grok_operation=skipped; grok_after=none; grok_reason=optional_missing
  printf '\n=== agents-update start: %s ===\n' "$(date -Iseconds)"
  if ! command -v npm >/dev/null 2>&1; then
    printf 'FAILED: npm が PATH にない（NVM 利用時は %s/nvm.sh と default Node を確認）\n' "${NVM_DIR:-$HOME/.nvm}"
    update_failed=1
    record_toolchain claude-code none none failed none pending npm_unavailable || update_failed=1
    record_toolchain codex-cli none none failed none pending npm_unavailable || update_failed=1
    claude_reason=npm_unavailable; codex_reason=npm_unavailable
  else
    npm_global_bin=''
    if ! npm_global_bin="$(resolve_npm_global_bin)"; then
      printf 'FAILED: npm global prefix/bin が不正または利用不能\n'
      update_failed=1
    else
      PATH="$npm_global_bin:$PATH"
    fi
    for pkg in "${PACKAGES[@]}"; do
      printf -- '--- %s ---\n' "$pkg"
      product=''; cli=''
      case "$pkg" in
        '@anthropic-ai/claude-code') product='claude-code'; cli='claude' ;;
        '@openai/codex') product='codex-cli'; cli='codex' ;;
      esac
      before=none; latest=none; after=none; operation=success; reason=updated; skip_install=0
      if [[ -n "$product" ]]; then
        if [[ -n "$npm_global_bin" ]]; then
          before="$($cli --version 2>/dev/null | extract_semver || true)"; before="${before:-none}"
        fi
        registry_json="$(npm view "$pkg" version --json 2>/dev/null)" || registry_json=''
        if ! latest="$(printf '%s' "$registry_json" | node "$TOOLCHAIN_CONTRACT_HELPER" npm-latest)"; then
          latest=none; after="$before"; operation=failed; reason=registry_unavailable; skip_install=1; update_failed=1
          printf 'FAILED: %s registry latest contract\n' "$pkg"
        elif [[ "$before" != none ]]; then
          relation="$(node "$TOOLCHAIN_CONTRACT_HELPER" compare "$before" "$latest" 2>/dev/null)" || relation=invalid
          if [[ "$relation" = 1 ]]; then
            after="$before"; operation=failed; reason=downgrade_refused; skip_install=1; update_failed=1
            printf 'FAILED: %s registry latest is older than installed version\n' "$pkg"
          elif [[ "$relation" = invalid ]]; then
            before=none
          fi
        fi
      fi
      install_spec="$(npm_install_spec "$pkg")"
      if [[ "$skip_install" -eq 0 ]] && ! npm install -g "$install_spec"; then
        printf 'FAILED: %s\n' "$pkg"
        update_failed=1
        operation=failed; reason=install_failed
      fi
      if [[ "$pkg" = throughline && "$operation" = success ]]; then
        printf -- '--- throughline:database-migration ---\n'
        throughline_migration_output="$(throughline migrate --json)"
        throughline_migration_rc=$?
        printf '%s\n' "$throughline_migration_output"
        if [[ "$throughline_migration_rc" -ne 0 ]] ||
          ! printf '%s' "$throughline_migration_output" | validate_throughline_migration; then
          printf 'FAILED: throughline database migration\n'
          update_failed=1
          operation=failed; reason=migration_failed
        fi
      fi
      if [[ -n "$product" ]]; then
        if [[ "$skip_install" -eq 0 && -n "$npm_global_bin" ]]; then
          after="$($cli --version 2>/dev/null | extract_semver || true)"; after="${after:-none}"
        fi
        if [[ "$operation" = success && "$after" = none ]]; then operation=failed; reason=post_version_unavailable; update_failed=1
        elif [[ "$operation" = success && "$after" != "$latest" ]]; then operation=failed; reason=version_mismatch; update_failed=1
        elif [[ "$operation" = success && "$before" = "$after" ]]; then operation=skipped; reason=already_current
        fi
        record_toolchain "$product" "$before" "$latest" "$operation" "$after" pending "$reason" || update_failed=1
        if [[ "$product" = claude-code ]]; then claude_before="$before"; claude_latest="$latest"; claude_operation="$operation"; claude_after="$after"; claude_reason="$reason"
        else codex_before="$before"; codex_latest="$latest"; codex_operation="$operation"; codex_after="$after"; codex_reason="$reason"
        fi
      fi
    done
  fi
  if ! command -v uv >/dev/null 2>&1; then
    printf 'FAILED: uv 不在（MarkItDownを更新できない）\n'
    update_failed=1
  else
    printf -- '--- MarkItDown:uv-tool ---\n'
    if ! uv_tools="$(uv tool list 2>&1)"; then
      printf 'FAILED: MarkItDown uv tool list\n'
      update_failed=1
    elif printf '%s' "$uv_tools" | node -e 'const text=require("fs").readFileSync(0,"utf8");process.exit(/^markitdown(?:\s|$)/m.test(text)?0:1)'; then
      if ! uv tool upgrade markitdown; then
        printf 'FAILED: MarkItDown uv tool upgrade\n'
        update_failed=1
      fi
    elif ! uv tool install markitdown; then
      printf 'FAILED: MarkItDown uv tool install\n'
      update_failed=1
    fi
  fi

  printf -- '--- unai:official-installer ---\n'
  if ! "$BASH" "$SCRIPT_DIR/install-unai.sh"; then
    printf 'FAILED: unai official installer\n'
    update_failed=1
  fi

  # Grok Build は npm 管理ではない。公開された stable JSON check だけを使い、
  # 人間向け version 文字列や alpha channel を推測して更新成功にはしない。
  printf -- '--- grok-build:stable-update-check ---\n'
  if ! command -v grok >/dev/null 2>&1; then
    printf 'SKIPPED: grok-build が PATH にない（optional toolchain）\n'
    grok_operation=skipped; grok_reason=optional_missing
  else
    grok_check="$(grok update --check --json)" || {
      printf 'FAILED: grok-build stable update check\n'
      update_failed=1
      grok_check=''
      grok_operation=failed; grok_reason=check_failed
    }
    grok_valid=''
    if [[ -n "$grok_check" ]] && ! grok_valid="$(printf '%s' "$grok_check" | node "$TOOLCHAIN_CONTRACT_HELPER" grok-check 2>&1)"; then
      printf 'FAILED: grok-build stable update JSON\n'
      update_failed=1
      grok_operation=failed
      case "$grok_valid" in
        *downgrade_refused*) grok_reason=downgrade_refused ;;
        *) grok_reason=check_schema_invalid ;;
      esac
    elif [[ -n "$grok_valid" ]] && printf '%s' "$grok_valid" | node -e '
      let value; try { value = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(1); }
      process.exit(value.updateAvailable === true ? 0 : 1);
    '; then
      grok_before="$(printf '%s' "$grok_valid" | json_semver currentVersion || true)"; grok_before="${grok_before:-none}"
      grok_latest="$(printf '%s' "$grok_valid" | json_semver latestVersion || true)"; grok_latest="${grok_latest:-none}"
      grok_operation=failed; grok_reason=update_failed
      if ! grok update --stable; then
        printf 'FAILED: grok-build stable update\n'
        update_failed=1
      elif ! grok --version >/dev/null; then
        printf 'FAILED: grok-build version after stable update\n'
        update_failed=1
        grok_reason=post_version_unavailable
      else
        grok_after_json="$(grok update --check --json)" || grok_after_json=''
        if ! grok_after_valid="$(printf '%s' "$grok_after_json" | node "$TOOLCHAIN_CONTRACT_HELPER" grok-post 2>&1)"; then
          printf 'FAILED: grok-build post-update stable contract\n'
          update_failed=1
          grok_reason=post_contract_failed
        else
          grok_after="$(printf '%s' "$grok_after_valid" | json_semver currentVersion || true)"; grok_after="${grok_after:-none}"
          grok_operation=success; grok_reason=updated
        fi
      fi
    elif [[ -n "$grok_valid" ]]; then
      grok_before="$(printf '%s' "$grok_valid" | json_semver currentVersion || true)"; grok_before="${grok_before:-none}"
      grok_latest="$(printf '%s' "$grok_valid" | json_semver latestVersion || true)"; grok_latest="${grok_latest:-none}"
      grok_after="$grok_before"; grok_operation=skipped; grok_reason=already_current
    fi
  fi
  record_toolchain grok-build "$grok_before" "$grok_latest" "$grok_operation" "$grok_after" pending "$grok_reason" || update_failed=1

  printf -- '--- factory-reporter:post-update-contract ---\n'
  if [[ ! -x "$FACTORY_REPORTER_RUNNER" ]]; then
    printf 'FAILED: factory reporter runner が実行できない: %s\n' "$FACTORY_REPORTER_RUNNER"
    report_failed=1
  else
    reporter_output="$($FACTORY_REPORTER_RUNNER --config "$FACTORY_REPORTER_CONFIG" --post-update 2>&1)"
    reporter_rc=$?
    printf '%s\n' "$reporter_output"
    post_gate="$(printf '%s\n' "$reporter_output" | node -e '
        const lines=require("fs").readFileSync(0,"utf8").trim().split(/\r?\n/).reverse();
        for(const line of lines){try{const value=JSON.parse(line);if(value&&["success","failed"].includes(value.post_gate_status)){process.stdout.write(value.post_gate_status);process.exit(0)}}catch{}}
        process.exit(1);
      ' || true)"
    if [[ "$reporter_rc" -ne 0 || "$post_gate" != success ]]; then
      printf 'FAILED: factory reporter の更新後contract gate\n'
      post_gate=failed
      report_failed=1
    fi
  fi

  [[ "$report_failed" -ne 0 ]] && post_gate=failed
  final_record_failed=0
  record_toolchain claude-code "$claude_before" "$claude_latest" "$claude_operation" "$claude_after" "$post_gate" "$claude_reason" || { update_failed=1; final_record_failed=1; }
  record_toolchain codex-cli "$codex_before" "$codex_latest" "$codex_operation" "$codex_after" "$post_gate" "$codex_reason" || { update_failed=1; final_record_failed=1; }
  record_toolchain grok-build "$grok_before" "$grok_latest" "$grok_operation" "$grok_after" "$post_gate" "$grok_reason" || { update_failed=1; final_record_failed=1; }

  # gate結果を台帳へ確定した後に、最終bytesを再投影して送る。pending状態はBugHubへ送らない。
  if [[ "$final_record_failed" -ne 0 ]]; then
    printf 'FAILED: factory reporter の最終台帳を確定できないため送信しません\n'
    report_failed=1
  elif [[ -x "$FACTORY_REPORTER_RUNNER" ]]; then
    final_output="$($FACTORY_REPORTER_RUNNER --config "$FACTORY_REPORTER_CONFIG" --finalize-update 2>&1)"
    final_rc=$?
    printf '%s\n' "$final_output"
    if [[ "$final_rc" -ne 0 ]]; then
      printf 'FAILED: factory reporter の最終update observation\n'
      report_failed=1
    fi
  fi

  printf 'agents-update result: update=%s report=%s\n' \
    "$([[ "$update_failed" -eq 0 ]] && printf success || printf failed)" \
    "$([[ "$report_failed" -eq 0 ]] && printf success || printf failed)"
  if [[ -n "${AGENTS_UPDATE_BATCH_TOKEN:-}" ]]; then
    printf 'agents-update batch-token: %s\n' "$AGENTS_UPDATE_BATCH_TOKEN"
  fi
  printf '=== agents-update end:   %s ===\n' "$(date -Iseconds)"
  if [[ "$update_failed" -ne 0 || "$report_failed" -ne 0 ]]; then
    exit 1
  fi
  exit 0
} 2>&1 | tee -a "$LOG"
