#!/usr/bin/env bash
set -euo pipefail
umask 077

POSIX_METADATA=1
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict; POSIX_METADATA=0 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 呼出元Codexの一時CODEX_HOMEを継承せず、各fixtureのHOME配下だけを検証する。
unset CODEX_HOME
HOME_FIXTURE="$(mktemp -d)"
CLI_DIR="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$CLI_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
PYTHON_BIN="$(command -v python3 || command -v python)" || fail 'Python runtimeがありません'
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$PYTHON_BIN" >"$CLI_DIR/python3"
chmod 755 "$CLI_DIR/python3"
export PATH="$CLI_DIR:$PATH"
file_stat() {
  python3 - "$1" "$2" <<'PY'
import os
import stat
import sys

info = os.stat(sys.argv[1])
values = {
    "mode": format(stat.S_IMODE(info.st_mode), "o"),
    "uid": str(info.st_uid),
    "gid": str(info.st_gid),
}
print(values[sys.argv[2]])
PY
}
HOOK="$HOME_FIXTURE/observer-parent-stop-hook"
STATE_ROOT="$HOME_FIXTURE/observer-state"
mkdir -p "$STATE_ROOT"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$HOOK"
chmod 755 "$HOOK"
cat >"$CLI_DIR/observer-hook-config" <<'PY'
#!/usr/bin/env python3
import json, sys
op, *args = sys.argv[1:]
provider = args[args.index("--provider") + 1]
executable = args[args.index("--executable") + 1]
state_root = args[args.index("--state-root") + 1]
command = f"{executable} --provider {provider} --state-root {state_root}"
entry = {"hooks":[{"type":"command","command":command,"timeout":5}]} if provider == "claude" else {"type":"command","command":command,"timeoutSec":5,"async":False,"statusMessage":None}
if op == "fragment":
    schema = "invalid" if __import__("os").environ.get("OBSERVER_TEST_BAD_SCHEMA") else "observer.parent_stop_hook_fragment.v1"
    print(json.dumps({"schema":schema,"provider":provider,"event":"Stop","entry":entry}))
    raise SystemExit(0)
candidate = json.load(sys.stdin)
entries = candidate.get("hooks", {}).get("Stop", [])
if provider == "claude":
    count = sum(1 for outer in entries if isinstance(outer, dict) for hook in outer.get("hooks", []) if isinstance(hook, dict) and hook.get("command") == command)
    canonical = count == 1 and any(outer == entry for outer in entries)
else:
    count = sum(1 for item in entries if isinstance(item, dict) and item.get("command") == command)
    canonical = count == 1 and entry in entries
print(json.dumps({"schema":"observer.parent_stop_hook_verification.v1","provider":provider,"event":"Stop","status":"canonical" if canonical else ("missing" if count == 0 else "noncanonical"),"target_count":count}))
PY
chmod 755 "$CLI_DIR/observer-hook-config"
OBSERVER_CLI="$CLI_DIR/observer-hook-config"
case "$(uname -s)" in
  MINGW*|MSYS*)
    mv "$OBSERVER_CLI" "$OBSERVER_CLI.py"
    printf '@echo off\r\n"%s" "%%~dp0observer-hook-config.py" %%*\r\n' "$(cygpath -w "$PYTHON_BIN")" >"$CLI_DIR/observer-hook-config.cmd"
    OBSERVER_CLI="$(cygpath -w "$CLI_DIR/observer-hook-config.cmd")"
    ;;
esac

mkdir -p "$HOME_FIXTURE/.claude" "$HOME_FIXTURE/.codex"
cat >"$HOME_FIXTURE/.claude/settings.json" <<'EOF'
{"env":"OBSERVER_SECRET_SENTINEL","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/other/keep"}]},{"hooks":[{"type":"command","command":"REPLACE_HOOK --provider claude --state-root /old/state","timeout":5}]}]}}
EOF
cat >"$HOME_FIXTURE/.codex/hooks.json" <<'EOF'
{"hooks":{"Stop":[{"type":"command","command":"/other/keep","timeoutSec":9,"async":false,"statusMessage":null},{"type":"command","command":"REPLACE_HOOK --provider codex --state-root /old/state","timeoutSec":5,"async":false,"statusMessage":null}]}}
EOF
python3 - "$HOME_FIXTURE/.claude/settings.json" "$HOME_FIXTURE/.codex/hooks.json" "$HOOK" <<'PY'
import sys
from pathlib import Path
for name in sys.argv[1:3]:
    path = Path(name)
    path.write_text(path.read_text().replace("REPLACE_HOOK", sys.argv[3]), encoding="utf-8")
PY
before_claude="$(cat "$HOME_FIXTURE/.claude/settings.json")"
before_codex="$(cat "$HOME_FIXTURE/.codex/hooks.json")"
dry="$(HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --observer-hook "$HOOK" --state-root "$STATE_ROOT" 2>&1)"
printf '%s' "$dry" | grep -Fq 'provider=claude' || fail 'dry-run がClaude要約を出さない'
printf '%s' "$dry" | grep -Fq 'provider=codex' || fail 'dry-run がCodex要約を出さない'
if printf '%s' "$dry" | grep -Fq 'OBSERVER_SECRET_SENTINEL'; then fail 'dry-run が設定内容を出した'; fi
[ "$(cat "$HOME_FIXTURE/.claude/settings.json")" = "$before_claude" ] || fail 'dry-run がClaudeを書換えた'
[ "$(cat "$HOME_FIXTURE/.codex/hooks.json")" = "$before_codex" ] || fail 'dry-run がCodexを書換えた'
if HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" \
  "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" >/dev/null 2>&1
then
  fail 'state root省略を成功扱いした'
fi
if HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" OBSERVER_TEST_BAD_SCHEMA=1 "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'schema不一致を成功扱いした'; fi
[ "$(cat "$HOME_FIXTURE/.claude/settings.json")" = "$before_claude" ] || fail 'schema failure がClaudeを書換えた'
[ "$(cat "$HOME_FIXTURE/.codex/hooks.json")" = "$before_codex" ] || fail 'schema failure がCodexを書換えた'
HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null
python3 - "$HOME_FIXTURE" "$HOOK" "$STATE_ROOT" <<'PY' || exit 1
import json, sys
from pathlib import Path
home, hook, state_root = map(Path, sys.argv[1:])
for provider, path in (("claude", home / ".claude/settings.json"), ("codex", home / ".codex/hooks.json")):
    data = json.load(open(path))
    assert any("/other/keep" in str(entry) for entry in data["hooks"]["Stop"])
    command = f"{hook} --provider {provider} --state-root {state_root}".replace("\\", "/")
    count = sum(1 for entry in data["hooks"]["Stop"] for item in (entry.get("hooks", []) if provider == "claude" else [entry]) if isinstance(item, dict) and item.get("command", "").replace("\\", "/") == command)
    assert count == 1
    assert "/old/state" not in str(data), data
PY
archive_count="$(find "$HOME_FIXTURE/Archives" -name '*.tar.gz' | wc -l | tr -d ' ')"
[ "$archive_count" = 1 ] || fail '初回applyのbackup数が不正'
archive_path="$(find "$HOME_FIXTURE/Archives" -name '*.tar.gz' -print -quit)"
python3 - "$archive_path" <<'PY' || fail 'backup modeが0600でない'
import stat
import sys
import os
from pathlib import Path
raise SystemExit(0 if os.name == "nt" or stat.S_IMODE(Path(sys.argv[1]).stat().st_mode) == 0o600 else 1)
PY
idempotent="$(HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT")"
printf '%s' "$idempotent" | grep -Fq 'apply-observer-hook-config:' || fail '二回目applyが結果を返さない'
[ "$(find "$HOME_FIXTURE/Archives" -name '*.tar.gz' | wc -l | tr -d ' ')" = "$archive_count" ] || fail '冪等applyがbackupを増やした'
if HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$CLI_DIR/missing" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'CLI不在を成功扱いした'; fi
saved_claude="$(cat "$HOME_FIXTURE/.claude/settings.json")"
saved_codex="$(cat "$HOME_FIXTURE/.codex/hooks.json")"
python3 - "$HOME_FIXTURE/.claude/settings.json" "$HOME_FIXTURE/.codex/hooks.json" "$HOOK" "$STATE_ROOT" <<'PY'
import json, sys
claude, codex, hook, state_root = sys.argv[1:]
data = json.load(open(claude))
json.dump(data, open(claude, "w", encoding="utf-8"), separators=(",", ":"))
data = json.load(open(codex))
command = f"{hook} --provider codex --state-root {state_root}".replace("\\", "/")
data["hooks"]["Stop"] = [entry for entry in data["hooks"]["Stop"] if entry.get("command", "").replace("\\", "/") != command]
json.dump(data, open(codex, "w", encoding="utf-8"), separators=(",", ":"))
PY
saved_claude="$(cat "$HOME_FIXTURE/.claude/settings.json")"
saved_codex="$(cat "$HOME_FIXTURE/.codex/hooks.json")"
if HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" DOTAGENTS_TEST_FAIL_REPLACE=hooks.json "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'replace failureを成功扱いした'; fi
[ "$(cat "$HOME_FIXTURE/.claude/settings.json")" = "$saved_claude" ] || fail 'rollback がClaudeを戻さない'
[ "$(cat "$HOME_FIXTURE/.codex/hooks.json")" = "$saved_codex" ] || fail 'rollback がCodexを戻さない'
stamp=20000101T000000Z
collision="$HOME_FIXTURE/Archives/dotagents-observer-hook-config-$stamp.tar.gz"
printf '%s' 'keep-existing-backup' >"$collision"
printf '\n' >>"$HOME_FIXTURE/.claude/settings.json"
HOME="$HOME_FIXTURE" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" DOTAGENTS_TEST_BACKUP_STAMP="$stamp" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null
[ "$(cat "$collision")" = keep-existing-backup ] || fail '既存backupを上書きした'
[ -f "$HOME_FIXTURE/Archives/dotagents-observer-hook-config-$stamp-1.tar.gz" ] || fail '同秒backupのsuffixを作らない'
SYMLINK_HOME="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$CLI_DIR" "$SYMLINK_HOME"' EXIT
mkdir -p "$SYMLINK_HOME/external-claude" "$SYMLINK_HOME/external-codex"
ln -s "$SYMLINK_HOME/external-claude" "$SYMLINK_HOME/.claude"
if HOME="$SYMLINK_HOME" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'symlink設定を成功扱いした'; fi
rm "$SYMLINK_HOME/.claude"
mkdir "$SYMLINK_HOME/.claude"
ln -s "$SYMLINK_HOME/external-codex" "$SYMLINK_HOME/codex-link"
if HOME="$SYMLINK_HOME" CODEX_HOME="$SYMLINK_HOME/codex-link" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --dry-run --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'symlink CODEX_HOMEを成功扱いした'; fi
ln -s "$SYMLINK_HOME/missing-codex-target" "$SYMLINK_HOME/broken-codex-link"
if HOME="$SYMLINK_HOME" CODEX_HOME="$SYMLINK_HOME/broken-codex-link" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --dry-run --observer-hook "$HOOK" --state-root "$STATE_ROOT" >/dev/null 2>&1; then fail 'broken symlink CODEX_HOMEを成功扱いした'; fi
EMPTY_HOME="$(mktemp -d)"
RESTORE_HOME="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$CLI_DIR" "$SYMLINK_HOME" "$EMPTY_HOME" "$RESTORE_HOME"' EXIT
mkdir -p "$EMPTY_HOME/.claude"
: >"$EMPTY_HOME/.claude/settings.json"
HOME="$EMPTY_HOME" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$EMPTY_HOME/observer-state" >/dev/null
python3 - "$EMPTY_HOME" <<'PY'
import json, sys
from pathlib import Path
home = Path(sys.argv[1])
assert isinstance(json.load(open(home / ".claude/settings.json")), dict)
assert isinstance(json.load(open(home / ".codex/hooks.json")), dict)
PY

mkdir -p "$RESTORE_HOME/.claude"
cat >"$RESTORE_HOME/.claude/settings.json" <<'EOF'
{"restore":"original","hooks":{"Stop":[]}}
EOF
chmod 640 "$RESTORE_HOME/.claude/settings.json"
restore_before="$(cat "$RESTORE_HOME/.claude/settings.json")"
if [ "$POSIX_METADATA" = 1 ]; then
  restore_uid="$(file_stat "$RESTORE_HOME/.claude/settings.json" uid)"
  restore_gid="$(file_stat "$RESTORE_HOME/.claude/settings.json" gid)"
fi
HOME="$RESTORE_HOME" OBSERVER_HOOK_CONFIG_BIN="$OBSERVER_CLI" \
  "$ROOT/bin/apply-observer-hook-config.sh" --apply --observer-hook "$HOOK" --state-root "$RESTORE_HOME/observer-state" >/dev/null
restore_archive="$(find "$RESTORE_HOME/Archives" -name '*.tar.gz' -print -quit)"
[ -n "$restore_archive" ] || fail 'restore fixture backupがない'
if [ "$POSIX_METADATA" = 1 ]; then
  [ "$(file_stat "$RESTORE_HOME/.claude/settings.json" mode)" = 640 ] || fail 'applyが既存modeを保持しない'
  [ "$(file_stat "$RESTORE_HOME/.codex/hooks.json" mode)" = 600 ] || fail 'applyが新規configを0600にしない'
fi

applied_claude="$(cat "$RESTORE_HOME/.claude/settings.json")"
applied_codex="$(cat "$RESTORE_HOME/.codex/hooks.json")"
if HOME="$RESTORE_HOME" DOTAGENTS_TEST_FAIL_REPLACE=hooks.json \
  "$ROOT/bin/apply-observer-hook-config.sh" --restore "$restore_archive" >/dev/null 2>&1
then
  fail 'restore replace failureを成功扱いした'
fi
[ "$(cat "$RESTORE_HOME/.claude/settings.json")" = "$applied_claude" ] || fail 'restore失敗がClaude current stateを壊した'
[ "$(cat "$RESTORE_HOME/.codex/hooks.json")" = "$applied_codex" ] || fail 'restore失敗がCodex current stateを壊した'

HOME="$RESTORE_HOME" "$ROOT/bin/apply-observer-hook-config.sh" --restore "$restore_archive" >/dev/null
[ "$(cat "$RESTORE_HOME/.claude/settings.json")" = "$restore_before" ] || fail 'restoreがClaude原文を戻さない'
[ ! -e "$RESTORE_HOME/.codex/hooks.json" ] || fail 'restoreが元absentのCodex configを削除しない'
if [ "$POSIX_METADATA" = 1 ]; then
  [ "$(file_stat "$RESTORE_HOME/.claude/settings.json" mode)" = 640 ] || fail 'restoreが元modeを戻さない'
  [ "$(file_stat "$RESTORE_HOME/.claude/settings.json" uid)" = "$restore_uid" ] || fail 'restoreが元uidを戻さない'
  [ "$(file_stat "$RESTORE_HOME/.claude/settings.json" gid)" = "$restore_gid" ] || fail 'restoreが元gidを戻さない'
fi

ln -s "$restore_archive" "$RESTORE_HOME/restore-link.tar.gz"
if HOME="$RESTORE_HOME" "$ROOT/bin/apply-observer-hook-config.sh" --restore "$RESTORE_HOME/restore-link.tar.gz" >/dev/null 2>&1
then
  fail 'symlink archiveをrestoreした'
fi
if [ "$POSIX_METADATA" = 1 ]; then
  chmod 644 "$restore_archive"
  if HOME="$RESTORE_HOME" "$ROOT/bin/apply-observer-hook-config.sh" --restore "$restore_archive" >/dev/null 2>&1
  then
    fail 'world-readable archiveをrestoreした'
  fi
  chmod 600 "$restore_archive"
fi
bad_archive="$RESTORE_HOME/Archives/dotagents-observer-hook-config-bad.tar.gz"
printf '%s' 'not-a-backup' >"$bad_archive"
chmod 600 "$bad_archive"
if HOME="$RESTORE_HOME" "$ROOT/bin/apply-observer-hook-config.sh" --restore "$bad_archive" >/dev/null 2>&1
then
  fail '破損archiveをrestoreした'
fi
echo 'observer hook config: OK'
