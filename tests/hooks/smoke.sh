#!/usr/bin/env bash
# shellcheck disable=SC2015
set -u
umask 077

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PYTHON_COMMAND=python3
if [ "${OS:-}" = "Windows_NT" ]; then
  PYTHON_COMMAND=python
fi
PYTHON_EXE=$(command -v "$PYTHON_COMMAND") || exit 1
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}
make_symlink() {
  local target link kind
  target=$(native_path "$1")
  link=$(native_path "$2")
  kind=${3:-file}
  "$PYTHON_EXE" -c 'import os,sys; os.symlink(sys.argv[1], sys.argv[2], target_is_directory=sys.argv[3] == "dir")' "$target" "$link" "$kind"
}
install_windows_fixture_wrapper() {
  [ "${OS:-}" = "Windows_NT" ] || return 0
  local script="$1" runtime="$2" runtime_path
  runtime_path=$(cygpath -w "$(command -v "$runtime")")
  printf '@echo off\r\n"%s" "%%~dp0%s" %%*\r\n' \
    "$runtime_path" "$(basename "$script")" >"$script.cmd"
}
install_git_fixture() {
  local directory="$1"
  if [ "${OS:-}" = "Windows_NT" ]; then
    local git_path
    git_path=$(where.exe git 2>/dev/null | tr -d '\r' | awk '{gsub(/\\/, "/"); if (tolower($0) ~ /\/cmd\/git\.exe$/) {print; exit}}')
    [ -n "$git_path" ] || return 1
    make_symlink "$git_path" "$directory/git.exe"
  else
    ln -s "$(command -v git)" "$directory/git"
  fi
}
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
  if [[ "$*" == *"lattice-gantt-hook.sh session-start"* ]]; then
    lattice_input=$(cat)
    "$@" <<<"$lattice_input" >"$out" 2>"$err"; RUN_STATUS=$?
    if [ "$RUN_STATUS" -eq 0 ] && [ ! -s "$err" ]; then
      lattice_key=$(printf '%s' "$lattice_input" | "$PYTHON_EXE" -c 'import hashlib,json,sys; print(hashlib.sha256(json.load(sys.stdin)["session_id"].encode()).hexdigest())')
      for _ in $(seq 1 70); do
        find "$STATE/dotagents/hooks" -maxdepth 1 -name "$lattice_key.*.lattice-gantt.pending" -type f | grep -q . || break
        sleep 0.1
      done
      set -- "${@:1:$(($# - 1))}" user-prompt-submit
      "$@" <<<"$lattice_input" >"$out" 2>"$err"; RUN_STATUS=$?
    fi
  else
    "$@" >"$out" 2>"$err"; RUN_STATUS=$?
  fi
  RUN_OUT=$(cat "$out"); RUN_BYTES=$(wc -c <"$out" | tr -d ' '); RUN_ERR=$(cat "$err")
  rm -f "$out" "$err"
  if [ "$RUN_STATUS" -ne 0 ] || [ -n "$RUN_ERR" ]; then fail_case "$name exit/stderr"; return 1; fi
  return 0
}
run_direct() {
  name=$1; shift
  out=$(mktemp); err=$(mktemp)
  "$@" >"$out" 2>"$err"; RUN_STATUS=$?
  RUN_OUT=$(cat "$out"); RUN_BYTES=$(wc -c <"$out" | tr -d ' '); RUN_ERR=$(cat "$err")
  rm -f "$out" "$err"
  if [ "$RUN_STATUS" -ne 0 ] || [ -n "$RUN_ERR" ]; then fail_case "$name exit/stderr"; return 1; fi
  return 0
}
json() { printf '%s' "$RUN_OUT" | "$PYTHON_EXE" -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; }
session_key() { printf '%s' "$1" | "$PYTHON_EXE" -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }

run c1-date-info "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d1","tool_name":"Agent","tool_input":{"model":"x-20202607"}}' && json && [[ "$RUN_OUT" == *additionalContext* && "$RUN_OUT" != *permissionDecision* ]] && pass c1-date-info || fail_case c1-date-info
run c1-aiterm-info "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d2","tool_name":"mcp__aiterm__codex_agent","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:read-only] review"}}' && json && [[ "$RUN_OUT" == *additionalContext* && "$RUN_OUT" != *permissionDecision* ]] && pass c1-aiterm-info || fail_case c1-aiterm-info
run c1-oracle-info "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d3","tool_name":"mcp__oracle__consult","tool_input":{"preset":"chatgpt-pro-heavy"}}' && json && [[ "$RUN_OUT" == *additionalContext* && "$RUN_OUT" != *permissionDecision* ]] && pass c1-oracle-info || fail_case c1-oracle-info
run c1-model-missing-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d4","tool_name":"Agent","tool_input":{"effort":"ultra"}}' && json && [[ "$RUN_OUT" == *'permissionDecision'* && "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-model-missing-deny || fail_case c1-model-missing-deny
run c1-model-inherit-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d4i","tool_name":"mcp__aiterm__codex_agent","tool_input":{"model":"inherit","reasoning_effort":"medium","prompt":"[scope:read-only]"}}' && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-model-inherit-deny || fail_case c1-model-inherit-deny
run c1-info "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d5","tool_name":"Agent","tool_input":{"model":"sonnet","effort":"medium"}}' && json && [[ "$RUN_OUT" == *'INFO:'* && "$RUN_OUT" != *permissionDecision* ]] && pass c1-info || fail_case c1-info
run c1-silent "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"d5","tool_name":"Agent","tool_input":{"model":"sonnet","effort":"medium"}}' && [ "$RUN_BYTES" -eq 0 ] && pass c1-silent || fail_case c1-silent
run c1-off env DOTAGENTS_PLACEMENT_GATE=off "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"off","tool_name":"mcp__aiterm__codex_agent","tool_input":{}}' && [ "$RUN_BYTES" -eq 0 ] && pass c1-off || fail_case c1-off

git -C "$REPO" init -q && git -C "$REPO" config user.email smoke@example.test && git -C "$REPO" config user.name smoke && git -C "$REPO" config core.autocrlf false
mkdir "$REPO/docs"; printf '%s\n' '- [ ] task' >"$REPO/docs/plan_x.md"; printf '%s\n' base >"$REPO/source.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm initial

# WindowsではshimをCreateProcessが解決できないため、実repoの状態でgateを検証する。
printf '%s\n' dirty >"$REPO/source.txt"
run git-destroy-dirty "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git checkout -- source.txt","cwd":"$HOOK_REPO"}}
EOF
json && [[ "$RUN_OUT" == *'permissionDecision'* && "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* && "$RUN_OUT" == *'stash push'* ]] && pass git-destroy-dirty || fail_case git-destroy-dirty
printf '%s\n' base >"$REPO/source.txt"
run git-destroy-clean "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git restore --worktree source.txt","cwd":"$HOOK_REPO"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass git-destroy-clean || fail_case git-destroy-clean
printf '%s\n' dirty >"$REPO/source.txt"
run git-destroy-restore-staged "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git restore --staged source.txt","cwd":"$HOOK_REPO"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass git-destroy-restore-staged || fail_case git-destroy-restore-staged
printf '%s\n' clean-target >"$REPO/clean-target.txt"
run git-destroy-clean-force "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git clean -fd","cwd":"$HOOK_REPO"}}
EOF
json && [[ "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* ]] && pass git-destroy-clean-force || fail_case git-destroy-clean-force
rm "$REPO/clean-target.txt"; printf '%s\n' base >"$REPO/source.txt"
mkdir -p "$STATE/non-git"
run git-destroy-nongit "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git clean -f","cwd":"$STATE/non-git"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass git-destroy-nongit || fail_case git-destroy-nongit
printf '%s\n' dirty >"$REPO/source.txt"
run git-destroy-off env DOTAGENTS_GIT_DESTROY_GATE=off "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git reset --hard","cwd":"$HOOK_REPO"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass git-destroy-off || fail_case git-destroy-off
run git-destroy-branch "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"git checkout main","cwd":"$HOOK_REPO"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass git-destroy-branch || fail_case git-destroy-branch
run git-destroy-composite "$PYTHON_EXE" "$ROOT/bin/git-destroy-gate-hook.sh" <<EOF
{"tool_name":"Bash","tool_input":{"command":"echo before && git stash clear","cwd":"$HOOK_REPO"}}
EOF
json && [[ "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* ]] && pass git-destroy-composite || fail_case git-destroy-composite
run git-destroy-codex "$PYTHON_EXE" "$ROOT/bin/codex-git-destroy-gate-hook.sh" <<EOF
{"tool_name":"shell_command","tool_input":{"command":"git checkout .","cwd":"$HOOK_REPO"}}
EOF
json && [[ "$RUN_OUT" == *'"decision": "deny"'* && "$RUN_OUT" == *'P12_UNCOMMITTED_DESTROY'* ]] && pass git-destroy-codex || fail_case git-destroy-codex
printf '%s\n' base >"$REPO/source.txt"

# C1 enforcement fixtures: fixed role, sidecar defaults, routing declaration,
# writer reservation/release, and operational failures all have distinct paths.
mkdir -p "$STATE/claude-project/.claude/agents" "$STATE/claude-home/.claude/agents"
CLAUDE_PROJECT=$(native_path "$STATE/claude-project")
CLAUDE_HOME=$(native_path "$STATE/claude-home")
NO_PROJECT=$(native_path "$STATE/no-project")
printf '%s\n' '---' 'model: sonnet' '---' >"$STATE/claude-project/.claude/agents/fixed.md"
printf '%s\n' '---' 'model: sonnet' '---' >"$STATE/claude-home/.claude/agents/fixed.md"
printf '%s\n' '---' 'model: inherit' '---' >"$STATE/claude-project/.claude/agents/priority.md"
printf '%s\n' '---' 'model: sonnet' '---' >"$STATE/claude-home/.claude/agents/priority.md"
printf '%s\n' '---' 'model: inherit' '---' >"$STATE/claude-home/.claude/agents/inherit.md"
run c1-project-shadow-deny env HOME="$CLAUDE_HOME" USERPROFILE="$CLAUDE_HOME" CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"role-project","tool_name":"Agent","tool_input":{"subagent_type":"fixed"}}' \
  && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-project-shadow-deny || fail_case c1-project-shadow-deny
run c1-project-shadow-explicit env HOME="$CLAUDE_HOME" USERPROFILE="$CLAUDE_HOME" CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"role-project-model","tool_name":"Agent","tool_input":{"subagent_type":"fixed","model":"sonnet"}}' \
  && json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-project-shadow-explicit || fail_case c1-project-shadow-explicit
run c1-home-direct-role env HOME="$CLAUDE_HOME" USERPROFILE="$CLAUDE_HOME" CLAUDE_PROJECT_DIR="$NO_PROJECT" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"role-home","tool_name":"Agent","tool_input":{"subagent_type":"fixed"}}' \
  && json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-home-direct-role || fail_case c1-home-direct-role
run c1-role-inherit-deny env HOME="$CLAUDE_HOME" USERPROFILE="$CLAUDE_HOME" CLAUDE_PROJECT_DIR="$NO_PROJECT" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<<'{"session_id":"role-inherit","tool_name":"Agent","tool_input":{"subagent_type":"inherit"}}' \
  && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-role-inherit-deny || fail_case c1-role-inherit-deny
run c1-sidecar-no-default-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"sidecar-none","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$STATE/no-default","tool_input":{"prompt":"read-only review"}}
EOF
json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-sidecar-no-default-deny || fail_case c1-sidecar-no-default-deny
printf '%s\n' 'defaults: {}' >"$REPO/.codex-sidecar.yml"
run c1-sidecar-empty-default-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"sidecar-empty","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$HOOK_REPO","tool_input":{"prompt":"[scope:read-only] review"}}
EOF
json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-sidecar-empty-default-deny || fail_case c1-sidecar-empty-default-deny
run c1-sidecar-explicit-allow "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"sidecar-explicit","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","modelReasoningEffort":"medium","prompt":"[scope:read-only] review"}}
EOF
json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-sidecar-explicit-allow || fail_case c1-sidecar-explicit-allow
printf '%s\n' 'defaults:' '  model: gpt-5.6-terra' '  model_reasoning_effort: medium' >"$REPO/.codex-sidecar.yml"
run c1-sidecar-default-allow "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"sidecar-default","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$HOOK_REPO","tool_input":{"prompt":"[scope:read-only] review"}}
EOF
json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-sidecar-default-allow || fail_case c1-sidecar-default-allow
printf '%s\n' 'defaults:' '  model: inherit' '  model_reasoning_effort: medium' >"$REPO/.codex-sidecar.yml"
run c1-sidecar-inherit-default-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"sidecar-inherit","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$HOOK_REPO","tool_input":{"prompt":"[scope:read-only] review"}}
EOF
json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass c1-sidecar-inherit-default-deny || fail_case c1-sidecar-inherit-default-deny
printf '%s\n' 'defaults:' '  model: gpt-5.6-terra' '  model_reasoning_effort: medium' >"$REPO/.codex-sidecar.yml"
run c1-scope-missing-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"scope","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"implement it"}}
EOF
json && [[ "$RUN_OUT" == *'P9_SCOPE_DECL_MISSING'* ]] && pass c1-scope-missing-deny || fail_case c1-scope-missing-deny
run c1-writer-first "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"writer-1","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:write] source.txt"}}
EOF
json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-writer-first || fail_case c1-writer-first
run c1-writer-second-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"writer-2","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:write] source.txt"}}
EOF
json && [[ "$RUN_OUT" == *'P11_WRITER_BUSY'* ]] && pass c1-writer-second-deny || fail_case c1-writer-second-deny
run c1-writer-list "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --list </dev/null && json && [[ "$RUN_OUT" == *writer-1* ]] && pass c1-writer-list || fail_case c1-writer-list
run c1-writer-release "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir "$REPO/.git" </dev/null && json && [[ "$RUN_OUT" == *released_common_dir* ]] && pass c1-writer-release || fail_case c1-writer-release
"$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --common-dir "$REPO/.git" </dev/null >"$STATE/c1-common.out" 2>"$STATE/c1-common.err"; common_status=$?
[ "$common_status" -eq 2 ] && [ ! -s "$STATE/c1-common.out" ] && [ ! -s "$STATE/c1-common.err" ] && pass c1-common-dir-without-release || fail_case c1-common-dir-without-release
chmod 755 "$STATE/dotagents/hooks/writer-reservations"
run c1-writer-after-release "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"writer-3","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:write] source.txt"}}
EOF
json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-writer-after-release || fail_case c1-writer-after-release
"$PYTHON_EXE" - "$STATE/dotagents/hooks/writer-reservations" <<'PY' && pass c1-writer-state-mode || fail_case c1-writer-state-mode
import os, stat, sys
path = sys.argv[1]
valid = os.path.isdir(path) and not os.path.islink(path)
if os.name != "nt":
    valid = valid and stat.S_IMODE(os.stat(path).st_mode) == 0o700
raise SystemExit(0 if valid else 1)
PY
RESERVATION=$(find "$STATE/dotagents/hooks/writer-reservations" -name '*.json' -print -quit)
touch -t 202001010000 "$RESERVATION"
run c1-reservation-gc-survives "$PYTHON_EXE" "$ROOT/bin/codex-callout-hook.sh" pre-tool-use <<EOF
{"session_id":"reservation-gc","tool_name":"spawn_agent","tool_input":{"model":"gpt-5.6-terra"}}
EOF
[ -f "$RESERVATION" ] && pass c1-reservation-gc-survives || fail_case c1-reservation-gc-survives
run c1-writer-release-after-gc "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir "$REPO/.git" </dev/null && json && pass c1-writer-release-after-gc || fail_case c1-writer-release-after-gc
mkdir -p "$STATE/not-git"; printf '%s\n' 'defaults:' '  model: gpt-5.6-terra' '  model_reasoning_effort: medium' >"$STATE/not-git/.codex-sidecar.yml"
NONGIT_REPO=$(native_path "$STATE/not-git")
run c1-nongit-writer-first "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"nongit-1","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$NONGIT_REPO","tool_input":{"prompt":"[scope:write] x"}}
EOF
json && [[ "$RUN_OUT" == *additionalContext* ]] && pass c1-nongit-writer-first || fail_case c1-nongit-writer-first
run c1-nongit-writer-second-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"nongit-2","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$NONGIT_REPO","tool_input":{"prompt":"[scope:write] x"}}
EOF
json && [[ "$RUN_OUT" == *'P11_WRITER_BUSY'* && "$RUN_OUT" == *unidentified-repo* ]] && pass c1-nongit-writer-second-deny || fail_case c1-nongit-writer-second-deny
run c1-nongit-release "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir unidentified-repo </dev/null && json && pass c1-nongit-release || fail_case c1-nongit-release
OPAQUE_KEY=$(printf '%s' unidentified-repo | "$PYTHON_EXE" -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
: >"$STATE/dotagents/hooks/writer-reservations/$OPAQUE_KEY.json"
run c1-corrupt-reservation-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"corrupt","tool_name":"mcp__codex-sidecar__codex_work","cwd":"$NONGIT_REPO","tool_input":{"prompt":"[scope:write] x"}}
EOF
json && [[ "$RUN_OUT" == *'P11_WRITER_BUSY'* && "$RUN_OUT" != *'内部障害'* ]] && pass c1-corrupt-reservation-deny || fail_case c1-corrupt-reservation-deny
run c1-corrupt-reservation-list "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --list </dev/null && json && [[ "$RUN_OUT" == *opaque* ]] && pass c1-corrupt-reservation-list || fail_case c1-corrupt-reservation-list
run c1-corrupt-reservation-release "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir unidentified-repo </dev/null && json && pass c1-corrupt-reservation-release || fail_case c1-corrupt-reservation-release
rmdir "$STATE/dotagents/hooks/writer-reservations"
make_symlink "$STATE/not-git" "$STATE/dotagents/hooks/writer-reservations" dir
run c1-writer-state-unavailable-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"state-unavailable","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:write] x"}}
EOF
json && [[ "$RUN_OUT" == *'P11_STATE_UNAVAILABLE'* ]] && pass c1-writer-state-unavailable-deny || fail_case c1-writer-state-unavailable-deny
run c1-scope-ambiguous-deny "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"scope-both","tool_name":"mcp__aiterm__codex_agent","cwd":"$HOOK_REPO","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:read-only] [scope:write]"}}
EOF
json && [[ "$RUN_OUT" == *'P9_SCOPE_DECL_AMBIGUOUS'* ]] && pass c1-scope-ambiguous-deny || fail_case c1-scope-ambiguous-deny

# Orchestrate advisoryはhook配布dirのfake sibling CLIだけを実行する。対象repoのCLIは悪性でも実行しない。
mkdir -p "$REPO/bin" "$STATE/sentinel" "$STATE/advisory-bin" "$STATE/lib/orchestrate"
ADVISORY="$STATE/advisory-bin/orchestrate-advisory-hook"
cp "$ROOT/bin/orchestrate-advisory-hook.sh" "$ADVISORY"
cp "$ROOT/lib/orchestrate/advisory-hook.py" "$STATE/lib/orchestrate/advisory-hook.py"
chmod +x "$ADVISORY"
printf '#!%s\n' "$(command -v node)" >"$STATE/advisory-bin/orchestrate-run"
cat >>"$STATE/advisory-bin/orchestrate-run" <<'PY'
const fs = require("fs");
const path = require("path");
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim() || "valid";
if (mode === "failure") process.exit(1);
if (mode === "timeout") setTimeout(() => process.exit(0), 6000);
else if (mode === "invalid") console.log("not-json");
else if (mode === "flood") console.log("x".repeat(70 * 1024));
else {
  const many = mode === "many" ? Array.from({ length: 5 }, (_, index) => `control-${index}`) : ["control-a"];
  const entries = (prefix, key, reason) => mode === "many" ? Array.from({ length: 5 }, (_, index) => ({ [key]: `${prefix}-${index}`, reason })) : [{ [key]: `${prefix}-a`, reason }];
  const result = { schema_version: "orchestrate.advisory-snapshot.v1", evaluated_at: "2026-07-14T00:00:00.000Z", active_control_ids: many,
    unknown: { worker_run_ids: mode === "many" ? Array.from({ length: 5 }, (_, index) => `worker-${index}`) : ["worker-a"], consultation_ids: [] },
    uncollected: { worker_run_ids: [], consultation_ids: mode === "many" ? Array.from({ length: 5 }, (_, index) => `consult-${index}`) : ["consult-a"] },
    write_conflicts: mode === "many" ? Array.from({ length: 5 }, (_, index) => ({ control_id: `control-${index}`, worker_run_id: `writer-${index}`, reason: "scope-overlap" })) : [{ control_id: "control-a", worker_run_id: "writer-a", reason: "scope-overlap" }],
    h_reference_gaps: entries("task", "task_id", "approval-expired"), capacity_warnings: entries("registry", "registry_observation_id", "hard-reached"), truncated: mode === "many" };
  if (mode === "empty") Object.assign(result, { active_control_ids: [], unknown: { worker_run_ids: [], consultation_ids: [] }, uncollected: { worker_run_ids: [], consultation_ids: [] }, write_conflicts: [], h_reference_gaps: [], capacity_warnings: [], truncated: false });
  console.log(JSON.stringify({ ok: true, command: "advisory-snapshot", result }));
}
PY
chmod +x "$STATE/advisory-bin/orchestrate-run"
install_windows_fixture_wrapper "$STATE/advisory-bin/orchestrate-run" node
printf '#!%s\n' "$(command -v node)" >"$STATE/advisory-bin/lattice"
cat >>"$STATE/advisory-bin/lattice" <<'JS'
const fs = require("fs");
const path = require("path");
// run store の状態は snapshot mode と独立。既定=ok。invalid_run_store は cli_error.v2 を
// stderr へ出し exit 1（現CLIの実挙動）。失敗が空集合へ丸められないことを検証する。
let runMode = "ok";
try { runMode = fs.readFileSync(path.join(__dirname, "lattice-mode"), "utf8").trim() || "ok"; } catch {}
if (runMode === "invalid_run_store") {
  process.stderr.write(JSON.stringify({ schema: "lattice.cli_error.v2", code: "INVALID_RUN_STORE", message: "run storeのartifact bindingが不正" }) + "\n");
  process.exit(1);
}
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim() || "valid";
const active = mode === "empty" || runMode === "empty" ? [] : [{ run_id: "lattice-run-a", run_ref: ".lattice/runs/lattice-run-a", base_sha: "a".repeat(40), executor_adapter: "scripted" }];
console.log(JSON.stringify({ schema: "lattice.run_list.v1", active_runs: active, result_digest: "b".repeat(64) }));
JS
chmod +x "$STATE/advisory-bin/lattice"
install_windows_fixture_wrapper "$STATE/advisory-bin/lattice" node
set_advisory_mode() { printf '%s\n' "$1" >"$STATE/advisory-bin/mode"; }
set_lattice_mode() { printf '%s\n' "$1" >"$STATE/advisory-bin/lattice-mode"; }
set_lattice_mode ok
cat >"$REPO/bin/orchestrate-run.mjs" <<'EOF'
#!/usr/bin/env bash
echo malicious-repo-cli-called >>"${ADVISORY_MALICIOUS_LOG:?}"
exit 99
EOF
chmod +x "$REPO/bin/orchestrate-run.mjs"
for provider in gpt-connector gpt-connector-mcp codex-sidecar-mcp aiterm-mcp; do
  cat >"$STATE/sentinel/$provider" <<'EOF'
#!/usr/bin/env bash
echo provider-called >>"${ADVISORY_SENTINEL_LOG:?}"
exit 99
EOF
  chmod +x "$STATE/sentinel/$provider"
done
for tool in "$(basename "$PYTHON_EXE")" git node dirname readlink; do
  cat >"$STATE/sentinel/$tool" <<'EOF'
#!/usr/bin/env bash
echo runtime-path-called >>"${ADVISORY_RUNTIME_LOG:?}"
exit 99
EOF
  chmod +x "$STATE/sentinel/$tool"
done
mkdir -p "$STATE/poison"
printf '%s\n' 'raise SystemExit("PYTHONPATH loaded")' >"$STATE/poison/sitecustomize.py"
printf '%s\n' 'require("fs").appendFileSync(process.env.ADVISORY_NODE_OPTIONS_LOG, "node-options-loaded\\n")' >"$STATE/poison/node-options.js"
set_advisory_mode valid
run advisory-success env PATH="$STATE/sentinel:$PATH" GIT_DIR="$STATE/not-a-git" PYTHONPATH="$STATE/poison" NODE_OPTIONS="--require=$STATE/poison/node-options.js" ADVISORY_NODE_OPTIONS_LOG="$STATE/node-options.log" ADVISORY_RUNTIME_LOG="$STATE/runtime.log" ADVISORY_SENTINEL_LOG="$STATE/provider.log" ADVISORY_MALICIOUS_LOG="$STATE/malicious.log" "$ADVISORY" <<EOF
{"session_id":"advisory-1","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_OUT" == *"active Lattice run: lattice-run-a"* && "$RUN_OUT" == *"active Control: control-a"* && "$RUN_OUT" == *"unknown Run: worker:worker-a"* && "$RUN_OUT" != *"permissionDecision"* ]] && pass advisory-success || fail_case advisory-success
[ ! -e "$STATE/provider.log" ] && pass advisory-no-provider || fail_case advisory-no-provider
[ ! -e "$STATE/malicious.log" ] && pass advisory-no-repo-cli || fail_case advisory-no-repo-cli
[ ! -e "$STATE/runtime.log" ] && [ ! -e "$STATE/node-options.log" ] && pass advisory-no-parent-runtime || fail_case advisory-no-parent-runtime
# run store失敗（INVALID_RUN_STORE）は空集合へ丸めず fail-visible にする（active runなしと区別）。
set_advisory_mode valid; set_lattice_mode invalid_run_store
run advisory-run-store-invalid "$ADVISORY" <<EOF
{"session_id":"advisory-run-invalid","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_OUT" == *"active Lattice run取得失敗: INVALID_RUN_STORE"* && "$RUN_OUT" == *"active Control: control-a"* ]] && pass advisory-run-store-invalid || fail_case advisory-run-store-invalid
set_lattice_mode ok
set_advisory_mode valid
run advisory-dedupe "$ADVISORY" <<EOF
{"session_id":"advisory-1","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass advisory-dedupe || fail_case advisory-dedupe
set_advisory_mode empty
run advisory-empty "$ADVISORY" <<EOF
{"session_id":"advisory-empty","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass advisory-empty || fail_case advisory-empty
for mode in failure timeout invalid flood; do
  set_advisory_mode "$mode"
  started=$("$PYTHON_EXE" -c 'import time; print(time.monotonic())')
  run "advisory-$mode" "$ADVISORY" <<EOF
{"session_id":"advisory-$mode","cwd":"$HOOK_REPO"}
EOF
  [ "$RUN_BYTES" -eq 0 ] && pass "advisory-$mode" || fail_case "advisory-$mode"
  if [ "$mode" = timeout ]; then
    "$PYTHON_EXE" - "$started" <<'PY' || fail_case advisory-timeout-deadline
import sys, time
raise SystemExit(0 if time.monotonic() - float(sys.argv[1]) < 4.5 else 1)
PY
    pass advisory-timeout-deadline
  fi
done
set_advisory_mode valid
run advisory-off env DOTAGENTS_ORCHESTRATE_ADVISORY=off "$ADVISORY" <<EOF
{"session_id":"advisory-off","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass advisory-off || fail_case advisory-off
set_advisory_mode many
run advisory-bounded "$ADVISORY" <<EOF
{"session_id":"advisory-many","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_OUT" == *"control-2"* && "$RUN_OUT" != *"control-3"* && "$RUN_BYTES" -lt 2048 ]] && pass advisory-bounded || fail_case advisory-bounded
MARKERS="$STATE/dotagents/hooks"; mkdir -p "$MARKERS"
touch -t 202001010000 "$MARKERS/other-hook-cache" "$MARKERS/orchestrate-advisory-old.shown"
set_advisory_mode empty
run advisory-gc "$ADVISORY" <<EOF
{"session_id":"advisory-gc","cwd":"$HOOK_REPO"}
EOF
[ -f "$MARKERS/other-hook-cache" ] && [ ! -e "$MARKERS/orchestrate-advisory-old.shown" ] && pass advisory-gc-ownership || fail_case advisory-gc-ownership
mkdir -p "$STATE/cache-target/dotagents/hooks"; printf '%s\n' keep >"$STATE/cache-target/dotagents/hooks/keep"
make_symlink "$STATE/cache-target" "$STATE/cache-link" dir
set_advisory_mode valid
run advisory-cache-symlink env XDG_CACHE_HOME="$STATE/cache-link" "$ADVISORY" <<EOF
{"session_id":"advisory-cache-symlink","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass advisory-cache-symlink || fail_case advisory-cache-symlink

# 親cache rootがsymlinkでも、C1はwriteをfail-closedしreadをINFO縮退する。他hookは無出力。
run c1-cache-symlink env XDG_CACHE_HOME="$STATE/cache-link" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<'EOF'
{"session_id":"unsafe-delegation-read","tool_name":"mcp__codex-sidecar__codex_review","tool_input":{}}
EOF
json && [[ "$RUN_OUT" == *'内部障害'* && "$RUN_OUT" != *permissionDecision* ]] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass c1-cache-symlink || fail_case c1-cache-symlink
run c1-parent-state-writer-deny env XDG_CACHE_HOME="$STATE/cache-link" "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<'EOF'
{"session_id":"unsafe-delegation-write","tool_name":"mcp__aiterm__codex_agent","tool_input":{"model":"gpt-5.6-terra","reasoning_effort":"medium","prompt":"[scope:write] x"}}
EOF
json && [[ "$RUN_OUT" == *'P11_STATE_UNAVAILABLE'* ]] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass c1-parent-state-writer-deny || fail_case c1-parent-state-writer-deny
run c2-cache-symlink env XDG_CACHE_HOME="$STATE/cache-link" "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" session-start <<EOF
{"session_id":"unsafe-todo","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass c2-cache-symlink || fail_case c2-cache-symlink
run c4-cache-symlink env XDG_CACHE_HOME="$STATE/cache-link" "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<'EOF'
{"session_id":"unsafe-onset"}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass c4-cache-symlink || fail_case c4-cache-symlink
run codex-cache-symlink env XDG_CACHE_HOME="$STATE/cache-link" "$PYTHON_EXE" "$ROOT/bin/codex-callout-hook.sh" user-prompt-submit <<'EOF'
{"session_id":"unsafe-codex"}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ "$(cat "$STATE/cache-target/dotagents/hooks/keep")" = keep ] && pass codex-cache-symlink || fail_case codex-cache-symlink

run c2-stocktake "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" session-start <<EOF
{"session_id":"t1","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'INFO: docs/'* ]] && pass c2-stocktake || fail_case c2-stocktake
mkdir -p "$STATE/c3-no-lattice-bin" "$STATE/c3-lattice-bin"
install_git_fixture "$STATE/c3-no-lattice-bin"
install_git_fixture "$STATE/c3-lattice-bin"
cat >"$STATE/c3-lattice-bin/lattice" <<'EOF'
#!/bin/sh
[ "$1" = "status" ] && [ "$2" = "--json" ] || exit 2
printf '%s\n' '{"schema":"lattice.project_status.v1","state":"'"${LATTICE_STATUS_STATE:-ready}"'","store":{"ref":".lattice/todo"}}'
EOF
chmod +x "$STATE/c3-lattice-bin/lattice"
install_windows_fixture_wrapper "$STATE/c3-lattice-bin/lattice" bash
run c3-clean env PATH="$STATE/c3-no-lattice-bin" "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass c3-clean || fail_case c3-clean
printf '%s\n' changed >>"$REPO/source.txt"
run c3-warn env PATH="$STATE/c3-no-lattice-bin" "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ -f "$STATE/dotagents/hooks/$(session_key t1).todo-pending" ] && pass c3-warn || fail_case c3-warn
run c3-active env PATH="$STATE/c3-no-lattice-bin" "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":true}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass c3-active || fail_case c3-active
run c3-lattice-baseline env PATH="$STATE/c3-lattice-bin" LATTICE_STATUS_STATE=ready "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" stop <<EOF
{"session_id":"t-lattice","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass c3-lattice-baseline || fail_case c3-lattice-baseline
printf '%s\n' lattice-changed >"$REPO/lattice-source.txt"
run c3-lattice-ready env PATH="$STATE/c3-lattice-bin" LATTICE_STATUS_STATE=ready "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" stop <<EOF
{"session_id":"t-lattice","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
C3_LATTICE_PENDING="$STATE/dotagents/hooks/$(session_key t-lattice).todo-pending"
[ "$RUN_BYTES" -eq 0 ] && [ -f "$C3_LATTICE_PENDING" ] && grep -q 'Lattice storeへ記録' "$C3_LATTICE_PENDING" && grep -q 'plan_x.md' "$C3_LATTICE_PENDING" && pass c3-lattice-ready || fail_case c3-lattice-ready

run c4-normal "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"u1"}' && json && [[ "$RUN_OUT" == *'通常レーン'* && "$RUN_OUT" == *'対象限定commitだけで閉じます'* ]] && pass c4-normal || fail_case c4-normal
run c4-silent "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"u1"}' && [ "$RUN_BYTES" -eq 0 ] && pass c4-silent || fail_case c4-silent
run c4-off env DOTAGENTS_ONSET_GATE=off "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"u2"}' && [ "$RUN_BYTES" -eq 0 ] && pass c4-off || fail_case c4-off
printf '%s\n' keep >"$STATE/cache-file-target"
FILE_SYMLINK_KEY=$(session_key unsafe-file-marker)
make_symlink "$STATE/cache-file-target" "$STATE/dotagents/hooks/$FILE_SYMLINK_KEY.onset-info"
run c4-cache-file-symlink "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"unsafe-file-marker"}'
[ "$RUN_BYTES" -eq 0 ] && [ "$(cat "$STATE/cache-file-target")" = keep ] && pass c4-cache-file-symlink || fail_case c4-cache-file-symlink
run c4-pending "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"t1"}' && json && [[ "$RUN_OUT" == *'前ターン'* ]] && pass c4-pending || fail_case c4-pending
[ ! -f "$STATE/dotagents/hooks/$(session_key t1).todo-pending" ] && pass c4-pending-drained || fail_case c4-pending-drained
run c4-compact "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" session-start <<EOF
{"session_id":"u1","source":"compact","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass c4-compact || fail_case c4-compact
run c4-rearmed "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"u1"}' && json && [[ "$RUN_OUT" == *'INFO:'* ]] && pass c4-rearmed || fail_case c4-rearmed

# TODO gate off でも compact は onset/placement の再武装だけ行う
run c4-compact-todo-off env DOTAGENTS_TODO_GATE=off "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" session-start <<EOF
{"session_id":"u1","source":"compact","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass c4-compact-todo-off || fail_case c4-compact-todo-off
run c4-rearmed-todo-off "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<<'{"session_id":"u1"}' && json && [[ "$RUN_OUT" == *'INFO:'* ]] && pass c4-rearmed-todo-off || fail_case c4-rearmed-todo-off

# session_id は cache filename に連結しない。絶対path・../・長大入力でも SHA-256 の固定長 key だけを使う。
TRAVERSAL_SESSION='../outside'
ABSOLUTE_SESSION="$STATE/outside-absolute"
LONG_SESSION=$("$PYTHON_EXE" -c 'print("x" * 10000)')
for session in "$TRAVERSAL_SESSION" "$ABSOLUTE_SESSION" "$LONG_SESSION"; do
  key=$(session_key "$session")
  run c5-onset-session-key "$PYTHON_EXE" "$ROOT/bin/onset-gate-hook.sh" <<EOF
{"session_id":"$session"}
EOF
  json && [ -f "$STATE/dotagents/hooks/$key.onset-info" ] && [ "${#key}" -eq 64 ] && pass c5-onset-session-key || fail_case c5-onset-session-key
done
[ ! -e "$STATE/dotagents/outside.onset-info" ] && [ ! -e "$ABSOLUTE_SESSION.onset-info" ] && pass c5-session-key-no-escape || fail_case c5-session-key-no-escape

TRAVERSAL_KEY=$(session_key "$TRAVERSAL_SESSION")
run c5-delegation-session-key "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" <<EOF
{"session_id":"$TRAVERSAL_SESSION","tool_name":"Agent","tool_input":{"model":"x-20202607"}}
EOF
json && [ -f "$STATE/dotagents/hooks/$TRAVERSAL_KEY.placement-warn" ] && pass c5-delegation-session-key || fail_case c5-delegation-session-key
[ ! -e "$STATE/dotagents/outside.placement-warn" ] && pass c5-delegation-no-escape || fail_case c5-delegation-no-escape

TODO_ABSOLUTE_KEY=$(session_key "$ABSOLUTE_SESSION")
run c5-todo-session-key "$PYTHON_EXE" "$ROOT/bin/todo-gate-hook.sh" session-start <<EOF
{"session_id":"$ABSOLUTE_SESSION","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && find "$STATE/dotagents/hooks" -maxdepth 1 -name "$TODO_ABSOLUTE_KEY.*.snapshot" -type f | grep -q . && pass c5-todo-session-key || fail_case c5-todo-session-key
[ "$(find "$STATE" -maxdepth 1 -name 'outside-absolute.*.snapshot' -type f | wc -l | tr -d ' ')" -eq 0 ] && pass c5-todo-no-escape || fail_case c5-todo-no-escape

# Lattice工程表SessionStart hook。共通coreの異常系とClaude plain stdoutを固定する。
mkdir -p "$STATE/git-only" "$STATE/lattice-bin" "$STATE/non-git"
install_git_fixture "$STATE/git-only"
cat >"$STATE/lattice-bin/lattice" <<'EOF'
#!/usr/bin/env bash
# typed discovery: hookは `status --json` を接続判定の正本として先に呼ぶ。
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  case "${LATTICE_STATUS_STATE:-ready}" in
    ready) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}}' ;;
    active_run) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"active_run","store":{"ref":".lattice/todo"}}' ;;
    uninitialized) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"uninitialized","store":{"ref":".lattice/todo"}}' ;;
    missing) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"missing","store":{"ref":".lattice/todo"}}' ;;
    invalid) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"invalid","store":{"ref":".lattice/todo"}}'; exit 1 ;;
    status_bad) printf '%s\n' '{"schema":"wrong"}' ;;
    status_fail) exit 1 ;;
    status_timeout) sleep 6 ;;
  esac
  exit 0
fi
# 統合入口（Lattice 0.14.0以降）。未設定なら exit 2 のままで、
# 「この入口を持たない古いCLI」として旧2呼び出し経路のcaseを兼ねる。
if [ "$1" = "session-context" ] && [ "$2" = "--json" ]; then
  case "${LATTICE_CONTEXT_MODE:-absent}" in
    absent) exit 2 ;;
    verified) printf '%s\n' '{"schema":"lattice.session_context.v1","status":{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}},"todo":{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},"independence":[{"plan_key":"master","coverage":"verified","guidance":{"code":"independence_verified","message":"記録時点の宣言境界では、他のready工程と干渉しない。","next_action":"none"},"unreadable_reason":null,"parallel_groups":[["G5","G6"]],"serialize_pair_count":0,"conflict_with_active_count":0,"unknown_task_ids":[]}],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
    empty_frontier) printf '%s\n' '{"schema":"lattice.session_context.v1","status":{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}},"todo":{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},"independence":[{"plan_key":"master","coverage":"verified","guidance":{"code":"independence_verified","message":"記録時点の宣言境界では、他のready工程と干渉しない。","next_action":"none"},"unreadable_reason":null,"parallel_groups":[["G5","G6"]],"serialize_pair_count":0,"conflict_with_active_count":0,"unknown_task_ids":[]}],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
    conflict) printf '%s\n' '{"schema":"lattice.session_context.v1","status":{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}},"todo":{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},"independence":[{"plan_key":"master","coverage":"verified","guidance":{"code":"independence_conflict_with_active","message":"作業中の工程と同じ資源を書く記録がある。並行すると衝突する。","next_action":"serialize_or_split_boundary"},"unreadable_reason":null,"parallel_groups":[],"serialize_pair_count":1,"conflict_with_active_count":1,"unknown_task_ids":["G7"]}],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
    future_key) printf '%s\n' '{"schema":"lattice.session_context.v1","status":{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}},"todo":{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},"independence":[{"plan_key":"master","coverage":"verified","future_field":123,"guidance":{"code":"independence_verified","message":"記録時点の宣言境界では、他のready工程と干渉しない。","next_action":"none","future_hint":"x"},"unreadable_reason":null,"parallel_groups":[["G5"]],"serialize_pair_count":0,"conflict_with_active_count":0,"unknown_task_ids":[]}],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
    no_independence) printf '%s\n' '{"schema":"lattice.session_context.v1","status":{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}},"todo":{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},"independence":[],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
    bad) printf '%s\n' '{"schema":"wrong"}' ;;
    typed_fail) printf '%s\n' '{"schema":"lattice.cli_error.v2","code":"STORE_INCONSISTENT"}' >&2; exit 1 ;;
    slow) sleep 6 ;;
  esac
  exit 0
fi
[ "$*" = "todo status" ] || exit 2
case "${LATTICE_TEST_MODE:-valid_v1}" in
  valid_v1)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v1","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線"}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
  valid_v2)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v2","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[]},{"plan_key":"master","task_id":"G6","label":"host rollout","unmet_dependencies":[{"plan_key":"master","task_id":"G3"},{"plan_key":"master","project_id":"dotagents","task_id":"G2"}]}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' ;;
  valid_v3)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v3","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[]}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"plan_key":"queue","plan_version":"v1","through_sequence":0,"journal_head_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","reconciliation_state":"registered_unreconciled","revision_digest":null,"reconciliation_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
  valid_v4)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[]}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}' ;;
  empty_frontier)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v4","project_id":"dotagents","active_set":[],"next_ready":[],"blocked":[],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}' ;;
  valid_v5)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v5","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[]}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"audit_pending":[{"plan_key":"legacy","phase_id":"terminal-audit","phase_status":"gate_ready","implicit":true,"required_evidence_slots":["terminal-audit"],"next_commands":["lattice todo phase review --plan legacy --phase terminal-audit --reason <text>"]}],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}' ;;
  valid_v6)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v6","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[]}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"audit_pending":[{"plan_key":"legacy","phase_id":"terminal-audit","phase_status":"gate_ready","implicit":true,"required_evidence_slots":["terminal-audit"],"next_commands":["lattice todo phase review --plan legacy --phase terminal-audit --reason <text>"]}],"member_heads":[{"plan_key":"master","plan_version":"rev-a","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reconciliation_state":"reconciled","revision_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciliation_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"plan_notes":[{"plan_key":"master","plan_note_head_digest":"1111111111111111111111111111111111111111111111111111111111111111","count":1,"latest":[{"event_digest":"1111111111111111111111111111111111111111111111111111111111111111","actor_agent":"agent-1","recorded_at":"2026-08-08T00:00:00.000Z"}],"next_commands":["lattice todo note list --plan master --json"]}],"coordination":[{"plan_key":"master","mode":"conversation","declared_by":{"host":"host-1","session":"session-1","agent":"agent-1"},"declared_at":"2026-08-08T00:00:00.000Z","reason":"卓の合意で調整する"}],"parallel_candidates":[{"plan_key":"master","coverage":"missing","unjudged_task_ids":["G5"],"verified_parallel_groups":[],"serialize_pairs":[],"next_commands":["lattice todo independence compile --plan master --input <file>"]}]}' ;;
  invalid_audit_pending)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v5","project_id":"dotagents","active_set":[],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"audit_pending":[{"plan_key":"legacy","phase_id":"terminal-audit","phase_status":"accepted","implicit":true,"required_evidence_slots":["terminal-audit"],"next_commands":["lattice todo phase review --plan legacy --phase terminal-audit --reason <text>"]}],"member_heads":[],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":1,"subset_requires_reason":true,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}' ;;
  audit_only)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v5","project_id":"dotagents","active_set":[],"next_ready":[],"blocked":[],"audit_pending":[{"plan_key":"legacy","phase_id":"terminal-audit","phase_status":"gate_ready","implicit":true,"required_evidence_slots":["terminal-audit"],"next_commands":["lattice todo phase review --plan legacy --phase terminal-audit --reason <text>"]}],"member_heads":[],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1","selection_source":"next_ready","policy":"all_ready_parallel_by_default","recommended_parallelism":0,"subset_requires_reason":false,"parallel_start_flag":"--parallel-frontier","frontier_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}' ;;
  unsupported_v7)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v7","project_id":"dotagents","active_set":[],"next_ready":[],"blocked":[],"member_heads":[],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
  slow_success)
    sleep 3
    printf '%s\n' '{"schema":"lattice.todo_status_result.v1","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線"}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
  invalid) printf '%s\n' '{"schema":"wrong"}' ;;
  invalid_dependency)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v2","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[{"plan_key":"master","task_id":"G3","extra":"rejected"}]}],"next_ready":[],"blocked":[],"member_heads":[],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}' ;;
  flood) head -c 70000 /dev/zero | tr '\0' x ;;
  failure) exit 1 ;;
  timeout) sleep 6 ;;
esac
EOF
chmod +x "$STATE/lattice-bin/lattice"
install_windows_fixture_wrapper "$STATE/lattice-bin/lattice" bash
run_direct lattice-async-start env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-async","source":"startup","cwd":"$HOOK_REPO"}
EOF
async_key=$(session_key lattice-async)
[ "$RUN_BYTES" -eq 0 ] \
  && find "$STATE/dotagents/hooks" -maxdepth 1 -name "$async_key.*.lattice-gantt.pending" -type f | grep -q . \
  && pass lattice-async-immediate || fail_case lattice-async-immediate
run_direct lattice-async-pending env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" user-prompt-submit <<EOF
{"session_id":"lattice-async","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'バックグラウンドで実行中'* && "$RUN_OUT" == *'このINFOは依頼範囲を拡張しません。'* ]] && pass lattice-async-pending || fail_case lattice-async-pending
run_direct lattice-async-pending-once env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" user-prompt-submit <<EOF
{"session_id":"lattice-async","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-async-pending-once || fail_case lattice-async-pending-once
for _ in $(seq 1 40); do
  find "$STATE/dotagents/hooks" -maxdepth 1 -name "$(session_key lattice-async).*lattice-gantt.pending" -type f | grep -q . || break
  sleep 0.1
done
run_direct lattice-async-result env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" user-prompt-submit <<EOF
{"session_id":"lattice-async","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* ]] && pass lattice-async-result || fail_case lattice-async-result
run_direct lattice-async-result-once env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" user-prompt-submit <<EOF
{"session_id":"lattice-async","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-async-result-once || fail_case lattice-async-result-once
run_direct lattice-codex-async-start env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-async","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-codex-async-start || fail_case lattice-codex-async-start
for _ in $(seq 1 20); do
  find "$STATE/dotagents/hooks" -maxdepth 1 -name "$(session_key lattice-codex-async).*lattice-gantt.pending" -type f | grep -q . || break
  sleep 0.1
done
run_direct lattice-codex-async-result env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" user-prompt-submit <<EOF
{"session_id":"lattice-codex-async","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_OUT" == *'"hookEventName": "UserPromptSubmit"'* && "$RUN_OUT" == *'active=master/G4'* ]] && pass lattice-codex-async-result || fail_case lattice-codex-async-result
run lattice-nongit-missing env PATH="$STATE/git-only" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-nongit","source":"startup","cwd":"$STATE/non-git"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-nongit-missing || fail_case lattice-nongit-missing
run lattice-cli-missing env PATH="$STATE/git-only" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-missing","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'CLIが未導入'* ]] && pass lattice-cli-missing || fail_case lattice-cli-missing
# typed discovery: state=uninitialized（案内する工程が無い）は静かに終了する。
run lattice-store-missing env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=uninitialized "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-no-store","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-store-missing || fail_case lattice-store-missing
# state=missing も同様に静音。
run lattice-status-missing env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=missing "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-state-missing","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-status-missing || fail_case lattice-status-missing
# state=invalid は fail-visible（.lattice/todo の有無で早期判定しない）。
run lattice-status-invalid env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=invalid "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-state-invalid","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'invalid状態'* ]] && pass lattice-status-invalid || fail_case lattice-status-invalid
# discovery（status --json）自体の失敗も空扱いにせず fail-visible。
run lattice-status-fail env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=status_fail "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-state-fail","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'status --json実行失敗'* ]] && pass lattice-status-fail || fail_case lattice-status-fail
run lattice-status-bad env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=status_bad "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-state-bad","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'status --json応答を検証できませんでした'* ]] && pass lattice-status-bad || fail_case lattice-status-bad
mkdir -p "$REPO/.lattice/todo"
run lattice-gantt-missing env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-no-gantt","source":"clear","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'未生成'* && "$RUN_OUT" == *'active=master/G4（dotagents側アクセス配線）'* && "$RUN_OUT" == *'next-ready=master/G5（authoring CLI）'* && "$RUN_OUT" == *'lattice todo gantt'* ]] && pass lattice-gantt-missing || fail_case lattice-gantt-missing
mkdir -p "$REPO/.lattice/generated"; printf '%s\n' '<html></html>' >"$REPO/.lattice/generated/gantt.html"
run lattice-valid env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'file://'*'.lattice/generated/gantt.html'* && "$RUN_OUT" != *'未生成'* ]] && pass lattice-valid || fail_case lattice-valid
run lattice-valid-v2 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v2 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid-v2","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" == *'未充足依存あり: active 1件'* && "$RUN_OUT" != *'取得できませんでした'* ]] && pass lattice-valid-v2 || fail_case lattice-valid-v2
run lattice-valid-v3 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v3 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid-v3","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" == *'校正状態: reconciled=1, unreconciled=1'* && "$RUN_OUT" != *'取得できませんでした'* ]] && pass lattice-valid-v3 || fail_case lattice-valid-v3
# v4: dispatch_frontier付き。受理され、依存件数と校正状態のv4分岐が動くこと。
run lattice-valid-v4 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v4 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid-v4","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" == *'校正状態: reconciled=1, unreconciled=0'* && "$RUN_OUT" != *'取得できませんでした'* && "$RUN_OUT" != *'対応範囲外'* ]] && pass lattice-valid-v4 || fail_case lattice-valid-v4
# 正規v4で案内する現在地が空なら、旧2呼び出し経路は完全に沈黙する。
run lattice-empty-frontier env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=empty_frontier "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-empty-frontier","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-empty-frontier || fail_case lattice-empty-frontier
# active_run state でも工程を読む。
run lattice-active-run env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=active_run LATTICE_TEST_MODE=valid_v4 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-active-run","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" != *'取得できませんでした'* ]] && pass lattice-active-run || fail_case lattice-active-run
# v5: audit_pending付き。受理され、v4分岐（依存件数・校正状態）も引き続き動くこと。
# ここが落ちると、v5をpublishした瞬間に全projectでSessionStartの工程案内が消える。
run lattice-valid-v5 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v5 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid-v5","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" == *'校正状態: reconciled=1, unreconciled=0'* && "$RUN_OUT" == *'監査待ち1件: legacy/terminal-audit（gate_ready）'* && "$RUN_OUT" != *'取得できませんでした'* && "$RUN_OUT" != *'対応範囲外'* ]] && pass lattice-valid-v5 || fail_case lattice-valid-v5
# v6: 工程3欄（plan_notes / coordination / parallel_candidates）付き。受理され、
# v4/v5分岐（依存件数・校正状態・監査待ち）も引き続き動くこと。ここが落ちると、
# v6をpublishした瞬間に全projectでSessionStartの工程案内が消える。
run lattice-valid-v6 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v6 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-valid-v6","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" == *'校正状態: reconciled=1, unreconciled=0'* && "$RUN_OUT" == *'監査待ち1件: legacy/terminal-audit（gate_ready）'* && "$RUN_OUT" != *'取得できませんでした'* && "$RUN_OUT" != *'対応範囲外'* ]] && pass lattice-valid-v6 || fail_case lattice-valid-v6
# audit_pendingの値域外（accepted）はexact検証で落ちる。監査欄を素通しにはしない。
run lattice-invalid-audit-pending env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=invalid_audit_pending "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-invalid-audit-pending","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'取得できませんでした'* ]] && pass lattice-invalid-audit-pending || fail_case lattice-invalid-audit-pending
# 全taskがdoneでも監査待ちが残る間は沈黙しない。ここが沈黙すると「残作業なし」と答えたのと同じで、
# この工程が直している終端監査の失念をhook自身が後押しすることになる。
run lattice-audit-only env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=audit_only "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-audit-only","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'監査待ち1件: legacy/terminal-audit（gate_ready）'* && "$RUN_OUT" == *'未監査は未完了です'* && "$RUN_OUT" == *'active=なし; next-ready=なし'* ]] && pass lattice-audit-only || fail_case lattice-audit-only
# unsupported version（v7）: malformed とは別の「対応範囲外」を fail-visible に出す。
run lattice-unsupported env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=unsupported_v7 "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-unsupported","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'対応範囲外'* && "$RUN_OUT" == *'CLIの版とstore整合を確認'* ]] && pass lattice-unsupported || fail_case lattice-unsupported
run lattice-slow-success env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-slow-success","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'active=master/G4'* && "$RUN_OUT" != *'取得できませんでした'* ]] && pass lattice-slow-success || fail_case lattice-slow-success
for mode in invalid invalid_dependency flood; do
  run "lattice-$mode" env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE="$mode" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-$mode","source":"startup","cwd":"$HOOK_REPO"}
EOF
  [[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'status応答を検証できない'* && "$RUN_OUT" == *'CLIの版とstore整合を確認'* ]] && pass "lattice-$mode" || fail_case "lattice-$mode"
done
run lattice-failure env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=failure "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-failure","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'CLI実行失敗'* ]] && pass lattice-failure || fail_case lattice-failure
run lattice-timeout env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=timeout "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-timeout","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'status取得が期限超過'* ]] && pass lattice-timeout || fail_case lattice-timeout
run lattice-resume env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-resume","source":"resume","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-resume || fail_case lattice-resume
run lattice-off env PATH="$STATE/lattice-bin:$PATH" DOTAGENTS_LATTICE_HOOK=off "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-off","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-off || fail_case lattice-off

# --- 統合入口（Lattice ADR 0131） ---
run lattice-context-verified env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=verified "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-verified","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'並列可否:'* \
  && "$RUN_OUT" == *'検証済み並列1group(2件)'* \
  && "$RUN_OUT" == *'他のready工程と干渉しない'* ]] \
  && pass lattice-context-verified || fail_case lattice-context-verified

# 正規session-contextの現在地が空なら、統合入口も完全に沈黙する。
run lattice-context-empty-frontier env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=empty_frontier "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-empty-frontier","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-context-empty-frontier || fail_case lattice-context-empty-frontier

run lattice-context-conflict env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=conflict "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-conflict","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == *'要直列1組'* && "$RUN_OUT" == *'作業中との競合1件'* \
  && "$RUN_OUT" == *'未検査1件'* && "$RUN_OUT" == *'並行すると衝突する'* ]] \
  && pass lattice-context-conflict || fail_case lattice-context-conflict

# 未知keyの追加でhookが壊れないこと（allowlist読み）。
run lattice-context-future-key env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=future_key "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-future-key","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'検証済み並列1group(1件)'* ]] \
  && pass lattice-context-future-key || fail_case lattice-context-future-key

# readyのあるplanに記録が無ければ並列可否は述べない（fragmentごと出さない）。
run lattice-context-no-independence env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=no_independence "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-no-independence","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" != *'並列可否:'* ]] \
  && pass lattice-context-no-independence || fail_case lattice-context-no-independence

# 応答が読めないときは静かに旧経路へ回らず、理由を出す（fail closed）。
run lattice-context-bad env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=bad "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-bad","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'検証できない'* ]] \
  && pass lattice-context-bad || fail_case lattice-context-bad

# typed failure（exit 1）は未実装と区別してfail-visibleにする。
run lattice-context-typed-fail env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=typed_fail "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-typed-fail","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'CLI実行失敗'* ]] \
  && pass lattice-context-typed-fail || fail_case lattice-context-typed-fail

run lattice-context-timeout env PATH="$STATE/lattice-bin:$PATH" LATTICE_CONTEXT_MODE=slow "$PYTHON_EXE" "$ROOT/bin/lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-context-timeout","source":"startup","cwd":"$HOOK_REPO"}
EOF
[[ "$RUN_OUT" == 'INFO: Lattice工程表:'* && "$RUN_OUT" == *'期限超過'* ]] \
  && pass lattice-context-timeout || fail_case lattice-context-timeout


# --- boundary-gate: 作業repoと異なる製品repoへの書込は責務宣言が要る ---
BOUNDARY_ROOT=$(mktemp -d)
mkdir -p "$BOUNDARY_ROOT/session-repo" "$BOUNDARY_ROOT/other-product" "$STATE/boundary"
( cd "$BOUNDARY_ROOT/session-repo" && git init -q . )
( cd "$BOUNDARY_ROOT/other-product" && git init -q . )
HB_SESSION=$(native_path "$BOUNDARY_ROOT/session-repo")
HB_OTHER=$(native_path "$BOUNDARY_ROOT/other-product")
HB_PRODUCTS=$(native_path "$BOUNDARY_ROOT")
HB_DECL=$(native_path "$STATE/boundary")
run boundary-cross-deny env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Edit","cwd":"$HB_SESSION","tool_input":{"file_path":"$HB_OTHER/src/a.mjs","old_string":"a","new_string":"b"}}
EOF
json && [[ "$RUN_OUT" == *'permissionDecision'* && "$RUN_OUT" == *'P13_BOUNDARY_UNDECLARED'* && "$RUN_OUT" == *'所有者:'* ]] && pass boundary-cross-deny || fail_case boundary-cross-deny
run boundary-same-repo-noop env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Write","cwd":"$HB_SESSION","tool_input":{"file_path":"$HB_SESSION/src/a.mjs","content":"x"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass boundary-same-repo-noop || fail_case boundary-same-repo-noop
run boundary-outside-products-noop env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Write","cwd":"$HB_SESSION","tool_input":{"file_path":"$HOOK_REPO/note.md","content":"x"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass boundary-outside-products-noop || fail_case boundary-outside-products-noop
printf '%s\n' '症状: other-product の配達が詰まる' '所有者: other-product/bridge' '理由: 症状の場所と所有者が同じ' '反証: 未実施' >"$STATE/boundary/other-product.md"
run boundary-declared-allow env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Edit","cwd":"$HB_SESSION","tool_input":{"file_path":"$HB_OTHER/src/a.mjs","old_string":"a","new_string":"b"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass boundary-declared-allow || fail_case boundary-declared-allow
printf '%s\n' '症状: x' '所有者:' '理由: y' '反証: z' >"$STATE/boundary/other-product.md"
run boundary-declared-incomplete-deny env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Edit","cwd":"$HB_SESSION","tool_input":{"file_path":"$HB_OTHER/src/a.mjs","old_string":"a","new_string":"b"}}
EOF
json && [[ "$RUN_OUT" == *'P13_BOUNDARY_UNDECLARED'* ]] && pass boundary-declared-incomplete-deny || fail_case boundary-declared-incomplete-deny
rm -f "$STATE/boundary/other-product.md"
run boundary-bash-commit-deny env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Bash","cwd":"$HB_SESSION","tool_input":{"command":"cd $HB_OTHER && git commit -q -m x && npm publish"}}
EOF
json && [[ "$RUN_OUT" == *'P13_BOUNDARY_UNDECLARED'* ]] && pass boundary-bash-commit-deny || fail_case boundary-bash-commit-deny
run boundary-bash-read-noop env DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Bash","cwd":"$HB_SESSION","tool_input":{"command":"cd $HB_OTHER && git status && cat README.md"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass boundary-bash-read-noop || fail_case boundary-bash-read-noop
run boundary-off env DOTAGENTS_BOUNDARY_GATE=off DOTAGENTS_PRODUCT_ROOT="$HB_PRODUCTS" DOTAGENTS_BOUNDARY_DIR="$HB_DECL" "$PYTHON_EXE" "$ROOT/bin/boundary-gate-hook.sh" <<EOF
{"tool_name":"Edit","cwd":"$HB_SESSION","tool_input":{"file_path":"$HB_OTHER/src/a.mjs","old_string":"a","new_string":"b"}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass boundary-off || fail_case boundary-off
rm -rf "$BOUNDARY_ROOT"

if [ "$fail" -ne 0 ]; then exit 1; fi
printf 'ALL PASS\n'
