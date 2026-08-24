#!/usr/bin/env python3
# 前提: Fable級統括が設計・Opus/Sol級の親が日常実行（2026-07 時点）。判定の正は docs/02_models.md
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib" / "orchestrate"))
from hook_state import safe_append, safe_exists, safe_touch, safe_unlink, state_dir, writer_release, writer_reservations, writer_reserve

STATE_DIR = state_dir()


def error_log(name):
    try:
        safe_append(os.path.join(STATE_DIR, "errors.log"), f"{datetime.datetime.now().isoformat()} {name} parse-fail\n")
    except Exception:
        pass


def gc():
    try:
        cutoff = datetime.datetime.now().timestamp() - 7 * 24 * 60 * 60
        for entry in os.scandir(STATE_DIR):
            if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                safe_unlink(entry.path)
    except Exception:
        pass


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def session_key(session_id):
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def hook_host():
    return os.environ.get("DOTAGENTS_HOOK_HOST", "claude")


def deny(code, missing, example):
    message = f"{code}: {missing}\n正しい呼び方: {example}\n正典: shared/orchestrate/delegation-contract.md"
    if hook_host() == "cursor":
        emit({"permission": "deny", "user_message": message, "agent_message": message})
        return
    if hook_host() == "grok":
        emit({"decision": "deny", "reason": message})
        return
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": message}})


def info_failure(reason):
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": f"INFO: delegation gate内部障害のため今回の判定を縮退しました（{reason}）。正当な作業は止めません。"}})


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def concrete_value(value):
    if not isinstance(value, str):
        return False
    value = value.strip().strip("'\"")
    return bool(value) and value.casefold() != "inherit" and not any(token in value for token in ("$", "{", "}"))


def effective_cwd(data, tool_input):
    value = tool_input.get("workspaceRoot") or tool_input.get("cwd") or data.get("cwd") or os.getcwd()
    if not nonempty(value):
        raise ValueError("cwd is unavailable")
    return Path(value).expanduser().resolve()


def sidecar_defaults_exist(cwd):
    current = cwd
    while True:
        path = current / ".codex-sidecar.yml"
        if path.is_file():
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                return False
            in_defaults, model, effort = False, None, None
            for line in lines:
                if re.match(r"^defaults\s*:\s*(?:#.*)?$", line):
                    in_defaults = True
                    continue
                if in_defaults and line and not line[0].isspace() and not line.lstrip().startswith("#"):
                    in_defaults = False
                if not in_defaults:
                    continue
                matched = re.match(r"^\s+(model|model_reasoning_effort)\s*:\s*([^#\s][^#]*?)\s*$", line)
                if matched:
                    value = matched.group(2).strip().strip("'\"")
                    if matched.group(1) == "model":
                        model = value
                    else:
                        effort = value
            return concrete_value(model) and concrete_value(effort)
        if current.parent == current:
            return False
        current = current.parent


def agent_definition_has_model(tool_input):
    subagent_type = tool_input.get("subagent_type")
    if not nonempty(subagent_type) or "/" in subagent_type or "\\" in subagent_type:
        return False
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if nonempty(project):
        if (Path(project).expanduser() / ".claude" / "agents").is_dir():
            return False
    path = Path.home() / ".claude" / "agents" / f"{subagent_type}.md"
    if not path.is_file():
        return False
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    if not lines or lines[0].strip() != "---":
        return False
    for line in lines[1:]:
        if line.strip() == "---":
            break
        matched = re.match(r"^\s*model\s*:\s*(.*?)\s*$", line)
        if matched:
            return concrete_value(matched.group(1))
    return False


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
    dispatch = data.get("conversation_id") or data.get("session_id") if hook_host() == "cursor" else data.get("sessionId") if hook_host() == "grok" else data.get("session_id", "unknown")
    return {"common_dir": common_dir(cwd), "tool": tool_name, "session_hint": str(hint), "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "dispatch_id": dispatch}


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


def handle_release(argv):
    common = None
    if "--common-dir" in argv and "--release" not in argv:
        return 2
    if "--common-dir" in argv:
        index = argv.index("--common-dir")
        if index + 1 >= len(argv):
            return 2
        common = argv[index + 1] if argv[index + 1] == "unidentified-repo" else str(Path(argv[index + 1]).expanduser().resolve())
    elif "--list" not in argv:
        return 2
    if "--list" in argv:
        records = writer_reservations()
        if records is None:
            return 1
        emit({"writer_reservations": records})
    if common is not None:
        if not writer_release(common):
            return 1
        emit({"released_common_dir": common})
    return 0


def main():
    if len(sys.argv) > 1:
        raise SystemExit(handle_release(sys.argv[1:]))
    raw = sys.stdin.read()
    if os.environ.get("DOTAGENTS_PLACEMENT_GATE") == "off":
        return
    try:
        data = json.loads(raw)
        if hook_host() == "cursor":
            session_id = data.get("session_id") or data.get("conversation_id")
            if data.get("hook_event_name") == "subagentStart" or "subagent_type" in data:
                tool_name = "Task"
                tool_input = {
                    "model": data.get("subagent_model"),
                    "subagent_type": data.get("subagent_type"),
                }
            else:
                tool_name = data.get("tool_name")
                tool_input = data.get("tool_input")
                if isinstance(tool_input, str):
                    try:
                        tool_input = json.loads(tool_input)
                    except json.JSONDecodeError:
                        tool_input = None
            if data.get("hook_event_name") not in {"preToolUse", "subagentStart"} and "subagent_type" not in data:
                raise ValueError
        elif hook_host() == "grok":
            session_id = data.get("sessionId")
            tool_name = data.get("toolName")
            tool_input = data.get("toolInput")
        else:
            session_id = data["session_id"]
            tool_name = data["tool_name"]
            tool_input = data["tool_input"]
        if not isinstance(session_id, str) or not isinstance(tool_name, str) or not isinstance(tool_input, dict):
            raise ValueError
    except Exception:
        error_log("delegation-gate-hook")
        return

    try:
        model = tool_input.get("model")
        effort_values = [tool_input.get(key) for key in ("reasoning_effort", "effort", "modelReasoningEffort")]
        effort = next((value for value in effort_values if value is not None), None)
        sidecar_writers = {
            "mcp__codex-sidecar__codex_work",
            "mcp__codex-sidecar__codex_work_start",
            "mcp__codex-sidecar__codex_generate",
            "codex-sidecar__codex_work",
            "codex-sidecar__codex_work_start",
            "codex-sidecar__codex_generate",
        }
        aiterm_codex = tool_name in {"mcp__aiterm__codex_agent", "aiterm__codex_agent"}
        spawn = tool_name in {"Agent", "Task", "spawn_subagent"}
        cwd = None
        if aiterm_codex:
            if not (concrete_value(model) and concrete_value(tool_input.get("reasoning_effort"))):
                deny("P10_MODEL_EFFORT_MISSING", "codex_agent に model と reasoning_effort が必要です", "model と reasoning_effort を両方指定した mcp__aiterm__codex_agent")
                return
        elif tool_name in sidecar_writers:
            cwd = effective_cwd(data, tool_input)
            if not (concrete_value(model) and concrete_value(tool_input.get("modelReasoningEffort"))) and not sidecar_defaults_exist(cwd):
                deny("P10_MODEL_EFFORT_MISSING", "sidecar の model/effort または repo defaults がありません", "model/effort を指定するか .codex-sidecar.yml のある repo から呼ぶ")
                return
        elif spawn and not (concrete_value(model) or agent_definition_has_model(tool_input)):
            deny("P10_MODEL_EFFORT_MISSING", "Agent/Task の model が未指定で、role定義にも model がありません", "model を指定するか model 固定の subagent_type を使う")
            return

        if aiterm_codex or tool_name in sidecar_writers:
            declaration = scope_declaration(tool_input)
            if declaration == "missing":
                deny("P9_SCOPE_DECL_MISSING", "scope 宣言トークンがありません", "prompt/input に [scope:read-only] または [scope:write] を一つだけ入れる")
                return
            if declaration == "ambiguous":
                deny("P9_SCOPE_DECL_AMBIGUOUS", "read-only と write のscope宣言が混在しています", "prompt/input に [scope:read-only] または [scope:write] を一つだけ入れる")
                return
            if declaration == "write":
                cwd = cwd or effective_cwd(data, tool_input)
                if reserve_writer(data, tool_name, tool_input, cwd) == "denied":
                    return
        warn_path = os.path.join(STATE_DIR, f"{session_key(session_id)}.placement-warn")
        if not safe_exists(warn_path) and safe_touch(warn_path):
            gc()
            shown_model = str(model) if model not in (None, "") else "省略"
            shown_effort = str(effort) if effort not in (None, "") else "未指定"
            message = f"INFO: このセッションで最初の委譲を検出しました（{tool_name}: model={shown_model}, effort={shown_effort}）。配置・委譲契約・モデル選択の基準は、グローバル CLAUDE.md / AGENTS.md「作業レーンと統制」および docs/02_models.md を参照。このINFO自体は追加の委譲や依頼範囲の拡張を要求しません。"
            emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": message}})
    except Exception as exc:
        error_log("delegation-gate-hook")
        info_failure(str(exc))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        error_log("delegation-gate-hook")
