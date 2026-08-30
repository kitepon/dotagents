# 申し送り — 工場全製品の展開閉包修理（2026-08-11）

> **履歴文書:** 本書は当時の引き継ぎを固定したもので、現行案内ではない。製品集合・区分・wireは[工場の現行状態](factory-current-state.md)を参照する。
>
> **状態: 解消済み（2026-08-15）**
>
> 本文は2026-08-11時点の監査入力として保持する。5欠陥は`e738538`で閉じ、WSL2一撃展開は
> `147c78c`〜`90df4ad`、Windows native一撃展開は`295411d`〜`e38e3ac`、Mac一撃展開は
> `082ae35`で完了した。現行の導入・定期更新・受入手順は[README](../README.md#他端末セットアップランブック)、
> 製品集合は[有限契約台帳](factory-product-contracts.md)、host別期待は
> [host matrix](factory-host-product-matrix.md)を正とし、以下の欠陥記述を現状として読まない。

この文書は、Lattice側のBPR5を退役した監査セッションから、dotagents側の修理セッションへ渡す自己完結した申し送りである。工程状態の正本ではない。着手時は`lattice status --json`で既存planとactive runを確認し、Lattice工程管理を新設するかどうかは現行規範とオーナー指示に従う。

## オーナー裁定

- Latticeの`bridge-persistence-recovery`にあったBPR5は退役済み。FOX固有のinstall／update／Startup配線をLatticeへ実装しない。
- 導入、更新、host配線、更新後検証、rollbackはdotagents工場の所有境界で閉じる。
- Latticeへ同じ機能を移植したり、製品別の端末運用を二重化したりしない。

## 目的

工場管理12製品について、「reportへ載る」だけでなく、対応hostへ初回導入でき、継続更新でき、配線と製品診断を検証でき、失敗を更新後gateで非0にできる状態へ直す。

対象製品は自作コア11製品（Caveat、Throughline、Spotter、Lattice、gpt-connector、aiterm-mcp、codex-sidecar、AIShell、Observer、ServerManager、peertable）と第三者管理のMarkItDown。基盤toolchain（Claude Code CLI、Codex CLI、Grok Build）は別区分のまま更新・互換性管理を維持する。

## 2026-08-11監査で確定した欠陥

### 1. 更新後gateが現行製品集合を覆っていない

`bin/factory-reporter-v7-schedule-runner.mjs`はv5 runner実装を再利用し、`gateFailures()`の必須集合は次の8製品に固定されている。

- Caveat
- Throughline
- Spotter
- Lattice
- MarkItDown
- gpt-connector
- aiterm-mcp
- codex-sidecar

ServerManagerとtoolchainはprofile条件で追加されるが、AIShell、Observer、peertableは追加されない。3製品の更新・診断が壊れても`agents-update`のpost-update gateを成功させうる。

受入条件:

- wire v7とhost profileの期待状態に従い、対応hostでAIShell、Observer、peertableを必須判定する。
- `unsupported`／`not_applicable`はhost matrixどおり非blockingとし、対応hostのmissing／incompatible／許可されていないunverifiedはblockingにする。
- 3製品それぞれについて、欠落または診断失敗でgateが非0になる負側testを置く。
- 新製品追加時にwire集合だけ増えてpost-update gateから漏れる退行を検出する。

主な入口:

- `bin/factory-reporter-v5-schedule-runner.mjs`
- `bin/factory-reporter-v7-schedule-runner.mjs`
- `lib/factory/v7.mjs`
- `docs/factory-host-product-matrix.md`

### 2. `verify-install`とinstall testが12製品presenceを保証しない

`bin/verify-install.sh`の`verify_factory_core()`は旧8製品と、対応Mac上のAIShellだけを検査する。Observerとpeertableが欠落しても合格でき、表示文言も「現役工場コア8製品」のままである。ServerManagerはmain-server専用のsource/runtimeなので、一般CLI列へ混ぜず専用検証として扱う。

さらに`tests/install/clean-home.sh`は`DOTAGENTS_SKIP_FACTORY_CORE=1`でverifyを呼ぶため、install CIは工場製品presenceを実質検証していない。

受入条件:

- `verify-install`がhost matrixに従って全12製品のrequired／unsupported／not_applicableを検査する。
- Observerとpeertableの欠落を対応hostでFAILにする。
- main-serverのServerManagerは公開readiness／revision契約で検証し、一般端末ではnot_applicableとする。
- clean-homeまたは専用fixture testで、全製品の期待集合と欠落負側をskipせず検査する。
- 旧製品数の文言とREADME／Makefileの製品数ドリフトを直す。

### 3. Windows nativeに`agents-update`の常設schedulerがない

factory reporterのWindows Task Scheduler経路は存在するが、全製品を更新する`agents-update`の常設手順・生成器・実機受入がない。READMEの自動更新手順はmacOS launchdとLinux／WSL cronだけで、`tests/update/cron-env.sh`はMINGW／MSYSを明示skipする。

受入条件:

- FOX Windows nativeへ`agents-update`を定期実行するTask Scheduler経路をdotagents所有として追加する。
- dry-run、冪等install/update、uninstall、登録状態診断、実走行smokeを持つ。
- Windows nativeのNode／npm global bin／`~/.local/bin`相当をscheduled taskの最小環境で復元し、対話shell成功を根拠にしない。
- task実行後に`agents-update end`、終了code、最新v7 reportのpresence、BugHub delivery受理まで確認する。
- 本番FOXへのapplyは、目的・影響・戻し方をオーナーへ示して承認後に行う。

### 4. MarkItDownを初回導入できない

`bin/agents-update.sh`は`uv tool upgrade markitdown`だけを実行する。未導入hostでは失敗し、工場の初回展開にならない。

受入条件:

- 未導入時は正規の`uv tool install markitdown`、導入済みなら`uv tool upgrade markitdown`を選ぶ。
- uv不在、初回install失敗、upgrade失敗を製品名付きで非0記録する。
- absent→install、present→upgradeの両fixture testを置く。

### 5. update testがpackage集合の内容を固定していない

`tests/update/cron-env.sh`は主にnpm呼出し件数を検査しており、1製品を別packageへ置換して件数が同じなら見逃しうる。Windows native実行と、AIShell／Observer／peertableのpost-update gateも覆っていない。

受入条件:

- package名とhost条件を集合として検査する。
- Darwin、Darwin arm64、Linux／WSL、Windows nativeの期待集合をfixtureで固定する。
- 既存のtoolchain ledgerとThroughline migrationの契約を弱めない。

## 実配備の現在値

2026-08-11にBugHubの`/api/factory/v2/matrix`を独立2回取得した。wire v7の15 IDが返り、requiredな12製品は最終報告時点ですべて必要hostへpresence済みだった。したがって「全製品が未配備」ではない。欠陥は初回展開と継続更新の閉包、検証範囲、scheduler常設にある。

- `mac-kite`: 2026-08-11 16:17 JST報告。Lattice、AIShell、Observer、peertableを含むrequired製品はinstalled。ローカル`verify-install --profile official`もOK。
- `fox-wsl`: 2026-08-11 16:17 JST報告。Caveat `native_diagnostics`、Throughline `codex_hooks`がongoing high。
- `main-server`: 2026-08-11 16:17 JST報告。Caveat `native_diagnostics`、Throughline `codex_hooks`がongoing high。ServerManager `/readyz`は`factory_ingest: stale`で503。
- `windows-workstation`: 最終報告は2026-08-10 19:17 JST。Caveat `native_diagnostics`、Codex CLI `required_hooks`、Throughline `codex_hooks`がongoing high。Codex CLIの`last_update`もrecurred。host停止とscheduler停止を現状だけで決めつけず、Windows実機で切り分ける。

これらのlive issueは、今回のdotagents統合欠陥と製品側診断欠陥を混同しない。工場修理後に再scanし、残ったissueは修正所有repoごとに仕分ける。

## 既知の罠

1. launchd／cronの最小PATHでは、対話shellで見えるnpm global、uv tool、Grok等が消える。scheduler受入はrunner exit 0だけでなく、最新reportの`presence_status`とdelivery acknowledgementまで見る。既存`lib/factory/scheduler-path.mjs`の補完を壊さない。
2. 新しい`bin/*.mjs`を足した場合、scheduler登録前に`./install.sh`を再実行して`~/.local/bin` symlinkを配る。`install --apply`のrunner解決fail-closedは修理済みなので退行させない。
3. Windows Task Scheduler XMLはUTF-16LE+BOMを使う。ACLは`Set-Acl`で全sectionを書かず、DACL `Access`だけを読み書きする。存在判定をlocale依存の`schtasks`文言へ依存させない。
4. Windowsの受入は必ず実scheduled taskのbatch tokenから行う。SSH／対話PowerShellの成功だけでは`SeSecurityPrivilege`やPATH差を検出できない。
5. hook commandは環境依存の文字列一致で比較しない。node／scriptのrealpath identityと引数契約で判定する。Throughlineの既修理を再実装・退行させない。
6. scheduler applyの負側試験を実hostのlaunchd／Task Schedulerへ到達させない。使い捨て環境または登録操作を隔離したfixtureを使う。

関連Caveat:

- `launchd-cron-path-factory-scheduled-scan-missing-bughub-current`
- `dotagents-bin-mjs-launchd-cron-install-sh-local-bin-symlink-module-not-found`
- `dotagents-factory-reporter-scheduler-install-apply-runner-bin-success-fail-open`
- `schtasks-create-xml-bom-utf-8-xml-set-acl-batch-token-sesecurityprivilege`
- `legacy`

## 完了gate

最低限、次をすべて満たしてから完了とする。

1. 上記5欠陥のfocused testがgreen。
2. `make test-update test-install test-factory-scan test-factory-wire`がgreen。
3. Macで`./bin/verify-install.sh --profile official`が全適用製品を表示してgreen。
4. Windows Task Schedulerのdry-run／apply前検証／実task smoke／rollback手順が実測済み。実機applyはオーナー承認後。
5. MarkItDownの未導入host bootstrapと既存host upgradeをfixtureまたは隔離実測で確認。
6. 4現役hostの最新v7 reportが届き、BugHub `/readyz`の`factory_ingest`がpass。端末停止中なら停止事実を確認し、staleを成功扱いしない。
7. 工場統合を直しても残る製品別issueを、dotagents adapter／設定責務か製品所有repo責務か仕分けて報告。
8. README、有限契約台帳、host matrix、Makefile説明、テスト期待集合の製品数と内容が一致。
9. repoをcleanな独立commitにし、dotagents規約どおりorigin/mainへpushしてGitHubへ真実を返す。

## 変更しない境界

- LatticeへFOX固有の更新・Startup機能を戻さない。
- 製品内部DB／stateをdotagentsから直接解釈しない。
- `unsupported`／`not_applicable`／`unverified`を便宜的にpassへ丸めない。
- ServerManager専用Docker配備をnpm updaterへ押し込まない。
- Spotterとpeertableのproject別activationを全projectへ強制しない。
- 本番scheduler、credential、reporting flagを無断で変更しない。

## 新しいdotagentsセッションへ貼る依頼文

> `docs/handoff_factory-deployment-closure-20260811.md`を最初に全文読んで、dotagents工場の全製品展開閉包を修理して。BPR5はLattice側で退役済みなので、Latticeへ同機能を戻さないこと。まず`git fetch`、`lattice status --json`、関連Caveatと実コード、BugHubの現在値を確認し、監査で確定した5欠陥と修正範囲への見立てを日本語で返して。俺の反応後、dotagents側で実装・focused test・関連gate・文書更新・commit・pushまで完遂して。Windows本番Task Schedulerなど実端末への高リスクapplyは、目的・影響・戻し方を示して直前に承認を取って。`
