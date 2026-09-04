#!/usr/bin/env python3
"""Claude Code の dotagents 所有 hook を差分適用する。"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import shlex
import shutil
import stat
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


HOOKS = (
    ("PreToolUse", "Agent|Task|Workflow|mcp__codex-sidecar__codex_.*|mcp__aiterm__(codex|grok|composer)_agent", "delegation-gate-hook", (), 5),
    ("PreToolUse", "Bash", "git-destroy-gate-hook", (), 5),
    ("PreToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash", "boundary-gate-hook", (), 5),
    ("SessionStart", None, "todo-gate-hook", ("session-start",), 10),
    ("SessionStart", None, "orchestrate-advisory-hook", (), 5),
    ("SessionStart", None, "lattice-gantt-hook", ("session-start",), 6),
    ("Stop", None, "todo-gate-hook", ("stop",), 10),
    ("UserPromptSubmit", None, "onset-gate-hook", (), 5),
    ("UserPromptSubmit", None, "lattice-gantt-hook", ("user-prompt-submit",), 5),
    ("PostToolUse", "ExitPlanMode", "plan-gate-hook", (), 5),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Claude Code の dotagents hook を差分適用する。")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="差分を表示する（既定）")
    group.add_argument("--apply", action="store_true", help="backup 後に差分を適用する")
    return parser.parse_args()


def command_path(command: object, home: Path) -> tuple[Path, tuple[str, ...]] | None:
    if not isinstance(command, str):
        return None
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
    if not parts:
        return None
    while parts:
        first = Path(parts[0]).name.lower()
        wsl = Path(parts[0]).name.lower() in {"bash.exe", "bash"} and "system32" in parts[0].replace("/", "\\").lower()
        if wsl or first in {
            "python.exe",
            "python3.exe",
            "python",
            "python3",
            "sh.exe",
            "bash.exe",
            "sh",
            "bash",
            "cmd.exe",
        }:
            parts = parts[1:]
            continue
        if parts[0] in {"/usr/bin/env", "env"} and len(parts) > 1:
            parts = parts[2:]
            continue
        break
    if not parts:
        return None
    path = parts[0]
    if path.startswith("~/"):
        path = str(home) + path[1:]
    return Path(path).expanduser().resolve(strict=False), tuple(parts[1:])


def win_quote(token: str) -> str:
    # Claude Code は hook を Git Bash の `bash -c` で回す。未引用の `\` は全部消える
    # （C:\Users\kite_ → C:Userskite_）。空白が無くても Windows path は引用する。
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
    raise ValueError("Windows hook用の Git sh.exe が無い")


def hook_interpreter(script: Path) -> str:
    shebang = ""
    if script.is_file():
        first = script.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
        shebang = first[0] if first else ""
    if "python" in shebang or not shebang:
        return str(Path(sys.executable).resolve())
    return windows_shell()


def canonical_hook_command(home: Path, name: str, arguments: tuple[str, ...]) -> str:
    script = home / ".local/bin" / name
    if os.name != "nt":
        command = "~/.local/bin/" + name
        if arguments:
            command += " " + " ".join(arguments)
        return command
    interpreter = hook_interpreter(script)
    tokens = [interpreter, str(script), *arguments]
    return " ".join(win_quote(token) for token in tokens)


def matching_hook(
    entries: list[object], matcher: str | None, name: str, arguments: tuple[str, ...], timeout: int, home: Path
) -> dict | None:
    target = (home / ".local/bin" / name).resolve(strict=False)
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("matcher") != matcher:
            continue
        hooks = entry.get("hooks")
        if not isinstance(hooks, list):
            continue
        for hook in hooks:
            if not isinstance(hook, dict) or hook.get("type") != "command" or hook.get("timeout") != timeout:
                continue
            parsed = command_path(hook.get("command"), home)
            if parsed == (target, arguments):
                return hook
    return None


def update(data: dict, home: Path) -> bool:
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("hooks は object である必要があります")
    changed = False
    for event, matcher, name, arguments, timeout in HOOKS:
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            raise ValueError(f"hooks.{event} は配列である必要があります")
        command = canonical_hook_command(home, name, arguments)
        found = matching_hook(entries, matcher, name, arguments, timeout, home)
        if found is not None:
            if found.get("command") != command:
                found["command"] = command
                changed = True
            continue
        entry: dict[str, object] = {"hooks": [{"type": "command", "command": command, "timeout": timeout}]}
        if matcher is not None:
            entry["matcher"] = matcher
        entries.append(entry)
        changed = True
    return changed


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def show_diff(path: Path, before: str, after: str) -> str:
    return "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile=str(path), tofile=str(path)))


def backup(home: Path, path: Path, original: str, existed: bool) -> Path:
    directory = home / "Archives"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = directory / f"dotagents-claude-config-{stamp}.tar.gz"
    suffix = 1
    while archive.exists():
        archive = directory / f"dotagents-claude-config-{stamp}-{suffix}.tar.gz"
        suffix += 1
    with tarfile.open(archive, "w:gz") as tar:
        if existed:
            info = tarfile.TarInfo(str(path.relative_to(home)))
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
    path = home / ".claude/settings.json"
    if path.is_symlink():
        raise ValueError("settings.json は symlink では適用できません")
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    try:
        data = {} if not original.strip() else json.loads(original)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: JSON パース失敗: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top-level object が必要です")
    changed = update(data, home)
    proposed = render(data) if changed else original
    if not changed:
        print("apply-claude-config: 変更なし")
        return 0
    if not args.apply:
        print(show_diff(path, original, proposed), end="")
        return 0
    archive = backup(home, path, original, existed)
    apply(path, proposed, original, existed)
    print(f"apply-claude-config: 適用完了（backup: {archive}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
