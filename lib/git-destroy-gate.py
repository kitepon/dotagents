"""未commit差分を暗黙に破壊するgit形だけをPreToolUseで拒否する。"""

import json
import os
import shlex
import subprocess
import sys


SHELL_TOOLS = {
    "Bash",
    "bash",
    "Shell",
    "shell",
    "shell_command",
    "functions.shell_command",
    "run_terminal_command",
}


def emit_deny(frontend, target):
    message = (
        f"P12_UNCOMMITTED_DESTROY: 未commit差分があるため {target} を実行できません。\n"
        "正しい手順: stash push または diff のpatch保存で退避してから再実行してください。\n"
        "正典: グローバル AGENTS.md「git・shell・ファイルの作法」"
    )
    if frontend == "cursor":
        payload = {"permission": "deny", "user_message": message, "agent_message": message}
    elif frontend in {"codex", "grok"}:
        payload = {"decision": "deny", "reason": message}
    else:
        payload = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message,
            }
        }
    sys.stdout.buffer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))


def shell_segments(command):
    """引用内の区切りを壊さず、単純な複合shell commandだけを分割する。"""
    segments, current, quote, escaped, index = [], [], None, False, 0
    while index < len(command):
        character = command[index]
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\" and quote != "'":
            current.append(character)
            escaped = True
        elif character in "'\"":
            current.append(character)
            quote = None if quote == character else (character if quote is None else quote)
        elif quote is None and character in ";\n":
            segments.append("".join(current))
            current = []
        elif quote is None and command[index:index + 2] in {"&&", "||"}:
            segments.append("".join(current))
            current = []
            index += 1
        else:
            current.append(character)
        index += 1
    if quote is not None or escaped:
        return []
    segments.append("".join(current))
    return segments


def git_tokens(segment):
    try:
        tokens = shlex.split(segment, posix=True)
    except ValueError:
        return None
    if not tokens or os.path.basename(tokens[0]).lower() not in {"git", "git.exe"}:
        return None
    return tokens[1:]


def checkout_target(arguments):
    if not arguments or arguments[0] != "checkout":
        return None
    values = arguments[1:]
    if "--" in values:
        position = values.index("--")
        return values[position + 1:] or None
    if any(value in {".", "./"} or value.startswith("./") for value in values):
        return None
    return False


def destroy_target(arguments):
    if not arguments:
        return False
    subcommand, values = arguments[0], arguments[1:]
    if subcommand == "checkout":
        return checkout_target(arguments)
    if subcommand == "restore":
        if "--staged" in values and "--worktree" not in values:
            return False
        if "--" in values:
            position = values.index("--")
            return values[position + 1:] or None
        return None
    if subcommand == "clean" and any(value == "--force" or value.startswith("-") and not value.startswith("--") and "f" in value[1:] for value in values):
        return None
    if subcommand == "reset" and any(value == "--hard" or value.startswith("--hard=") for value in values):
        return None
    if subcommand == "stash" and values[:1] in (["drop"], ["clear"]):
        return None
    return False


def detected_targets(command):
    if not isinstance(command, str) or not command.strip():
        return []
    targets = []
    for segment in shell_segments(command):
        arguments = git_tokens(segment.strip())
        if arguments is None:
            continue
        target = destroy_target(arguments)
        if target is not False:
            targets.append(target)
    return targets


def has_changes(cwd, target):
    if not isinstance(cwd, str) or not cwd:
        return False
    command = ["git", "-C", cwd, "status", "--porcelain"]
    if target:
        command.extend(["--", *target])
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and bool(result.stdout.strip())


def cursor_shell_command(data):
    event = data.get("hook_event_name")
    if event == "beforeShellExecution":
        command = data.get("command")
        cwd = data.get("cwd")
        return command, cwd
    if event == "preToolUse" and data.get("tool_name") in SHELL_TOOLS:
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, dict):
            return None, None
        command = tool_input.get("command")
        cwd = tool_input.get("working_directory") or tool_input.get("cwd") or data.get("cwd")
        return command, cwd
    return None, None


def main(frontend):
    if frontend not in {"claude", "codex", "grok", "cursor"} or os.environ.get("DOTAGENTS_GIT_DESTROY_GATE") == "off":
        return
    try:
        data = json.loads(sys.stdin.read())
        if not isinstance(data, dict):
            return
        cwd = None
        if frontend == "cursor":
            command, cwd = cursor_shell_command(data)
            if not isinstance(command, str):
                return
            tool_input = {"command": command, "cwd": cwd}
            tool_name = "Shell"
        elif frontend == "grok":
            tool_name = data.get("toolName")
            tool_input = data.get("toolInput")
        else:
            tool_name = data.get("tool_name")
            tool_input = data.get("tool_input")
        if tool_name not in SHELL_TOOLS or not isinstance(tool_input, dict):
            return
        targets = detected_targets(tool_input.get("command"))
        if not targets:
            return
        cwd = tool_input.get("cwd") or data.get("cwd") or cwd
        for target in targets:
            if has_changes(cwd, target):
                emit_deny(frontend, "対象pathspec" if target else "worktree全体")
                return
    except Exception:
        return
