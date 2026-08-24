#!/usr/bin/env python3
"""Grok config の工場所有面を差分適用する。model / login / permission は触らない。"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import re
import shlex
import shutil
import stat
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


SECTION = "compat.claude"
COMPAT_FALSE_KEYS = ("agents", "hooks")
VALUE = "false"

FACTORY_SERVERS = (
    ("aiterm", {"command": "aiterm-mcp"}),
    ("caveat", {"command": "caveat", "args": ("mcp-server",)}),
    ("lattice", {"command": "lattice-mcp"}),
    ("codex-sidecar", {"command": "codex-sidecar-mcp"}),
    ("gpt_connector", {"command": "gpt-connector-mcp"}),
    ("aishell", {"command": "aishell-mcp", "env": {"AISHELL_CAPABILITY_SET": "expanded-v1"}}),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Grok の工場MCPと compat.claude.agents/hooks、Windows 工場hook command を差分適用する。")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="差分を表示する（既定）")
    group.add_argument("--apply", action="store_true", help="backup 後に差分を適用する")
    return parser.parse_args()


def grok_home(home: Path) -> Path:
    raw = os.environ.get("GROK_HOME")
    if raw:
        return Path(raw).expanduser().resolve()
    return (home / ".grok").resolve()


def normalize_toml(text: str) -> str:
    body = text.replace("\r\n", "\n")
    if body and not body.endswith("\n"):
        return f"{body}\n"
    return body


def set_compat_claude_false(text: str, key: str) -> str:
    body = normalize_toml(text)
    header = re.compile(r"^[ \t]*\[compat\.claude\][ \t]*(?:#.*)?$")
    next_header = re.compile(r"^[ \t]*\[")
    key_line = re.compile(rf"^([ \t]*{re.escape(key)}[ \t]*=[ \t]*)(.*?)([ \t]*(?:#.*)?)?$")
    lines = body.splitlines(keepends=True)
    start = None
    for index, line in enumerate(lines):
        if header.match(line.rstrip("\n")):
            start = index
            break
    if start is None:
        prefix = "" if not body.strip() else "\n"
        return f"{body}{prefix}[{SECTION}]\n{key} = {VALUE}\n"
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if next_header.match(lines[index]) and not header.match(lines[index].rstrip("\n")):
            end = index
            break
    for index in range(start + 1, end):
        match = key_line.match(lines[index].rstrip("\n"))
        if match is None:
            continue
        comment = match.group(3) or ""
        lines[index] = f"{match.group(1)}{VALUE}{comment}\n"
        return "".join(lines)
    insert_at = start + 1
    while insert_at < end and lines[insert_at].strip() == "":
        insert_at += 1
    lines.insert(insert_at, f"{key} = {VALUE}\n")
    return "".join(lines)


WINDOWS_COMMAND_SUFFIXES = {".exe", ".cmd", ".bat", ".com"}


def toml_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def toml_unquote(value: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value) and value[index + 1] in {"\\", '"'}:
            out.append(value[index + 1])
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def command_name_matches(path: Path, logical_name: str) -> bool:
    if path.name == logical_name:
        return True
    if os.name != "nt":
        return False
    return path.stem.lower() == logical_name.lower() and path.suffix.lower() in WINDOWS_COMMAND_SUFFIXES


def realized_command(name: str) -> str:
    found = shutil.which(name)
    if not found:
        return name
    return str(Path(found))


def existing_command(body: str) -> str | None:
    match = re.search(r'^[ \t]*command[ \t]*=[ \t]*"((?:\\.|[^"\\])*)"[ \t]*(?:#.*)?$', body, re.M)
    if match is None:
        return None
    return toml_unquote(match.group(1))


def usable_absolute_command(command: str, name: str) -> bool:
    path = Path(command)
    if not path.is_absolute() or not command_name_matches(path, name) or not path.is_file():
        return False
    if os.name == "nt":
        return True
    return os.access(path, os.X_OK)


def command_to_write(spec: dict, existing_body: str | None = None) -> str:
    name = spec["command"]
    realized = realized_command(name)
    if realized != name:
        return realized
    if existing_body:
        current = existing_command(existing_body)
        if current and usable_absolute_command(current, name):
            return current
    return name


def command_satisfies_contract(body: str, spec: dict) -> bool:
    current = existing_command(body)
    if current is None:
        return False
    name = spec["command"]
    if current == name:
        return shutil.which(name) is None
    return usable_absolute_command(current, name)


def windows_node_dir() -> str | None:
    home_local = Path.home() / "AppData" / "Local"
    candidates = (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "nodejs" / "node.exe",
        Path(os.environ.get("LOCALAPPDATA", str(home_local))) / "Programs" / "nodejs" / "node.exe",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.parent)
    return None


def default_gui_path_dirs() -> list[str]:
    if os.name == "nt":
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        local_app_data = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
        dirs = [
            str(windir / "System32"),
            str(windir),
            str(windir / "System32" / "Wbem"),
            str(program_files / "PowerShell" / "7"),
            str(local_app_data / "Microsoft" / "WindowsApps"),
        ]
        node_dir = windows_node_dir()
        if node_dir and node_dir not in dirs:
            dirs.insert(0, node_dir)
        return dirs
    return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]


def mcp_env(spec: dict, command: str) -> dict[str, str]:
    env = dict(spec.get("env") or {})
    path_dirs = default_gui_path_dirs()
    command_path = Path(command)
    if command_path.is_absolute():
        bindir = str(command_path.parent)
        if bindir not in path_dirs:
            path_dirs.insert(0, bindir)
    env["PATH"] = os.pathsep.join(path_dirs)
    return env


def render_mcp_section(name: str, spec: dict, existing_body: str | None = None) -> str:
    command = command_to_write(spec, existing_body)
    lines = [f"[mcp_servers.{name}]", f"command = {toml_quote(command)}"]
    args = spec.get("args") or ()
    if args:
        rendered = ", ".join(toml_quote(item) for item in args)
        lines.append(f"args = [{rendered}]")
    env = mcp_env(spec, command)
    if env:
        rendered = ", ".join(f"{key} = {toml_quote(value)}" for key, value in env.items())
        lines.append(f"env = {{ {rendered} }}")
    lines.append("enabled = true")
    return "\n".join(lines) + "\n"


def table_ranges(text: str, header_re: re.Pattern[str]) -> list[tuple[int, int]]:
    lines = text.splitlines(keepends=True)
    next_header = re.compile(r"^[ \t]*\[")
    starts = [index for index, line in enumerate(lines) if header_re.match(line.rstrip("\n"))]
    ranges: list[tuple[int, int]] = []
    for start in starts:
        end = len(lines)
        for index in range(start + 1, len(lines)):
            if next_header.match(lines[index]):
                end = index
                break
        ranges.append((start, end))
    return ranges


def factory_server_ranges(text: str, name: str) -> list[tuple[int, int]]:
    header_re = re.compile(
        rf"^[ \t]*\[mcp_servers\.{re.escape(name)}(?:\.[^\]]+)?\][ \t]*(?:#.*)?$"
    )
    return table_ranges(text, header_re)


def section_has_factory_contract(body: str, spec: dict) -> bool:
    if not command_satisfies_contract(body, spec):
        return False
    if re.search(r"^[ \t]*enabled[ \t]*=[ \t]*false[ \t]*(?:#.*)?$", body, re.M):
        return False
    args = spec.get("args") or ()
    if args:
        needle = ", ".join(f'"{item}"' for item in args)
        if f"[{needle}]" not in body:
            return False
    command = command_to_write(spec, body)
    for key, value in mcp_env(spec, command).items():
        if key not in body or toml_quote(value) not in body:
            return False
    return True


def upsert_factory_mcp(text: str) -> str:
    body = normalize_toml(text)
    for name, spec in FACTORY_SERVERS:
        ranges = factory_server_ranges(body, name)
        if not ranges:
            prefix = "" if not body.strip() else "\n"
            body = f"{body}{prefix}{render_mcp_section(name, spec)}"
            continue
        lines = body.splitlines(keepends=True)
        existing = "".join("".join(lines[start:end]) for start, end in ranges)
        if len(ranges) == 1 and section_has_factory_contract(existing, spec):
            continue
        drop = {index for start, end in ranges for index in range(start, end)}
        kept = [line for index, line in enumerate(lines) if index not in drop]
        insert_at = ranges[0][0]
        body = "".join(kept[:insert_at]) + render_mcp_section(name, spec, existing) + "".join(kept[insert_at:])
    return normalize_toml(body)


def win_quote(token: str) -> str:
    # Git Bash / 未引用の `\` 消失を避ける。空白が無くても Windows path は引用する。
    if token.startswith('"') and token.endswith('"') and len(token) >= 2:
        return token
    return '"' + token.replace('"', '\\"') + '"'


def is_wsl_bash(path: str) -> bool:
    value = path.replace("/", "\\").lower()
    return Path(path).name.lower() in {"bash.exe", "bash"} and "system32" in value


def windows_shell() -> str:
    roots = (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Git",
    )
    for root in roots:
        for candidate in (root / "bin" / "sh.exe", root / "usr" / "bin" / "sh.exe"):
            if candidate.is_file():
                return str(candidate)
    found = shutil.which("sh")
    if found and not is_wsl_bash(found):
        return str(Path(found).resolve())
    raise ValueError("Windows 工場hook用の Git sh.exe が無い")


def hook_interpreter(script: Path) -> str:
    shebang = ""
    if script.is_file():
        first = script.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
        shebang = first[0] if first else ""
    if "python" in shebang or script.suffix.lower() in {".py"}:
        return str(Path(sys.executable).resolve())
    return windows_shell()


def already_has_interpreter(first: str) -> bool:
    if is_wsl_bash(first):
        return False
    name = Path(first).name.lower()
    return name in {
        "python.exe",
        "python3.exe",
        "python",
        "python3",
        "sh.exe",
        "bash.exe",
        "sh",
        "bash",
        "cmd.exe",
    }


def split_hook_command(command: str) -> list[str]:
    parts = shlex.split(command, posix=os.name != "nt")
    if os.name == "nt":
        parts = [
            part[1:-1]
            if len(part) >= 2 and part[0] == part[-1] and part[0] in {"'", '"'}
            else part
            for part in parts
        ]
    return parts


def strip_interpreters(parts: list[str]) -> list[str]:
    rest = list(parts)
    while rest:
        if is_wsl_bash(rest[0]) or already_has_interpreter(rest[0]):
            rest = rest[1:]
            continue
        if rest[0] in {"/usr/bin/env", "env"} and len(rest) > 1:
            rest = rest[2:]
            continue
        break
    return rest


def windows_hook_command(command: str, home: Path) -> str:
    expanded = command.replace("${HOME}", str(home))
    if expanded.startswith("~/"):
        expanded = str(home) + expanded[1:]
    parts = strip_interpreters(split_hook_command(expanded))
    if not parts:
        return command
    script = Path(parts[0])
    if not script.is_absolute():
        script = home / script
    interpreter = hook_interpreter(script)
    tokens = [interpreter, str(script), *parts[1:]]
    return " ".join(win_quote(token) for token in tokens)


def rewrite_factory_hooks(data: dict, home: Path) -> dict:
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        raise ValueError("factory.json の hooks は object である必要があります")
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            raise ValueError(f"factory.json hooks.{event} は配列である必要があります")
        for group in groups:
            if not isinstance(group, dict):
                continue
            entries = group.get("hooks")
            if not isinstance(entries, list):
                continue
            for hook in entries:
                if not isinstance(hook, dict) or hook.get("type") != "command":
                    continue
                command = hook.get("command")
                if not isinstance(command, str):
                    continue
                hook["command"] = windows_hook_command(command, home)
    return data


def propose_factory_hooks(home: Path) -> tuple[Path | None, str | None, str | None]:
    if os.name != "nt":
        return None, None, None
    dest = grok_home(home) / "hooks" / "factory.json"
    if not dest.exists() and not dest.is_symlink():
        return None, None, None
    original = dest.read_text(encoding="utf-8")
    try:
        data = json.loads(original)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{dest}: JSON パース失敗: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{dest}: top-level object が必要です")
    proposed = json.dumps(rewrite_factory_hooks(data, home), ensure_ascii=False, indent=2) + "\n"
    if proposed == original and not dest.is_symlink():
        return dest, None, original
    return dest, proposed, original


def apply_factory_hooks(dest: Path, content: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{dest.name}.", dir=dest.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        if dest.is_symlink() or dest.exists():
            dest.unlink()
        os.replace(temporary, dest)
    except BaseException as exc:
        Path(temporary).unlink(missing_ok=True)
        raise OSError(f"工場hook適用失敗: {exc}") from exc


def propose(text: str) -> str:
    body = text
    for key in COMPAT_FALSE_KEYS:
        body = set_compat_claude_false(body, key)
    return upsert_factory_mcp(body)


def show_diff(path: Path, before: str, after: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=str(path),
            tofile=str(path),
        )
    )


def backup(home: Path, extras: list[tuple[Path, str]]) -> Path:
    directory = home / "Archives"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = directory / f"dotagents-grok-config-{stamp}.tar.gz"
    suffix = 1
    while archive.exists():
        archive = directory / f"dotagents-grok-config-{stamp}-{suffix}.tar.gz"
        suffix += 1
    with tarfile.open(archive, "w:gz") as tar:
        for path, original in extras:
            try:
                name = str(path.relative_to(home))
            except ValueError:
                name = path.name
            info = tarfile.TarInfo(name.replace("\\", "/"))
            encoded = original.encode("utf-8")
            info.size = len(encoded)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(encoded))
    os.chmod(archive, 0o600)
    return archive


def apply(path: Path, content: str, original: str, existed: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if existed else 0o600
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        if os.environ.get("DOTAGENTS_TEST_FAIL_REPLACE") == path.name:
            raise OSError(f"test injection: {path.name} replace failure")
        os.replace(temporary, path)
    except BaseException as exc:
        if existed and path.exists() and path.read_text(encoding="utf-8") != original:
            rollback = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
            try:
                rollback.write(original)
                rollback.flush()
                os.fsync(rollback.fileno())
                rollback.close()
                os.chmod(rollback.name, mode)
                os.replace(rollback.name, path)
            finally:
                Path(rollback.name).unlink(missing_ok=True)
        raise OSError(f"適用失敗、rollback 済み: {exc}") from exc
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser().resolve()
    path = grok_home(home) / "config.toml"
    if path.is_symlink():
        raise ValueError("config.toml は symlink では適用できません")
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    proposed = propose(original)
    config_changed = proposed != normalize_toml(original)
    hook_path, hook_proposed, hook_original = propose_factory_hooks(home)
    hook_changed = hook_proposed is not None
    if not config_changed and not hook_changed:
        print("apply-grok-config: 変更なし")
        return 0
    if not args.apply:
        if config_changed:
            print(show_diff(path, original, proposed), end="")
        if hook_changed and hook_path is not None and hook_original is not None:
            print(show_diff(hook_path, hook_original, hook_proposed), end="")
        return 0
    extras: list[tuple[Path, str]] = []
    if config_changed and existed:
        extras.append((path, original))
    if hook_changed and hook_path is not None and hook_original is not None:
        extras.append((hook_path, hook_original))
    archive = backup(home, extras)
    if config_changed:
        apply(path, proposed, original, existed)
    if hook_changed and hook_path is not None and hook_proposed is not None:
        apply_factory_hooks(hook_path, hook_proposed)
    print(f"apply-grok-config: 適用完了（backup: {archive}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
