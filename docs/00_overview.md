# docs/ の地図（正典入口）

dotagents の文書群の全体地図。全てのMarkdown／MDCは[document registry](document-registry.json)が先頭一致で`generated`／`current`／`contract`／`history`／`evidence`へ分類する。docs/ 直下は原則として生きた文書だけを置き、役目を終えた文書は [archive/](archive/) へ退避する。ControlやLatticeが固定パスを束縛する履歴・証拠・互換stubだけは直下の同じpathを保ち、registryで`history`／`evidence`へ落として通常の読書入口から外す。

archive移動はregistryへ旧path・新path・旧pathの扱い・凍結本文digestを同時登録する。互換stubはstub自身のdigestも固定する。登録外のarchive増減、凍結本文の要約や修正、stubの肥大化、current文書のlocal link切れはCIが拒否する。製品を接続するhost skill・pointer・matrixはcurrent surface policyで薄さを検査し、製品内部手順を戻せない。

各製品の導入・設定・状態・schema・migration・診断の意味・復旧・更新・releaseは、その製品repoの文書だけが正本である。dotagentsは製品集合、host/wire、公開入口のprojection、横断受入を統括するが、製品を制御しない。

**命名規約**（[adr/0004](adr/0004-docs-naming-convention.md)）: 恒久正典＝`NN_` 連番・小文字ケバブ（番号が読む順）／一時文書＝`plan_`・`queue_` 接頭辞（TODO を兼ね、完遂で archive へ）／archive 内＝`YYYY-MM_` 接頭辞（時系列に並ぶ）。

## 読む順

| 文書 | 役割 |
|---|---|
| [../PLAN.md](../PLAN.md) | **憲章（聖典 v4）**。趣旨・原則1〜10・文書の作法・定常運用・残件 |
| `lattice todo status --json` | 進行中工程の正本。完了したMarkdown計画を現在地として読まない |
| [01_project-layout.md](01_project-layout.md) | 全プロジェクト共通のフォルダ構成標準 |
| [02_models.md](02_models.md) | 役割→モデル×effort順位表（唯一の参照点） |
| [03_settings-fragments.md](03_settings-fragments.md) | .claude/settings.json の生成手順・断片 |
| [04_ci.md](04_ci.md) | lint / CI ゲート（`make ci`＝CI同一、`make lint`＝静的部分ゲート）の正典 |
| [factory-current-state.md](factory-current-state.md) | 配備契約から生成する製品数・区分・現役wire・本番endpoint・rollback先 |
| [05_codex-fragments.md](05_codex-fragments.md) | Codex 端末設定の断片カタログ（MultiAgent V2 role routing 必須断片・実効値ゲート・親既定はオーナー領分） |
| [06_gpt-connector.md](06_gpt-connector.md) | ChatGPT製品を工場へ登録する薄い接続pointer（`gpt_connector` / `gpt-connector-mcp`） |
| [07_grok-fragments.md](07_grok-fragments.md) | Grok 端末設定の工場断片（compat.agents と工場MCP 6。model/login/permissionは触らない） |
| [08_cursor-fragments.md](08_cursor-fragments.md) | Cursor 端末設定の工場断片（工場MCP 6。cli-config.json の model/login/permissionは触らない） |
| [../README.md](../README.md#他端末セットアップランブック) | 現役4席（Mac / main-server / rabbit native Linux / Windows native）の一撃展開と定期更新。Windows nativeはPowerShell 7＋Git for Windowsだけで閉じ、WSL／Dockerを前提にせず、main-server恒久SSHも同じ入口で閉じる |
| [../shared/orchestrate/contract.md](../shared/orchestrate/contract.md) | 両親共通のorchestrate use-not-use・Control lifecycle・統括ゲート |
| [../shared/orchestrate/delegation-contract.md](../shared/orchestrate/delegation-contract.md) | 製品中立のDelegation Packet／Worker Reportと統括側受入契約 |
| `plan_*.md` | 現役計画だけ。完遂時は`archive/`へ移し、固定path consumerが実在する場合だけroot stubを残す |
| [archive/](archive/) | 役目を終えた文書（Fable 期キャンペーンの計画 v3・消化台帳一式） |
| [adr/](adr/) / [evidence/](evidence/) | 固定された判断・証拠。個別の現行文書から必要な時だけ辿り、通常の読む順には入れない |

ADR本文と状態は裁定時点の不変記録であり、後から改稿しない。現行効力は次のsupersession表を正とし、後続裁定が増えた時はこの表だけへ追記する。

| 先行ADR | 現行効力 | 後続裁定 |
|---|---|---|
| [0085](adr/0085-agents-update-throughline-migration-gate.md) | 決定1〜4を失効。決定5の製品DB・SQL・schema非所有は維持 | [0137](adr/0137-product-owned-update-lifecycle.md) |
| [0086](adr/0086-throughline-migration-four-host-acceptance.md) | 当時の受入証拠は維持。親裁定のThroughline固有二段呼出しと内部JSON解釈は失効 | [0137](adr/0137-product-owned-update-lifecycle.md) |
| [0132](adr/0132-document-current-state-registry.md) | 決定1のうち新規文書をcatch-allでcurrentへする部分だけ失効。他の決定は維持 | [0136](adr/0136-document-ci-ownership-and-base-relative-immutability.md) |
| [0134](adr/0134-product-owned-document-ci.md) | 決定3〜5を失効。製品CI所有を定める決定1〜2は維持 | [0136](adr/0136-document-ci-ownership-and-base-relative-immutability.md) |

## 工場（管理対象製品）の正典

変動する現行値と恒久契約は次へ分離し、他文書へ複製しない。

| 文書 | 役割 |
|---|---|
| [factory-current-state.md](factory-current-state.md) | 管理製品・区分・現役wire・本番endpointの**生成された現行値** |
| [factory-product-contracts.md](factory-product-contracts.md) | 公開version/diagnostics入口・adapter projection・privacyだけを持つ**統合台帳** |
| [factory-grok-build-community-overlay.md](factory-grok-build-community-overlay.md) | 公式 Grok Build CLI とは別の、自前 Desktop / AFK overlay。コア製品IDを増やさない |
| [factory-host-product-matrix.md](factory-host-product-matrix.md) | host別の期待状態（required／optional／unsupported／not_applicable）と親別connector |
| [factory-reporter-runbook.md](factory-reporter-runbook.md) | 工場clientの設定・収集・送信・outbox・scheduler・wire互換とhost別rollback。server側はServerManagerへ委譲 |
| `wire-vN-design.md` | wire major各版の固定契約。現役とrollback先は[工場の現行状態](factory-current-state.md)を参照し、過去版は履歴として凍結する |

製品の追加・削除・第三者化・所有移管の手順は [../README.md](../README.md)「工場コア製品の変更管理」が正。

## 関連

- 罠DB: [Caveat](https://github.com/kitepon/Caveat)（own DB・schema・同期・診断はCaveat自身が所有する）
- 調査資産: [../rag/INDEX.md](../rag/INDEX.md)
- 人格・全端末共通規範: [../shared/constitution.md](../shared/constitution.md)（唯一の共通正本。harness固有差分と配布生成物は各harnessディレクトリ。現役のGrok/Cursor配線は[07](07_grok-fragments.md)／[08](08_cursor-fragments.md)、完了した導入工程は[archive](archive/)が持つ）
- 規範の入口: ルート [../AGENTS.md](../AGENTS.md) は全AI向けのproject正典であり、Claude Code はルート [../CLAUDE.md](../CLAUDE.md) の `@AGENTS.md` 経由で取り込む。共通憲法は `shared/constitution.md`、host固有差分は各host delta、runtime配布物は生成物として管理する。
- 同期ハブ: `install.sh` がskill・command・agent・rule・binを端末へsymlink配布し、GitHubを真実の源とする。初回導入と再適用は`setup-macos-factory`／`setup-linux-factory`／`setup-linux-workstation-factory`／`setup-windows-native-factory.ps1`がhost固有配線を所有し、共有する製品集合だけをdeployment contractから読む。Windows nativeはWSL・Docker・仮想化を導入／検証せず、Git for Windowsの`bash.exe`／`sh.exe`をWSLと混同しない。同入口はmain-server専用SSH鍵・pinned host key・alias／直IP config・runner経由公開鍵登録・非対話再接続も所有する。知識台帳は `rag/`（調査）と `docs/`（判断・計画）、Caveatのown DBはdotagents外でCaveat自身が管理する。
- 文書はregistry上の5種と所有roleへ機械分類する。変動する現行値は構造化正本から生成し、current文書は[工場の現行状態](factory-current-state.md)を参照する。完了文書は`archive/`、固定証拠は`evidence/`へ置き、製品内部契約は各製品repoへ返す。archiveはinventoryとdigest、製品接続面はsurface policyで機械検査する。
