#!/usr/bin/env bash
# verify-install: install.sh 後、リポの各エントリが $HOME 側で本リポ向き symlink に
# なっているかを自動検証する。ランブック §3「ls -la で目視」の実行可能版。
# 他端末セットアップで「実ファイル退避を忘れて正本化が静かに失敗」を検出する狙い。
# 使い方: verify-install [--profile official|legacy]
set -uo pipefail
export PYTHONIOENCODING=utf-8

profile=official
profile_set=false
usage() {
  cat <<'EOF'
使い方: verify-install [--profile official|legacy]

Codex skill 検証面:
  official  ~/.agents/skills （既定）
  legacy    ~/.codex/skills
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --profile)
      if [ "$#" -lt 2 ] || [ "$profile_set" != false ]; then
        echo 'FAIL: --profile は一度だけ official または legacy を指定する' >&2; exit 2
      fi
      profile="$2"; profile_set=true; shift 2 ;;
    --profile=*)
      if [ "$profile_set" != false ]; then
        echo 'FAIL: --profile を重複指定できない' >&2; exit 2
      fi
      profile="${1#--profile=}"; profile_set=true; shift ;;
    *) echo "FAIL: 不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$profile" in official|legacy) ;; *) echo "FAIL: 不正な profile: $profile" >&2; exit 2 ;; esac

# 自身の実体を辿ってリポルートを解決（install.sh は絶対パスで symlink するので readlink は絶対）
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
REPO="$(cd "$(dirname "$SELF")/.." && pwd)"
# 親AI sessionは ~/.local/bin を持たないことがある。uv tool と install 配布面はここ。
export PATH="$HOME/.local/bin:$PATH"
if [ "$profile" = official ]; then
  codex_skills_dir="$HOME/.agents/skills"
  other_codex_skills_dir="$HOME/.codex/skills"
else
  codex_skills_dir="$HOME/.codex/skills"
  other_codex_skills_dir="$HOME/.agents/skills"
fi

fail=0
check() { # check <dst> <expect_src>
  local dst="$1" exp="$2"
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "FAIL: $dst 不在（install.sh 未実行または対象追加後。install.sh を再実行）"; fail=1; return
  fi
  if [ ! -L "$dst" ]; then
    echo "FAIL: $dst は実ファイル（退避して install.sh 再実行しないと正本が使われない）"; fail=1; return
  fi
  local tgt; tgt="$(readlink "$dst")"
  # 期待 src と完全一致で比較（末尾スラッシュ差を正規化）。$REPO 配下でも別ファイル向きは FAIL。
  if [ "${tgt%/}" != "${exp%/}" ]; then
    echo "FAIL: $dst → $tgt（期待 ${exp%/} と不一致）"; fail=1
  fi
}

check_orchestrate_references() {
  local skill="$1" file
  for file in contract.md delegation-contract.md aiterm-dispatch.md recipes.md; do
    if [ ! -r "$skill/references/shared-orchestrate/$file" ]; then
      echo "FAIL: 配布済みorchestrateから $file を読めない: $skill"
      fail=1
    fi
  done
}

verify_factory_core() {
  # 工場所有の退役配線と互換wrapperだけを確認する。製品の導入結果は再検査しない。
  if command -v codegraph >/dev/null 2>&1; then
    echo "FAIL: retired Codegraph command remains on PATH: $(command -v codegraph)"
    fail=1
  fi
  if [ ! -x "$HOME/.local/bin/oracle-mcp-stable" ]; then
    echo "FAIL: Oracle canonical wrapper が実行不能: $HOME/.local/bin/oracle-mcp-stable"
    fail=1
  else
    echo "OK  Oracle canonical wrapper: $HOME/.local/bin/oracle-mcp-stable"
  fi
}

verify_retired_codegraph_settings() {
  local config
  for config in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml"; do
    if [ -f "$config" ] && grep -Fq 'codegraph' "$config"; then
      echo "FAIL: $config に retired Codegraph残骸・除去が必要（役割はlattice-mcpとSpotterへ継承済み）"
      fail=1
    fi
  done
}

verify_retired_codegraph_settings

if [ "${DOTAGENTS_FACTORY_CORE_ONLY:-0}" = 1 ]; then
  verify_factory_core
  exit "$fail"
fi

# Codex の orchestrate は製品固有の実ディレクトリとし、製品中立の共通契約を参照する。
# Claude 本文の複製や symlink への後退をここで明示的に検出する。
codex_orchestrate="$REPO/codex/skills/orchestrate"
claude_orchestrate="$REPO/claude/skills/orchestrate/SKILL.md"
shared_orchestrate_contract="$REPO/shared/orchestrate/contract.md"
shared_delegation_contract="$REPO/shared/orchestrate/delegation-contract.md"
if [ -L "$codex_orchestrate" ] || [ ! -d "$codex_orchestrate" ]; then
  echo "FAIL: $codex_orchestrate は製品固有の実ディレクトリではない（Claude 側への symlink を置かない）"
  fail=1
elif [ ! -r "$codex_orchestrate/SKILL.md" ]; then
  echo "FAIL: $codex_orchestrate/SKILL.md を読めない"
  fail=1
elif [ ! -r "$shared_orchestrate_contract" ]; then
  echo "FAIL: $shared_orchestrate_contract を読めない"
  fail=1
elif [ ! -r "$shared_delegation_contract" ]; then
  echo "FAIL: $shared_delegation_contract を読めない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/contract.md)' "$codex_orchestrate/SKILL.md"; then
  echo "FAIL: $codex_orchestrate/SKILL.md が共通契約を参照していない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/delegation-contract.md)' "$codex_orchestrate/SKILL.md"; then
  echo "FAIL: $codex_orchestrate/SKILL.md が共有委譲契約を参照していない"
  fail=1
elif [ ! -r "$claude_orchestrate" ]; then
  echo "FAIL: $claude_orchestrate を読めない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/contract.md)' "$claude_orchestrate"; then
  echo "FAIL: $claude_orchestrate が共通契約を参照していない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/delegation-contract.md)' "$claude_orchestrate"; then
  echo "FAIL: $claude_orchestrate が共有委譲契約を参照していない"
  fail=1
elif [ -e "$REPO/claude/skills/orchestrate/references/delegation-contract.md" ]; then
  echo "FAIL: Claude 固有の旧 delegation-contract.md が残っている"
  fail=1
fi

grok_orchestrate="$REPO/grok/skills/orchestrate/SKILL.md"
if [ ! -r "$grok_orchestrate" ]; then
  echo "FAIL: $grok_orchestrate を読めない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/contract.md)' "$grok_orchestrate"; then
  echo "FAIL: $grok_orchestrate が共通契約を参照していない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/delegation-contract.md)' "$grok_orchestrate"; then
  echo "FAIL: $grok_orchestrate が共有委譲契約を参照していない"
  fail=1
fi

cursor_orchestrate="$REPO/cursor/skills/orchestrate/SKILL.md"
if [ ! -r "$cursor_orchestrate" ]; then
  echo "FAIL: $cursor_orchestrate を読めない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/contract.md)' "$cursor_orchestrate"; then
  echo "FAIL: $cursor_orchestrate が共通契約を参照していない"
  fail=1
elif ! grep -Fq '](references/shared-orchestrate/delegation-contract.md)' "$cursor_orchestrate"; then
  echo "FAIL: $cursor_orchestrate が共有委譲契約を参照していない"
  fail=1
fi
if [ -e "$REPO/cursor/skills-cursor" ] || [ -L "$REPO/cursor/skills-cursor" ]; then
  echo "FAIL: $REPO/cursor/skills-cursor が存在する（Cursor内蔵面は工場所有外）"
  fail=1
fi

check_orchestrate_references "$HOME/.claude/skills/orchestrate"
check_orchestrate_references "$codex_skills_dir/orchestrate"
check_orchestrate_references "$HOME/.grok/skills/orchestrate"
check_orchestrate_references "$HOME/.cursor/skills/orchestrate"

# install.sh の配布グループと対称に検証
[ -f "$REPO/claude/CLAUDE.md" ] && check "$HOME/.claude/CLAUDE.md" "$REPO/claude/CLAUDE.md"
[ -d "$REPO/shared/runbooks" ] && check "$HOME/.claude/runbooks" "$REPO/shared/runbooks"
for d in "$REPO/claude/skills"/*/;   do [ -d "$d" ] && check "$HOME/.claude/skills/$(basename "$d")" "$d"; done
for f in "$REPO/claude/commands"/*.md; do [ -e "$f" ] && check "$HOME/.claude/commands/$(basename "$f")" "$f"; done
for f in "$REPO/claude/agents"/*.md;   do [ -e "$f" ] && check "$HOME/.claude/agents/$(basename "$f")" "$f"; done
[ -f "$REPO/codex/AGENTS.md" ] && check "$HOME/.codex/AGENTS.md" "$REPO/codex/AGENTS.md"
[ -d "$REPO/shared/runbooks" ] && check "$HOME/.codex/runbooks" "$REPO/shared/runbooks"
[ -f "$REPO/grok/AGENTS.md" ] && check "$HOME/.grok/rules/AGENTS.md" "$REPO/grok/AGENTS.md"
[ -d "$REPO/shared/runbooks" ] && check "$HOME/.grok/runbooks" "$REPO/shared/runbooks"
[ -f "$REPO/cursor/rules/factory.mdc" ] && check "$HOME/.cursor/rules/factory.mdc" "$REPO/cursor/rules/factory.mdc"
[ -f "$REPO/cursor/rules/factory.mdc" ] && check "$HOME/.cursor/factory-constitution/.cursor/rules/factory.mdc" "$REPO/cursor/rules/factory.mdc"
[ -d "$REPO/shared/runbooks" ] && check "$HOME/.cursor/runbooks" "$REPO/shared/runbooks"
if [ -e "$HOME/.cursor/AGENTS.md" ] || [ -L "$HOME/.cursor/AGENTS.md" ]; then
  echo "FAIL: $HOME/.cursor/AGENTS.md が存在する（Cursor憲法のmountは ~/.cursor/rules/factory.mdc のみ）"
  fail=1
fi
for d in "$REPO/cursor/skills"/*/; do
  [ -d "$d" ] && check "$HOME/.cursor/skills/$(basename "$d")" "$d"
done
for f in "$REPO/cursor/agents"/*.md; do
  [ -e "$f" ] && check "$HOME/.cursor/agents/$(basename "$f")" "$f"
done
for d in "$REPO/grok/skills"/*/; do
  [ -d "$d" ] && check "$HOME/.grok/skills/$(basename "$d")" "$d"
done
for f in "$REPO/grok/agents"/*.md; do
  [ -e "$f" ] && check "$HOME/.grok/agents/$(basename "$f")" "$f"
done
windows_native=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) windows_native=1 ;; esac
[ -n "${WINDIR:-}" ] && windows_native=1
PYTHON_BIN=python3
[ "$windows_native" -eq 1 ] && PYTHON_BIN=python
grok_logged_in=0
if [ -n "${XAI_API_KEY:-}" ] || [ -s "$HOME/.grok/auth.json" ]; then
  grok_logged_in=1
fi
for f in "$REPO/grok/hooks"/*.json; do
  [ -e "$f" ] || continue
  if [ "$(basename "$f")" = factory.json ]; then
    dest="$HOME/.grok/hooks/factory.json"
    if [ "$grok_logged_in" -ne 1 ]; then
      check "$dest" "$f"
    elif [ ! -f "$dest" ]; then
      echo "FAIL: $dest 不在（工場hookは apply-grok-config が実ファイルを書く）"; fail=1
    elif [ -L "$dest" ]; then
      echo "FAIL: $dest が symlink のまま（Grok sandbox用の実ファイルが正）"; fail=1
    fi
    continue
  fi
  check "$HOME/.grok/hooks/$(basename "$f")" "$f"
done
grok_factory_hooks="$HOME/.grok/hooks/factory.json"
if { [ "$windows_native" -ne 1 ] || [ "$grok_logged_in" -eq 1 ]; } \
  && { [ -f "$grok_factory_hooks" ] || [ -L "$grok_factory_hooks" ]; }; then
  if ! "$PYTHON_BIN" - "$grok_factory_hooks" "$REPO/lib/hook-command.py" <<'PY'
import importlib.util
import json
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("hook_command", sys.argv[2])
hook_command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook_command)
command_matches = hook_command.command_matches

path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
    print(f"FAIL: {path} の JSON パース失敗: {exc}")
    raise SystemExit(1)

home = Path(os.environ.get("HOME", str(Path.home()))).expanduser().resolve()
required = (
    ("PreToolUse", "grok-git-destroy-gate-hook"),
    ("PreToolUse", "grok-delegation-gate-hook"),
    ("SessionStart", "grok-todo-gate-hook session-start"),
    ("SessionStart", "grok-lattice-gantt-hook session-start"),
    ("SessionStart", "grok-orchestrate-advisory-hook"),
    ("UserPromptSubmit", "grok-onset-gate-hook"),
    ("UserPromptSubmit", "grok-lattice-gantt-hook user-prompt-submit"),
    ("Stop", "grok-todo-gate-hook stop"),
    ("PostToolUse", "grok-plan-gate-hook"),
)
missing = []
for event, required_command in required:
    commands = (
        hook.get("command", "")
        for entry in data.get("hooks", {}).get(event, [])
        if isinstance(entry, dict)
        for hook in entry.get("hooks", [])
        if isinstance(hook, dict)
    )
    if not any(
        isinstance(command, str) and command_matches(command, required_command, home)
        for command in commands
    ):
        missing.append(f"{event}: {required_command}")
if missing:
    print("FAIL: Grok 工場hook が欠落: " + "、".join(missing))
    raise SystemExit(1)
PY
  then
    fail=1
  fi
fi
cursor_hooks="$HOME/.cursor/hooks.json"
if [ -f "$cursor_hooks" ] || [ -L "$cursor_hooks" ]; then
  if [ -L "$cursor_hooks" ]; then
    echo "FAIL: $cursor_hooks は symlink（実ファイルの工場hook面が正）"
    fail=1
  elif ! "$PYTHON_BIN" - "$cursor_hooks" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"FAIL: {path} の JSON パース失敗: {exc}")
    raise SystemExit(1)
hooks = data.get("hooks") if isinstance(data, dict) else None
if not isinstance(hooks, dict):
    print(f"FAIL: {path} の hooks が object でない")
    raise SystemExit(1)
commands = []
for entries in hooks.values():
    if not isinstance(entries, list):
        continue
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("command"), str):
            commands.append(entry["command"])
required = (
    "cursor-constitution-hook",
    "cursor-git-destroy-gate-hook",
    "cursor-delegation-gate-hook",
    "cursor-todo-gate-hook",
    "cursor-lattice-gantt-hook",
    "cursor-orchestrate-advisory-hook",
)
missing = [name for name in required if not any(name in command for command in commands)]
if missing:
    print("FAIL: Cursor 工場hook が欠落: " + "、".join(missing))
    raise SystemExit(1)
PY
  then
    fail=1
  fi
fi
if [ -x "$HOME/.local/bin/cursor-constitution-hook" ] && [ -e "$HOME/.cursor/rules/factory.mdc" ]; then
  const_probe="$(mktemp -d)"
  mkdir -p "$const_probe/rules"
  cp "$HOME/.cursor/rules/factory.mdc" "$const_probe/rules/factory.mdc"
  const_out="$(CURSOR_HOME="$const_probe" "$PYTHON_BIN" "$HOME/.local/bin/cursor-constitution-hook" <<'EOF'
{"hook_event_name":"beforeSubmitPrompt","session_id":"verify-install","prompt":"x","cursor_version":"1.0.0"}
EOF
)" || true
  if ! "$PYTHON_BIN" - "$const_out" "$const_probe/rules/factory.mdc" <<'PY'
import json
import sys
from pathlib import Path

raw = sys.argv[1]
path = Path(sys.argv[2])
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("FAIL: cursor-constitution-hook が JSON を返さない")
    raise SystemExit(1)
ctx = data.get("additional_context") or ""
if not isinstance(ctx, str) or not ctx.strip():
    print("FAIL: cursor-constitution-hook が additional_context を返さない")
    raise SystemExit(1)
if len(ctx) > 10000:
    print(f"FAIL: cursor-constitution-hook の additional_context が {len(ctx)} 字（cap 10000）")
    raise SystemExit(1)
if "ベルの共通憲法" not in ctx or "Cursor nativeの単発" not in ctx:
    print("FAIL: cursor-constitution-hook がベル／Cursor native を配達しない")
    raise SystemExit(1)
if "mcp__aiterm__pty_" in ctx:
    print("FAIL: cursor-constitution-hook が Claude の日常shell既定を混ぜた")
    raise SystemExit(1)
body = path.read_text(encoding="utf-8")
if "alwaysApply" in ctx:
    print("FAIL: cursor-constitution-hook が frontmatter を本文へ混ぜた")
    raise SystemExit(1)
if len(body) > 10000 and "## Cursor固有差分" not in ctx:
    print("FAIL: 超過時配達が Cursor固有差分を切った")
    raise SystemExit(1)
PY
  then
    echo "FAIL: cursor-constitution-hook の cap 内配達が契約と違う"
    fail=1
  fi
  rm -rf "$const_probe"
fi
grok_config="$HOME/.grok/config.toml"
if [ "$grok_logged_in" -eq 1 ] && [ -f "$grok_config" ]; then
  if ! "$PYTHON_BIN" - "$grok_config" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
header = re.compile(r"(?m)^[ \t]*\[compat\.claude\][ \t]*(?:#.*)?$")
next_header = re.compile(r"(?m)^[ \t]*\[")
match = header.search(text)
if match is None:
    print(f"FAIL: {sys.argv[1]} に [compat.claude] が無い")
    raise SystemExit(1)
end = len(text)
for found in next_header.finditer(text, match.end()):
    if not header.match(found.group(0)):
        end = found.start()
        break
section = text[match.start():end]
for key in ("agents", "hooks"):
    if not re.search(rf"(?m)^[ \t]*{key}[ \t]*=[ \t]*false(?:[ \t]+#.*)?[ \t]*$", section):
        print(f"FAIL: {sys.argv[1]} の compat.claude.{key} が false でない")
        raise SystemExit(1)
    if re.search(rf"(?m)^[ \t]*{key}[ \t]*=[ \t]*true(?:[ \t]+#.*)?[ \t]*$", section):
        print(f"FAIL: {sys.argv[1]} の compat.claude.{key} が true のまま")
        raise SystemExit(1)
PY
  then
    fail=1
  fi
fi
for d in "$REPO/codex/skills"/*/; do
  [ -d "$d" ] || continue
  skill_name="$(basename "$d")"
  check "$codex_skills_dir/$skill_name" "$d"
  if [ -e "$other_codex_skills_dir/$skill_name" ] || [ -L "$other_codex_skills_dir/$skill_name" ]; then
    echo "FAIL: Codex skill ${skill_name} が反対 profile 面にも存在（${other_codex_skills_dir}/${skill_name}）"
    fail=1
  fi
done
for f in "$REPO/codex/rules"/*;      do [ -e "$f" ] && check "$HOME/.codex/rules/$(basename "$f")" "$f"; done
for f in "$REPO/codex/agents"/*.toml; do [ -e "$f" ] && check "$HOME/.codex/agents/$(basename "$f")" "$f"; done
for f in "$REPO/bin"/*.sh; do
  if [ -e "$f" ]; then
    installed="$HOME/.local/bin/$(basename "$f" .sh)"
    check "$installed" "$f"
    if [ ! -x "$installed" ]; then echo "FAIL: 配布CLIが実行不能: $installed"; fail=1; fi
  fi
done
for f in "$REPO/bin"/*.mjs; do
  if [ -e "$f" ]; then
    [ "$(basename "$f")" != render-current-docs.mjs ] || continue
    installed="$HOME/.local/bin/$(basename "$f" .mjs)"
    check "$installed" "$f"
    if [ ! -x "$installed" ]; then echo "FAIL: 配布CLIが実行不能: $installed"; fail=1; fi
  fi
done

# ~/.codex/AGENTS.override.md シャドー検出: Codex は override が存在すれば AGENTS.md より
# 優先して読むため、非空の override は配布憲法（codex/AGENTS.md）を無言で無効化する。
# 空ファイルはシャドーしない（Codex 側が空なら読み飛ばす想定）ので FAIL にしない。
override_file="$HOME/.codex/AGENTS.override.md"
if [ -s "$override_file" ]; then
  echo "FAIL: ${override_file} が非空で存在（AGENTS.md より優先され配布憲法が読まれない。意図的でなければ退避）"
  fail=1
fi

# GPT-5.6 Sol/Terra はモデルカタログにより multi_agent_v2 を選ぶ。0.144.1 の v2 既定は
# agent_type/model/effort を spawn_agent schema から隠すため、role TOML が存在しても選べない。
# namespace も既定 collaboration のまま schema を拡張すると backend の reserved-schema
# 検証で拒否される組み合わせがあるため、全端末で agents へ明示移動する。
codex_config="$HOME/.codex/config.toml"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "FAIL: $PYTHON_BIN 不在（${codex_config} の agent routing 設定を検証できない）"
  fail=1
elif ! "$PYTHON_BIN" - "$codex_config" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
try:
    text = path.read_text(encoding="utf-8")
except (OSError, UnicodeDecodeError):
    raise SystemExit(1)
match = re.search(
    r"(?m)^\[features\.multi_agent_v2\](?:[ \t]+#[^\n]*)?[ \t]*\n(?s:(.*?))(?=^\[|\Z)",
    text,
)
if not match:
    raise SystemExit(1)
section = match.group(1)
if not re.search(r"(?m)^hide_spawn_agent_metadata\s*=\s*false(?:[ \t]+#.*)?[ \t]*$", section):
    raise SystemExit(1)
if not re.search(r'(?m)^tool_namespace\s*=\s*"agents"(?:[ \t]+#.*)?[ \t]*$', section):
    raise SystemExit(1)
PY
then
  echo "FAIL: ${codex_config} に agent routing 必須断片がない（docs/05_codex-fragments.md §3 を適用）"
  fail=1
fi

# 呼びかけ hook は settings.json へ手挿しするため、symlink 検証とは別に配線を確認する。
claude_settings="$HOME/.claude/settings.json"
if [ ! -f "$claude_settings" ]; then
  echo "WARN ${claude_settings} 不在（Claude Code 未セットアップ端末）" >&2
elif ! "$PYTHON_BIN" - "$claude_settings" "$REPO/lib/hook-command.py" <<'PY'
import importlib.util
import json
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("hook_command", sys.argv[2])
hook_command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook_command)
hook_script = hook_command.hook_script
command_matches = hook_command.command_matches

path = Path(sys.argv[1])
try:
    with path.open(encoding="utf-8") as file:
        data = json.load(file)
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
    print(f"FAIL: {path} の JSON パース失敗: {exc}")
    raise SystemExit(1)

home = Path(os.environ.get("HOME", str(Path.home()))).expanduser().resolve()
required = (
    ("PreToolUse", "delegation-gate-hook"),
    ("PreToolUse", "git-destroy-gate-hook"),
    ("PreToolUse", "boundary-gate-hook"),
    ("SessionStart", "todo-gate-hook session-start"),
    ("Stop", "todo-gate-hook stop"),
    ("UserPromptSubmit", "onset-gate-hook"),
    ("PostToolUse", "plan-gate-hook"),
)
missing = []
for event, required_command in required:
    commands = (
        hook.get("command", "")
        for entry in data.get("hooks", {}).get(event, [])
        if isinstance(entry, dict)
        for hook in entry.get("hooks", [])
        if isinstance(hook, dict)
    )
    if not any(
        isinstance(command, str) and command_matches(command, required_command, home)
        for command in commands
    ):
        missing.append(f"{event}: {required_command}")

if missing:
    print("FAIL: Claude Code 必須 hook が欠落: " + "、".join(missing))
    raise SystemExit(1)

advisory = (home / ".local/bin/orchestrate-advisory-hook").resolve(strict=False)
relevant = []
canonical = []
for entry in data.get("hooks", {}).get("SessionStart", []):
    if not isinstance(entry, dict):
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        command = hook["command"]
        parsed = hook_script(command, home)
        if "orchestrate-advisory-hook" in command:
            relevant.append(hook)
        if parsed is not None and parsed[0] == advisory and parsed[1] == ():
            canonical.append(hook)
expected = {"type": "command", "command": None, "timeout": 5}
if len(relevant) != 1 or len(canonical) != 1 or set(canonical[0]) != {"type", "command", "timeout"} or canonical[0].get("type") != expected["type"] or canonical[0].get("timeout") != expected["timeout"]:
    print("FAIL: Claude SessionStart の orchestrate-advisory-hook は canonical command / type=command / timeout=5 の1件である必要がある")
    raise SystemExit(1)

lattice = (home / ".local/bin/lattice-gantt-hook").resolve(strict=False)
relevant = []
canonical = []
for entry in data.get("hooks", {}).get("SessionStart", []):
    if not isinstance(entry, dict):
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        command = hook["command"]
        parsed = hook_script(command, home)
        if "lattice-gantt-hook" in command:
            relevant.append(hook)
        if parsed is not None and parsed[0] == lattice and parsed[1] == ("session-start",):
            canonical.append(hook)
if len(relevant) != 1 or len(canonical) != 1 or canonical[0] != {"type": "command", "command": canonical[0]["command"], "timeout": 6}:
    print("FAIL: Claude SessionStart の lattice-gantt-hook session-start は canonical command / type=command / timeout=6 の1件である必要がある")
    raise SystemExit(1)
relevant = []
canonical = []
for entry in data.get("hooks", {}).get("UserPromptSubmit", []):
    if not isinstance(entry, dict):
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        command = hook["command"]
        parsed = hook_script(command, home)
        if "lattice-gantt-hook" in command:
            relevant.append(hook)
        if parsed is not None and parsed[0] == lattice and parsed[1] == ("user-prompt-submit",):
            canonical.append(hook)
if len(relevant) != 1 or len(canonical) != 1 or canonical[0] != {"type": "command", "command": canonical[0]["command"], "timeout": 5}:
    print("FAIL: Claude UserPromptSubmit の lattice-gantt-hook user-prompt-submit は canonical command / type=command / timeout=5 の1件である必要がある")
    raise SystemExit(1)
gate = (home / ".local/bin/git-destroy-gate-hook").resolve(strict=False)
matches = []
for entry in data.get("hooks", {}).get("PreToolUse", []):
    if not isinstance(entry, dict) or entry.get("matcher") != "Bash":
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        parsed = hook_script(hook["command"], home)
        if parsed is not None and parsed[0] == gate and parsed[1] == ():
            matches.append(hook)
if len(matches) != 1 or set(matches[0]) != {"type", "command", "timeout"} or matches[0].get("type") != "command" or matches[0].get("timeout") != 5:
    print("FAIL: Claude PreToolUse の git-destroy-gate-hook は matcher=Bash / canonical command / timeout=5 の1件である必要がある")
    raise SystemExit(1)
PY
then
  fail=1
fi

codex_hooks="$HOME/.codex/hooks.json"
if [ ! -f "$codex_hooks" ]; then
  echo "WARN ${codex_hooks} 不在（Codex 未セットアップ端末）" >&2
elif ! "$PYTHON_BIN" - "$codex_hooks" <<'PY'
import json
import os
import shlex
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    with path.open(encoding="utf-8") as file:
        data = json.load(file)
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
    print(f"FAIL: {path} の JSON パース失敗: {exc}")
    raise SystemExit(1)

required = {
    "SessionStart": ("session-start", 10),
    "PreToolUse": ("pre-tool-use", 5),
    "UserPromptSubmit": ("user-prompt-submit", 5),
    "Stop": ("stop", 10),
}
missing = []
hook_path = str(Path(os.environ["HOME"]).expanduser().resolve() / ".local/bin/codex-callout-hook")
python_prefix = [str(Path(sys.executable).resolve())] if os.name == "nt" else ["/usr/bin/env", "python3"]
for event, (subcommand, timeout) in required.items():
    parts = [*python_prefix, hook_path, subcommand]
    command = "& " + " ".join(f'"{part}"' for part in parts) if os.name == "nt" else shlex.join(parts)
    matches = [
        hook
        for entry in data.get("hooks", {}).get(event, [])
        if isinstance(entry, dict)
        for hook in entry.get("hooks", [])
        if isinstance(hook, dict) and hook.get("command") == command
    ]
    if len(matches) != 1 or matches[0] != {
        "type": "command",
        "command": command,
        "timeout": timeout,
        "async": False,
        "statusMessage": None,
    }:
        missing.append(f"{event}: codex-callout-hook {subcommand} の正規 entry")

gate_path = str(Path(os.environ["HOME"]).expanduser().resolve() / ".local/bin/codex-git-destroy-gate-hook")
parts = [*python_prefix, gate_path]
gate_command = "& " + " ".join(f'"{part}"' for part in parts) if os.name == "nt" else shlex.join(parts)
gate_expected = {"type": "command", "command": gate_command, "timeout": 5, "async": False, "statusMessage": None}
gate_matches = [
    hook
    for entry in data.get("hooks", {}).get("PreToolUse", [])
    if isinstance(entry, dict)
    for hook in entry.get("hooks", [])
    if isinstance(hook, dict) and hook.get("command") == gate_command
]
if gate_matches != [gate_expected]:
    missing.append("PreToolUse: codex-git-destroy-gate-hook のcanonical entry")

if missing:
    print("FAIL: Codex 必須 hook が欠落: " + "、".join(missing))
    raise SystemExit(1)
PY
then
  fail=1
fi

# Orchestrate advisory はSessionStartへ一件だけの追加INFOであり、既存calloutとは別entryで保持する。
if [ -f "$codex_hooks" ] && ! "$PYTHON_BIN" - "$codex_hooks" <<'PY'
import json
import os
import shlex
import shutil
import sys
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
path = str(Path(os.environ["HOME"]).expanduser().resolve() / ".local/bin/orchestrate-advisory-hook")
shell_prefix = str((Path(os.environ["ProgramFiles"]) / "Git/bin/bash.exe").resolve()) if os.name == "nt" else "/bin/sh"
parts = [shell_prefix, path]
command = "& " + " ".join(f'"{part}"' for part in parts) if os.name == "nt" else shlex.join(parts)
expected = {"type": "command", "command": command, "timeout": 5, "async": False, "statusMessage": None}
matches = [
    hook
    for entry in data.get("hooks", {}).get("SessionStart", [])
    if isinstance(entry, dict)
    for hook in entry.get("hooks", [])
    if isinstance(hook, dict) and hook.get("command") == command
]
raise SystemExit(0 if matches == [expected] else 1)
PY
then
  echo "FAIL: Codex SessionStart に orchestrate-advisory-hook の正規 entry がない"
  fail=1
fi

# Lattice工程表案内もSessionStartへ独立したcanonical entryで保持する。
if [ -f "$codex_hooks" ] && ! "$PYTHON_BIN" - "$codex_hooks" <<'PY'
import json
import os
import shlex
import sys
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
path = str(Path(os.environ["HOME"]).expanduser().resolve() / ".local/bin/codex-lattice-gantt-hook")
python_prefix = [str(Path(sys.executable).resolve())] if os.name == "nt" else ["/usr/bin/env", "python3"]
parts = [*python_prefix, path, "session-start"]
command = "& " + " ".join(f'"{part}"' for part in parts) if os.name == "nt" else shlex.join(parts)
expected = {"type": "command", "command": command, "timeout": 6, "async": False, "statusMessage": None}
relevant = []
matches = []
for entry in data.get("hooks", {}).get("SessionStart", []):
    if not isinstance(entry, dict):
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        if "codex-lattice-gantt-hook" in hook["command"]:
            relevant.append(hook)
        if hook["command"] == command:
            matches.append(hook)
if relevant != [expected] or matches != [expected]:
    raise SystemExit(1)
parts = [*python_prefix, path, "user-prompt-submit"]
command = "& " + " ".join(f'"{part}"' for part in parts) if os.name == "nt" else shlex.join(parts)
expected = {"type": "command", "command": command, "timeout": 5, "async": False, "statusMessage": None}
relevant = []
matches = []
for entry in data.get("hooks", {}).get("UserPromptSubmit", []):
    if not isinstance(entry, dict):
        continue
    for hook in entry.get("hooks", []):
        if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
            continue
        if "codex-lattice-gantt-hook" in hook["command"]:
            relevant.append(hook)
        if hook["command"] == command:
            matches.append(hook)
raise SystemExit(0 if relevant == [expected] and matches == [expected] else 1)
PY
then
  echo "FAIL: Codex Lattice工程表hook（SessionStart / UserPromptSubmit）の正規 entry がない"
  fail=1
fi

if [ "${DOTAGENTS_SKIP_FACTORY_CORE:-0}" != 1 ]; then
  verify_factory_core
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "verify-install: OK — profile=${profile}、全エントリが本リポ ${REPO} 向き symlink"
else
  echo "verify-install: FAIL あり — profile=${profile}。上記を退避/再 install で解消（手順は dotagents/README ランブック §2-3）"
fi
exit "$fail"
