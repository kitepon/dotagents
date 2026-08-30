#!/usr/bin/env bash
# Linux / WSL2 の cron 最小環境で agents-update が NVM の npm を復元することを検証する。
set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*) printf 'agents-update cron env: SKIP — Windows native は cron/NVM 対象外\n'; exit 0 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_HOME="$(mktemp -d)"
EMPTY_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME" "$EMPTY_HOME"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TEST_HOME/.nvm/fake-bin" "$TEST_HOME/base-bin" "$TEST_HOME/npm-global/bin" "$TEST_HOME/shadow-bin" "$TEST_HOME/.local/bin"
mkdir -p "$TEST_HOME/system-bin"
for command_path in /bin/date /bin/mkdir /usr/bin/tee "$(command -v readlink)" "$(command -v node)" "$(command -v uname)"; do
  [ -x "$command_path" ] || fail "test prerequisite がない: $command_path"
  ln -s "$command_path" "$TEST_HOME/base-bin/${command_path##*/}"
done
cat > "$TEST_HOME/.local/bin/curl" <<'EOF'
#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ] || exit 64
printf ':\n' > "$output"
/bin/cat > "$HOME/.local/bin/unai" <<'UNAI'
#!/bin/sh
case "$*" in
  --version) printf '0.4.0\n' ;;
  'factory-diagnostics --json') printf '%s\n' '{"schema":"unai.native_factory_diagnostics.v2","product":{"name":"unai","version":"0.4.0"},"overall":"ready","checks":{"manifest_consistency":"pass","node_runtime":"pass","skill_bundle":"pass","skill_projections":{"claude":"ready","codex":"ready","grok":"ready","cursor":"ready"}}}' ;;
  *) exit 64 ;;
esac
UNAI
/bin/chmod +x "$HOME/.local/bin/unai"
EOF
chmod +x "$TEST_HOME/.local/bin/curl"
cat > "$TEST_HOME/.nvm/nvm.sh" <<'EOF'
PATH="$NVM_DIR/fake-bin:$PATH"
export PATH
EOF
cat > "$TEST_HOME/.nvm/fake-bin/npm" <<'EOF'
#!/bin/sh
case "$*" in
  'prefix -g') printf '%s\n' "${NPM_PREFIX:-$HOME/npm-global}"; exit 0 ;;
  'view @anthropic-ai/claude-code version --json')
    if [ -n "${NPM_CLAUDE_LATEST_JSON+x}" ]; then printf '%s\n' "$NPM_CLAUDE_LATEST_JSON"; else echo '"2.1.207"'; fi
    exit 0 ;;
  'view @openai/codex version --json') echo '"0.144.3"'; exit 0 ;;
esac
printf '%s:%s\n' "${RUN_ID:-default}" "$*" >> "$HOME/npm-calls.log"
printf 'npm:%s\n' "$*" >> "$HOME/update-events.log"
case "${NPM_FAIL_PACKAGE:-}" in
  '') exit 0 ;;
esac
case "$*" in
  *"${NPM_FAIL_PACKAGE}@latest"*) exit 23 ;;
esac
EOF
chmod +x "$TEST_HOME/.nvm/fake-bin/npm"
cat > "$TEST_HOME/system-bin/npm" <<'EOF'
#!/bin/sh
printf 'system-npm:%s\n' "$*" >> "$HOME/update-events.log"
exit 91
EOF
chmod +x "$TEST_HOME/system-bin/npm"
cat > "$TEST_HOME/.nvm/fake-bin/claude" <<'EOF'
#!/bin/sh
echo '2.1.207'
EOF
cat > "$TEST_HOME/.nvm/fake-bin/codex" <<'EOF'
#!/bin/sh
echo '0.144.3'
EOF
chmod +x "$TEST_HOME/.nvm/fake-bin/claude" "$TEST_HOME/.nvm/fake-bin/codex"
cat > "$TEST_HOME/npm-global/bin/claude" <<'EOF'
#!/bin/sh
printf '%s:global-claude\n' "${RUN_ID:-default}" >> "$HOME/cli-calls.log"
count_file="$HOME/${RUN_ID:-default}-claude-version-count"
count=0; [ ! -f "$count_file" ] || IFS= read -r count < "$count_file"
count=$((count + 1)); printf '%s' "$count" > "$count_file"
if [ "${CLAUDE_DISAPPEAR_AFTER_FIRST:-0}" -eq 1 ] && [ "$count" -gt 1 ]; then exit 127; fi
echo "${CLAUDE_VERSION:-2.1.207}"
EOF
cat > "$TEST_HOME/npm-global/bin/codex" <<'EOF'
#!/bin/sh
printf '%s:global-codex\n' "${RUN_ID:-default}" >> "$HOME/cli-calls.log"
echo '0.144.3'
EOF
cat > "$TEST_HOME/npm-global/bin/throughline" <<'EOF'
#!/bin/sh
printf '%s:throughline:%s\n' "${RUN_ID:-default}" "$*" >> "$HOME/update-events.log"
[ "$*" = 'self-update --json' ] || exit 64
if [ "${THROUGHLINE_SELF_UPDATE_FAIL:-0}" -eq 1 ]; then
  echo '{"schema":"throughline.self_update.v1","status":"failed","stage":"database_migration_failed"}'
  exit 1
fi
if [ "${THROUGHLINE_SELF_UPDATE_OPAQUE:-0}" -eq 1 ]; then echo 'product-owned-output'; exit 0; fi
echo '{"schema":"throughline.self_update.v1","status":"already_current"}'
EOF
cat > "$TEST_HOME/shadow-bin/claude" <<'EOF'
#!/bin/sh
printf '%s:shadow-claude\n' "${RUN_ID:-default}" >> "$HOME/cli-calls.log"
echo '2.1.128'
EOF
cat > "$TEST_HOME/shadow-bin/codex" <<'EOF'
#!/bin/sh
printf '%s:shadow-codex\n' "${RUN_ID:-default}" >> "$HOME/cli-calls.log"
echo '0.144.2'
EOF
chmod +x "$TEST_HOME/npm-global/bin/claude" "$TEST_HOME/npm-global/bin/codex" \
  "$TEST_HOME/npm-global/bin/throughline" \
  "$TEST_HOME/shadow-bin/claude" "$TEST_HOME/shadow-bin/codex"
cat > "$TEST_HOME/.nvm/fake-bin/uv" <<'EOF'
#!/bin/sh
printf '%s:%s\n' "${RUN_ID:-default}" "$*" >> "$HOME/uv-calls.log"
printf 'uv:%s\n' "$*" >> "$HOME/update-events.log"
if [ "$*" = 'tool list' ]; then
  [ "${UV_LIST_FAIL:-0}" -eq 1 ] && exit 25
  [ "${UV_MARKITDOWN_ABSENT:-0}" -eq 1 ] || echo 'markitdown 0.1.0'
  exit 0
fi
case "${UV_FAIL_PACKAGE:-}" in
  '') exit 0 ;;
esac
case "$*" in
  *"${UV_FAIL_PACKAGE}"*) exit 24 ;;
esac
EOF
chmod +x "$TEST_HOME/.nvm/fake-bin/uv"
cat > "$TEST_HOME/base-bin/factory-reporter-schedule-runner" <<'EOF'
#!/bin/sh
printf '%s:%s\n' "${RUN_ID:-default}" "$*" >> "$HOME/reporter-calls.log"
printf 'reporter:%s\n' "$*" >> "$HOME/update-events.log"
if [ "${REPORT_FAIL:-0}" -ne 0 ]; then exit 1; fi
case "$*" in
  *--post-update) echo '{"ok":true,"post_gate_status":"success"}' ;;
  *--finalize-update)
    node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(Object.values(v.products).some((r)=>r.post_gate_status==="pending"))process.exit(1)' "$HOME/.local/state/agents-update/toolchain-ledger.json" || exit 25
    echo '{"ok":true,"finalized":true}' ;;
esac
EOF
chmod +x "$TEST_HOME/base-bin/factory-reporter-schedule-runner"
cat > "$TEST_HOME/.nvm/fake-bin/grok" <<'EOF'
#!/bin/sh
printf '%s:grok:%s\n' "${RUN_ID:-default}" "$*" >> "$HOME/update-events.log"
case "$*" in
  'update --check --json')
    if [ -n "${GROK_CHECK_JSON+x}" ]; then printf '%s\n' "$GROK_CHECK_JSON"; elif [ -f "$HOME/grok-updated" ]; then echo '{"currentVersion":"0.2.1","latestVersion":"0.2.1","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}'; else echo '{"currentVersion":"0.2.0","latestVersion":"0.2.1","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}'; fi ;;
  'update --stable') : > "$HOME/grok-updated" ;;
  --version) [ "${GROK_VERSION_MISSING:-0}" -ne 1 ] || exit 127; echo '0.2.1' ;;
esac
EOF
chmod +x "$TEST_HOME/.nvm/fake-bin/grok"

REPORTER="$TEST_HOME/base-bin/factory-reporter-schedule-runner"
REPORTER_CONFIG="$TEST_HOME/factory-reporter.json"

if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=normal \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/normal.out" 2>&1; then
  cat "$TEST_HOME/normal.out" >&2
  fail '正常fixtureのagents-updateが失敗した'
fi

expected_npm_packages=13
if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  expected_npm_packages=14
fi
node --input-type=module - <<'EOF' || fail 'OS/arch別npm package集合がdeployment contractと一致しない'
import { npmPackagesForHost } from './lib/factory/deployment-contract.mjs';
const base = ['@anthropic-ai/claude-code','@openai/codex','gpt-connector','@anthropic-ai/sdk','aiterm-mcp','caveat-cli','claude-spotter','codex-sidecar-cli','codex-sidecar-core','codex-sidecar-mcp','@quolu/lattice','peertable','pnpm','throughline'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!same(npmPackagesForHost({ os: 'Linux', arch: 'x64' }), base)
 || !same(npmPackagesForHost({ os: 'Windows_NT', arch: 'x64' }), base)
 || !same(npmPackagesForHost({ os: 'Darwin', arch: 'x64' }), [...base])
 || !same(npmPackagesForHost({ os: 'Darwin', arch: 'arm64' }), [...base, '@quolu/aishell'])) process.exit(1);
EOF
[ "$(grep -c '^normal:' "$TEST_HOME/npm-calls.log")" -eq "$expected_npm_packages" ] \
  || fail "curated package集合を fake npm へ正確に渡していない"
grep -q '^normal:install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest$' \
  "$TEST_HOME/npm-calls.log" || fail 'Claude Code lifecycle scriptをpackage限定で許可しない'
grep -q '^normal:install -g --allow-scripts=claude-spotter claude-spotter@latest$' \
  "$TEST_HOME/npm-calls.log" || fail 'Spotter lifecycle scriptをpackage限定で許可しない'
if grep -q '@colbymchenry/codegraph' "$TEST_HOME/npm-calls.log"; then
  fail 'retired Codegraphを更新対象へ再導入している'
fi
[ "$(grep -c '^normal:tool upgrade markitdown$' "$TEST_HOME/uv-calls.log")" -eq 1 ] \
  || fail 'markitdown を fake uv tool upgrade へ1件渡していない'
[ "$(grep -c '^normal:throughline:self-update --json$' "$TEST_HOME/update-events.log")" -eq 1 ] \
  || fail 'Throughline製品所有self-update入口を1回だけ実行していない'
[ "$(grep -Fc 'throughline self-update --json' "$ROOT/bin/agents-update.sh")" -eq 1 ] \
  || fail '工場updater内のThroughline公開更新入口が一回呼出しに閉じていない'
if grep -Eq 'throughline migrate|throughline\.database_migration|validate_throughline_migration' "$ROOT/bin/agents-update.sh"; then
  fail '工場updaterがThroughline migrationのcommand/schema/意味を再所有している'
fi
[ "$(grep -c '^normal:--config '"$REPORTER_CONFIG"' --post-update$' "$TEST_HOME/reporter-calls.log")" -eq 1 ] \
  || fail '更新後に factory reporter を1回実行していない'
[ "$(grep -c '^normal:--config '"$REPORTER_CONFIG"' --finalize-update$' "$TEST_HOME/reporter-calls.log")" -eq 1 ] \
  || fail 'gate確定後に最終update observationを1回実行していない'
[ "$(tail -n 1 "$TEST_HOME/update-events.log")" = "reporter:--config $REPORTER_CONFIG --finalize-update" ] \
  || fail 'factory reporter が更新処理より前に実行された'
normal_migration_line="$(grep -n '^normal:throughline:self-update --json$' "$TEST_HOME/update-events.log" | cut -d: -f1)"
normal_report_line="$(grep -n "^reporter:--config $REPORTER_CONFIG --post-update$" "$TEST_HOME/update-events.log" | head -n 1 | cut -d: -f1)"
[ "$normal_migration_line" -lt "$normal_report_line" ] \
  || fail 'Throughline self-updateより先にfactory reporterを実行した'
if grep -q '^normal:install -g throughline@latest$' "$TEST_HOME/npm-calls.log"; then
  fail '工場がThroughline package更新を製品入口の外で実行した'
fi
grep -q '^normal:grok:update --check --json$' "$TEST_HOME/update-events.log" \
  || fail 'Grok stable update check を実行していない'
grep -q '^normal:grok:update --stable$' "$TEST_HOME/update-events.log" \
  || fail 'Grok update_available時にstable updateを実行していない'
grep -q '^normal:grok:--version$' "$TEST_HOME/update-events.log" \
  || fail 'Grok stable update後のversion確認がない'
grep -q '=== agents-update end:' "$TEST_HOME/.local/state/agents-update/agents-update.log" \
  || fail '完了行がない'
node -e '
  const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if(v.schema_version!=="dotagents.toolchain-update.v1")process.exit(1);
  for(const id of ["claude-code","codex-cli","grok-build"]){const r=v.products[id];if(!r||r.post_gate_status!=="success"||!["success","skipped"].includes(r.operation_status))process.exit(1)}
' "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" \
  || fail '3基盤CLIの更新前後・post-gate台帳を保存していない'

if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=system-npm-shadow \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/system-npm-shadow.out" 2>&1; then
  cat "$TEST_HOME/system-npm-shadow.out" >&2
  fail 'system npmが存在する環境でNVM npmを復元できない'
fi
if grep -q '^system-npm:' "$TEST_HOME/update-events.log"; then
  fail 'system npmをNVM npmより優先した'
fi

if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/shadow-bin:$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=path-shadow \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/path-shadow.out" 2>&1; then
  cat "$TEST_HOME/path-shadow.out" >&2
  fail 'npm global binより前にshadow CLIがあってもagents-updateが失敗した'
fi
grep -q '^path-shadow:global-claude$' "$TEST_HOME/cli-calls.log" \
  || fail 'npm global prefixのclaudeをversion判定に使っていない'
grep -q '^path-shadow:global-codex$' "$TEST_HOME/cli-calls.log" \
  || fail 'npm global prefixのcodexをversion判定に使っていない'
if grep -q '^path-shadow:shadow-' "$TEST_HOME/cli-calls.log"; then
  fail 'PATH shadowされた旧CLIをversion判定に使った'
fi

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  NPM_CLAUDE_LATEST_JSON='{"version":"2.1.207"}' RUN_ID=registry-drift \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/registry-drift.out" 2>&1; then
  fail 'npm registry objectをlatest versionとして受理した'
fi
if grep -q '^registry-drift:install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest$' "$TEST_HOME/npm-calls.log"; then
  fail 'npm registry schema drift時にClaude Codeを更新した'
fi
grep -q '^registry-drift:install -g @openai/codex@latest$' "$TEST_HOME/npm-calls.log" \
  || fail 'Claude Code registry drift後に独立したCodex更新を継続しなかった'
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["claude-code"];if(r.reason_code!=="registry_unavailable"||r.operation_status!=="failed")process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail 'registry driftを台帳へfailed記録しない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  NPM_CLAUDE_LATEST_JSON='"unknown"' RUN_ID=registry-unknown \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/registry-unknown.out" 2>&1; then
  fail 'npm registry unknown versionを更新成功扱いした'
fi
if grep -q '^registry-unknown:install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest$' "$TEST_HOME/npm-calls.log"; then
  fail 'npm registry unknown version時にClaude Codeを更新した'
fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["claude-code"];if(r.reason_code!=="registry_unavailable"||r.latest_version!==null)process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail 'unknown latestを推測せず台帳へ保存しない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  CLAUDE_VERSION=2.2.0 RUN_ID=npm-downgrade \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/npm-downgrade.out" 2>&1; then
  fail 'installed > registry latestを更新成功扱いした'
fi
if grep -q '^npm-downgrade:install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest$' "$TEST_HOME/npm-calls.log"; then
  fail 'npm downgradeを実行した'
fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["claude-code"];if(r.reason_code!=="downgrade_refused"||r.before_version!=="2.2.0"||r.after_version!=="2.2.0")process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail 'npm downgrade拒否を台帳へ保存しない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  CLAUDE_DISAPPEAR_AFTER_FIRST=1 RUN_ID=post-cli-missing \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/post-cli-missing.out" 2>&1; then
  fail '更新後CLI消失を成功扱いした'
fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["claude-code"];if(r.reason_code!=="post_version_unavailable"||r.after_version!==null)process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail '更新後CLI消失を台帳へ保存しない'

rm -f "$TEST_HOME/grok-updated"
if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  GROK_CHECK_JSON='{"currentVersion":"0.2.2","latestVersion":"0.2.1","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}' \
  RUN_ID=grok-downgrade /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/grok-downgrade.out" 2>&1; then
  fail 'Grok current > latestを更新成功扱いした'
fi
if grep -q '^grok-downgrade:grok:update --stable$' "$TEST_HOME/update-events.log"; then
  fail 'Grok downgradeを実行した'
fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["grok-build"];if(r.reason_code!=="downgrade_refused"||r.operation_status!=="failed")process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail 'Grok downgrade拒否を台帳へ保存しない'

rm -f "$TEST_HOME/grok-updated"
if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  GROK_VERSION_MISSING=1 RUN_ID=grok-post-missing \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/grok-post-missing.out" 2>&1; then
  fail 'Grok更新後CLI消失を成功扱いした'
fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).products["grok-build"];if(r.reason_code!=="post_version_unavailable"||r.operation_status!=="failed")process.exit(1)' \
  "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" || fail 'Grok更新後CLI消失を台帳へ保存しない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/shadow-bin:$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  NPM_PREFIX='relative-prefix' \
  RUN_ID=invalid-prefix \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/invalid-prefix.out" 2>&1; then
  fail '不正なnpm global prefixを成功扱いした'
fi
grep -q '^FAILED: npm global prefix/bin が不正または利用不能$' "$TEST_HOME/invalid-prefix.out" \
  || fail '不正なnpm global prefixを名指ししない'

# Fresh Windows/npm installations may expose a valid absolute prefix before
# its command directory exists.  The bootstrap owns creating that directory.
fresh_prefix="$TEST_HOME/fresh-npm-global"
rm -rf "$fresh_prefix"
env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" FACTORY_REPORTER_RUNNER="$REPORTER" \
  TOOLCHAIN_LEDGER_FILE="$TEST_HOME/fresh-prefix-ledger.json" \
  NPM_PREFIX="$fresh_prefix" RUN_ID=fresh-prefix \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/fresh-prefix.out" 2>&1 || true
[ ! -e "$fresh_prefix" ] && fail '正規npm global prefixを初回bootstrapで作成しない'
[ -d "$fresh_prefix/bin" ] || fail '正規npm global binを初回bootstrapで作成しない'
if grep -q '^FAILED: npm global prefix/bin が不正または利用不能$' "$TEST_HOME/fresh-prefix.out"; then
  fail '存在前の正規npm global prefixを不正扱いした'
fi
if grep -q '^invalid-prefix:shadow-' "$TEST_HOME/cli-calls.log"; then
  fail '不正prefix時にPATH shadowされたCLIでversion判定した'
fi

# install.sh の配布面は agents-update と ledger helper の拡張子を落とした symlink になる。
# source 実行と同じ helper を解決できなければ、実 package 更新なしのこのfixtureでも非0になる。
mkdir -p "$TEST_HOME/distributed-bin"
ln -s "$ROOT/bin/agents-update.sh" "$TEST_HOME/distributed-bin/agents-update"
ln -s "$ROOT/bin/factory-toolchain-ledger.mjs" "$TEST_HOME/distributed-bin/factory-toolchain-ledger"
if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=distributed-symlink \
  /bin/bash "$TEST_HOME/distributed-bin/agents-update" >"$TEST_HOME/distributed-symlink.out" 2>&1; then
  cat "$TEST_HOME/distributed-symlink.out" >&2
  fail '配布symlink経由のagents-updateが失敗した'
fi
distributed_npm_packages="$(grep -c '^distributed-symlink:' "$TEST_HOME/npm-calls.log")"
[ "$distributed_npm_packages" -eq "$expected_npm_packages" ] \
  || fail "配布symlink経由のcurated package件数が不正: actual=${distributed_npm_packages} expected=${expected_npm_packages}"
if grep -q 'MODULE_NOT_FOUND' "$TEST_HOME/distributed-symlink.out"; then
  fail '配布symlink経由でledger helperを誤った拡張子付きpathへ解決した'
fi

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=npm-fail \
  NPM_FAIL_PACKAGE='claude-spotter' \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/fail.out" 2>&1; then
  fail '途中の npm install 失敗を成功扱いした'
fi
[ "$(grep -c '^npm-fail:' "$TEST_HOME/npm-calls.log")" -eq "$expected_npm_packages" ] \
  || fail '途中失敗後も残り package を更新しなかった'
grep -q '^FAILED: claude-spotter$' "$TEST_HOME/.local/state/agents-update/agents-update.log" \
  || fail '失敗した package 名を log に残さない'
grep -q '^npm-fail:install -g codex-sidecar-mcp@latest$' "$TEST_HOME/npm-calls.log" \
  || fail '途中失敗後の package を fake npm へ渡していない'
[ "$(grep -c '^npm-fail:tool upgrade markitdown$' "$TEST_HOME/uv-calls.log")" -eq 1 ] \
  || fail 'npm 失敗後も uv tool upgrade を継続しなかった'
[ "$(grep -c '^npm-fail:' "$TEST_HOME/reporter-calls.log")" -eq 2 ] \
  || fail 'npm 失敗後に factory reporter を実行しなかった'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=throughline-self-update-fail \
  THROUGHLINE_SELF_UPDATE_FAIL=1 \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/throughline-self-update-fail.out" 2>&1; then
  fail 'Throughline self-update失敗を更新成功扱いした'
fi
grep -q '^FAILED: throughline self-update$' "$TEST_HOME/throughline-self-update-fail.out" \
  || fail 'Throughline self-update失敗を名指ししない'
[ "$(grep -c '^throughline-self-update-fail:' "$TEST_HOME/reporter-calls.log")" -eq 2 ] \
  || fail 'Throughline self-update失敗後もfactory reporterを実行していない'

if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=throughline-self-update-opaque \
  THROUGHLINE_SELF_UPDATE_OPAQUE=1 \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/throughline-self-update-opaque.out" 2>&1; then
  cat "$TEST_HOME/throughline-self-update-opaque.out" >&2
  fail '工場が製品所有self-update出力の内部意味を解釈した'
fi
[ "$(grep -c '^throughline-self-update-opaque:throughline:self-update --json$' "$TEST_HOME/update-events.log")" -eq 1 ] \
  || fail 'Throughline self-update出力をopaqueに扱うfixtureが入口を1回だけ呼ばない'

mv "$TEST_HOME/.nvm/fake-bin/uv" "$TEST_HOME/.nvm/fake-bin/uv.off"
if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=uv-missing \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/uv-missing.out" 2>&1; then
  fail 'uv 不在を成功扱いした'
fi
[ "$(grep -c '^uv-missing:' "$TEST_HOME/npm-calls.log")" -eq "$expected_npm_packages" ] \
  || fail 'uv 不在時に npm の残件を更新しなかった'
[ "$(grep -c '^uv-missing:' "$TEST_HOME/reporter-calls.log")" -eq 2 ] \
  || fail 'uv 不在時に factory reporter を実行しなかった'
mv "$TEST_HOME/.nvm/fake-bin/uv.off" "$TEST_HOME/.nvm/fake-bin/uv"

if ! env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=uv-absent UV_MARKITDOWN_ABSENT=1 \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/uv-absent.out" 2>&1; then
  cat "$TEST_HOME/uv-absent.out" >&2
  fail 'MarkItDown absent→install fixtureが失敗した'
fi
[ "$(grep -c '^uv-absent:tool install --force markitdown$' "$TEST_HOME/uv-calls.log")" -eq 1 ] \
  || fail 'MarkItDown absent時にuv tool install --forceでuv ownershipを収束していない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=uv-list-fail UV_LIST_FAIL=1 \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/uv-list-fail.out" 2>&1; then
  cat "$TEST_HOME/uv-list-fail.out" >&2
  fail 'MarkItDown list失敗を更新成功扱いした'
fi
grep -q '^FAILED: MarkItDown uv tool list$' "$TEST_HOME/.local/state/agents-update/agents-update.log" \
  || fail 'uv tool list失敗を製品名付きで記録しない'
if grep -q '^uv-list-fail:tool \(install\|upgrade\) markitdown$' "$TEST_HOME/uv-calls.log"; then
  fail 'uv tool list失敗後にMarkItDownを更新している'
fi

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=uv-fail \
  UV_FAIL_PACKAGE='markitdown' \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/uv-fail.out" 2>&1; then
  fail 'uv tool upgrade 失敗を成功扱いした'
fi
[ "$(grep -c '^uv-fail:' "$TEST_HOME/npm-calls.log")" -eq "$expected_npm_packages" ] \
  || fail 'uv tool upgrade 失敗時に npm の残件を更新しなかった'
[ "$(grep -c '^uv-fail:tool upgrade markitdown$' "$TEST_HOME/uv-calls.log")" -eq 1 ] \
  || fail 'uv tool upgrade を実行していない'
grep -q '^FAILED: MarkItDown uv tool upgrade$' "$TEST_HOME/.local/state/agents-update/agents-update.log" \
  || fail 'uv 失敗した package 名を log に残さない'

if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  RUN_ID=report-fail \
  REPORT_FAIL=1 \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/report-fail.out" 2>&1; then
  fail 'factory reporter 失敗を成功扱いした'
fi
[ "$(grep -c '^report-fail:' "$TEST_HOME/npm-calls.log")" -eq "$expected_npm_packages" ] \
  || fail 'reporter 失敗の試験で更新処理を省略した'
grep -q '^agents-update result: update=success report=failed$' "$TEST_HOME/report-fail.out" \
  || fail '更新成功とreport失敗を区別していない'
node -e '
  const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if(Object.values(v.products).some((r)=>r.post_gate_status!=="failed"))process.exit(1)
' "$TEST_HOME/.local/state/agents-update/toolchain-ledger.json" \
  || fail 'report失敗を3基盤CLIのpost-gate台帳へ反映していない'

cat > "$TEST_HOME/base-bin/failing-ledger-helper.mjs" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const path = `${process.env.HOME}/ledger-helper-count`;
let count = 0;
try { count = Number(readFileSync(path, 'utf8')); } catch {}
count += 1; writeFileSync(path, String(count));
if (count > 3) process.exit(42);
EOF
if env -i HOME="$TEST_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$REPORTER_CONFIG" \
  TOOLCHAIN_LEDGER_HELPER="$TEST_HOME/base-bin/failing-ledger-helper.mjs" \
  RUN_ID=ledger-fail \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$TEST_HOME/ledger-fail.out" 2>&1; then
  fail '最終台帳record失敗を成功扱いした'
fi
[ "$(grep -c '^ledger-fail:' "$TEST_HOME/reporter-calls.log")" -eq 1 ] \
  || fail '最終台帳record失敗後にfinalizeを呼んだ'
grep -q '最終台帳を確定できないため送信しません' "$TEST_HOME/ledger-fail.out" \
  || fail '最終台帳record失敗の送信停止理由を名指ししない'

if env -i HOME="$EMPTY_HOME" PATH="$TEST_HOME/base-bin" \
  AGENTS_UPDATE_PATH_PREFIX="$TEST_HOME/no-system-bin" \
  FACTORY_REPORTER_RUNNER="$REPORTER" \
  FACTORY_REPORTER_CONFIG="$EMPTY_HOME/factory-reporter.json" \
  RUN_ID=npm-missing \
  /bin/bash "$ROOT/bin/agents-update.sh" >"$EMPTY_HOME/out.log" 2>&1; then
  fail 'npm / NVM 不在を成功扱いした'
fi
grep -q '^FAILED: npm が PATH にない' "$EMPTY_HOME/out.log" \
  || fail 'npm 不在の原因を名指ししない'
[ "$(grep -c '^npm-missing:' "$EMPTY_HOME/reporter-calls.log")" -eq 2 ] \
  || fail 'npm / NVM 不在でも factory reporter を実行しなかった'

echo 'agents-update cron env: OK'
