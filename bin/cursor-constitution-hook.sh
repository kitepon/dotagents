#!/usr/bin/env python3
"""Cursor sessionStart: factory.mdc 本文を additional_context へ載せる。

Desktop 3.17.8 の getGlobalRules は workspace 内の alwaysApply だけを注入し、
公式の user rule files（~/.cursor/rules）を always-apply しない。
User Rules UI 手貼りは完成形にしない。正本ファイルは factory.mdc のまま。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


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
    if data.get("hook_event_name") != "sessionStart":
        return 0
    path = cursor_home() / "rules" / "factory.mdc"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    body = strip_frontmatter(text)
    if not body.strip():
        return 0
    sys.stdout.write(json.dumps({"additional_context": body}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
