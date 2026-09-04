"""責務境界ゲート: セッションの作業repoと異なる製品repoへの書込を、責務宣言が無い限りPreToolUseで拒否する。

背景（オーナー叱責 2026-09-04）: 稼働中の系が壊れた最中に、症状が出た製品（peertable の wakeup-bridge）へ
別製品（aiterm）が所有する状態（PTYの前面プロセスグループ・termios）の処理を書いて公開した。
「絆創膏でプロダクトを直すな」。同型の逸脱は cwd と別の製品repoへ書く瞬間に必ず起きるので、
その瞬間に 4 問（症状の製品／状態の所有製品／なぜここか／反証）へ答えた宣言を要求する。
判断はしない。宣言が今日付で 4 行揃っていれば通す。

宣言file: $DOTAGENTS_BOUNDARY_DIR（既定 ~/.local/state/dotagents/boundary）/<対象repo名>.md
必須行（先頭一致・値が空でない）: `症状:` `所有者:` `理由:` `反証:`
有効期限: 当日（mtime の日付が今日）。翌日は書き直す。
対象: $DOTAGENTS_PRODUCT_ROOT（既定 ~/Developer）配下の git repo への Edit/Write/MultiEdit/NotebookEdit、
      および Bash の `git commit` / `git push` / `npm publish` / `pnpm publish`（`cd` で移った先を追う）。
無効化: DOTAGENTS_BOUNDARY_GATE=off
"""

import datetime as _dt
import importlib.util
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "bash", "Shell", "shell", "shell_command", "run_terminal_command"}
REQUIRED_KEYS = ("症状:", "所有者:", "理由:", "反証:")


def _load_destroy_gate():
    core = Path(__file__).resolve().parent / "git-destroy-gate.py"
    spec = importlib.util.spec_from_file_location("dotagents_git_destroy_gate_for_boundary", core)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_toplevel(path):
    if not isinstance(path, str) or not path:
        return None
    probe = Path(path).expanduser()
    # 新規fileや未作成dirへの書込も対象なので、実在する最初の祖先までさかのぼる
    while not probe.is_dir():
        if probe.parent == probe:
            return None
        probe = probe.parent
    try:
        result = subprocess.run(
            ["git", "-C", str(probe), "rev-parse", "--show-toplevel"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    top = result.stdout.decode("utf-8", "replace").strip()
    return str(Path(top).resolve()) if top else None


def product_root():
    return str(Path(os.environ.get("DOTAGENTS_PRODUCT_ROOT") or (Path.home() / "Developer")).expanduser().resolve())


def boundary_dir():
    return Path(os.environ.get("DOTAGENTS_BOUNDARY_DIR") or (Path.home() / ".local/state/dotagents/boundary")).expanduser()


def declaration_ok(target_root):
    path = boundary_dir() / f"{Path(target_root).name}.md"
    try:
        stat = path.stat()
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False, path
    if _dt.date.fromtimestamp(stat.st_mtime) != _dt.date.today():
        return False, path
    found = {key: False for key in REQUIRED_KEYS}
    for line in text.splitlines():
        stripped = line.strip()
        for key in REQUIRED_KEYS:
            if stripped.startswith(key) and stripped[len(key):].strip():
                found[key] = True
    return all(found.values()), path


def bash_write_targets(command, cwd, destroy_gate):
    """`cd` を追いながら commit/push/publish の実行dirを列挙する。"""
    targets = []
    current = cwd
    for segment in destroy_gate.shell_segments(command or ""):
        try:
            tokens = shlex.split(segment.strip(), posix=True)
        except ValueError:
            return []
        if not tokens:
            continue
        head = os.path.basename(tokens[0]).lower()
        if head == "cd" and len(tokens) >= 2:
            candidate = Path(tokens[1]).expanduser()
            current = str(candidate if candidate.is_absolute() else Path(current or ".") / candidate)
            continue
        if head in {"git", "git.exe"} and len(tokens) >= 2:
            sub = tokens[1]
            git_cwd = current
            if sub == "-C" and len(tokens) >= 4:
                git_cwd, sub = tokens[2], tokens[3]
            if sub in {"commit", "push"}:
                targets.append(git_cwd)
        elif head in {"npm", "pnpm", "yarn"} and len(tokens) >= 2 and tokens[1] == "publish":
            targets.append(current)
    return targets


def emit_deny(target_root, path, reason):
    message = (
        f"P13_BOUNDARY_UNDECLARED: 作業repoと異なる製品repo（{target_root}）への書込には責務宣言が要ります（{reason}）。\n"
        f"宣言file: {path}\n"
        "次の4行を書いてから再実行してください（当日限り有効・値を空にしない）:\n"
        "症状: <症状が出た製品と現象>\n"
        "所有者: <触る状態を所有する製品と部位>\n"
        "理由: <なぜその製品に書くのか（症状の場所と所有者が同じか）>\n"
        "反証: <誰が・いつ反証したか。未実施なら『未実施』と書き、反証後に書き直す>\n"
        "止血は運用操作（手動キー・bridge再起動・自動蘇生の停止）だけで行い、製品の変更と公開を止血に使わない。\n"
        "正典: グローバル AGENTS.md「姿勢の原則」12"
    )
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": message,
        }
    }
    sys.stdout.buffer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))


def main(frontend):
    if frontend != "claude" or os.environ.get("DOTAGENTS_BOUNDARY_GATE") == "off":
        return
    try:
        data = json.loads(sys.stdin.read())
        if not isinstance(data, dict):
            return
        tool_name = data.get("tool_name")
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, dict):
            return
        session_cwd = data.get("cwd")
        candidates = []
        if tool_name in EDIT_TOOLS:
            file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
            if isinstance(file_path, str) and file_path:
                candidates.append(file_path)
        elif tool_name in SHELL_TOOLS:
            destroy_gate = _load_destroy_gate()
            candidates.extend(bash_write_targets(tool_input.get("command"), session_cwd, destroy_gate))
        else:
            return
        if not candidates:
            return
        session_root = git_toplevel(session_cwd) or (str(Path(session_cwd).resolve()) if isinstance(session_cwd, str) and session_cwd else None)
        products = product_root()
        for candidate in candidates:
            target_root = git_toplevel(candidate)
            if target_root is None:
                continue
            if not target_root.startswith(products + os.sep):
                continue
            if session_root and (target_root == session_root or session_root.startswith(target_root + os.sep)):
                continue
            ok, path = declaration_ok(target_root)
            if ok:
                continue
            emit_deny(target_root, path, "宣言が無い、期限切れ、または4行が揃っていない")
            return
    except Exception:
        return
