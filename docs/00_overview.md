# docs/ の地図（正典入口）

dotagents の文書群の全体地図。全てのMarkdown／MDCは[document registry](document-registry.json)が先頭一致で`generated`／`current`／`contract`／`history`／`evidence`へ分類する。docs/ 直下は**生きた文書だけ**を置き、役目を終えた文書は [archive/](archive/) へ退避する。Latticeがdigestで束縛した既存のroot receiptだけはpathを動かさず`evidence`へ分類し、新しい証拠は`docs/evidence/`へ置く（文書3分類の規約は [../PLAN.md](../PLAN.md) 憲章「文書の作法」）。

**命名規約**（[adr/0004](adr/0004-docs-naming-convention.md)）: 恒久正典＝`NN_` 連番・小文字ケバブ（番号が読む順）／一時文書＝`plan_`・`queue_` 接頭辞（TODO を兼ね、完遂で archive へ）／archive 内＝`YYYY-MM_` 接頭辞（時系列に並ぶ）。

## 読む順

| 文書 | 役割 |
|---|---|
| [../PLAN.md](../PLAN.md) | **憲章（聖典 v4）**。趣旨・原則1〜10・文書の作法・定常運用・残件 |
| [plan_factory-master.md](plan_factory-master.md) | **進行中作業の唯一の親TODO**。現在地・並行レーン・合流条件・全端末展開順 |
| [01_project-layout.md](01_project-layout.md) | 全プロジェクト共通のフォルダ構成標準 |
| [02_models.md](02_models.md) | 役割→モデル×effort順位表（唯一の参照点） |
| [03_settings-fragments.md](03_settings-fragments.md) | .claude/settings.json の生成手順・断片 |
| [04_ci.md](04_ci.md) | lint / CI ゲート（`make ci`＝CI同一、`make lint`＝静的部分ゲート）の正典 |
| [factory-current-state.md](factory-current-state.md) | 配備契約から生成する製品数・区分・現役wire・本番endpoint・rollback先 |
| [05_codex-fragments.md](05_codex-fragments.md) | Codex 端末設定の断片カタログ（MultiAgent V2 role routing 必須断片・実効値ゲート・親既定はオーナー領分） |
| [06_gpt-connector.md](06_gpt-connector.md) | ChatGPT接続の正規ランブック（`gpt_connector` / `gpt-connector-mcp`・専用Chrome・session回収） |
| [06_oracle-mcp.md](06_oracle-mcp.md) | Oracleの互換・手動rollback記録（新規導入の正本ではない） |
| [07_grok-fragments.md](07_grok-fragments.md) | Grok 端末設定の工場断片（compat.agents と工場MCP 6。model/login/permissionは触らない） |
| [08_cursor-fragments.md](08_cursor-fragments.md) | Cursor 端末設定の工場断片（工場MCP 6。cli-config.json の model/login/permissionは触らない） |
| [plan_cursor-parent-host.md](plan_cursor-parent-host.md) | Cursorを第4harnessにする計画。Mac新規session受入まで着地（2026-08-24） |
| [plan_windows-pwsh7-aiterm-psmux-normalization-20260825.md](plan_windows-pwsh7-aiterm-psmux-normalization-20260825.md) | Windows工場shellをPowerShell 7へ統一し、Aiterm／psmux責務と工場コア修理を配布面まで閉じる進行中campaign |
| [../README.md](../README.md#他端末セットアップランブック) | 工場4席（Mac / Windows native / WSL2 / Linux）の一撃展開と定期更新。Windows nativeはPowerShell 7＋Git for Windowsだけで閉じ、WSL2／Dockerを前提にせず、main-server恒久SSHも同じ入口で閉じる |
| [../shared/orchestrate/contract.md](../shared/orchestrate/contract.md) | 両親共通のorchestrate use-not-use・Control lifecycle・統括ゲート |
| [../shared/orchestrate/delegation-contract.md](../shared/orchestrate/delegation-contract.md) | 製品中立のDelegation Packet／Worker Reportと統括側受入契約 |
| `plan_*.md` | 進行中の子計画（詳細TODO・受入条件。マスターの実行順に従い、完遂で `YYYY-MM_` 接頭辞にして archive へ移し、docs/直下には archive を指す短いスタブだけ残す） |
| [archive/queue_memory-promotion.md](archive/queue_memory-promotion.md) | 終了した端末メモリ→リポ正典への旧昇格待ち行列 |
| [adr/](adr/) | このリポ自身の構造決定の記録 |
| [archive/](archive/) | 役目を終えた文書（Fable 期キャンペーンの計画 v3・消化台帳一式） |

## 工場（管理対象製品）の正典

変動する現行値と恒久契約は次へ分離し、他文書へ複製しない。

| 文書 | 役割 |
|---|---|
| [factory-current-state.md](factory-current-state.md) | 管理製品・区分・現役wire・本番endpointの**生成された現行値** |
| [factory-product-contracts.md](factory-product-contracts.md) | 管理製品＋基盤toolchainの**有限契約台帳**。version入口・正規diagnostics・adapter・禁止事項 |
| [factory-grok-build-community-overlay.md](factory-grok-build-community-overlay.md) | 公式 Grok Build CLI とは別の、自前 Desktop / AFK overlay。コア製品IDを増やさない |
| [factory-host-product-matrix.md](factory-host-product-matrix.md) | host別の期待状態（required／optional／unsupported／not_applicable）と親別connector |
| [factory-reporter-runbook.md](factory-reporter-runbook.md) | credential・設定・送信・rotation・**wire major別のserver-first cutoverとrollback**の運用手順 |
| `wire-vN-design.md` | wire major各版の固定契約。現役とrollback先は[工場の現行状態](factory-current-state.md)を参照し、過去版は履歴として凍結する |

製品の追加・削除・第三者化・所有移管の手順は [../README.md](../README.md)「工場コア製品の変更管理」が正。

## 関連

- 罠DB: [../caveat/](../caveat/)（own エントリの正本。caveat MCP が symlink 越しに読む）
- 調査資産: [../rag/INDEX.md](../rag/INDEX.md)
- 人格・全端末共通規範: [../shared/constitution.md](../shared/constitution.md)（唯一の共通正本。harness固有差分と配布生成物は各harnessディレクトリ。GrokをClaude / Codexと同格の親にする作業は[plan_grok-parent-host.md](plan_grok-parent-host.md)、Cursorを第4harnessにする作業は[plan_cursor-parent-host.md](plan_cursor-parent-host.md)が所有）
- 規範の入口: ルート [../AGENTS.md](../AGENTS.md) は全AI向けのproject正典であり、Claude Code はルート [../CLAUDE.md](../CLAUDE.md) の `@AGENTS.md` 経由で取り込む。共通憲法は `shared/constitution.md`、host固有差分は各host delta、runtime配布物は生成物として管理する。
- 同期ハブ: `install.sh` がskill・command・agent・rule・binを端末へsymlink配布し、GitHubを真実の源とする。初回導入と再適用は`setup-macos-factory`／`setup-linux-factory`／`setup-wsl-factory`／`setup-windows-native-factory.ps1`がhost固有配線を所有し、共有する製品集合だけをdeployment contractから読む。Windows nativeはWSL2・Docker・仮想化を導入／検証せず、Git for Windowsの`bash.exe`／`sh.exe`をWSLと混同しない。同入口はmain-server専用SSH鍵・pinned host key・alias／直IP config・runner経由公開鍵登録・非対話再接続も所有する。知識台帳は `rag/`（調査）と `docs/`（判断・計画）、Caveatのown DBはdotagents外でCaveat自身が管理する。
- 文書はregistry上の5種へ機械分類する。変動する現行値は構造化正本から生成し、current文書は[工場の現行状態](factory-current-state.md)を参照する。完了した文書は `archive/` へ退避し、証拠は`evidence/`へ固定する。
