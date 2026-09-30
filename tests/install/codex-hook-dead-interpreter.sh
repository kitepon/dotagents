#!/usr/bin/env bash
# 死んだ Python interpreter の git-destroy-gate を同一 hook として、既存の位置で畳む。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONIOENCODING=utf-8

python3 - "$ROOT/bin/apply-codex-config.sh" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
ns = {"__name__": "apply_codex", "__file__": sys.argv[1]}
exec(compile(source, sys.argv[1], "exec"), ns)

home = Path.home()
hook = home / ".local/bin/codex-git-destroy-gate-hook"
dead = (
    r'& "C:\Program Files\Python313\python.exe" '
    r'"' + str(hook) + r'"'
)
live = ns["python_hook_command"](hook)
same = lambda command, path: ns["is_script_command"](command, path, (), home, ns["PYTHON_HOOK_PREFIX"])
assert same(dead, hook), "死んだ interpreter を同一 hook と見なさない"
assert same(live, hook), "現行 interpreter を同一 hook と見なさない"
assert not same(dead, home / ".local/bin/other-hook")

# 信頼記録の鍵は位置で決まる。既存ゲートの位置を保ち、無い時だけ末尾へ足す。
rtk = {"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook codex"}]}
data = {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": dead, "timeout": 5}]}, rtk]}}
ns["update_hooks"](data, home)
pre = data["hooks"]["PreToolUse"]
assert [entry["hooks"][0]["command"] for entry in pre] == [live, "rtk hook codex"], pre
data = {"hooks": {"PreToolUse": [rtk]}}
ns["update_hooks"](data, home)
assert [entry["hooks"][0]["command"] for entry in data["hooks"]["PreToolUse"]] == ["rtk hook codex", live]
print("codex hook dead interpreter matching")
PY
