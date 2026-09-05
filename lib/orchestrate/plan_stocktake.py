"""Claude/Codexで共通のMarkdown計画棚卸し。工程の状態を持たない案内文書は数えない。"""
import os
from pathlib import Path
import time


def plan_files(root):
    docs = Path(root) / "docs"
    if not docs.is_dir():
        return []
    return sorted(path.name for path in docs.iterdir()
                  if path.name.startswith(("plan_", "queue_")) and path.suffix == ".md" and path.is_file())


def plan_stocktake(root):
    entries, complete = [], []
    for name in plan_files(root):
        path = Path(root) / "docs" / name
        text = path.read_text(encoding="utf-8")
        unchecked, checked = text.count("- [ ]"), text.count("- [x]")
        if unchecked:
            days = max(0, int((time.time() - os.path.getmtime(path)) // 86400))
            entries.append(f"{name}（未消化 {unchecked}・最終更新 {days} 日前）")
        elif checked:
            complete.append(name)
    return entries, complete
