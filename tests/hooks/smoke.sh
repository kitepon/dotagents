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
  "$@" >"$out" 2>"$err"; RUN_STATUS=$?
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

if [ "$fail" -ne 0 ]; then exit 1; fi
printf 'ALL PASS\n'
