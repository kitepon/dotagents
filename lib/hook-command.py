"""POSIX 直書きと Windows の interpreter + 引用付き絶対 path を同一 hook command として照合する。"""

from __future__ import annotations

import os
import shlex
from pathlib import Path


def _basename(token: str) -> str:
    """Windows形（backslash区切り）とPOSIX形のbasenameを、実行hostのOSに依らず同じ規則で取る。

    POSIX hostのPath()はbackslashを区切りに数えないため、Windows絶対pathの
    interpreter/script名がhost依存で取れず、wsl2/linux/macOS laneのCIが
    Windows引用commandの照合に失敗していた（2026-08-24実被弾）。
    """
    return token.replace("\\", "/").rsplit("/", 1)[-1]


def hook_script(command: str, home: Path):
    try:
        parts = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return None
    if os.name == "nt":
        parts = [
            part[1:-1]
            if len(part) >= 2 and part[0] == part[-1] and part[0] in {"'", '"'}
            else part
            for part in parts
        ]
    interpreters = {
        "python.exe", "python3.exe", "python", "python3",
        "sh.exe", "bash.exe", "sh", "bash", "cmd.exe",
    }
    while parts:
        first = _basename(parts[0]).lower()
        if first in interpreters:
            parts = parts[1:]
            continue
        if parts[0] in {"/usr/bin/env", "env"} and len(parts) > 1:
            parts = parts[2:]
            continue
        break
    if not parts:
        return None
    script = parts[0]
    if script.startswith("~/"):
        script = str(home) + script[1:]
    return Path(script).expanduser().resolve(strict=False), tuple(parts[1:])


def command_matches(command: str, required_command: str, home: Path) -> bool:
    if required_command in command:
        return True
    parsed = hook_script(command, home)
    if parsed is None:
        return False
    script, args = parsed
    tokens = required_command.split()
    name, rest = tokens[0], tuple(tokens[1:])
    script_name = _basename(str(script))
    script_stem = script_name.rsplit(".", 1)[0] if "." in script_name else script_name
    if name not in {script_name, script_stem}:
        return False
    return args[: len(rest)] == rest
