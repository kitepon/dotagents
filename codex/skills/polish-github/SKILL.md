---
name: polish-github
description: Use when the user asks to polish a GitHub repository's public OSS presentation, README, metadata, releases, topics, CI badges, social preview, OG or hero images, diagrams, or launch-ready GitHub appearance. First audit only, present prioritized options, and wait for GO before changing files or GitHub settings unless the user already explicitly says to do everything.
---

<!-- 前提: 2026-07 検証。本文の正本は claude/commands/polish-github.md（一本化済み 2026-07-04・P0-12）。このファイルは Codex 向けの薄い入口 -->

# Polish GitHub

**正本を読んで従うこと**: 同じdotagents checkoutの`claude/commands/polish-github.md`（このスキル自体が同リポからのsymlinkなので、実体は同居している。POSIXの`~/Developer/dotagents`やWindowsの`C:\Users\kite_\Developer\dotagent`など、checkoutの実pathから解決する）。

正本が読めない場合はエラーとして報告し、以下の要約だけで代行しない（フォールバック禁止）。

## 正本の要点（迷子防止の要約——正本が常に優先）

1. **監査だけ先に実行**し、効果／コスト表で選択肢を提示。ユーザーの GO まで変更しない（「全部やれ」指示があれば一括可）。
2. 不可逆・外部変異（push・tag・Release 作成・repo 設定・Settings 変更）は**実行前に一言告知**。
3. 監査軸: メタデータ（description/topics/homepage/OG/default branch/license）・README 構造（1行 pitch・30秒例・比較表）・図（mermaid 優先）・CI バッジ・Community Profile / security・package/tag/default branch/Release/CHANGELOG 整合。
4. tagがdefault branchの祖先でない場合はRelease不足と混同せず、履歴整合問題として明示する。license種類やtag付け替えは推測で決めない。
5. 既存の長文は消さず `<details>` で折りたたむ。プロジェクトの性格と画像の派手さをマッチさせる。
