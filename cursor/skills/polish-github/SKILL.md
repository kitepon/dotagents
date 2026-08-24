---
name: polish-github
description: Use when the user asks to polish a GitHub repository's public OSS presentation, README, metadata, releases, topics, CI badges, social preview, OG or hero images, diagrams, or launch-ready GitHub appearance. First audit only, present prioritized options, and wait for GO before changing files or GitHub settings unless the user already explicitly says to do everything.
---

# Polish GitHub

**正本を読んで従うこと**: [claude/commands/polish-github.md](../../../claude/commands/polish-github.md)。正本が読めない場合はエラーとして報告し、要約だけで代行しない。

1. 監査だけ先に実行し、効果／コスト表で選択肢を提示する。GOまで変更しない（「全部やれ」があれば一括可）。
2. 不可逆・外部変異（push・tag・Release作成・repo設定）は実行前に一言告知する。
3. tagがdefault branchの祖先でない場合はRelease不足と混同せず、履歴整合問題として明示する。
