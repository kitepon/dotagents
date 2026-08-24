#!/usr/bin/env bash
# apply-cursor-config を実 HOME に触れず検証する。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONIOENCODING=utf-8
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict ;; esac
HOME_FIXTURE="$(mktemp -d)"
ABSENT_HOME="$(mktemp -d)"
SYMLINK_HOME="$(mktemp -d)"
RESOLVE_HOME="$(mktemp -d)"
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$ABSENT_HOME" "$SYMLINK_HOME" "$RESOLVE_HOME" "$STUB_BIN"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

HOME="$HOME_FIXTURE" "$ROOT/install.sh" --profile official >/dev/null
[ -L "$HOME_FIXTURE/.local/bin/apply-cursor-config" ] \
  || fail 'apply-cursor-config を ~/.local/bin へ配布しない'
[ "$(readlink "$HOME_FIXTURE/.local/bin/apply-cursor-config")" = "$ROOT/bin/apply-cursor-config.sh" ] \
  || fail 'apply-cursor-config の symlink 先が本リポでない'

mkdir -p "$HOME_FIXTURE/.cursor"
cat >"$HOME_FIXTURE/.cursor/cli-config.json" <<'EOF'
{
  "model": {
    "modelId": "keep-me"
  },
  "permissions": {
    "allow": ["Shell(ls)"]
  }
}
EOF
cat >"$HOME_FIXTURE/.cursor/mcp.json" <<'EOF'
{
  "mcpServers": {
    "gmail": {
      "command": "keep-personal",
      "url": "https://example.invalid/mcp"
    }
  }
}
EOF
chmod 644 "$HOME_FIXTURE/.cursor/cli-config.json" "$HOME_FIXTURE/.cursor/mcp.json"
cli_before="$(cat "$HOME_FIXTURE/.cursor/cli-config.json")"
before="$(cat "$HOME_FIXTURE/.cursor/mcp.json")"
dry="$(HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --dry-run)"
grep -Fq '"aiterm"' <<<"$dry" || fail 'dry-run が工場MCP aiterm を出さない'
grep -Fq '"caveat"' <<<"$dry" || fail 'dry-run が工場MCP caveat を出さない'
[ "$(cat "$HOME_FIXTURE/.cursor/mcp.json")" = "$before" ] || fail 'dry-run が mcp.json を書き換えた'
[ "$(cat "$HOME_FIXTURE/.cursor/cli-config.json")" = "$cli_before" ] || fail 'dry-run が cli-config.json を書き換えた'
[ ! -d "$HOME_FIXTURE/Archives" ] || fail 'dry-run が backup を作った'

HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
applied="$(cat "$HOME_FIXTURE/.cursor/mcp.json")"
[ "$(cat "$HOME_FIXTURE/.cursor/cli-config.json")" = "$cli_before" ] || fail 'apply が cli-config.json を書き換えた'
grep -Fq '"keep-personal"' <<<"$applied" || fail '個人MCP gmail を消した'
grep -Fq 'https://example.invalid/mcp' <<<"$applied" || fail '個人MCP url を消した'
for name in aiterm caveat lattice codex-sidecar gpt_connector aishell; do
  grep -Fq "\"$name\"" <<<"$applied" || fail "工場MCP $name を書かない"
done
python3 - "$HOME_FIXTURE/.cursor/mcp.json" <<'PY' || fail '工場MCP の JSON 契約が違う'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
servers = data["mcpServers"]
caveat = servers["caveat"]
if caveat.get("args") != ["mcp-server"]:
    raise SystemExit("caveat args")
aishell = servers["aishell"]
if aishell.get("env", {}).get("AISHELL_CAPABILITY_SET") != "expanded-v1":
    raise SystemExit("aishell env")
if "command" not in caveat or "command" not in servers["aiterm"]:
    raise SystemExit("command")
PY
[ -f "$HOME_FIXTURE/.cursor/hooks.json" ] || fail 'apply が hooks.json を書かない'
python3 - "$HOME_FIXTURE/.cursor/hooks.json" <<'PY' || fail '工場hook の JSON 契約が違う'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if data.get("version") != 1:
    raise SystemExit("version")
commands = []
for entries in data["hooks"].values():
    for entry in entries:
        commands.append(entry.get("command", ""))
if not any("cursor-git-destroy-gate-hook" in command for command in commands):
    raise SystemExit("git-destroy")
if not any("cursor-constitution-hook" in command for command in commands):
    raise SystemExit("constitution")
prompts = data["hooks"].get("beforeSubmitPrompt") or []
if not any("cursor-constitution-hook" in entry.get("command", "") for entry in prompts):
    raise SystemExit("constitution prompt")
if any("spotter" in command.lower() or "throughline" in command.lower() for command in commands):
    raise SystemExit("product hook")
if any("permissionDecision" in json.dumps(data) for _ in [0]):
    raise SystemExit("claude shape")
PY
[ -d "$HOME_FIXTURE/Archives" ] || fail 'apply が backup を作らない'

HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply | grep -Fq '変更なし' \
  || fail '2回目 apply が冪等でない'
[ "$(cat "$HOME_FIXTURE/.cursor/cli-config.json")" = "$cli_before" ] || fail '2回目 apply が cli-config.json を書き換えた'

HOME="$ABSENT_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
[ -f "$ABSENT_HOME/.cursor/mcp.json" ] || fail '不在の mcp.json を作らない'
python3 - "$ABSENT_HOME/.cursor/mcp.json" <<'PY' || fail '新規 mcp.json に工場MCPを書かない'
import json
import sys
from pathlib import Path

servers = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["mcpServers"]
for name in ("aiterm", "caveat", "lattice", "codex-sidecar", "gpt_connector", "aishell"):
    if name not in servers:
        raise SystemExit(name)
PY
[ ! -e "$ABSENT_HOME/.cursor/cli-config.json" ] || fail '不在HOMEに cli-config.json を作った'

mkdir -p "$SYMLINK_HOME/.cursor" "$SYMLINK_HOME/target"
printf '%s\n' '{"mcpServers":{}}' >"$SYMLINK_HOME/target/mcp.json"
ln -s "$SYMLINK_HOME/target/mcp.json" "$SYMLINK_HOME/.cursor/mcp.json"
if HOME="$SYMLINK_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null 2>&1; then
  fail 'symlink mcp.json への apply を受理した'
fi
grep -Fq '{"mcpServers":{}}' "$SYMLINK_HOME/target/mcp.json" || fail 'symlink 先を書き換えた'

if [ "${OS:-}" = "Windows_NT" ]; then
  printf '%s\n' '@echo off' >"$STUB_BIN/caveat.cmd"
  mkdir -p "$RESOLVE_HOME/.cursor"
  PATH="$STUB_BIN:$PATH" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
  python3 - "$RESOLVE_HOME/.cursor/mcp.json" <<'PY'
import json
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
data = json.loads(text)
command = data["mcpServers"]["caveat"]["command"]
if "caveat.cmd" not in command.lower():
    raise SystemExit("FAIL: 解決できた caveat を絶対パスで書かない")
env_path = data["mcpServers"]["caveat"]["env"]["PATH"]
if ";" not in env_path:
    raise SystemExit("FAIL: Windows の env.PATH が pathsep になっていない")
PY
  PATH="$STUB_BIN:$PATH" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply \
    | grep -Fq '変更なし' || fail '絶対パス適用の2回目が冪等でない'
else
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$STUB_BIN/caveat"
  chmod +x "$STUB_BIN/caveat"
  mkdir -p "$RESOLVE_HOME/.cursor"
  PATH="$STUB_BIN:/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
  python3 - "$RESOLVE_HOME/.cursor/mcp.json" "$STUB_BIN" <<'PY' || fail '解決できた caveat を絶対パスで書かない'
import json
import sys
from pathlib import Path

stub = sys.argv[2]
data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
command = data["mcpServers"]["caveat"]["command"]
if command != f"{stub}/caveat":
    raise SystemExit(command)
env_path = data["mcpServers"]["caveat"]["env"]["PATH"]
if not env_path.startswith(f"{stub}:") or "/usr/bin:/bin:/usr/sbin:/sbin" not in env_path:
    raise SystemExit(env_path)
PY
  PATH="$STUB_BIN:/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply \
    | grep -Fq '変更なし' || fail '絶対パス適用の2回目が冪等でない'
  PATH="/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply \
    | grep -Fq '変更なし' || fail 'GUI PATH の apply が実行可能な絶対パスを名前へ戻した'
fi

echo 'apply-cursor-config: OK'
