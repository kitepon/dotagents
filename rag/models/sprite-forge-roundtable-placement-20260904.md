# sprite-forge 円卓の配置実測（2026-09-04）

出典: peertable 円卓 `sprite-forge-mcp`（Lattice plan modernization-20260904 / -b、席: 実装 Codex Terra×high ×2〜3、監査 Grok 4.6×medium → Claude Sonnet 5×medium、親 Fable）。取得日 2026-09-04。確度: dotagents 実測（一般性能へ拡張しない）。

## 実装役（Terra×high）

| 工程 | 受入の書き方 | 結果 |
|---|---|---|
| p0（ComfyUI Portable 導入・学習器）、p1（新顔比較 6 本、LoRA 学習）、b1〜b6（workflow・素体・設定画・LoRA・ダメージ版・記録） | 「fox で MCP を呼んで画像／LoRA／記録が出る」と成果物で書いた | 全件、初回提出で監査（Sonnet 5）合格 |
| p2-core / p2-mcp（backend 再構築） | 「pytest green、list_tools に残すツールが出る」と曖昧 | backend を 294 行・MCP ツール 3 つに縮めて提出。監査（Grok medium）が通し、統括が Phase 2 出口を不合格と裁定。追加計画 B で是正 |
| b7-web（WebUI 5 画面の操作導線 1 周） | 「Playwright でコンソールエラー 0 と主要導線 1 周」 | 1 回目 Playwright 未使用、2 回目 画面遷移のみ → 2 回不合格 |

**Sol×high へ昇格後**: b7-web を 7 分で合格。p3-deploy では依頼外の配置前実地検（Dockerfile 不在・compose の鍵 mount 不可視・web 未配信・記録画面の欠け）を自分で見つけて現工程の中で修正に入った。

## 監査役

- Grok 4.6×medium: p2-core/p2-mcp の縮小提出を通した（受入文言が曖昧な時に厳しくならない）。
- Sonnet 5×medium: b1〜b7 で証跡に実行結果のパスが無い提出を不合格にし、b7 を 2 回差し戻した。

## 運用判断（順位は変えない）

- Terra×high は「受入を成果物・数値で書ける工程」に置く。受入の意味を読んで範囲を自分で決める工程（統合・配置・UI の受入）は最初から Sol×high に置く。
- 監査役は受入文言が曖昧になりうる campaign では Sonnet 5×medium を選ぶ（Grok medium は 2 位へ）。
- 親の教訓: 設計メモの受入条件を「何を呼んで何が出るか」まで書く。曖昧な受入は席のモデルに関係なく縮小提出を招く。
