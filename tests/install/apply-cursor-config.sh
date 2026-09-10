#!/usr/bin/env bash
# apply-cursor-config を実 HOME に触れず検証する。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONIOENCODING=utf-8
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict ;; esac
HOME_FIXTURE="$(mktemp -d)"
ABSENT_HOME="$(mktemp -d)"
SYMLINK_HOME="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$ABSENT_HOME" "$SYMLINK_HOME"' EXIT

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
if grep -Fq 'mcp.json' <<<"$dry"; then fail 'dry-run が製品MCPの変更を出した'; fi
[ "$(cat "$HOME_FIXTURE/.cursor/mcp.json")" = "$before" ] || fail 'dry-run が mcp.json を書き換えた'
[ "$(cat "$HOME_FIXTURE/.cursor/cli-config.json")" = "$cli_before" ] || fail 'dry-run が cli-config.json を書き換えた'
[ ! -d "$HOME_FIXTURE/Archives" ] || fail 'dry-run が backup を作った'

HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
applied="$(cat "$HOME_FIXTURE/.cursor/mcp.json")"
[ "$(cat "$HOME_FIXTURE/.cursor/cli-config.json")" = "$cli_before" ] || fail 'apply が cli-config.json を書き換えた'
grep -Fq '"keep-personal"' <<<"$applied" || fail '個人MCP gmail を消した'
grep -Fq 'https://example.invalid/mcp' <<<"$applied" || fail '個人MCP url を消した'
[ "$applied" = "$before" ] || fail '製品MCP設定を変更した'
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
tools = data["hooks"].get("preToolUse") or []
if not any("cursor-constitution-hook" in entry.get("command", "") for entry in tools):
    raise SystemExit("constitution pretool")
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
[ ! -e "$ABSENT_HOME/.cursor/mcp.json" ] || fail '製品所有のmcp.jsonを作った'
[ ! -e "$ABSENT_HOME/.cursor/cli-config.json" ] || fail '不在HOMEに cli-config.json を作った'

mkdir -p "$SYMLINK_HOME/.cursor" "$SYMLINK_HOME/target"
printf '%s\n' '{"mcpServers":{}}' >"$SYMLINK_HOME/target/mcp.json"
ln -s "$SYMLINK_HOME/target/mcp.json" "$SYMLINK_HOME/.cursor/mcp.json"
HOME="$SYMLINK_HOME" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
grep -Fq '{"mcpServers":{}}' "$SYMLINK_HOME/target/mcp.json" || fail 'symlink 先を書き換えた'

# 他製品hookと利用者hookを保持したまま工場hookを更新する。
python3 - "$HOME_FIXTURE/.cursor/hooks.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
v = json.loads(p.read_text())
v["hooks"].setdefault("beforeSubmitPrompt", []).append({"command": "product-owned-hook"})
p.write_text(json.dumps(v))
PY
HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-cursor-config" --apply >/dev/null
grep -Fq 'product-owned-hook' "$HOME_FIXTURE/.cursor/hooks.json" || fail '他製品hookを消した'
echo 'apply-cursor-config: OK'
