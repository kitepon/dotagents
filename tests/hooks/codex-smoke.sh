#!/usr/bin/env bash
# shellcheck disable=SC2015
# bin/codex-callout-hook.sh の空打ちテスト（X1-X5）。既存 smoke.sh（Claude 側）は触らない。
set -u
umask 077

export PYTHONUTF8=1

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
  local script="$1" runtime_path
  runtime_path=$(cygpath -w "$(command -v bash)")
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
WRITER_REPO=$(mktemp -d)
HOOK_REPO=$REPO
HOOK_STATE=$STATE
if command -v cygpath >/dev/null 2>&1; then
  HOOK_REPO=$(cygpath -m "$REPO")
  HOOK_STATE=$(cygpath -m "$STATE")
fi
HOOK_WRITER_REPO=$(native_path "$WRITER_REPO")
HOOK_HOME=$(native_path "$STATE/home")
trap 'rm -rf "$STATE" "$REPO" "$WRITER_REPO"' EXIT
export XDG_CACHE_HOME="$HOOK_STATE"
HOOK="$ROOT/bin/codex-callout-hook.sh"

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
  if [[ "$*" == *"codex-lattice-gantt-hook.sh session-start"* ]]; then
    lattice_input=$(cat)
    "$@" <<<"$lattice_input" >"$out" 2>"$err"; RUN_STATUS=$?
    if [ "$RUN_STATUS" -eq 0 ] && [ ! -s "$err" ]; then
      lattice_key=$(printf '%s' "$lattice_input" | "$PYTHON_EXE" -c 'import hashlib,json,sys; print(hashlib.sha256(json.load(sys.stdin)["session_id"].encode()).hexdigest())')
      for _ in $(seq 1 70); do
        find "$STATE/dotagents/hooks" -maxdepth 1 -name "$lattice_key.*.lattice-gantt.pending" -type f 2>/dev/null | grep -q . || break
        sleep 0.1
      done
      # Windowsのcleanupより先に、workerが中継fileを閉じて終了する余地を与える。
      sleep 0.1
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
json() {
  RUN_JSON_TEXT=$(printf '%s' "$RUN_OUT" | "$PYTHON_EXE" -c 'import json,sys; sys.stdout.buffer.write(json.dumps(json.load(sys.stdin), ensure_ascii=False).encode("utf-8"))' 2>/dev/null)
}
session_key() { printf '%s' "$1" | "$PYTHON_EXE" -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }

# 対象外サブコマンド／引数なし → 沈黙
run x0-noargs "$PYTHON_EXE" "$HOOK" <<<'{}' && [ "$RUN_BYTES" -eq 0 ] && pass x0-noargs || fail_case x0-noargs
run x0-badcmd "$PYTHON_EXE" "$HOOK" bogus <<<'{}' && [ "$RUN_BYTES" -eq 0 ] && pass x0-badcmd || fail_case x0-badcmd

# --- X2 pre-tool-use fast-path ---
run x2-fastpath-other "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"p0","tool_name":"apply_patch","tool_input":{}}' && [ "$RUN_BYTES" -eq 0 ] && pass x2-fastpath-other || fail_case x2-fastpath-other

# update_plan 初回・step<4 → 沈黙
run x2-plan-small "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"p1","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"pending"},{"step":"b","status":"pending"}]}}' \
  && [ "$RUN_BYTES" -eq 0 ] && pass x2-plan-small || fail_case x2-plan-small

# update_plan 初回・step>=4 → レーン別の計画文言
run x2-plan-canon "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"p2","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"pending"},{"step":"b","status":"pending"},{"step":"c","status":"pending"},{"step":"d","status":"pending"}]}}
EOF
json && [[ "$RUN_OUT" == *"通常レーンは内蔵planで足り"* && "$RUN_OUT" == *"統括レーンだけ"* ]] && pass x2-plan-canon || fail_case x2-plan-canon

# 同一セッション2回目の update_plan（4件以上でも）→ 初回スロットル済みで沈黙
run x2-plan-canon-2nd "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"p2","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"pending"},{"step":"b","status":"pending"},{"step":"c","status":"pending"},{"step":"d","status":"pending"}]}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x2-plan-canon-2nd || fail_case x2-plan-canon-2nd

# 全 step completed → TODO 消化文言（別セッションで独立に発火することを確認）
run x2-plan-done "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"p3","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"completed"},{"step":"b","status":"completed"}]}}
EOF
json && [[ "$RUN_OUT" == *"completed"* ]] && pass x2-plan-done || fail_case x2-plan-done

# 同一セッション再度全 completed → スロットル済みで沈黙
run x2-plan-done-2nd "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"p3","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"completed"},{"step":"b","status":"completed"}]}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x2-plan-done-2nd || fail_case x2-plan-done-2nd

# DOTAGENTS_TODO_GATE=off → update_plan は沈黙
run x2-plan-off env DOTAGENTS_TODO_GATE=off "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"p4","tool_name":"update_plan","tool_input":{"plan":[{"step":"a","status":"pending"},{"step":"b","status":"pending"},{"step":"c","status":"pending"},{"step":"d","status":"pending"}]}}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x2-plan-off || fail_case x2-plan-off

# spawn_agent: model 明示、または配布先の固定model roleだけを許可する。
run x2-spawn-info "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s1","tool_name":"spawn_agent","tool_input":{"model":"x-20260227","message":"[scope:read-only]"}}' \
  && json && [[ "$RUN_OUT" == *'INFO:'* && "$RUN_OUT" != *permissionDecision* ]] && pass x2-spawn-info || fail_case x2-spawn-info
run x2-spawn-direct-inherit-deny "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s1i","tool_name":"spawn_agent","tool_input":{"model":"inherit"}}' \
  && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass x2-spawn-direct-inherit-deny || fail_case x2-spawn-direct-inherit-deny
mkdir -p "$STATE/home/.codex/agents"
printf '%s\n' 'model = "gpt-5.6-terra"' >"$STATE/home/.codex/agents/fixed.toml"
run x2-spawn-fixed-role env HOME="$HOOK_HOME" USERPROFILE="$HOOK_HOME" "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s2","tool_name":"spawn_agent","tool_input":{"agent_type":"fixed","message":"[scope:read-only]"}}' \
  && json && [[ "$RUN_OUT" == *'INFO:'* ]] && pass x2-spawn-fixed-role || fail_case x2-spawn-fixed-role
run x2-spawn-missing-deny env HOME="$HOOK_HOME" USERPROFILE="$HOOK_HOME" "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s3","tool_name":"spawn_agent","tool_input":{"agent_type":"unknown"}}' \
  && json && [[ "$RUN_OUT" == *'decision'* && "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass x2-spawn-missing-deny || fail_case x2-spawn-missing-deny
printf '%s\n' 'model = "inherit"' >"$STATE/home/.codex/agents/inherit.toml"
run x2-spawn-inherit-deny env HOME="$HOOK_HOME" USERPROFILE="$HOOK_HOME" "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s4","tool_name":"spawn_agent","tool_input":{"agent_type":"inherit"}}' \
  && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass x2-spawn-inherit-deny || fail_case x2-spawn-inherit-deny
printf '%s\n' 'model = "gpt-5.6-terra"' 'reasoning_effort = "inherit"' >"$STATE/home/.codex/agents/bad-effort.toml"
run x2-spawn-effort-inherit-deny env HOME="$HOOK_HOME" USERPROFILE="$HOOK_HOME" "$PYTHON_EXE" "$HOOK" pre-tool-use <<<'{"session_id":"s4e","tool_name":"spawn_agent","tool_input":{"agent_type":"bad-effort"}}' \
  && json && [[ "$RUN_OUT" == *'P10_MODEL_EFFORT_MISSING'* ]] && pass x2-spawn-effort-inherit-deny || fail_case x2-spawn-effort-inherit-deny

git -C "$WRITER_REPO" init -q && git -C "$WRITER_REPO" config user.email smoke@example.test && git -C "$WRITER_REPO" config user.name smoke
printf '%s\n' base >"$WRITER_REPO/source.txt"
git -C "$WRITER_REPO" add . && git -C "$WRITER_REPO" commit -qm initial

# X2 writerはC1と同じscope tokenと共有reservationを使う。
run x2-scope-missing-deny "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w0","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO"}}
EOF
json && [[ "$RUN_OUT" == *'P9_SCOPE_DECL_MISSING'* && "$RUN_OUT" == *'"decision": "deny"'* ]] && pass x2-scope-missing-deny || fail_case x2-scope-missing-deny

run x2-writer-first "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w1","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:write]"}}
EOF
json && [[ "$RUN_OUT" != *'"decision": "deny"'* ]] && pass x2-writer-first || fail_case x2-writer-first
run x2-writer-busy-deny "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w2","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:write]"}}
EOF
json && [[ "$RUN_OUT" == *'P11_WRITER_BUSY'* && "$RUN_OUT" == *'"decision": "deny"'* ]] && pass x2-writer-busy-deny || fail_case x2-writer-busy-deny
run x2-writer-release "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir "$HOOK_WRITER_REPO/.git" </dev/null \
  && json && [[ "$RUN_OUT" == *'released_common_dir'* ]] && pass x2-writer-release || fail_case x2-writer-release
run x2-writer-after-release "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w3","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:write]"}}
EOF
json && [[ "$RUN_OUT" != *'"decision": "deny"'* ]] && pass x2-writer-after-release || fail_case x2-writer-after-release
run x2-writer-release-2 "$PYTHON_EXE" "$ROOT/bin/delegation-gate-hook.sh" --release --common-dir "$HOOK_WRITER_REPO/.git" </dev/null \
  && json && pass x2-writer-release-2 || fail_case x2-writer-release-2
run x2-reader-passthrough "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w4","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:read-only]"}}
EOF
json && [[ "$RUN_OUT" != *'"decision": "deny"'* ]] && pass x2-reader-passthrough || fail_case x2-reader-passthrough
mkdir -p "$STATE/unavailable-writer-state"
rmdir "$STATE/dotagents/hooks/writer-reservations"
make_symlink "$STATE/unavailable-writer-state" "$STATE/dotagents/hooks/writer-reservations" dir
run x2-writer-state-unavailable-deny "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"w5","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:write]"}}
EOF
json && [[ "$RUN_OUT" == *'P11_STATE_UNAVAILABLE'* && "$RUN_OUT" == *'"decision": "deny"'* ]] && pass x2-writer-state-unavailable-deny || fail_case x2-writer-state-unavailable-deny

# DOTAGENTS_PLACEMENT_GATE=off → spawn_agent は沈黙
run x2-spawn-off env DOTAGENTS_PLACEMENT_GATE=off "$PYTHON_EXE" "$HOOK" pre-tool-use <<EOF
{"session_id":"s5","tool_name":"spawn_agent","cwd":"$HOOK_WRITER_REPO","tool_input":{"model":"x-20260227","cwd":"$HOOK_WRITER_REPO","message":"[scope:write]"}}
EOF
[ "$RUN_STATUS" -eq 0 ] && [ "$RUN_BYTES" -eq 0 ] && pass x2-spawn-off || fail_case x2-spawn-off

# --- X1 session-start（C2 ミラー） ---
git -C "$REPO" init -q && git -C "$REPO" config user.email smoke@example.test && git -C "$REPO" config user.name smoke && git -C "$REPO" config core.autocrlf false
mkdir "$REPO/docs"; printf '%s\n' '- [ ] task' >"$REPO/docs/plan_x.md"; printf '%s\n' base >"$REPO/source.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm initial

run x1-stocktake "$PYTHON_EXE" "$HOOK" session-start <<EOF
{"session_id":"t1","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_OUT" == *'INFO: docs/'* ]] && pass x1-stocktake || fail_case x1-stocktake

run x1-resume "$PYTHON_EXE" "$HOOK" session-start <<EOF
{"session_id":"t2","source":"resume","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x1-resume || fail_case x1-resume

run x1-off env DOTAGENTS_TODO_GATE=off "$PYTHON_EXE" "$HOOK" session-start <<EOF
{"session_id":"t3","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x1-off || fail_case x1-off

# --- X4 stop（C3 ミラー） ---
run x4-clean "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x4-clean || fail_case x4-clean

printf '%s\n' changed >>"$REPO/source.txt"
run x4-warn "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ -f "$STATE/dotagents/hooks/$(session_key t1).codex-pending" ] && pass x4-warn || fail_case x4-warn

# dirty snapshot から同一HEADのcleanへ戻った時も、直前の変更pathを保持して0ファイルと誤表示しない。
git -C "$REPO" restore source.txt
run x4-dirty-clean "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
pending=$(cat "$STATE/dotagents/hooks/$(session_key t1).codex-pending")
[ "$RUN_BYTES" -eq 0 ] && [[ "$pending" == *'1 ファイルの作業差分を解消'* && "$pending" != *'0 ファイル'* ]] && pass x4-dirty-clean || fail_case x4-dirty-clean

# 配布前の2行snapshotでも、dirty→cleanを0ファイルとは表示しない。
printf '%s\n' legacy >>"$REPO/source.txt"
run x4-legacy-baseline "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t-legacy","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
legacy_snapshot=$(find "$STATE/dotagents/hooks" -maxdepth 1 -name "$(session_key t-legacy).*codex-snapshot" -print -quit)
sed -n '1,2p' "$legacy_snapshot" >"$legacy_snapshot.old"
mv "$legacy_snapshot.old" "$legacy_snapshot"
git -C "$REPO" restore source.txt
run x4-legacy-dirty-clean "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t-legacy","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
pending=$(cat "$STATE/dotagents/hooks/$(session_key t-legacy).codex-pending")
[ "$RUN_BYTES" -eq 0 ] && [[ "$pending" == *'dirtyだった作業差分を解消'* && "$pending" != *'0 ファイル'* ]] && pass x4-legacy-dirty-clean || fail_case x4-legacy-dirty-clean

run x4-active "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":true}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x4-active || fail_case x4-active

run x4-off env DOTAGENTS_TODO_GATE=off "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x4-off || fail_case x4-off

# block 値でもStopは止めず、pending保存だけ
printf '%s\n' new2 >"$REPO/source2.txt"
run x4-block-1 env DOTAGENTS_TODO_GATE=block "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t1","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && [ -f "$STATE/dotagents/hooks/$(session_key t1).codex-pending" ] && pass x4-block-1 || fail_case x4-block-1

mkdir -p "$STATE/codex-c3-lattice-bin"
install_git_fixture "$STATE/codex-c3-lattice-bin"
cat >"$STATE/codex-c3-lattice-bin/lattice" <<'EOF'
#!/bin/sh
[ "$1" = "status" ] && [ "$2" = "--json" ] || exit 2
printf '%s\n' '{"schema":"lattice.project_status.v1","state":"'"${LATTICE_STATUS_STATE:-ready}"'","store":{"ref":".lattice/todo"}}'
EOF
chmod +x "$STATE/codex-c3-lattice-bin/lattice"
install_windows_fixture_wrapper "$STATE/codex-c3-lattice-bin/lattice"
run x4-lattice-baseline env PATH="$STATE/codex-c3-lattice-bin" LATTICE_STATUS_STATE=ready "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t-lattice","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x4-lattice-baseline || fail_case x4-lattice-baseline
printf '%s\n' lattice-changed >"$REPO/lattice-source.txt"
run x4-lattice-ready env PATH="$STATE/codex-c3-lattice-bin" LATTICE_STATUS_STATE=ready "$PYTHON_EXE" "$HOOK" stop <<EOF
{"session_id":"t-lattice","cwd":"$HOOK_REPO","stop_hook_active":false}
EOF
X4_LATTICE_PENDING="$STATE/dotagents/hooks/$(session_key t-lattice).codex-pending"
[ "$RUN_BYTES" -eq 0 ] && [ -f "$X4_LATTICE_PENDING" ] && grep -q 'Lattice storeへ記録' "$X4_LATTICE_PENDING" && grep -q 'plan_x.md' "$X4_LATTICE_PENDING" && pass x4-lattice-ready || fail_case x4-lattice-ready

# --- X3/X5 user-prompt-submit（セッション1回のINFO ＋ pending drain） ---
run x35-normal "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u1"}' \
  && json && [[ "$RUN_OUT" == *'通常レーン'* && "$RUN_OUT" == *'対象限定commitだけで閉じます'* ]] && pass x35-normal || fail_case x35-normal

run x35-silent "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u1"}' \
  && [ "$RUN_BYTES" -eq 0 ] && pass x35-silent || fail_case x35-silent

run x35-off env DOTAGENTS_ONSET_GATE=off "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u2"}' \
  && [ "$RUN_BYTES" -eq 0 ] && pass x35-off || fail_case x35-off

mkdir -p "$STATE/dotagents/hooks"
printf '%s' 'pending-notice-text' >"$STATE/dotagents/hooks/$(session_key u3).codex-pending"
run x35-pending "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u3"}' \
  && json && [[ "$RUN_OUT" == *'pending-notice-text'* && "$RUN_OUT" == *'INFO:'* ]] && pass x35-pending || fail_case x35-pending
[ ! -f "$STATE/dotagents/hooks/$(session_key u3).codex-pending" ] && pass x35-pending-drained || fail_case x35-pending-drained

run x35-compact "$PYTHON_EXE" "$HOOK" session-start <<EOF
{"session_id":"u1","source":"compact","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass x35-compact || fail_case x35-compact
run x35-rearmed "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u1"}' \
  && json && [[ "$RUN_OUT" == *'INFO:'* ]] && pass x35-rearmed || fail_case x35-rearmed

# TODO gate off なら既存 pending も配送しない
printf '%s' 'must-stay-pending' >"$STATE/dotagents/hooks/$(session_key u4).codex-pending"
run x35-pending-off env DOTAGENTS_TODO_GATE=off DOTAGENTS_ONSET_GATE=off "$PYTHON_EXE" "$HOOK" user-prompt-submit <<<'{"session_id":"u4"}' \
  && [ "$RUN_BYTES" -eq 0 ] && [ -f "$STATE/dotagents/hooks/$(session_key u4).codex-pending" ] && pass x35-pending-off || fail_case x35-pending-off

# 絶対path・../・長大入力でも Codex hook は固定長 digest filename だけを参照する。
for session in "$STATE/codex-absolute" '../codex-outside' "$("$PYTHON_EXE" -c 'print("y" * 10000)')"; do
  key=$(session_key "$session")
  printf '%s' 'digest-pending' >"$STATE/dotagents/hooks/$key.codex-pending"
  run x6-session-key "$PYTHON_EXE" "$HOOK" user-prompt-submit <<EOF
{"session_id":"$session"}
EOF
  json && [[ "$RUN_OUT" == *'digest-pending'* ]] && [ ! -e "$STATE/dotagents/hooks/$key.codex-pending" ] && pass x6-session-key || fail_case x6-session-key
done
[ ! -e "$STATE/codex-absolute.codex-pending" ] && [ ! -e "$STATE/dotagents/codex-outside.codex-pending" ] && pass x6-session-key-no-escape || fail_case x6-session-key-no-escape

# Codex frontendは共通Lattice coreのINFOをadditionalContextへ包む。
mkdir -p "$STATE/git-only" "$STATE/lattice-bin" "$REPO/.lattice/todo" "$REPO/.lattice/generated"
install_git_fixture "$STATE/git-only"
cat >"$STATE/lattice-bin/lattice" <<'EOF'
#!/usr/bin/env bash
# typed discovery: hookは `status --json` を接続判定の正本として先に呼ぶ。
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  case "${LATTICE_STATUS_STATE:-ready}" in
    ready) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"ready","store":{"ref":".lattice/todo"}}' ;;
    uninitialized) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"uninitialized","store":{"ref":".lattice/todo"}}' ;;
    invalid) printf '%s\n' '{"schema":"lattice.project_status.v1","state":"invalid","store":{"ref":".lattice/todo"}}'; exit 1 ;;
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
  unsupported_v7)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v7","project_id":"dotagents","active_set":[],"next_ready":[],"blocked":[],"member_heads":[],"result_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' ;;
  slow_success)
    sleep 3
    printf '%s\n' '{"schema":"lattice.todo_status_result.v1","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線"}],"next_ready":[{"plan_key":"master","task_id":"G5","label":"authoring CLI"}],"blocked":[],"member_heads":[{"plan_key":"master","through_sequence":4,"journal_head_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
  invalid)
    printf '%s\n' '{"schema":"wrong"}' ;;
  invalid_dependency)
    printf '%s\n' '{"schema":"lattice.todo_status_result.v2","project_id":"dotagents","active_set":[{"plan_key":"master","task_id":"G4","label":"dotagents側アクセス配線","unmet_dependencies":[{"plan_key":"master","task_id":"G3","extra":"rejected"}]}],"next_ready":[],"blocked":[],"member_heads":[],"result_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}' ;;
  failure) exit 1 ;;
  timeout) sleep 6 ;;
esac
EOF
chmod +x "$STATE/lattice-bin/lattice"
install_windows_fixture_wrapper "$STATE/lattice-bin/lattice"
printf '%s\n' '<html></html>' >"$REPO/.lattice/generated/gantt.html"
run lattice-codex-missing env PATH="$STATE/git-only" "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-missing","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'CLIが未導入'* ]] && pass lattice-codex-missing || fail_case lattice-codex-missing
run lattice-codex-valid env PATH="$STATE/lattice-bin:$PATH" "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid","source":"startup","cwd":"$HOOK_REPO"}
EOF
json \
  && printf '%s' "$RUN_OUT" | "$PYTHON_EXE" -c 'import sys; sys.stdin.buffer.read().decode("ascii")' \
  && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'file://'* && "$RUN_JSON_TEXT" == *'active=master/G4'* && "$RUN_OUT" == *'\u'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] \
  && pass lattice-codex-valid || fail_case lattice-codex-valid
run lattice-codex-valid-v2 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v2 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid-v2","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'未充足依存あり: active 1件'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-valid-v2 || fail_case lattice-codex-valid-v2
run lattice-codex-valid-v3 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v3 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid-v3","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'校正状態: reconciled=1, unreconciled=1'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-valid-v3 || fail_case lattice-codex-valid-v3
run lattice-codex-valid-v4 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v4 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid-v4","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'active=master/G4'* && "$RUN_JSON_TEXT" == *'reconciled=1, unreconciled=0'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-valid-v4 || fail_case lattice-codex-valid-v4
run lattice-codex-empty-frontier env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=empty_frontier "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-empty-frontier","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-codex-empty-frontier || fail_case lattice-codex-empty-frontier
run lattice-codex-valid-v5 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v5 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid-v5","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'active=master/G4'* && "$RUN_JSON_TEXT" == *'reconciled=1, unreconciled=0'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* && "$RUN_JSON_TEXT" != *'対応範囲外'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-valid-v5 || fail_case lattice-codex-valid-v5
run lattice-codex-valid-v6 env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=valid_v6 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-valid-v6","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'active=master/G4'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* && "$RUN_JSON_TEXT" != *'対応範囲外'* ]] && pass lattice-codex-valid-v6 || fail_case lattice-codex-valid-v6
run lattice-codex-unsupported env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=unsupported_v7 "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-unsupported","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'CLIの版とstore整合を確認'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-unsupported || fail_case lattice-codex-unsupported
run lattice-codex-status-invalid env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=invalid "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-status-invalid","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'invalid'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-status-invalid || fail_case lattice-codex-status-invalid
run lattice-codex-uninitialized env PATH="$STATE/lattice-bin:$PATH" LATTICE_STATUS_STATE=uninitialized "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-uninitialized","source":"startup","cwd":"$HOOK_REPO"}
EOF
[ "$RUN_BYTES" -eq 0 ] && pass lattice-codex-uninitialized || fail_case lattice-codex-uninitialized
run lattice-codex-slow-success env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=slow_success "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-slow-success","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'active=master/G4'* && "$RUN_JSON_TEXT" != *'取得できませんでした'* ]] && pass lattice-codex-slow-success || fail_case lattice-codex-slow-success
for mode in invalid invalid_dependency; do
  run "lattice-codex-$mode" env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE="$mode" "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-$mode","source":"startup","cwd":"$HOOK_REPO"}
EOF
  json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'status応答を検証できない'* && "$RUN_JSON_TEXT" == *'CLIの版とstore整合を確認'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass "lattice-codex-$mode" || fail_case "lattice-codex-$mode"
done
run lattice-codex-failure env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=failure "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-failure","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'CLI実行失敗'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-failure || fail_case lattice-codex-failure
run lattice-codex-timeout env PATH="$STATE/lattice-bin:$PATH" LATTICE_TEST_MODE=timeout "$PYTHON_EXE" "$ROOT/bin/codex-lattice-gantt-hook.sh" session-start <<EOF
{"session_id":"lattice-codex-timeout","source":"startup","cwd":"$HOOK_REPO"}
EOF
json && [[ "$RUN_JSON_TEXT" == *'additionalContext'* && "$RUN_JSON_TEXT" == *'status取得が期限超過'* && "$RUN_JSON_TEXT" != *permissionDecision* ]] && pass lattice-codex-timeout || fail_case lattice-codex-timeout

if [ "$fail" -ne 0 ]; then exit 1; fi
printf 'ALL PASS\n'
