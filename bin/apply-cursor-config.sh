#!/usr/bin/env python3
"""Cursor MCP の工場所有面を差分適用する。cli-config.json の model / login / permission は触らない。"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


FACTORY_SERVERS = (
    ("aiterm", {"command": "aiterm-mcp"}),
    ("caveat", {"command": "caveat", "args": ("mcp-server",)}),
    ("lattice", {"command": "lattice-mcp"}),
    ("codex-sidecar", {"command": "codex-sidecar-mcp"}),
    ("gpt_connector", {"command": "gpt-connector-mcp"}),
    ("aishell", {"command": "aishell-mcp", "env": {"AISHELL_CAPABILITY_SET": "expanded-v1"}}),
)
WINDOWS_COMMAND_SUFFIXES = {".exe", ".cmd", ".bat", ".com"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cursor の工場MCP 6を ~/.cursor/mcp.json へ差分適用する。")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="差分を表示する（既定）")
    group.add_argument("--apply", action="store_true", help="backup 後に差分を適用する")
    return parser.parse_args()


def cursor_home(home: Path) -> Path:
    raw = os.environ.get("CURSOR_HOME")
    if raw:
        return Path(raw).expanduser().resolve()
    return (home / ".cursor").resolve()


def dump_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


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


def usable_absolute_command(command: str, name: str) -> bool:
    path = Path(command)
    if not path.is_absolute() or not command_name_matches(path, name) or not path.is_file():
        return False
    if os.name == "nt":
        return True
    return os.access(path, os.X_OK)


def command_to_write(spec: dict, existing: dict | None = None) -> str:
    name = spec["command"]
    realized = realized_command(name)
    if realized != name:
        return realized
    if existing:
        current = existing.get("command")
        if isinstance(current, str) and usable_absolute_command(current, name):
            return current
    return name


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
        dirs = [
            str(windir / "System32"),
            str(windir),
            str(windir / "System32" / "Wbem"),
            str(windir / "System32" / "WindowsPowerShell" / "v1.0"),
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


def render_server(spec: dict, existing: dict | None = None) -> dict:
    command = command_to_write(spec, existing)
    entry: dict = {"command": command}
    args = spec.get("args") or ()
    if args:
        entry["args"] = list(args)
    env = mcp_env(spec, command)
    if env:
        entry["env"] = env
    return entry


def command_satisfies_contract(entry: dict, spec: dict) -> bool:
    current = entry.get("command")
    if not isinstance(current, str):
        return False
    name = spec["command"]
    if current == name:
        return shutil.which(name) is None
    return usable_absolute_command(current, name)


def entry_satisfies_contract(entry: object, spec: dict) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("disabled") is True:
        return False
    if not command_satisfies_contract(entry, spec):
        return False
    args = spec.get("args") or ()
    if args and entry.get("args") != list(args):
        return False
    if not args and "args" in entry and entry.get("args") not in (None, []):
        return False
    command = command_to_write(spec, entry)
    expected_env = mcp_env(spec, command)
    actual_env = entry.get("env")
    if not isinstance(actual_env, dict):
        return False
    for key, value in expected_env.items():
        if actual_env.get(key) != value:
            return False
    return True


def load_mcp(text: str) -> dict:
    if not text.strip():
        return {"mcpServers": {}}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"mcp.json の JSON パース失敗: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("mcp.json は object である必要があります")
    servers = data.get("mcpServers")
    if servers is None:
        data["mcpServers"] = {}
    elif not isinstance(servers, dict):
        raise ValueError("mcpServers は object である必要があります")
    return data


def propose(text: str) -> str:
    data = load_mcp(text)
    servers = data["mcpServers"]
    changed = False
    for name, spec in FACTORY_SERVERS:
        existing = servers.get(name)
        if entry_satisfies_contract(existing, spec):
            continue
        servers[name] = render_server(spec, existing if isinstance(existing, dict) else None)
        changed = True
    if not changed:
        return text
    return dump_json(data)


def show_diff(path: Path, before: str, after: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=str(path),
            tofile=str(path),
        )
    )


def backup(home: Path, original: str, path: Path) -> Path:
    directory = home / "Archives"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = directory / f"dotagents-cursor-config-{stamp}.tar.gz"
    suffix = 1
    while archive.exists():
        archive = directory / f"dotagents-cursor-config-{stamp}-{suffix}.tar.gz"
        suffix += 1
    with tarfile.open(archive, "w:gz") as tar:
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
    path = cursor_home(home) / "mcp.json"
    if path.is_symlink():
        raise ValueError("mcp.json は symlink では適用できません")
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    proposed = propose(original)
    if proposed == original:
        print("apply-cursor-config: 変更なし")
        return 0
    if not args.apply:
        print(show_diff(path, original, proposed), end="")
        return 0
    archive = backup(home, original, path)
    apply(path, proposed, original, existed)
    print(f"apply-cursor-config: 適用完了（backup: {archive}）")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(2) from error
