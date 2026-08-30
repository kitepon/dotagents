# AI協業をコード化する — 委譲構造を Skill/スクリプトで書く

- 出典: @UT_Codex（東大Codex研究所）2026-06-24 https://x.com/UT_Codex/status/2069707145747292441（781 bookmarks・55万 views・詳細は動画＋article リンク）
- 取得日: 2026-07-04
- 確度: 中（要旨は本文から明確。実装詳細は動画のため未検証）
- 関連: dotagents/docs/02_models.md（役割配置表）・orchestrate skill・[[karpathy-obsidian-llm-knowledge-base]]
- 注記（2026-07-11）: 本文中の `bin/delegate.sh` は**廃止済み**。委譲の現行入口は codex-sidecar MCP（`codex_work` 等）と aiterm 永続PTY（正典 docs/02_models.md）。以下は取得時点の記録。

## 要旨

- 「ChatGPT Pro を**計画担当**、Codex を**実行担当**として呼び出す Skill」の実例。
  - GPT が計画を立て、Codex が実行、スレッドはリポジトリ単位で紐付く。R/W アクセス＋コードベース全体のコンテキストを渡す。
- 核心思想: **「どの AI に何をやらせるか、その設計がコードになった」**。AIどうしの協業構造を、人間が Skill（コード）として明示的に書ける。

## うちへの含意（採用する思想）

1. **方向は逆だが構造は同型**: あちらは「GPT 計画 / Codex 実行」。うちは「**Fable(Claude) 統括・裁定 / Codex・Grok 実行**」（02_models.md）。頭を Claude に置くのがうちの選択（統括の推論品質と敵対的検証を重視）。外部の実例がこの分業の有効性を裏づける。
2. **委譲をコード化する**は、うちの `bin/delegate.sh`（外部知能の統一ラッパ）と orchestrate skill の方向そのもの。ad-hoc な呼び出しでなく、役割配置を再現可能なコードに落とす＝原則「構造で品質を出す」。
3. **リポ単位のスレッド紐付け**は参考にする: 委譲時にリポのコンテキスト（CLAUDE.md・PROJECT_LAYOUT）を渡す規約を delegate ツールに組み込む。

## 保留（未検証）

- Skill の具体実装・GPT Pro 側 API 経路は動画/article 未取得。delegate ツール設計で必要になれば article を markitdown 化して深掘りする。
