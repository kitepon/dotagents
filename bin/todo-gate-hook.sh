#!/usr/bin/env python3
# 前提: Fable級統括が設計・Opus/Sol級の親が日常実行（2026-07 時点）。判定の正は docs/02_models.md
import datetime
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib" / "orchestrate"))
from hook_state import safe_append, safe_exists, safe_mtime, safe_read, safe_touch, safe_unlink, safe_write, state_dir
from plan_stocktake import plan_files, plan_stocktake

STATE_DIR = state_dir()
if STATE_DIR is None:
    raise SystemExit(0)


def error_log():
    try:
        safe_append(os.path.join(STATE_DIR, "errors.log"), f"{datetime.datetime.now().isoformat()} todo-gate-hook parse-fail\n")
    except Exception:
        pass


def run_git(cwd, *args):
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError
    return result.stdout


def gc():
    try:
        cutoff = time.time() - 7 * 24 * 60 * 60
        for entry in os.scandir(STATE_DIR):
            if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                safe_unlink(entry.path)
    except Exception:
        pass


def repo_info(cwd):
    root = run_git(cwd, "rev-parse", "--show-toplevel").strip()
    porcelain = run_git(root, "status", "--porcelain")
    head = run_git(root, "rev-parse", "HEAD").strip()
    return root, hashlib.sha1(root.encode()).hexdigest()[:12], hashlib.sha1(porcelain.encode()).hexdigest(), head, porcelain


def session_key(session_id):
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def snapshot_path(session_id, repo_key):
    return os.path.join(STATE_DIR, f"{session_key(session_id)}.{repo_key}.snapshot")


def write_snapshot(path, porcelain_hash, head):
    safe_write(path, f"{porcelain_hash}\n{head}\n")


def status_paths(porcelain):
    paths = set()
    for line in porcelain.splitlines():
        if len(line) < 4:
            continue
        value = line[3:]
        if " -> " in value:
            value = value.split(" -> ", 1)[1]
        paths.add(value.strip('"'))
    return paths


def lattice_store_is_canonical(root):
    core = Path(__file__).resolve().parents[1] / "lib" / "lattice-hook.py"
    try:
        spec = importlib.util.spec_from_file_location("dotagents_lattice_hook", core)
        if spec is None or spec.loader is None:
            return False
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        lattice = module.executable("lattice")
        if lattice is None:
            return False
        project_status, _ = module.read_project_status(lattice, root)
        return isinstance(project_status, dict) and project_status.get("state") in ("ready", "active_run")
    except Exception:
        return False


def grok_host():
    return os.environ.get("DOTAGENTS_HOOK_HOST") == "grok"


def cursor_host():
    return os.environ.get("DOTAGENTS_HOOK_HOST") == "cursor"


def cursor_cwd(data):
    cwd = data.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd
    roots = data.get("workspace_roots")
    if isinstance(roots, list) and roots and isinstance(roots[0], str):
        return roots[0]
    return None


def emit_cursor_context(message):
    sys.stdout.write(json.dumps({"additional_context": message}, ensure_ascii=False) + "\n")


def session_start(data):
    if cursor_host():
        session_id = data.get("session_id") or data.get("conversation_id")
        source = data.get("composer_mode") or "startup"
        cwd = cursor_cwd(data)
        if source in {"agent", "ask", "edit"}:
            source = "startup"
    elif grok_host():
        session_id = data.get("sessionId")
        source = data.get("source") or "startup"
        cwd = data.get("cwd") or data.get("workspaceRoot")
    else:
        session_id, source, cwd = data["session_id"], data["source"], data["cwd"]
    if not all(isinstance(value, str) for value in (session_id, source, cwd)):
        raise ValueError
    root, repo_key, porcelain_hash, head, _ = repo_info(cwd)
    key = session_key(session_id)
    snap = snapshot_path(session_id, repo_key)
    if not safe_exists(snap):
        write_snapshot(snap, porcelain_hash, head)
    if source == "compact":
        for suffix in ("placement-warn", "onset-info"):
            try:
                safe_unlink(os.path.join(STATE_DIR, f"{key}.{suffix}"))
            except OSError:
                pass
    if os.environ.get("DOTAGENTS_TODO_GATE") == "off":
        return
    if source not in ("startup", "clear"):
        return
    stocktake = os.path.join(STATE_DIR, f"{repo_key}.stocktake")
    stocktake_mtime = safe_mtime(stocktake)
    if stocktake_mtime is not None and time.time() - stocktake_mtime < 24 * 60 * 60:
        return
    entries, complete = plan_stocktake(root)
    archived = complete if not entries else []
    if not entries and not archived:
        return
    fragments = entries[:]
    if archived:
        fragments.append("全消化済みで archive 未退避: " + "・".join(archived))
    gc()
    if not safe_touch(stocktake):
        return
    message = "INFO: docs/ のプラン状況: " + "・".join(fragments) + "。プランの維持・完了処理の方針は、グローバル CLAUDE.md / AGENTS.md「計画文書の作法」を参照。この一覧は現在の依頼範囲を変更しません。"
    if cursor_host():
        emit_cursor_context(message)
        return
    sys.stdout.write(message + "\n")


def stop(data):
    if cursor_host():
        session_id = data.get("session_id") or data.get("conversation_id")
        cwd = cursor_cwd(data)
        if data.get("status") not in (None, "completed"):
            return
    elif grok_host():
        session_id = data.get("sessionId")
        cwd = data.get("cwd") or data.get("workspaceRoot")
        if data.get("reason") not in (None, "end_turn"):
            return
        if data.get("stopHookActive") is True:
            return
    else:
        session_id, cwd = data["session_id"], data["cwd"]
        if data.get("stop_hook_active") is True:
            return
    if not isinstance(session_id, str) or not isinstance(cwd, str):
        raise ValueError
    if os.environ.get("DOTAGENTS_TODO_GATE") == "off":
        return
    root, repo_key, porcelain_hash, head, porcelain = repo_info(cwd)
    snap = snapshot_path(session_id, repo_key)
    if not safe_exists(snap):
        write_snapshot(snap, porcelain_hash, head)
        return
    try:
        old_porcelain, old_head = (safe_read(snap) or "").splitlines()[:2]
    except ValueError:
        write_snapshot(snap, porcelain_hash, head)
        return
    if old_porcelain == porcelain_hash and old_head == head:
        write_snapshot(snap, porcelain_hash, head)
        return
    paths = status_paths(porcelain)
    commits = 0
    if old_head != head:
        try:
            paths.update(filter(None, run_git(root, "diff", "--name-only", old_head, head).splitlines()))
            commits = int(run_git(root, "rev-list", "--count", f"{old_head}..{head}").strip())
        except Exception:
            write_snapshot(snap, porcelain_hash, head)
            return
    plans = ["docs/" + name for name in plan_files(root) if name.startswith("plan_")]
    write_snapshot(snap, porcelain_hash, head)
    if not plans or any(path in paths for path in plans):
        return
    gc()
    summary = f"{len(paths)} ファイル/コミット {commits}"
    # Lattice文面を肯定するのはtyped discoveryがready/active_runの時だけ。
    # discovery失敗は発火を握りつぶすfallbackではなく、確定済み発火の文面選択を既存側に倒す。
    prefix = f"INFO: 前ターンでは作業差分（{summary}）が検出され、docs/ のプラン正本（{', '.join(os.path.basename(path) for path in plans)}）には同じターンの更新が確認されませんでした。"
    if lattice_store_is_canonical(root):
        guidance = "この差分がLattice工程のToDoに属するなら進捗・完了証拠をLattice storeへ記録し、Markdown planの統括レーンに属するならそのplanへ進捗を反映してください。無関係な通常レーンなら更新不要です"
    else:
        guidance = "この差分が当該planに属する統括レーンなら進捗を反映し、無関係な通常レーンなら更新不要です"
    message = prefix + guidance + "。この情報は依頼範囲を広げません。"
    safe_write(os.path.join(STATE_DIR, f"{session_key(session_id)}.todo-pending"), message + "\n")


def main():
    raw = sys.stdin.read()
    if len(sys.argv) != 2 or sys.argv[1] not in ("session-start", "stop"):
        return
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
    except Exception:
        error_log()
        return
    if grok_host() or cursor_host():
        if sys.argv[1] == "session-start":
            if cursor_host():
                required_ok = isinstance(data.get("session_id") or data.get("conversation_id"), str) and isinstance(cursor_cwd(data), str)
            else:
                required_ok = isinstance(data.get("sessionId"), str) and isinstance(data.get("cwd") or data.get("workspaceRoot"), str)
        else:
            if cursor_host():
                required_ok = isinstance(data.get("session_id") or data.get("conversation_id"), str) and isinstance(cursor_cwd(data), str)
            else:
                required_ok = isinstance(data.get("sessionId"), str) and isinstance(data.get("cwd") or data.get("workspaceRoot"), str)
    else:
        required = ("session_id", "source", "cwd") if sys.argv[1] == "session-start" else ("session_id", "cwd", "stop_hook_active")
        required_ok = all(key in data for key in required)
    if not required_ok:
        error_log()
        return
    try:
        if sys.argv[1] == "session-start":
            session_start(data)
        else:
            stop(data)
    except Exception:
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        error_log()
