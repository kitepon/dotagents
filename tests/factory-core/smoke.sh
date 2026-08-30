#!/usr/bin/env bash
# 工場管理製品を verify-install のテスト専用最小モードで固定する。
# 実 CLI や利用者の状態には依存しない。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
HOME_DIR="$TMP/home"
PROJECT="$TMP/project"
BIN_DIR="$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$HOME_DIR/.local/bin" "$PROJECT" "$BIN_DIR"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v node)" > "$BIN_DIR/node"
chmod +x "$BIN_DIR/node"
PYTHON_RUNTIME=python3
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PYTHON_RUNTIME=python ;;
esac
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v "$PYTHON_RUNTIME")" > "$BIN_DIR/python3"
chmod +x "$BIN_DIR/python3"
for command in throughline markitdown; do
  cat > "$BIN_DIR/$command" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$BIN_DIR/$command"
done
cat > "$BIN_DIR/caveat" <<'EOF'
#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != factory-diagnostics ] || [ "$2" != --json ]; then
  exit 64
fi
if [ -n "${CAVEAT_DIAGNOSTICS_CALL_LOG:-}" ]; then
  [ ! -s "$CAVEAT_DIAGNOSTICS_CALL_LOG" ] || exit 65
  printf 'factory-diagnostics --json\n' > "$CAVEAT_DIAGNOSTICS_CALL_LOG"
fi
case "${CAVEAT_DIAGNOSTICS_MODE:-valid}" in
  valid)
    printf '%s\n' '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"0.18.1","overall":{"status":"ready"},"database":{"status":"ready"},"sync":{"status":"ready"},"connectors":{"claude":{"status":"ready"},"codex":{"status":"ready"}}}'
    exit 0
    ;;
  not_ready)
    printf '%s\n' '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"0.18.1","overall":{"status":"not_ready"}}'
    exit 1
    ;;
  invalid_schema)
    printf '%s\n' '{"schema":"caveat.native_factory_diagnostics.v2","product":"caveat","version":"0.18.1","overall":{"status":"ready"}}'
    exit 0
    ;;
  ready_nonzero)
    printf '%s\n' '{"schema":"caveat.native_factory_diagnostics.v1","product":"caveat","version":"0.18.1","overall":{"status":"ready"}}'
    exit 1
    ;;
esac
exit 64
EOF
chmod +x "$BIN_DIR/caveat"
cat > "$BIN_DIR/uv" <<'EOF'
#!/bin/sh
if [ "$1" = tool ] && [ "$2" = list ]; then
  printf '%s\n' 'markitdown 0.0.0'
  exit 0
fi
exit 64
EOF
chmod +x "$BIN_DIR/uv"

for command in oracle gpt-connector aiterm-mcp codex-sidecar-mcp lattice aishell-mcp peertable-client unai; do
  cat > "$BIN_DIR/$command" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && exit 0
exit 64
EOF
  chmod +x "$BIN_DIR/$command"
done
cat > "$BIN_DIR/codex" <<'EOF'
#!/bin/sh
if [ "$1" = mcp ] && [ "$2" = get ] && [ "$3" = aishell ] && [ "$4" = --json ]; then
  case "${CODEX_AISHELL_MODE:-valid}" in
    valid)
      printf '%s\n' '{"name":"aishell","enabled":true,"transport":{"type":"stdio","command":"aishell-mcp","args":[],"env":{"AISHELL_CAPABILITY_SET":"expanded-v1"}}}'
      ;;
    missing_env)
      printf '%s\n' '{"name":"aishell","enabled":true,"transport":{"type":"stdio","command":"aishell-mcp","args":[],"env":null}}'
      ;;
    absolute_command)
      printf '%s\n' '{"name":"aishell","enabled":true,"transport":{"type":"stdio","command":"/opt/homebrew/bin/aishell-mcp","args":[],"env":{"AISHELL_CAPABILITY_SET":"expanded-v1"}}}'
      ;;
  esac
  exit 0
fi
exit 64
EOF
chmod +x "$BIN_DIR/codex"
cat > "$BIN_DIR/claude" <<'EOF'
#!/bin/sh
if [ "$1" = mcp ] && [ "$2" = get ] && [ "$3" = aishell ]; then
  printf '%s\n' 'aishell:'
  printf '%s\n' '  Scope: User config (available in all your projects)'
  printf '%s\n' '  Status: ✔ Connected'
  printf '%s\n' '  Type: stdio'
  printf '%s\n' '  Command: aishell-mcp'
  printf '%s\n' '  Args:'
  printf '%s\n' '  Environment:'
  if [ "${CLAUDE_AISHELL_MODE:-valid}" = valid ]; then
    printf '%s\n' '    AISHELL_CAPABILITY_SET=expanded-v1'
  fi
  exit 0
fi
exit 64
EOF
chmod +x "$BIN_DIR/claude"
cat > "$HOME_DIR/.local/bin/oracle-mcp-stable" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$HOME_DIR/.local/bin/oracle-mcp-stable"

cat > "$BIN_DIR/spotter" <<'EOF'
#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != diagnostics ] || [ "$2" != factory ]; then
  exit 64
fi
if [ -n "${SPOTTER_DIAGNOSTICS_CALL_LOG:-}" ]; then
  [ ! -s "$SPOTTER_DIAGNOSTICS_CALL_LOG" ] || exit 65
  printf 'diagnostics factory\n' > "$SPOTTER_DIAGNOSTICS_CALL_LOG"
fi
case "${SPOTTER_DIAGNOSTICS_MODE:-valid}" in
  valid)
    cat <<'JSON'
{"schema_version":"1.0","product":"spotter","version":"1.6.3","overall_status":"unverified","marker_schema_version":"2","throughline_context":"disabled","catalogs":{"claude":"available","codex":"available"},"codex_hook_readiness":"configured-unverified","runtime_error_store":{"schema":"spotter.runtime_error_status.v1","collection":"disabled","store":"not_accessed","records":0,"open":0,"resolved":0,"unacknowledged":0,"latest_sequence":0,"acknowledged_through":0},"checks":[{"check_id":"project_activation","status":"pass"},{"check_id":"marker_schema","status":"pass"},{"check_id":"throughline_context","status":"skipped","reason_code":"evaluation_evidence_disabled"},{"check_id":"claude_catalog","status":"pass"},{"check_id":"codex_catalog","status":"pass"},{"check_id":"audit_catalog_readiness","status":"pass"},{"check_id":"codex_hooks","status":"unverified","reason_code":"trust_not_machine_verifiable"}]}
JSON
    ;;
  inactive)
    cat <<'JSON'
{"schema_version":"1.0","product":"spotter","version":"1.6.3","overall_status":"not_applicable","marker_schema_version":null,"throughline_context":"unverified","catalogs":{"claude":"not_applicable","codex":"not_applicable"},"codex_hook_readiness":"not_applicable","runtime_error_store":{"schema":"spotter.runtime_error_status.v1","collection":"disabled","store":"not_accessed","records":0,"open":0,"resolved":0,"unacknowledged":0,"latest_sequence":0,"acknowledged_through":0},"checks":[{"check_id":"project_activation","status":"skipped","reason_code":"project_not_activated"}]}
JSON
    ;;
  missing_catalog)
    cat <<'JSON'
{"schema_version":"1.0","product":"spotter","version":"1.6.3","overall_status":"unverified","marker_schema_version":"2","throughline_context":"disabled","catalogs":{"claude":"missing","codex":"available"},"codex_hook_readiness":"configured-unverified","runtime_error_store":{"schema":"spotter.runtime_error_status.v1","collection":"disabled","store":"not_accessed","records":0,"open":0,"resolved":0,"unacknowledged":0,"latest_sequence":0,"acknowledged_through":0},"checks":[{"check_id":"project_activation","status":"pass"},{"check_id":"marker_schema","status":"pass"},{"check_id":"throughline_context","status":"skipped","reason_code":"evaluation_evidence_disabled"},{"check_id":"claude_catalog","status":"skipped","reason_code":"catalog_missing"},{"check_id":"codex_catalog","status":"pass"},{"check_id":"audit_catalog_readiness","status":"pass"},{"check_id":"codex_hooks","status":"unverified","reason_code":"trust_not_machine_verifiable"}]}
JSON
    ;;
  failed)
    cat <<'JSON'
{"schema_version":"1.0","product":"spotter","version":"1.6.3","overall_status":"fail","marker_schema_version":null,"throughline_context":"disabled","catalogs":{"claude":"available","codex":"available"},"codex_hook_readiness":"configured-unverified","runtime_error_store":{"schema":"spotter.runtime_error_status.v1","collection":"disabled","store":"not_accessed","records":0,"open":0,"resolved":0,"unacknowledged":0,"latest_sequence":0,"acknowledged_through":0},"checks":[{"check_id":"project_activation","status":"pass"},{"check_id":"marker_schema","status":"fail","reason_code":"unsupported_marker_schema"},{"check_id":"throughline_context","status":"skipped","reason_code":"evaluation_evidence_disabled"},{"check_id":"claude_catalog","status":"pass"},{"check_id":"codex_catalog","status":"pass"},{"check_id":"audit_catalog_readiness","status":"pass"},{"check_id":"codex_hooks","status":"unverified","reason_code":"trust_not_machine_verifiable"}]}
JSON
    ;;
  invalid_schema)
    printf '%s\n' '{"schema_version":"2.0","product":"spotter","version":"1.6.3","overall_status":"pass","checks":[]}'
    ;;
esac
exit 0
EOF
chmod +x "$BIN_DIR/spotter"

SERVERMANAGER_TEST_READY_URL='data:application/json,{"checks":[{"id":"database","status":"pass"},{"id":"schema","status":"pass"},{"id":"source_revision","status":"pass"}],"source_revision":"fixture-revision"}'
verify_core() {
  : > "$TMP/caveat-diagnostics.calls"
  : > "$TMP/spotter-diagnostics.calls"
  HOME="$HOME_DIR" PATH="$BIN_DIR:/usr/bin:/bin" \
    SERVERMANAGER_READY_URL="$SERVERMANAGER_TEST_READY_URL" \
    DOTAGENTS_FACTORY_CORE_ONLY=1 \
    DOTAGENTS_FACTORY_PROJECT_ROOT="$PROJECT" \
    CAVEAT_DIAGNOSTICS_CALL_LOG="$TMP/caveat-diagnostics.calls" \
    SPOTTER_DIAGNOSTICS_CALL_LOG="$TMP/spotter-diagnostics.calls" \
    "$ROOT/bin/verify-install.sh" --profile official
}

assert_rejected() {
  local label="$1"
  if verify_core >/dev/null 2>&1; then
    fail "$label を成功扱いした"
  fi
}

[ "$(grep -Ec '^  advisory:$' "$ROOT/.codex-sidecar.yml")" -eq 1 ] || fail 'codex-sidecar advisory preset がない'

verify_core || fail '有効な factory core fixture が verify-install に拒否された'
[ "$(wc -l < "$TMP/caveat-diagnostics.calls" | tr -d ' ')" -eq 1 ] || fail 'Caveat diagnosticsを一回だけ呼んでいない'
[ "$(wc -l < "$TMP/spotter-diagnostics.calls" | tr -d ' ')" -eq 1 ] || fail 'Spotter diagnosticsを一回だけ呼んでいない'

mv "$BIN_DIR/caveat" "$BIN_DIR/caveat.off"
assert_rejected 'caveat CLI 欠落'
mv "$BIN_DIR/caveat.off" "$BIN_DIR/caveat"

mv "$BIN_DIR/throughline" "$BIN_DIR/throughline.off"
assert_rejected 'throughline CLI 欠落'
mv "$BIN_DIR/throughline.off" "$BIN_DIR/throughline"

mv "$BIN_DIR/markitdown" "$BIN_DIR/markitdown.off"
assert_rejected 'markitdown CLI 欠落'
mv "$BIN_DIR/markitdown.off" "$BIN_DIR/markitdown"

cat > "$BIN_DIR/codegraph" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$BIN_DIR/codegraph"
assert_rejected 'retired codegraph CLI残存'
rm "$BIN_DIR/codegraph"

mv "$BIN_DIR/uv" "$BIN_DIR/uv.off"
assert_rejected 'uv CLI 欠落'
mv "$BIN_DIR/uv.off" "$BIN_DIR/uv"

mv "$BIN_DIR/spotter" "$BIN_DIR/spotter.off"
assert_rejected 'spotter CLI 欠落'
mv "$BIN_DIR/spotter.off" "$BIN_DIR/spotter"

for command in aiterm-mcp codex-sidecar-mcp lattice peertable-client unai; do
  mv "$BIN_DIR/$command" "$BIN_DIR/$command.off"
  assert_rejected "$command CLI 欠落"
  mv "$BIN_DIR/$command.off" "$BIN_DIR/$command"
done

if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] \
  && [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ]; then
  mv "$BIN_DIR/aishell-mcp" "$BIN_DIR/aishell-mcp.off"
  assert_rejected 'aishell-mcp CLI 欠落'
  mv "$BIN_DIR/aishell-mcp.off" "$BIN_DIR/aishell-mcp"
  CODEX_AISHELL_MODE=missing_env assert_rejected 'Codex AIShell expanded-v1欠落'
  CODEX_AISHELL_MODE=absolute_command assert_rejected 'Codex AIShell absolute command'
  CLAUDE_AISHELL_MODE=missing_env assert_rejected 'Claude AIShell expanded-v1欠落'
fi

# Oracle はv1 rollback互換だけに残す。v2の通常導入・更新対象ではないため、
# v2 factory core smokeはOracle wrapperの正常性を要求しない。

CAVEAT_DIAGNOSTICS_MODE=not_ready assert_rejected 'Caveat diagnostics not_ready'
CAVEAT_DIAGNOSTICS_MODE=invalid_schema assert_rejected 'Caveat diagnostics schema不一致'
CAVEAT_DIAGNOSTICS_MODE=ready_nonzero assert_rejected 'Caveat diagnostics exit不一致'

SPOTTER_DIAGNOSTICS_MODE=inactive assert_rejected 'Spotter project非activation'
SPOTTER_DIAGNOSTICS_MODE=missing_catalog assert_rejected 'Spotter host catalog欠落'
SPOTTER_DIAGNOSTICS_MODE=failed assert_rejected 'Spotter diagnostics fail'
SPOTTER_DIAGNOSTICS_MODE=invalid_schema assert_rejected 'Spotter diagnostics schema不一致'

printf 'factory core smoke: OK\n'
