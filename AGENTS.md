# AGENTS.md

このリポで働く**全 AI エージェント共通**のプロジェクト正典（ツール非依存）。趣旨・原則・残件は [PLAN.md](PLAN.md)（憲章＝聖典 v4）、人間向けの詳細ランブックは [README.md](README.md) が正。正典群の地図は [docs/00_overview.md](docs/00_overview.md)、配置規約とエントリ形式は [docs/01_project-layout.md](docs/01_project-layout.md)、検証入口は [docs/04_ci.md](docs/04_ci.md) が正。

## このリポジトリの役割

Claude Code と Codex の自作 skill / slash command / rule を複数端末で同期する個人 dotfiles。`install.sh` がリポジトリ内エントリを各配布面へ**ファイル / ディレクトリ単位の symlink** で配置する（配布先一覧・冪等仕様・SKIP／fail-closed 挙動は README「他端末セットアップ・ランブック」が正）。**リポジトリ内の配布ファイルを編集すれば、選択した配布面へ即反映される**（symlink なので同じファイル）——編集は常に「全端末へ今効く」前提で行う。グローバル憲法の編集・生成手順は [docs/04_ci.md](docs/04_ci.md) が正。

### 開発工場の定義（所有境界）

- **開発工場そのものはdotagents**。dotagentsを「工場の一部」「司令室だけ」「ServerManagerと並ぶ一方のcontrol plane」と再定義しない。全端末・全projectの規範、導入、更新、親別配線、互換契約、検証、上流追従をここが統括する。
- 製品数・区分・現役wire・本番endpointは[工場の現行状態](docs/factory-current-state.md)が正。**LatticeはCodegraphを完全吸収した正式後継であり、独立Codegraphはretired／not_applicableの履歴だけを保持して現役製品・依存・配線に含めない。** 製品ごとの恒久契約は[製品契約台帳](docs/factory-product-contracts.md)、host対応と構造的`unsupported`は[host matrix](docs/factory-host-product-matrix.md)、Oracleの利用局面は[docs/02_models.md](docs/02_models.md)が正。Mac自前 Desktop と main-server 自前 AFK はコアIDを増やさない Community overlay で、正典は[factory-grok-build-community-overlay.md](docs/factory-grok-build-community-overlay.md)。
- 全documentは[document registry](docs/document-registry.json)が先頭一致で`generated`／`current`／`contract`／`history`／`evidence`へ分類する。変動する現行値は`lib/factory/deployment-contract.mjs`から生成し、current文書へ手入力しない。`make lint-current-docs`は生成drift、current surfaceへの製品制御・履歴の逆流、current link切れ、未登録archive、凍結本文・互換stubのdigest driftを拒否する。
- **BugHubは独立した製品ではなく、ServerManager内部のコンポーネント**。既存の読み取り専用集約、報告元アプリによる重大度決定、`resolve` / `reopen`、`/ai`という契約を守り、各製品のversion・bug・compatibility結果を統括する連携先として活用する。
- 各製品は自身のソース・状態・schema・migration・正規診断を所有する。dotagentsはそれらを複製せず統合契約を所有し、ServerManager/BugHubはdotagentsの代わりに工場方針を決めたり製品状態を直接書き換えたりしない。
- オーナーは、dotagentsの統括AIが**自作コア製品**の正規repoへ必要な修正とrelease管理を行うことを明示許可している。これは責務範囲の恒久裁定であり、第三者製品のfork/patchを許可するものではない。自作コアのpublish・本番反映は完遂であり、承認待ちへ分解しない。高リスク操作は目的・影響・戻し方を説明してから自分で行う。release gateとrollbackは各製品repoの正典が所有し、dotagentsは[統合契約台帳](docs/factory-product-contracts.md#共通境界)の公開probeと横断受入だけを所有する。
- 工場欠陥の重大度分類とmaintenance wave処理は[shared/orchestrate/contract.md](shared/orchestrate/contract.md)「Phase maintenance」、dotagents固有の範囲内外境界は[統合契約台帳](docs/factory-product-contracts.md#共通境界)が正（本ファイルへ複製しない）。
- **ControlのDecision証拠・fixed Worker中の親commit**などControl lifecycleの製品中立規則は[shared/orchestrate/contract.md](shared/orchestrate/contract.md)を正とする（本ファイルへ複製しない）。
- コア製品の追加・削除・第三者化・所有移管は、単なる一覧編集ではない。[README.md](README.md)「工場コア製品の変更管理」に従う。**source repoの移動・改名は別途オーナー承認が必要**であり、管理区分の変更をその承認の代用にしない。

## AI オンボーディング（この URL を渡された AI へ）

新しい端末での稼働手順は [README.md](README.md)「他端末セットアップ・ランブック」（§0〜4）だけが正典。席への手作業の工場展開は、その席のdotagents作業ディレクトリの親AIに正規入口を実行させ、失敗はその席で直す（同ランブック§3）。**Windows nativeはPowerShell 7とGit for Windowsだけで閉じ、WSL2・Docker・仮想化を前提・fallback・代替実行面にしない。WSL2は同じ物理PC上でも別席である。** `settings.json` 断片の冪等マージは [docs/03_settings-fragments.md](docs/03_settings-fragments.md)、Codex routing / hook 断片は [docs/05_codex-fragments.md](docs/05_codex-fragments.md) が正。親モデル×effort の既定はオーナー領分（AI は変更しない）。

## 掟（複数端末リポの作法）

1. **作業前に必ず `git fetch` → origin/main と照合**してから触る。このリポは複数端末から編集される。作業後は必ず push で真実を返す（GitHub が真実の源）。
2. **dirty を見つけたら差分から意図を確認**してから収容（コミット）か破棄を判断する。symlink 運用ゆえ、`~/.claude` / `~/.codex` 側での編集がこのリポの dirty として現れる。勝手に checkout で消さない。
3. **趣旨・原則・残件は [PLAN.md](PLAN.md)（憲章＝聖典 v4）が正**。環境まわりの作業はまず PLAN.md とLatticeの現行状態で現在地を拾い、判断に迷ったら原則に立ち返る。文書の5分類・archive・所有境界は [docs/00_overview.md](docs/00_overview.md) と [document registry](docs/document-registry.json) が正。製品内部の導入・設定・状態・schema・migration・診断・復旧・更新・releaseをdotagentsへ正本化しない。
