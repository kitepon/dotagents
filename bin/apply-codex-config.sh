#!/usr/bin/env python3
"""Codex routingとdotagents所有hookを安全に適用する。"""

from __future__ import annotations

import argparse
import copy
import difflib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


ROUTING_SECTION = "features.multi_agent_v2"
ROUTING_VALUES = {
    "hide_spawn_agent_metadata": "false",
    "tool_namespace": '"agents"',
}
HOOKS = {
    "SessionStart": ("session-start", 10),
    "PreToolUse": ("pre-tool-use", 5),
    "UserPromptSubmit": ("user-prompt-submit", 5),
    "Stop": ("stop", 10),
}
ADVISORY_HOOK = ("SessionStart", 5)
GIT_DESTROY_HOOK = ("PreToolUse", 5)
LATTICE_HOOK = ("SessionStart", "session-start", 6)
LATTICE_USER_PROMPT_HOOK = ("UserPromptSubmit", "user-prompt-submit", 5)
PYTHON_HOOK_PREFIX = (
    (str(Path(sys.executable).resolve()),)
    if os.name == "nt"
    else ("/usr/bin/env", "python3")
)
SHELL_HOOK_PREFIX = (
    (str((Path(os.environ["ProgramFiles"]) / "Git/bin/bash.exe").resolve()),)
    if os.name == "nt"
    else ("/bin/sh",)
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Codex routing、deprecated hook flag、dotagents hookを差分適用する。"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="差分を表示する（既定）")
    group.add_argument("--apply", action="store_true", help="backup 後に差分を適用する")
    return parser.parse_args()


def validate_toml(text: str, path: Path) -> None:
    """Codex 本体の TOML parser で全体を検証する。"""
    codex = shutil.which("codex")
    if not codex:
        raise ValueError("codex CLI 不在のため TOML を完全検証できません")
    with tempfile.TemporaryDirectory(prefix="dotagents-toml-") as directory:
        config = Path(directory) / "config.toml"
        config.write_text(text, encoding="utf-8")
        try:
            result = subprocess.run(
                [codex, "debug", "prompt-input"],
                env={**os.environ, "HOME": directory, "CODEX_HOME": directory},
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError(f"{path}: Codex TOML parser が timeout") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit {result.returncode}"
        raise ValueError(f"{path}: TOML パース失敗: {detail}")


def update_routing(text: str) -> str:
    header = f"[{ROUTING_SECTION}]"
    header_match = re.search(rf"(?m)^{re.escape(header)}(?:[ \t]+#.*)?[ \t]*$", text)
    if not header_match:
        suffix = "" if not text or text.endswith("\n") else "\n"
        return text + suffix + f"{header}\n" + "\n".join(
            f"{key} = {value}" for key, value in ROUTING_VALUES.items()
        ) + "\n"

    start = header_match.end()
    next_header = re.search(r"(?m)^\[", text[start:])
    end = start + next_header.start() if next_header else len(text)
    section = text[start:end]
    for key, value in ROUTING_VALUES.items():
        pattern = re.compile(rf"(?m)^(\s*{re.escape(key)}\s*=\s*)(.*?)(\s+#.*)?$")
        match = pattern.search(section)
        if match:
            section = section[: match.start()] + f"{match.group(1)}{value}{match.group(3) or ''}" + section[match.end() :]
        else:
            prefix = "" if not section or section.endswith("\n") else "\n"
            section += f"{prefix}{key} = {value}\n"
    return text[:start] + section + text[end:]


def migrate_deprecated_hooks_flag(text: str) -> str:
    """[features].codex_hooksを現行hooksへ移行し、警告の再発を止める。"""
    header_match = re.search(r"(?m)^\[features\](?:[ \t]+#.*)?[ \t]*$", text)
    if not header_match:
        return text
    start = header_match.end()
    next_header = re.search(r"(?m)^\[", text[start:])
    end = start + next_header.start() if next_header else len(text)
    section = text[start:end]
    legacy = re.compile(
        r"^(?P<indent>[ \t]*)codex_hooks(?P<assignment>[ \t]*=[ \t]*)"
        r"(?P<value>true|false)(?P<comment>[ \t]*(?:#.*)?)(?P<newline>\r?\n)?$"
    )
    modern = re.compile(r"^[ \t]*hooks[ \t]*=", re.MULTILINE)
    if not any(legacy.match(line) for line in section.splitlines(keepends=True)):
        return text
    migrated = []
    modern_exists = modern.search(section) is not None
    for line in section.splitlines(keepends=True):
        match = legacy.match(line)
        if not match:
            migrated.append(line)
        elif not modern_exists:
            migrated.append(
                f"{match.group('indent')}hooks{match.group('assignment')}"
                f"{match.group('value')}{match.group('comment')}{match.group('newline') or ''}"
            )
            modern_exists = True
    return text[:start] + "".join(migrated) + text[end:]


def load_hooks(text: str, path: Path) -> dict:
    if not text:
        return {"hooks": {}}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: JSON パース失敗: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
        raise ValueError(f"{path}: top-level hooks object が必要")
    if "hooks" not in data:
        data["hooks"] = {}
    return data


def command_parts(command: object) -> list[str] | None:
    if not isinstance(command, str):
        return None
    try:
        parts = shlex.split(command, posix=os.name != "nt")
        if os.name == "nt":
            parts = [
                part[1:-1]
                if len(part) >= 2 and part[0] == part[-1] and part[0] in ("'", '"')
                else part
                for part in parts
            ]
            if parts[:1] == ["&"]:
                parts = parts[1:]
            return parts
        return parts
    except ValueError:
        return None


def resolved_command_path(value: str, home: Path) -> Path:
    if value == "~" or value.startswith("~/"):
        value = str(home) + value[1:]
    return Path(value).expanduser().resolve(strict=False)


def is_script_command(
    command: object,
    hook_path: Path,
    arguments: tuple[str, ...],
    home: Path,
    interpreter_prefix: tuple[str, ...],
) -> bool:
    parts = command_parts(command)
    if parts is None:
        return False
    legacy = [str(hook_path), *arguments]
    canonical = [*interpreter_prefix, str(hook_path), *arguments]
    for candidate in (legacy, canonical):
        if len(parts) == len(candidate) and parts[1:] == candidate[1:]:
            if resolved_command_path(parts[0], home) == resolved_command_path(candidate[0], home):
                return True
        if interpreter_prefix and len(parts) == len(canonical) and parts[: len(interpreter_prefix)] == list(interpreter_prefix):
            script_index = len(interpreter_prefix)
            if (parts[script_index + 1:] == list(arguments)
                    and resolved_command_path(parts[script_index], home) == hook_path.resolve(strict=False)):
                return True
    # interpreter が違っても同一 hook script なら同一 entry。
    # 死んだ Python313 path が残ると PreToolUse が毎回 code 1 になる。
    hook_resolved = hook_path.resolve(strict=False)
    for index, part in enumerate(parts):
        if resolved_command_path(part, home) != hook_resolved:
            continue
        if parts[index + 1:] == list(arguments):
            return True
    return False


def render_hook_command(parts: list[str]) -> str:
    if os.name == "nt":
        if any('"' in part for part in parts):
            raise ValueError("Windows hook command token に quote は使用できません")
        # Codex は hook を現在の turn shell で実行する。Windows の PowerShell では
        # quoted executable を command として呼ぶため先頭の call operator が必要。
        return "& " + " ".join(f'"{part}"' for part in parts)
    return shlex.join(parts)


def python_hook_command(hook_path: Path, *arguments: str) -> str:
    return render_hook_command([*PYTHON_HOOK_PREFIX, str(hook_path), *arguments])


def shell_hook_command(hook_path: Path, *arguments: str) -> str:
    return render_hook_command([*SHELL_HOOK_PREFIX, str(hook_path), *arguments])


def is_callout_command(command: object, hook_path: Path, subcommand: str, home: Path) -> bool:
    return is_script_command(command, hook_path, (subcommand,), home, PYTHON_HOOK_PREFIX)


def is_python_hook_command(command: object, hook_path: Path, home: Path) -> bool:
    return is_script_command(command, hook_path, (), home, PYTHON_HOOK_PREFIX)


def is_advisory_command(command: object, hook_path: Path, home: Path) -> bool:
    return is_script_command(command, hook_path, (), home, SHELL_HOOK_PREFIX)


def update_hooks(data: dict, home: Path) -> dict:
    hook_path = home / ".local/bin/codex-callout-hook"
    for event, (subcommand, timeout) in HOOKS.items():
        entries = data["hooks"].setdefault(event, [])
        if not isinstance(entries, list):
            raise ValueError(f"hooks.{event} は配列である必要がある")
        canonical = {
            "type": "command",
            "command": python_hook_command(hook_path, subcommand),
            "timeout": timeout,
            "async": False,
            "statusMessage": None,
        }
        normalized = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                normalized.append(entry)
                continue
            hooks = []
            for hook in entry["hooks"]:
                if isinstance(hook, dict) and is_callout_command(hook.get("command"), hook_path, subcommand, home):
                    continue
                hooks.append(hook)
            if hooks:
                copied = dict(entry)
                copied["hooks"] = hooks
                normalized.append(copied)
            elif set(entry) != {"hooks"}:
                copied = dict(entry)
                copied["hooks"] = []
                normalized.append(copied)
        normalized.append({"hooks": [canonical]})
        data["hooks"][event] = normalized
    event, timeout = ADVISORY_HOOK
    hook_path = home / ".local/bin/orchestrate-advisory-hook"
    entries = data["hooks"].setdefault(event, [])
    if not isinstance(entries, list):
        raise ValueError(f"hooks.{event} は配列である必要がある")
    canonical = {
        "type": "command",
        "command": shell_hook_command(hook_path),
        "timeout": timeout,
        "async": False,
        "statusMessage": None,
    }
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            normalized.append(entry)
            continue
        hooks = [hook for hook in entry["hooks"] if not (isinstance(hook, dict) and is_advisory_command(hook.get("command"), hook_path, home))]
        if hooks:
            copied = dict(entry)
            copied["hooks"] = hooks
            normalized.append(copied)
        elif set(entry) != {"hooks"}:
            copied = dict(entry)
            copied["hooks"] = []
            normalized.append(copied)
    normalized.append({"hooks": [canonical]})
    data["hooks"][event] = normalized

    event, timeout = GIT_DESTROY_HOOK
    hook_path = home / ".local/bin/codex-git-destroy-gate-hook"
    entries = data["hooks"].setdefault(event, [])
    if not isinstance(entries, list):
        raise ValueError(f"hooks.{event} は配列である必要がある")
    canonical = {
        "type": "command",
        "command": python_hook_command(hook_path),
        "timeout": timeout,
        "async": False,
        "statusMessage": None,
    }
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            normalized.append(entry)
            continue
        hooks = [hook for hook in entry["hooks"] if not (isinstance(hook, dict) and is_python_hook_command(hook.get("command"), hook_path, home))]
        if hooks:
            copied = dict(entry)
            copied["hooks"] = hooks
            normalized.append(copied)
        elif set(entry) != {"hooks"}:
            copied = dict(entry)
            copied["hooks"] = []
            normalized.append(copied)
    normalized.append({"hooks": [canonical]})
    data["hooks"][event] = normalized

    event, subcommand, timeout = LATTICE_HOOK
    hook_path = home / ".local/bin/codex-lattice-gantt-hook"
    entries = data["hooks"].setdefault(event, [])
    if not isinstance(entries, list):
        raise ValueError(f"hooks.{event} は配列である必要がある")
    canonical = {
        "type": "command",
        "command": python_hook_command(hook_path, subcommand),
        "timeout": timeout,
        "async": False,
        "statusMessage": None,
    }
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            normalized.append(entry)
            continue
        hooks = [
            hook
            for hook in entry["hooks"]
            if not (
                isinstance(hook, dict)
                and is_callout_command(hook.get("command"), hook_path, subcommand, home)
            )
        ]
        if hooks:
            copied = dict(entry)
            copied["hooks"] = hooks
            normalized.append(copied)
        elif set(entry) != {"hooks"}:
            copied = dict(entry)
            copied["hooks"] = []
            normalized.append(copied)
    normalized.append({"hooks": [canonical]})
    data["hooks"][event] = normalized

    event, subcommand, timeout = LATTICE_USER_PROMPT_HOOK
    entries = data["hooks"].setdefault(event, [])
    if not isinstance(entries, list):
        raise ValueError(f"hooks.{event} は配列である必要がある")
    canonical = {
        "type": "command",
        "command": python_hook_command(hook_path, subcommand),
        "timeout": timeout,
        "async": False,
        "statusMessage": None,
    }
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            normalized.append(entry)
            continue
        hooks = [
            hook for hook in entry["hooks"]
            if not (isinstance(hook, dict) and is_callout_command(hook.get("command"), hook_path, subcommand, home))
        ]
        if hooks:
            copied = dict(entry)
            copied["hooks"] = hooks
            normalized.append(copied)
        elif set(entry) != {"hooks"}:
            copied = dict(entry)
            copied["hooks"] = []
            normalized.append(copied)
    normalized.append({"hooks": [canonical]})
    data["hooks"][event] = normalized
    return data


def render_hooks(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"

def environment_path(value: str) -> Path:
    if os.name == "nt" and value.startswith("/"):
        converted = subprocess.run(
            ["cygpath", "-w", value],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()
        return Path(converted).resolve()
    return Path(value).expanduser().resolve()


def diff(path: Path, before: str, after: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=str(path),
            tofile=str(path),
        )
    )


def backup(home: Path, originals: dict[Path, str]) -> Path:
    archive_dir = home / "Archives"
    archive_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(archive_dir, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = archive_dir / f"dotagents-codex-config-{stamp}.tar.gz"
    suffix = 1
    while archive.exists():
        archive = archive_dir / f"dotagents-codex-config-{stamp}-{suffix}.tar.gz"
        suffix += 1
    with tarfile.open(archive, "w:gz") as tar:
        for path, content in originals.items():
            if path.exists():
                try:
                    member_name = str(path.relative_to(home))
                except ValueError:
                    member_name = f"external-codex-home/{path.name}"
                info = tarfile.TarInfo(member_name)
                encoded = content.encode("utf-8")
                info.size = len(encoded)
                info.mode = 0o600
                tar.addfile(info, fileobj=__import__("io").BytesIO(encoded))
    os.chmod(archive, 0o600)
    return archive


def prepare_write(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        return temporary
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def apply_transaction(changed: dict[Path, str], originals: dict[Path, str], existed: dict[Path, bool]) -> None:
    prepared = {}
    replaced = []
    try:
        for path, text in changed.items():
            prepared[path] = prepare_write(path, text)
        for path in changed:
            if os.environ.get("DOTAGENTS_TEST_FAIL_REPLACE") == path.name:
                raise OSError(f"test injection: {path.name} replace failure")
            os.replace(prepared[path], path)
            replaced.append(path)
    except BaseException as exc:
        rollback_errors = []
        for path in reversed(replaced):
            try:
                if existed[path]:
                    os.replace(prepare_write(path, originals[path]), path)
                else:
                    path.unlink(missing_ok=True)
            except BaseException as rollback_exc:
                rollback_errors.append(f"{path}: {rollback_exc}")
        if rollback_errors:
            raise OSError(f"適用失敗: {exc}; rollback 失敗: {'; '.join(rollback_errors)}") from exc
        raise OSError(f"適用失敗、rollback 済み: {exc}") from exc
    finally:
        for temporary in prepared.values():
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def main() -> int:
    args = parse_args()
    home = environment_path(os.environ.get("HOME", str(Path.home())))
    codex_home = environment_path(os.environ.get("CODEX_HOME", str(home / ".codex")))
    config_path = codex_home / "config.toml"
    hooks_path = codex_home / "hooks.json"
    if config_path.is_symlink() or hooks_path.is_symlink():
        raise ValueError("config.toml と hooks.json は symlink では適用できません")
    existed = {config_path: config_path.exists(), hooks_path: hooks_path.exists()}
    originals = {
        config_path: config_path.read_text(encoding="utf-8") if existed[config_path] else "",
        hooks_path: hooks_path.read_text(encoding="utf-8") if existed[hooks_path] else "",
    }

    validate_toml(originals[config_path], config_path)
    hooks = load_hooks(originals[hooks_path], hooks_path)
    original_hooks = copy.deepcopy(hooks)
    updated_hooks = update_hooks(hooks, home)
    proposed = {
        config_path: update_routing(migrate_deprecated_hooks_flag(originals[config_path])),
        hooks_path: originals[hooks_path] if updated_hooks == original_hooks else render_hooks(updated_hooks),
    }
    validate_toml(proposed[config_path], config_path)
    load_hooks(proposed[hooks_path], hooks_path)
    changed = {path: text for path, text in proposed.items() if text != originals[path]}

    if not args.apply:
        for path in (config_path, hooks_path):
            if path in changed:
                sys.stdout.write(diff(path, originals[path], changed[path]))
        return 0
    if not changed:
        print("apply-codex-config: 変更なし")
        return 0

    archive = backup(home, originals)
    apply_transaction(changed, originals, existed)
    print(f"apply-codex-config: 適用完了（backup: {archive}）")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
