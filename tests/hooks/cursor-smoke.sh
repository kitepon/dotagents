#!/usr/bin/env bash
# Cursor factory hook の負系 fixture。Claude/Codex/Grok smoke は触らない。
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PYTHON_COMMAND=python3
if [ "${OS:-}" = "Windows_NT" ]; then
  PYTHON_COMMAND=python
fi
PYTHON_EXE=$(command -v "$PYTHON_COMMAND") || exit 1

STATE=$(mktemp -d)
REPO=$(mktemp -d)
CONST_HOME=$(mktemp -d)
MISS_HOME=$(mktemp -d)
OVER_HOME=$(mktemp -d)
LIVE_HOME=$(mktemp -d)
HOOK_REPO=$REPO
HOOK_STATE=$STATE
if command -v cygpath >/dev/null 2>&1; then
  HOOK_REPO=$(cygpath -m "$REPO")
  HOOK_STATE=$(cygpath -m "$STATE")
fi
trap 'rm -rf "$STATE" "$REPO" "$CONST_HOME" "$MISS_HOME" "$OVER_HOME" "$LIVE_HOME"' EXIT
export XDG_CACHE_HOME="$HOOK_STATE"

fail=0
pass() { printf 'PASS %s\n' "$1"; }
fail_case() {
  printf 'FAIL %s\n' "$1"
  printf '  timestamp: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '  exit status: %s\n' "${RUN_STATUS:-unset}"
  printf '  RUN_OUT (first 200 lines):\n'
  printf '%s\n' "${RUN_OUT:-}" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' | sed -n '1,200p'
  printf '  RUN_ERR (first 200 lines):\n'
  printf '%s\n' "${RUN_ERR:-}" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' | sed -n '1,200p'
  fail=1
}
run() {
  name=$1; shift
  out=$(mktemp); err=$(mktemp)
  "$@" >"$out" 2>"$err"; RUN_STATUS=$?
  RUN_OUT=$(cat "$out"); RUN_BYTES=$(wc -c <"$out" | tr -d ' '); RUN_ERR=$(cat "$err")
  rm -f "$out" "$err"
  if [ "$RUN_STATUS" -ne 0 ] || [ -n "$RUN_ERR" ]; then fail_case "$name exit/stderr"; return 1; fi
  return 0
}
json() { printf '%s' "$RUN_OUT" | "$PYTHON_EXE" -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; }

git -C "$REPO" init -q && git -C "$REPO" config user.email smoke@example.test && git -C "$REPO" config user.name smoke && git -C "$REPO" config core.autocrlf false
printf '%s\n' base >"$REPO/source.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm initial

printf '%s\n' dirty >"$REPO/source.txt"
run cursor-destroy-shell-deny "$PYTHON_EXE" "$ROOT/bin/cursor-git-destroy-gate-hook.sh" <<EOF
{"hook_event_name":"beforeShellExecution","session_id":"c-destroy","cwd":"$HOOK_REPO","command":"git checkout -- source.txt","cursor_version":"1.0.0"}
EOF
if json && [[ "$RUN_OUT" == *'"permission": "deny"'* && "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* && "$RUN_OUT" != *permissionDecision* && "$RUN_OUT" != *'"decision": "deny"'* ]]; then
  pass cursor-destroy-shell-deny
else
  fail_case cursor-destroy-shell-deny
fi

run cursor-destroy-grok-noop "$PYTHON_EXE" "$ROOT/bin/cursor-git-destroy-gate-hook.sh" <<EOF
{"hookEventName":"pre_tool_use","sessionId":"c-grok","cwd":"$HOOK_REPO","toolName":"run_terminal_command","toolInput":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"}}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-destroy-grok-noop
else
  fail_case cursor-destroy-grok-noop
fi

run cursor-destroy-claude-noop "$PYTHON_EXE" "$ROOT/bin/cursor-git-destroy-gate-hook.sh" <<EOF
{"session_id":"c-claude","tool_name":"Bash","tool_input":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"},"cwd":"$HOOK_REPO"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-destroy-claude-noop
else
  fail_case cursor-destroy-claude-noop
fi

run grok-destroy-cursor-envelope "$PYTHON_EXE" "$ROOT/bin/grok-git-destroy-gate-hook.sh" <<EOF
{"hook_event_name":"beforeShellExecution","session_id":"g-cursor","cwd":"$HOOK_REPO","command":"git checkout -- source.txt"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass grok-destroy-cursor-envelope
else
  fail_case grok-destroy-cursor-envelope
fi

run claude-destroy-cursor-envelope "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"hook_event_name":"beforeShellExecution","session_id":"cl-cursor","cwd":"$HOOK_REPO","command":"git checkout -- source.txt"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass claude-destroy-cursor-envelope
else
  fail_case claude-destroy-cursor-envelope
fi

run cursor-delegation-task-deny "$PYTHON_EXE" "$ROOT/bin/cursor-delegation-gate-hook.sh" <<<'{"hook_event_name":"preToolUse","session_id":"c-del","tool_name":"Task","tool_input":{"effort":"high"},"cursor_version":"1.0.0"}'
if json && [[ "$RUN_OUT" == *'"permission": "deny"'* && "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* && "$RUN_OUT" != *permissionDecision* && "$RUN_OUT" != *'"decision": "deny"'* ]]; then
  pass cursor-delegation-task-deny
else
  fail_case cursor-delegation-task-deny
fi

run cursor-delegation-grok-noop "$PYTHON_EXE" "$ROOT/bin/cursor-delegation-gate-hook.sh" <<<'{"sessionId":"c-del-grok","toolName":"spawn_subagent","toolInput":{"effort":"high"}}'
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-delegation-grok-noop
else
  fail_case cursor-delegation-grok-noop
fi

mkdir -p "$CONST_HOME/.cursor/rules"
printf '%s\n' '---' 'alwaysApply: true' '---' '# ベルの共通憲法' 'Cursor nativeの単発' >"$CONST_HOME/.cursor/rules/factory.mdc"
run cursor-constitution-session-start env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"sessionStart","session_id":"c-const","cwd":"$HOOK_REPO","cursor_version":"1.0.0"}
EOF
if json && [[ "$RUN_OUT" == *'"additional_context"'* && "$RUN_OUT" == *'ベルの共通憲法'* && "$RUN_OUT" == *'Cursor nativeの単発'* && "$RUN_OUT" != *mcp__aiterm__pty_* && "$RUN_OUT" != *alwaysApply* ]]; then
  pass cursor-constitution-session-start
else
  fail_case cursor-constitution-session-start
fi

run cursor-constitution-grok-noop env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hookEventName":"sessionStart","sessionId":"c-const-grok","cwd":"$HOOK_REPO"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-constitution-grok-noop
else
  fail_case cursor-constitution-grok-noop
fi

run cursor-constitution-missing-file env HOME="$MISS_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"sessionStart","session_id":"c-const-miss","cwd":"$HOOK_REPO"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-constitution-missing-file
else
  fail_case cursor-constitution-missing-file
fi

run cursor-constitution-before-submit env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"beforeSubmitPrompt","session_id":"c-const-prompt","prompt":"hi","cursor_version":"1.0.0"}
EOF
if json && [[ "$RUN_OUT" == *'"additional_context"'* && "$RUN_OUT" == *'ベルの共通憲法'* ]]; then
  pass cursor-constitution-before-submit
else
  fail_case cursor-constitution-before-submit
fi

run cursor-constitution-before-submit-once env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"beforeSubmitPrompt","session_id":"c-const-prompt","prompt":"again","cursor_version":"1.0.0"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-constitution-before-submit-once
else
  fail_case cursor-constitution-before-submit-once
fi

run cursor-constitution-pretooluse-after-prompt env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"preToolUse","session_id":"c-const-prompt","tool_name":"Shell","cursor_version":"1.0.0"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-constitution-pretooluse-after-prompt
else
  fail_case cursor-constitution-pretooluse-after-prompt
fi

run cursor-constitution-pretooluse env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"preToolUse","session_id":"c-const-tool","tool_name":"Shell","cursor_version":"1.0.0"}
EOF
if json && [[ "$RUN_OUT" == *'"additional_context"'* && "$RUN_OUT" == *'ベルの共通憲法'* ]]; then
  pass cursor-constitution-pretooluse
else
  fail_case cursor-constitution-pretooluse
fi

run cursor-constitution-pretooluse-once env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"preToolUse","session_id":"c-const-tool","tool_name":"Read","cursor_version":"1.0.0"}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass cursor-constitution-pretooluse-once
else
  fail_case cursor-constitution-pretooluse-once
fi

run cursor-constitution-session-start-after-prompt env HOME="$CONST_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"sessionStart","session_id":"c-const-prompt","cursor_version":"1.0.0"}
EOF
if json && [[ "$RUN_OUT" == *'"additional_context"'* && "$RUN_OUT" == *'ベルの共通憲法'* ]]; then
  pass cursor-constitution-session-start-after-prompt
else
  fail_case cursor-constitution-session-start-after-prompt
fi

mkdir -p "$OVER_HOME/.cursor/rules"
"$PYTHON_EXE" - "$OVER_HOME/.cursor/rules/factory.mdc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
# Desktop 3.17.8 nft=10000。超過本文は compact 配達へ落とす。
pad = "x" * 10020
body = "# ベルの共通憲法\nCursor nativeの単発\n" + pad + "\n"
path.write_text("---\nalwaysApply: true\n---\n" + body, encoding="utf-8")
PY
run cursor-constitution-over-inline-cap env HOME="$OVER_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"beforeSubmitPrompt","session_id":"c-const-over","prompt":"hi","cursor_version":"1.0.0"}
EOF
if json && "$PYTHON_EXE" - "$RUN_OUT" "$OVER_HOME/.cursor/rules/factory.mdc" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(sys.argv[1])
ctx = data.get("additional_context") or ""
path = Path(sys.argv[2])
if len(ctx) > 10000:
    raise SystemExit(1)
if "ベルの共通憲法" not in ctx or "Cursor nativeの単発" not in ctx:
    raise SystemExit(1)
if str(path.resolve()) not in ctx:
    raise SystemExit(1)
if "Read" not in ctx:
    raise SystemExit(1)
if "xxxx" not in ctx:
    raise SystemExit(1)
if ctx.strip() == path.read_text(encoding="utf-8").split("\n---", 1)[-1].lstrip("\n").strip():
    raise SystemExit(1)
if "alwaysApply" in ctx or "mcp__aiterm__pty_" in ctx:
    raise SystemExit(1)
PY
then
  pass cursor-constitution-over-inline-cap
else
  fail_case cursor-constitution-over-inline-cap
fi

mkdir -p "$LIVE_HOME/.cursor/rules"
ln -s "$ROOT/cursor/rules/factory.mdc" "$LIVE_HOME/.cursor/rules/factory.mdc"
run cursor-constitution-live-factory-over-cap env HOME="$LIVE_HOME" "$PYTHON_EXE" "$ROOT/bin/cursor-constitution-hook.sh" <<EOF
{"hook_event_name":"beforeSubmitPrompt","session_id":"c-const-live","prompt":"hi","cursor_version":"1.0.0"}
EOF
if json && "$PYTHON_EXE" - "$RUN_OUT" "$LIVE_HOME/.cursor/rules/factory.mdc" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(sys.argv[1])
ctx = data.get("additional_context") or ""
path = Path(sys.argv[2])
body = path.read_text(encoding="utf-8")
rest = body.split("\n---", 1)[-1].lstrip("\n")
if len(rest) <= 10000:
    raise SystemExit(0)
if len(ctx) > 10000:
    raise SystemExit(1)
if "ベルの共通憲法" not in ctx or "Cursor nativeの単発" not in ctx:
    raise SystemExit(1)
if "限界まで甘やかす" not in ctx:
    raise SystemExit(1)
if "## Cursor固有差分" not in ctx:
    raise SystemExit(1)
if "factory.mdc" not in ctx:
    raise SystemExit(1)
if "Read" not in ctx:
    raise SystemExit(1)
if ctx.strip() == rest.strip():
    raise SystemExit(1)
if "alwaysApply" in ctx or "mcp__aiterm__pty_" in ctx:
    raise SystemExit(1)
PY
then
  pass cursor-constitution-live-factory-over-cap
else
  fail_case cursor-constitution-live-factory-over-cap
fi

run cursor-todo-stop-no-followup "$PYTHON_EXE" "$ROOT/bin/cursor-todo-gate-hook.sh" stop <<EOF
{"hook_event_name":"stop","session_id":"c-stop","workspace_roots":["$HOOK_REPO"],"status":"completed","cursor_version":"1.0.0"}
EOF
if [[ "$RUN_OUT" != *followup_message* && "$RUN_OUT" != *'"decision": "block"'* && "$RUN_STATUS" -eq 0 ]]; then
  pass cursor-todo-stop-no-followup
else
  fail_case cursor-todo-stop-no-followup
fi

FACTORY="$ROOT/cursor/hooks/factory.json"
if "$PYTHON_EXE" - "$FACTORY" <<'PY'
import json, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
for forbidden in ("spotter", "throughline", "caveat", "observer"):
    if forbidden in text.lower():
        raise SystemExit(1)
data = json.loads(text)
if data.get("version") != 1:
    raise SystemExit(1)
commands = []
for event, entries in data["hooks"].items():
    for entry in entries:
        commands.append(entry["command"])
if not commands or any("cursor-" not in command for command in commands):
    raise SystemExit(1)
starts = data["hooks"].get("sessionStart") or []
if not starts or "cursor-constitution-hook" not in starts[0].get("command", ""):
    raise SystemExit(1)
prompts = data["hooks"].get("beforeSubmitPrompt") or []
if not prompts or "cursor-constitution-hook" not in prompts[0].get("command", ""):
    raise SystemExit(1)
tools = data["hooks"].get("preToolUse") or []
if not tools or "cursor-constitution-hook" not in tools[0].get("command", ""):
    raise SystemExit(1)
if "PreToolUse" in data["hooks"] or "UserPromptSubmit" in data["hooks"]:
    raise SystemExit(1)
PY
then
  pass cursor-factory-json-owned
else
  fail_case cursor-factory-json-owned
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
printf 'ALL PASS\n'
