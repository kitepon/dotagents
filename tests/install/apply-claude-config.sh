#!/usr/bin/env bash
# apply-claude-config の差分適用を実 HOME に触れず検証する。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONIOENCODING=utf-8
HOME_FIXTURE="$(mktemp -d)"
ROLLBACK_HOME="$(mktemp -d)"
ABSENT_HOME="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$ROLLBACK_HOME" "$ABSENT_HOME"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

HOME="$HOME_FIXTURE" "$ROOT/install.sh" --profile official >/dev/null
[ -L "$HOME_FIXTURE/.local/bin/apply-claude-config" ] \
  || fail 'apply-claude-config を ~/.local/bin へ配布しない'

dry="$(HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-claude-config" --dry-run)"
grep -Fq 'delegation-gate-hook' <<<"$dry" || fail 'dry-run がClaude hook差分を表示しない'
[ ! -e "$HOME_FIXTURE/.claude/settings.json" ] || fail 'dry-run が settings.json を作成した'

HOME="$ABSENT_HOME" "$HOME_FIXTURE/.local/bin/apply-claude-config" --apply >/dev/null
[ -f "$ABSENT_HOME/.claude/settings.json" ] || fail '不在の settings.json をapplyで作成しない'

mkdir -p "$HOME_FIXTURE/.claude"
printf '%s\n' '{"model":"keep-me","permissions":{"allow":["keep"]},"hooks":{"Stop":[{"matcher":"keep","hooks":[{"type":"command","command":"/custom/keep"}]}]}}' >"$HOME_FIXTURE/.claude/settings.json"
HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-claude-config" --apply >/dev/null
applied="$(cat "$HOME_FIXTURE/.claude/settings.json")"
python3 - "$HOME_FIXTURE/.claude/settings.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["model"] == "keep-me"
assert data["permissions"] == {"allow": ["keep"]}
assert data["hooks"]["Stop"][0] == {
    "matcher": "keep",
    "hooks": [{"type": "command", "command": "/custom/keep"}],
}
expected = {
    ("PreToolUse", ("delegation-gate-hook",)),
    ("PreToolUse", ("git-destroy-gate-hook",)),
    ("SessionStart", ("todo-gate-hook", "session-start")),
    ("SessionStart", ("orchestrate-advisory-hook",)),
    ("SessionStart", ("lattice-gantt-hook", "session-start")),
    ("Stop", ("todo-gate-hook", "stop")),
    ("UserPromptSubmit", ("onset-gate-hook",)),
    ("UserPromptSubmit", ("lattice-gantt-hook", "user-prompt-submit")),
    ("PostToolUse", ("plan-gate-hook",)),
}
commands = [
    (event, hook["command"])
    for event, entries in data["hooks"].items()
    for entry in entries if isinstance(entry, dict)
    for hook in entry.get("hooks", []) if isinstance(hook, dict) and isinstance(hook.get("command"), str)
]
missing = [
    f"{event}: {' '.join(needles)}"
    for event, needles in expected
    if not any(item_event == event and all(needle in command for needle in needles) for item_event, command in commands)
]
assert not missing, missing
PY
python3 - <<'PY'
def win_quote(token: str) -> str:
    if token.startswith('"') and token.endswith('"') and len(token) >= 2:
        return token
    return '"' + token.replace('"', '\\"') + '"'
assert win_quote(r'C:\Users\kite_\AppData\Local\Programs\Python\Python312\python3.exe') == r'"C:\Users\kite_\AppData\Local\Programs\Python\Python312\python3.exe"'
assert win_quote(r'C:\Users\kite_\.local\bin\todo-gate-hook') == r'"C:\Users\kite_\.local\bin\todo-gate-hook"'
assert win_quote('session-start') == '"session-start"'
print('win_quote quotes backslash paths')
PY

second="$(HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-claude-config" --apply)"
grep -Fq '変更なし' <<<"$second" || fail '2回目のapplyをno-opにしない'
[ "$(cat "$HOME_FIXTURE/.claude/settings.json")" = "$applied" ] || fail '2回目のapplyがsettings.jsonを変更した'
[ "$(find "$HOME_FIXTURE/Archives" -name 'dotagents-claude-config-*.tar.gz' | wc -l | tr -d ' ')" = 1 ] \
  || fail 'no-opでもbackupを作成した'

mkdir -p "$ROLLBACK_HOME/.claude"
printf '%s\n' '{"sentinel":"rollback"}' >"$ROLLBACK_HOME/.claude/settings.json"
before="$(cat "$ROLLBACK_HOME/.claude/settings.json")"
if HOME="$ROLLBACK_HOME" DOTAGENTS_TEST_FAIL_REPLACE=settings.json "$HOME_FIXTURE/.local/bin/apply-claude-config" --apply >/dev/null 2>&1; then
  fail 'replace failureを成功扱いした'
fi
[ "$(cat "$ROLLBACK_HOME/.claude/settings.json")" = "$before" ] || fail 'rollback が元のsettings.jsonを保持しない'
find "$ROLLBACK_HOME/Archives" -name 'dotagents-claude-config-*.tar.gz' -type f | grep -q . \
  || fail 'rollback前のbackupを作成しない'

echo 'apply-claude-config install test: OK'
