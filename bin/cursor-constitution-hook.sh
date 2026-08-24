#!/usr/bin/env python3
"""Cursor: factory.mdc を Agent の additional_context へ載せる。

Desktop 3.17.8 の getGlobalRules は workspace 内の alwaysApply だけを注入し、
公式の user rule files（~/.cursor/rules）を always-apply しない。
User Rules UI 手貼りは完成形にしない。正本ファイルは factory.mdc のまま。

sessionStart は fire-and-forget で、composer handle 未作成だと
additional_context を黙って落とす。beforeSubmitPrompt は待って注入する。
preToolUse の additional_context も Desktop が次ターンへ載せるので、
prompt を踏まない既存窓の最初の tool でも同じ配達を返す（session ごとに1回）。

Desktop 3.17.8 の additional_context は 10000 字まで inline の
system_reminder。超過分は agent-tools の uuid.txt へ spill し、
モデルへは「そのファイルを Read」という短文だけが残る。現行の生成憲法は
10000 字を超えるため、超過時は spill に頼らず cap 内へ案内（ベル・
Cursor native shell・正本パス）と本文冒頭を載せ、末尾の Cursor delta は
切らず、同一全文は正本ファイルの Read で届ける。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


DELIVER_EVENTS = {"sessionStart", "beforeSubmitPrompt", "preToolUse"}
STAMP_EVENTS = {"beforeSubmitPrompt", "preToolUse"}
# Cursor Desktop 3.17.8 workbench: nft=1e4 in hook-additional-context-render.
INLINE_CAP = 10000


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


def strip_html_comment_lines(text: str) -> str:
    lines = [
        line
        for line in text.split("\n")
        if not (line.startswith("<!--") and line.endswith("-->"))
    ]
    return "\n".join(lines).lstrip("\n")


def split_cursor_delta(body: str) -> tuple[str, str]:
    marker = "## Cursor固有差分"
    index = body.find(marker)
    if index < 0:
        return body, ""
    return body[:index], body[index:]


def compact_delivery(path: Path, body: str) -> str:
    """10000 字超の本文を Desktop spill に渡さない。

    identity と Cursor delta を inline し、残り cap に本文冒頭を載せる。
    同一全文は正本 Read。
    """
    header = (
        "【工場憲法】Cursor Desktop はホームの rules/*.mdc を Agent の always-apply に載せない。"
        "あなたはベル。クオの技術パートナー。応答は日本語。\n\n"
        "shell操作は、Cursor nativeの単発・背景コマンドを既定にする。"
        "長時間・対話・cwd保持が要る外部子だけaiterm永続PTYを使う。"
        "Cursor親の日常shellをaitermへ流さない。\n\n"
        f"同一本文の正本は `{path}` である。応答する前に必ず Read し、以後その本文に従う。\n"
        "本文は「ベルの共通憲法」から始まる。Claude固有の日常shell既定は使わない。\n"
    )
    packed = strip_html_comment_lines(body)
    common, delta = split_cursor_delta(packed)
    separator = "\n---\n"
    budget = INLINE_CAP - len(header) - len(separator) - len(delta)
    if budget < 0:
        clipped = header + separator + delta
        return clipped[:INLINE_CAP]
    if len(common) <= budget:
        prefix = common
    else:
        prefix = common[:budget]
        if delta:
            nl = prefix.rfind("\n")
            if nl >= 0:
                prefix = prefix[: nl + 1]
    return header + separator + prefix + delta


def delivery_context(path: Path, body: str) -> str:
    if len(body) <= INLINE_CAP:
        return body
    compact = compact_delivery(path, body)
    if len(compact) > INLINE_CAP:
        compact = compact[:INLINE_CAP]
    return compact


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
    if event in STAMP_EVENTS and stamp is not None and stamp.exists():
        return 0
    path = home / "rules" / "factory.mdc"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    body = strip_frontmatter(text)
    if not body.strip():
        return 0
    context = delivery_context(path, body)
    sys.stdout.write(json.dumps({"additional_context": context}, ensure_ascii=False) + "\n")
    if event in STAMP_EVENTS and stamp is not None:
        try:
            stamp.parent.mkdir(parents=True, exist_ok=True)
            stamp.write_text("1\n", encoding="utf-8")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
