# harness用語統一・OS/ハーネス分離 campaign（2026-08-24）

- **状態**: 進行中
- **レーン**: 統括（複数repoの書込みを調整）
- **背景**: Cursorは複数AIモデルを載せる実行基盤であり、AIを「ベンダー」で分類する語彙が破綻した。オーナー裁定により、実行基盤の分類語を**harness（ハーネス）**へ全面置換する。実際のCursor対応は本campaignの対象外（aiterm-mcpは0.28.0で先行実装済み）。

## ゴール

1. **G1 用語置換**: AI実行基盤の分類として使われる「vendor」を「harness」へ置換する。対象は現役の正典・README・コード内identifier・コメント。**歴史文書（evidence/・docs/archive/・CHANGELOG・確定済みADR本文）と、公開wire契約の互換fieldは置換しない**（下記「不変契約」）。
2. **G2 分離**: OS依存ファイルとハーネス依存ファイルを最小限の内容で分離する。**レイヤ裁定: OS層を下層、ハーネス層をその上に置く**（harness adapterがOS抽象を利用し、coreはharness interfaceだけに依存する）。aiterm-mcp campaign 32（2026-08-23完遂・core → harnesses → shared → os の一方向依存）を工場標準の実証形とする。
3. **G3 簡単化**: 置換・分離のついでに見つけた明白な重複・死コードの整理（挙動不変のみ）。
4. **G4 完遂**: リファクタした製品ごとに、全ドキュメント更新→commit→push→npm global install→npm release→公開後smokeまで同一waveで閉じる。docs-only変更の製品はcommit/pushまで（npm releaseは製品挙動の変更が無いため対象外、理由付きで報告）。

## 不変契約（置換しないもの）

- aiterm-mcp診断schema `aiterm-mcp.factory-diagnostics.v1` の `vendor_dependencies` キー（dotagents `lib/factory/v2〜v7.mjs` がexact allowlistで検証する現行wire。v2-v5は凍結履歴）。
- aiterm-mcp receiptの互換field `vendor`／`vendor_session_id`（ADR 0038で互換維持を確定済み。正本fieldは `harness`）。
- runtime error code `AITERM.VENDOR_LAUNCHER_FAILED`（fingerprint安定性）。
- peertable room DBの既存列・旧skill資産からの `vendor` 書込み（migration＋読み書き互換で受ける）。
- 第三者パッケージの実パス（`@openai/codex-*/vendor/`）、依存vendoring語（Lattice sensor grammar・aishell等の「vendored dependency」）——AI分類語ではないため対象外。

## 現状調査の結論（2026-08-24実測）

| repo | vendor=AI分類の実態 | 処置 |
|---|---|---|
| aiterm-mcp | src/vendors/ 4 adapter・identifier約160箇所。OS/harness分離は0.27.8で完了、harness APIは0.28.0で導入済み | 内部identifier・dir・現役docsをharnessへ改名、release |
| peertable | member台帳の素性field `vendor`（DB列・API・SSE・env `PEERTABLE_VENDOR`・skill scripts・UI） | 互換付き全面rename（正本`harness`・旧`vendor`受理/併記）、release |
| Throughline | README×2・CLAUDE.md・docs/16 の散文「cross-vendor」等6箇所 | docs置換のみ |
| Spotter | docs/00_overview.md「host-vendor decision points」1箇所 | docs置換のみ |
| Caveat | docs/05_next_session.md「vendor-neutral hook」1箇所 | docs置換のみ |
| dotagents | 正典散文（codex skill/delta・shared/orchestrate/executor-adapters.md等）＋生成物 | 散文置換＋生成物再生成。lib/factoryのwireキーは不変 |
| Lattice / aishell / codex-sidecar / gpt-connector / ServerManager / MarkItDown | AI分類のvendor使用なし（依存vendoring・rag引用のみ） | 対象外 |

- OS/ハーネス分離の現状: aiterm-mcpは完了済み。dotagentsは既に分離済み（claude/・codex/・grok/ のharness別dir＋OS別setup 4入口）。Caveatはinstall面がファイル単位で分離済み（claudeInstall.ts / codexHookInstall.ts / hookShared.ts）。Spotterはdocs/00_overview宣言どおり分離済み。peertableのharness分岐はwakeup-bridge等の小分岐に局在しており、adapter抽出は間接を増やすだけで最小実装原則に反するため**改名に留める**（Cursor対応時に必要ならその時に抽出する）。

## 非目標

- Cursor実対応（peertable・他製品への追加）。aiterm-mcp診断schema v2化（`vendor_dependencies`→`harness_dependencies`のwire改名はhost横断cutoverが必要で、用語統一の利益に対し過大）。歴史文書の書換え。挙動修正・機能追加。

## 工程

- P1 aiterm-mcp: rename（vendors/→harnesses/・identifier・docs）→ full test → release 0.28.2 → install → smoke
- P2 peertable: 互換付きrename → test/smoke → release 0.6.0 → install → smoke
- P3 docs-only 3repo（Throughline / Spotter / Caveat）: 置換 → commit/push
- P4 dotagents: 正典散文置換＋生成物再生成 → shell lint/契約test → commit/push
- P5 知識還流・本計画の完遂化

## 並列化検討の結論（campaign単位で一度）

repo間は独立だが、統括1名の直列実行とする。理由: 置換の罠（wire互換fieldの誤置換）が全repoで同型であり、統括自身が一度学んだ判定を直列で適用する方が委譲Packet作成＋受入コストより安い。Lattice runは新設しない。

## 検証

- aiterm-mcp: `npm test` full（macOS）＋ `npm pack --dry-run` 同梱確認 ＋ 公開後smoke。
- peertable: 既存test＋room server起動smoke＋新旧field互換のfocused test。
- dotagents: `npm test`（factory-scan契約test）＋生成物diff確認。
- 各repo: `rg -i vendor` 残存の全数確認（不変契約の残存だけが許容）。
