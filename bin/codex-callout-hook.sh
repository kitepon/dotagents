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
from hook_state import safe_append, safe_exists, safe_mtime, safe_read, safe_touch, safe_unlink, safe_write, state_dir, writer_reserve
from plan_stocktake import plan_files, plan_stocktake

STATE_DIR = state_dir()

ONSET_CONTEXT = "INFO: 統括レーン（計画に組込済みの中断・多段の受入連鎖・複数repo書込調整・裁定証跡のいずれかが着手時に確定する戦役）は、グローバル AGENTS.md「作業レーンと統制」とorchestrate skillに従います。それ以外はすべて通常レーンで、短い成功条件・focused test・対象限定commitだけで閉じます（委譲もfan-out技法も通常レーンで使えます）。このINFO自体は作業範囲を拡張しません。"


def error_log(name):
    try:
        safe_append(os.path.join(STATE_DIR, "errors.log"), f"{datetime.datetime.now().isoformat()} {name} parse-fail\n")
    except Exception:
        pass


def gc():
    try:
        cutoff = time.time() - 7 * 24 * 60 * 60
        for entry in os.scandir(STATE_DIR):
            if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                safe_unlink(entry.path)
    except Exception:
        pass


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def deny(code, missing, example):
    # Codex PreToolUse's measured deny envelope is deliberately distinct from
    # Claude's permissionDecision envelope.
    emit({"decision": "deny", "reason": f"{code}: {missing}\n正しい呼び方: {example}\n正典: shared/orchestrate/delegation-contract.md"})


def concrete_value(value):
    if not isinstance(value, str):
        return False
    value = value.strip().strip("'\"")
    return bool(value) and value.casefold() != "inherit" and not any(token in value for token in ("$", "{", "}"))


def native_role_has_model(agent_type):
    if not isinstance(agent_type, str) or not agent_type.strip():
        return False
    path = Path.home() / ".codex" / "agents" / f"{agent_type}.toml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    # The installed file is the authority; a fixed concrete model is equivalent
    # to explicit dispatch only when any declared effort field is concrete too.
    import re
    model = re.search(r"(?m)^\s*model\s*=\s*(.*?)\s*(?:#.*)?$", text)
    if model is None or not concrete_value(model.group(1)):
        return False
    efforts = re.findall(r"(?m)^\s*(?:reasoning_effort|model_reasoning_effort|effort)\s*=\s*(.*?)\s*(?:#.*)?$", text)
    return all(concrete_value(value) for value in efforts)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def scope_declaration(tool_input):
    try:
        text = json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        raise ValueError("tool input is not serializable")
    has_read = "[scope:read-only]" in text
    has_write = "[scope:write]" in text
    if has_read and has_write:
        return "ambiguous"
    if has_write:
        return "write"
    if has_read:
        return "read"
    return "missing"


def effective_cwd(data, tool_input):
    value = tool_input.get("workspaceRoot") or tool_input.get("cwd") or data.get("cwd") or os.getcwd()
    if not nonempty(value):
        raise ValueError("cwd is unavailable")
    return Path(value).expanduser().resolve()


def common_dir(cwd):
    try:
        result = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--git-common-dir"], capture_output=True, text=True, encoding="utf-8", timeout=2)
        if result.returncode or not result.stdout.strip():
            return "unidentified-repo"
        raw = Path(result.stdout.strip())
        return str((cwd / raw).resolve() if not raw.is_absolute() else raw.resolve())
    except (OSError, subprocess.TimeoutExpired):
        return "unidentified-repo"


def writer_record(data, tool_name, tool_input, cwd):
    hint = tool_input.get("session_name") or tool_input.get("sessionName") or tool_input.get("cwd") or str(cwd)
    return {"common_dir": common_dir(cwd), "tool": tool_name, "session_hint": str(hint), "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "dispatch_id": data.get("session_id", "unknown")}


def reserve_writer(data, tool_name, tool_input, cwd):
    record = writer_record(data, tool_name, tool_input, cwd)
    status, existing = writer_reserve(record)
    if status == "reserved":
        return
    if status == "busy":
        shown = json.dumps(existing, ensure_ascii=False, sort_keys=True)
        deny("P11_WRITER_BUSY", f"先行writer（{shown}）が未解放です", f"受入完了後に delegation-gate-hook --release --common-dir '{record['common_dir']}'、並列なら Lattice run（plan compile→run start）")
        return "denied"
    deny("P11_STATE_UNAVAILABLE", "writer予約stateを安全に確保できません", "stateを修復してから [scope:write] を再実行する")
    return "denied"


def run_git(cwd, *args):
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError
    return result.stdout


def repo_info(cwd):
    root = run_git(cwd, "rev-parse", "--show-toplevel").strip()
    porcelain = run_git(root, "status", "--porcelain")
    head = run_git(root, "rev-parse", "HEAD").strip()
    return root, hashlib.sha1(root.encode()).hexdigest()[:12], hashlib.sha1(porcelain.encode()).hexdigest(), head, porcelain


def session_key(session_id):
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def snapshot_path(session_id, repo_key):
    # Claude 側 todo-gate-hook の *.snapshot と同一 STATE_DIR を共有するが、
    # session_id が別空間のため衝突しない。可読性のため接尾辞だけ変える。
    return os.path.join(STATE_DIR, f"{session_key(session_id)}.{repo_key}.codex-snapshot")


def write_snapshot(path, porcelain_hash, head, porcelain=""):
    paths = json.dumps(sorted(status_paths(porcelain)), ensure_ascii=False)
    safe_write(path, f"{porcelain_hash}\n{head}\n{paths}\n")


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


# --- X1: session-start（C2 ミラー。棚卸し文言は additionalContext 契約で統一） ---
def session_start(data):
    session_id, source, cwd = data.get("session_id"), data.get("source"), data.get("cwd")
    if not all(isinstance(value, str) for value in (session_id, source, cwd)):
        raise ValueError
    key = session_key(session_id)
    if source == "compact":
        for suffix in ("codex-onset-info", "codex-placement-info"):
            try:
                safe_unlink(os.path.join(STATE_DIR, f"{key}.{suffix}"))
            except OSError:
                pass
    if os.environ.get("DOTAGENTS_TODO_GATE") == "off":
        return
    root, repo_key, porcelain_hash, head, porcelain = repo_info(cwd)
    snap = snapshot_path(session_id, repo_key)
    if not safe_exists(snap):
        write_snapshot(snap, porcelain_hash, head, porcelain)
    if source not in ("startup", "clear"):
        return
    # stocktake はリポキーのみ＝Claude 側 C2 と意図的に共有（同一リポの棚卸し表示を統合抑制）
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
    message = "INFO: docs/ のプラン状況: " + "・".join(fragments) + "。プランの維持・完了処理の方針は、グローバル AGENTS.md「計画文書の作法」を参照。この一覧は現在の依頼範囲を変更しません。"
    emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": message}})


# --- X2: pre-tool-use（update_plan / spawn_agent のみ。それ以外は main() の fast-path で弾く） ---
def pre_tool_use(data):
    session_id = data.get("session_id")
    tool_name = data.get("tool_name")
    tool_input = data.get("tool_input")
    if not isinstance(session_id, str) or not isinstance(tool_input, dict):
        raise ValueError
    key = session_key(session_id)

    if tool_name == "update_plan":
        if os.environ.get("DOTAGENTS_TODO_GATE") == "off":
            return
        plan = tool_input.get("plan")
        if not isinstance(plan, list):
            return
        statuses = [item.get("status") for item in plan if isinstance(item, dict)]
        messages = []

        canon_path = os.path.join(STATE_DIR, f"{key}.codex-plan-canon")
        if not safe_exists(canon_path) and safe_touch(canon_path):
            if len(plan) >= 4:
                messages.append("INFO: Codex の内蔵プランが作成されました。通常レーンは内蔵planで足り、統括レーンだけがグローバル AGENTS.md「計画文書の作法」に従ってdocs正本を持ちます。")

        if statuses and all(status == "completed" for status in statuses):
            done_path = os.path.join(STATE_DIR, f"{key}.codex-plan-done")
            if not safe_exists(done_path) and safe_touch(done_path):
                messages.append("INFO: Codex の内蔵プランが全項目 completed になりました。永続プランの進捗反映と完了文書の扱いは、グローバル AGENTS.md「計画文書の作法」を参照。")

        if messages:
            gc()
            emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "\n".join(messages)}})
        return

    if tool_name == "spawn_agent":
        if os.environ.get("DOTAGENTS_PLACEMENT_GATE") == "off":
            return
        if not concrete_value(tool_input.get("model")):
            if not native_role_has_model(tool_input.get("agent_type")):
                deny("P10_MODEL_EFFORT_MISSING", "spawn_agent の model が未指定で、agent_type の固定 model もありません", "model を指定するか model 固定の agent_type を指定する")
                return
        declaration = scope_declaration(tool_input)
        if declaration == "missing":
            deny("P9_SCOPE_DECL_MISSING", "scope 宣言トークンがありません", "prompt/input に [scope:read-only] または [scope:write] を一つだけ入れる")
            return
        if declaration == "ambiguous":
            deny("P9_SCOPE_DECL_AMBIGUOUS", "read-only と write のscope宣言が混在しています", "prompt/input に [scope:read-only] または [scope:write] を一つだけ入れる")
            return
        if declaration == "write":
            if reserve_writer(data, tool_name, tool_input, effective_cwd(data, tool_input)) == "denied":
                return
        shown = os.path.join(STATE_DIR, f"{key}.codex-placement-info")
        if safe_exists(shown):
            return
        if not safe_touch(shown):
            return
        gc()
        message = "INFO: このセッションで最初のネイティブ委譲を検出しました。配置・routing・委譲契約の基準は、グローバル AGENTS.md「作業レーンと統制」および docs/02_models.md を参照。このINFO自体は追加の委譲や依頼範囲の拡張を要求しません。"
        emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": message}})
        return


# --- X3+X5: user-prompt-submit（セッション初回INFO ＋ pending drain） ---
def user_prompt_submit(data):
    session_id = data.get("session_id")
    parts = []
    if isinstance(session_id, str) and os.environ.get("DOTAGENTS_ONSET_GATE") != "off":
        key = session_key(session_id)
        shown = os.path.join(STATE_DIR, f"{key}.codex-onset-info")
        if not safe_exists(shown) and safe_touch(shown):
            parts.append(ONSET_CONTEXT)
    if isinstance(session_id, str) and os.environ.get("DOTAGENTS_TODO_GATE") != "off":
        pending_path = os.path.join(STATE_DIR, f"{session_key(session_id)}.codex-pending")
        if safe_exists(pending_path):
            content = (safe_read(pending_path) or "").strip()
            safe_unlink(pending_path)
            if content:
                parts.append(content)
    if parts:
        emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n".join(parts)}})


# --- X4: stop（C3 ミラー。rolling baseline で検出し pending 保存） ---
def stop(data):
    session_id, cwd = data.get("session_id"), data.get("cwd")
    if not isinstance(session_id, str) or not isinstance(cwd, str):
        raise ValueError
    if os.environ.get("DOTAGENTS_TODO_GATE") == "off":
        return
    if data.get("stop_hook_active") is True:
        return
    root, repo_key, porcelain_hash, head, porcelain = repo_info(cwd)
    key = session_key(session_id)
    snap = snapshot_path(session_id, repo_key)
    if not safe_exists(snap):
        write_snapshot(snap, porcelain_hash, head, porcelain)
        return
    try:
        snapshot = (safe_read(snap) or "").splitlines()
        old_porcelain, old_head = snapshot[:2]
        old_paths = set()
        if len(snapshot) >= 3:
            stored_paths = json.loads(snapshot[2])
            if not isinstance(stored_paths, list) or not all(isinstance(path, str) for path in stored_paths):
                raise ValueError
            old_paths.update(stored_paths)
    except (ValueError, json.JSONDecodeError):
        write_snapshot(snap, porcelain_hash, head, porcelain)
        return
    if old_porcelain == porcelain_hash and old_head == head:
        write_snapshot(snap, porcelain_hash, head, porcelain)
        return
    paths = status_paths(porcelain)
    cleanup = not porcelain and old_porcelain != hashlib.sha1(b"").hexdigest() and old_head == head
    if cleanup:
        paths.update(old_paths)
    commits = 0
    if old_head != head:
        try:
            paths.update(filter(None, run_git(root, "diff", "--name-only", old_head, head).splitlines()))
            commits = int(run_git(root, "rev-list", "--count", f"{old_head}..{head}").strip())
        except Exception:
            write_snapshot(snap, porcelain_hash, head, porcelain)
            return
    plans = ["docs/" + name for name in plan_files(root) if name.startswith("plan_")]
    write_snapshot(snap, porcelain_hash, head, porcelain)
    if not plans or any(path in paths for path in plans):
        return
    gc()
    if cleanup:
        summary = f"{len(paths)} ファイルの作業差分を解消/コミット {commits}" if paths else f"dirtyだった作業差分を解消/コミット {commits}"
    else:
        summary = f"{len(paths)} ファイル/コミット {commits}"
    # Lattice文面を肯定するのはtyped discoveryがready/active_runの時だけ。
    # discovery失敗は発火を握りつぶすfallbackではなく、確定済み発火の文面選択を既存側に倒す。
    prefix = f"INFO: 前ターンでは作業差分（{summary}）が検出され、docs/ のプラン正本（{', '.join(os.path.basename(path) for path in plans)}）には同じターンの更新が確認されませんでした。"
    if lattice_store_is_canonical(root):
        guidance = "この差分がLattice工程のToDoに属するなら進捗・完了証拠をLattice storeへ記録し、Markdown planの統括レーンに属するならそのplanへ進捗を反映してください。無関係な通常レーンなら更新不要です"
    else:
        guidance = "この差分が当該planに属する統括レーンなら進捗を反映し、無関係な通常レーンなら更新不要です"
    message = prefix + guidance + "。この情報は依頼範囲を広げません。"
    safe_write(os.path.join(STATE_DIR, f"{key}.codex-pending"), message + "\n")


def main():
    raw = sys.stdin.read()
    if len(sys.argv) != 2 or sys.argv[1] not in ("session-start", "pre-tool-use", "user-prompt-submit", "stop"):
        return
    cmd = sys.argv[1]

    # fast-path: pre-tool-use は matcher が無く全ツールで発火するため、
    # JSON をパースする前に対象外ツールを軽量な文字列判定で弾く（150-300ms 税対策）。
    if cmd == "pre-tool-use" and "update_plan" not in raw and "spawn_agent" not in raw:
        return

    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
    except Exception:
        error_log("codex-callout-hook")
        return

    try:
        if cmd == "session-start":
            session_start(data)
        elif cmd == "pre-tool-use":
            pre_tool_use(data)
        elif cmd == "user-prompt-submit":
            user_prompt_submit(data)
        elif cmd == "stop":
            stop(data)
    except Exception:
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        error_log("codex-callout-hook")
