#!/usr/bin/env bash
# Grok factory hook の負系 fixture。Claude/Codex smoke は触らない。
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PYTHON_COMMAND=python3
if [ "${OS:-}" = "Windows_NT" ]; then
  PYTHON_COMMAND=python
fi
PYTHON_EXE=$(command -v "$PYTHON_COMMAND") || exit 1

STATE=$(mktemp -d)
REPO=$(mktemp -d)
HOOK_REPO=$REPO
HOOK_STATE=$STATE
if command -v cygpath >/dev/null 2>&1; then
  HOOK_REPO=$(cygpath -m "$REPO")
  HOOK_STATE=$(cygpath -m "$STATE")
fi
trap 'rm -rf "$STATE" "$REPO"' EXIT
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

# PreToolUse deny: Grok camelCase + run_terminal_command
printf '%s\n' dirty >"$REPO/source.txt"
run grok-destroy-camel-deny "$PYTHON_EXE" "$ROOT/bin/grok-git-destroy-gate-hook.sh" <<EOF
{"hookEventName":"pre_tool_use","sessionId":"g-destroy","cwd":"$HOOK_REPO","toolName":"run_terminal_command","toolInput":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"}}
EOF
if json && [[ "$RUN_OUT" == *'"decision": "deny"'* && "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* && "$RUN_OUT" != *permissionDecision* && "$RUN_OUT" != *session_id* ]]; then
  pass grok-destroy-camel-deny
else
  fail_case grok-destroy-camel-deny
fi

# Claude 形へ canonicalize しない: snake_case だけでは deny しない
run grok-destroy-snake-noop "$PYTHON_EXE" "$ROOT/bin/grok-git-destroy-gate-hook.sh" <<EOF
{"session_id":"g-snake","tool_name":"run_terminal_command","tool_input":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"}}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass grok-destroy-snake-noop
else
  fail_case grok-destroy-snake-noop
fi

# Claude frontend は Grok envelope を読まない（経路不変）
run claude-destroy-grok-envelope "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"hookEventName":"pre_tool_use","sessionId":"g-claude","cwd":"$HOOK_REPO","toolName":"run_terminal_command","toolInput":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"}}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass claude-destroy-grok-envelope
else
  fail_case claude-destroy-grok-envelope
fi

printf '%s\n' base >"$REPO/source.txt"
run grok-destroy-clean "$PYTHON_EXE" "$ROOT/bin/grok-git-destroy-gate-hook.sh" <<EOF
{"sessionId":"g-clean","cwd":"$HOOK_REPO","toolName":"run_terminal_command","toolInput":{"command":"git restore --worktree source.txt","cwd":"$HOOK_REPO"}}
EOF
if [ "$RUN_BYTES" -eq 0 ]; then
  pass grok-destroy-clean
else
  fail_case grok-destroy-clean
fi

# delegation deny on spawn_subagent camelCase
run grok-delegation-model-deny "$PYTHON_EXE" "$ROOT/bin/grok-delegation-gate-hook.sh" <<<'{"sessionId":"g-del","toolName":"spawn_subagent","toolInput":{"effort":"high"}}'
if json && [[ "$RUN_OUT" == *'"decision": "deny"'* && "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* && "$RUN_OUT" != *permissionDecision* ]]; then
  pass grok-delegation-model-deny
else
  fail_case grok-delegation-model-deny
fi

# snake_case では Grok frontend は動かない
run grok-delegation-snake-noop "$PYTHON_EXE" "$ROOT/bin/grok-delegation-gate-hook.sh" <<<'{"session_id":"g-del-snake","tool_name":"spawn_subagent","tool_input":{"effort":"high"}}'
if [ "$RUN_BYTES" -eq 0 ]; then
  pass grok-delegation-snake-noop
else
  fail_case grok-delegation-snake-noop
fi

# Stop: camelCase で exit 0、continuation を出さない
run grok-todo-stop-no-continue "$PYTHON_EXE" "$ROOT/bin/grok-todo-gate-hook.sh" stop <<EOF
{"hookEventName":"stop","sessionId":"g-stop","cwd":"$HOOK_REPO","stopHookActive":false,"reason":"end_turn"}
EOF
if [[ "$RUN_OUT" != *'"decision": "block"'* && "$RUN_OUT" != *additionalContext* && "$RUN_STATUS" -eq 0 ]]; then
  pass grok-todo-stop-no-continue
else
  fail_case grok-todo-stop-no-continue
fi

# session_id 欠落（sessionId だけ）でも exit 2 にしない
run grok-onset-camel "$PYTHON_EXE" "$ROOT/bin/grok-onset-gate-hook.sh" <<<'{"sessionId":"g-onset","hookEventName":"user_prompt_submit"}'
if [ "$RUN_STATUS" -eq 0 ]; then
  pass grok-onset-camel
else
  fail_case grok-onset-camel
fi

run grok-plan-camel /bin/bash "$ROOT/bin/grok-plan-gate-hook.sh" <<<'{"sessionId":"g-plan","toolName":"exit_plan_mode","toolInput":{}}'
if [ "$RUN_STATUS" -eq 0 ] && [ "$RUN_BYTES" -eq 0 ]; then
  pass grok-plan-camel
else
  fail_case grok-plan-camel
fi

run grok-lattice-camel "$PYTHON_EXE" "$ROOT/bin/grok-lattice-gantt-hook.sh" session-start <<EOF
{"sessionId":"g-lattice","cwd":"$HOOK_REPO","source":"startup"}
EOF
if [ "$RUN_STATUS" -eq 0 ]; then
  pass grok-lattice-camel
else
  fail_case grok-lattice-camel
fi

# 所有JSONは工場hookだけ。製品hook名を載せない。
FACTORY="$ROOT/grok/hooks/factory.json"
if "$PYTHON_EXE" - "$FACTORY" <<'PY'
import json, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
for forbidden in ("spotter", "throughline", "caveat", "observer"):
    if forbidden in text.lower():
        raise SystemExit(1)
data = json.loads(text)
commands = []
for event, groups in data["hooks"].items():
    for group in groups:
        for hook in group["hooks"]:
            commands.append(hook["command"])
if not commands or any("grok-" not in command for command in commands):
    raise SystemExit(1)
if any("git-destroy-gate-hook" in command and "grok-git-destroy-gate-hook" not in command for command in commands):
    raise SystemExit(1)
PY
then
  pass grok-factory-json-owned
else
  fail_case grok-factory-json-owned
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
printf 'ALL PASS\n'
