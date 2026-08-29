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

mkdir -p "$HOME_DIR/.caveat/own" "$HOME_DIR/.local/bin" "$PROJECT/.spotter" "$PROJECT/.claude" "$BIN_DIR"
for runtime in node git; do
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v "$runtime")" > "$BIN_DIR/$runtime"
  chmod +x "$BIN_DIR/$runtime"
done
PYTHON_RUNTIME=python3
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PYTHON_RUNTIME=python ;;
esac
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v "$PYTHON_RUNTIME")" > "$BIN_DIR/python3"
chmod +x "$BIN_DIR/python3"
git -C "$HOME_DIR/.caveat/own" init -q
git -C "$HOME_DIR/.caveat/own" remote add origin 'git@github.com:kitepon-rgb/Caveat-Private.git'
cat > "$PROJECT/.spotter/marker.json" <<EOF
{"markerVersion":"2","auditorContext":{"mode":"throughline","command":"$BIN_DIR/throughline"}}
EOF
printf '{}\n' > "$PROJECT/.spotter/tool-db.json"
printf '{}\n' > "$PROJECT/.spotter/tool-db.codex.json"
cat > "$PROJECT/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "spotter.mjs hook session-start"}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "spotter.mjs hook user-prompt"}]}],
    "PreToolUse": [{"hooks": [{"type": "command", "command": "spotter.mjs hook pre-tool-use"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "spotter.mjs hook stop"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "spotter.mjs hook session-end"}]}]
  }
}
EOF

for command in caveat throughline markitdown; do
  cat > "$BIN_DIR/$command" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$BIN_DIR/$command"
done
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
if [ "$1" = codex-hook ] && [ "$2" = diagnostics ] && [ "$3" = --project ]; then
  case "${SPOTTER_DIAGNOSTICS_MODE:-valid}" in
    valid)
      printf '%s\n' '{"availability":"available","installedHooks":{"sessionStart":"installed","userPromptSubmit":"installed","stop":"installed"},"readiness":"configured-unverified","validation":{"sessionStart":{"registered":true,"compatible":true,"misconfigured":false,"canonical":true,"issues":[]},"userPromptSubmit":{"registered":true,"compatible":true,"misconfigured":false,"canonical":true,"issues":[]},"stop":{"registered":true,"compatible":true,"misconfigured":false,"canonical":true,"issues":[]}}}'
      ;;
    noncanonical)
      printf '%s\n' '{"availability":"available","installedHooks":{"sessionStart":"installed","userPromptSubmit":"installed","stop":"installed"},"readiness":"configured-unverified","validation":{"sessionStart":{"registered":true,"compatible":true,"misconfigured":false,"canonical":true,"issues":[]},"userPromptSubmit":{"registered":true,"compatible":true,"misconfigured":false,"canonical":false,"issues":["noncanonical"]},"stop":{"registered":true,"compatible":true,"misconfigured":false,"canonical":true,"issues":[]}}}'
      ;;
  esac
  exit 0
fi
exit 64
EOF
chmod +x "$BIN_DIR/spotter"

SERVERMANAGER_TEST_READY_URL='data:application/json,{"checks":[{"id":"database","status":"pass"},{"id":"schema","status":"pass"},{"id":"source_revision","status":"pass"}],"source_revision":"fixture-revision"}'
verify_core() {
  HOME="$HOME_DIR" PATH="$BIN_DIR:/usr/bin:/bin" \
    SERVERMANAGER_READY_URL="$SERVERMANAGER_TEST_READY_URL" \
    DOTAGENTS_FACTORY_CORE_ONLY=1 \
    DOTAGENTS_FACTORY_PROJECT_ROOT="$PROJECT" \
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

git -C "$HOME_DIR/.caveat/own" remote set-url origin 'git@github.com:kitepon-rgb/not-private.git'
assert_rejected 'Caveat-Private remote 欠落'
git -C "$HOME_DIR/.caveat/own" remote set-url origin 'git@github.com:kitepon-rgb/Caveat-Private.git'

mv "$PROJECT/.spotter/marker.json" "$PROJECT/.spotter/marker.json.off"
assert_rejected 'Spotter marker 欠落'
mv "$PROJECT/.spotter/marker.json.off" "$PROJECT/.spotter/marker.json"

cat > "$PROJECT/.spotter/marker.json" <<EOF
{"markerVersion":"2","auditorContext":{"mode":"none","command":"$BIN_DIR/throughline"}}
EOF
assert_rejected 'Throughline 以外の auditor context'
cat > "$PROJECT/.spotter/marker.json" <<EOF
{"markerVersion":"2","auditorContext":{"mode":"throughline","command":"$BIN_DIR/throughline"}}
EOF

SPOTTER_DIAGNOSTICS_MODE=noncanonical assert_rejected '非 canonical Spotter diagnostics'

printf 'factory core smoke: OK\n'
