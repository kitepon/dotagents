#!/usr/bin/env python3
"""Cursor: factory.mdc 本文を additional_context へ載せる。

Desktop 3.17.8 の getGlobalRules は workspace 内の alwaysApply だけを注入し、
公式の user rule files（~/.cursor/rules）を always-apply しない。
User Rules UI 手貼りは完成形にしない。正本ファイルは factory.mdc のまま。

sessionStart は fire-and-forget で、composer handle 未作成だと
additional_context を黙って落とす。beforeSubmitPrompt は待って注入するので
同じ本文をそちらでも返す（session ごとに1回）。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


DELIVER_EVENTS = {"sessionStart", "beforeSubmitPrompt"}


def cursor_home() -> Path:
    raw = os.environ.get("CURSOR_HOME")
    if raw:
        return Path(raw).expanduser().resolve()
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    return (home / ".cursor").resolve()


def strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text.strip()
    rest = text[3:]
    end = rest.find("\n---")
    if end < 0:
        return text.strip()
    return rest[end + 4 :].lstrip("\n").rstrip() + "\n"


def stamp_file(home: Path, session_id: str) -> Path | None:
    if not session_id or not isinstance(session_id, str):
        return None
    safe = session_id.replace("/", "").replace("\\", "").replace("..", "")
    if not safe or len(safe) > 128:
        return None
    return home / "factory-hook-state" / "constitution-delivered" / safe


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if not isinstance(data, dict):
        return 0
    event = data.get("hook_event_name")
    if event not in DELIVER_EVENTS:
        return 0
    home = cursor_home()
    session_id = data.get("session_id") or data.get("conversation_id") or ""
    stamp = stamp_file(home, str(session_id)) if session_id else None
    if event == "beforeSubmitPrompt" and stamp is not None and stamp.exists():
        return 0
    path = home / "rules" / "factory.mdc"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    body = strip_frontmatter(text)
    if not body.strip():
        return 0
    sys.stdout.write(json.dumps({"additional_context": body}, ensure_ascii=False) + "\n")
    if event == "beforeSubmitPrompt" and stamp is not None:
        try:
            stamp.parent.mkdir(parents=True, exist_ok=True)
            stamp.write_text("1\n", encoding="utf-8")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
