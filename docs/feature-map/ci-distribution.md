# CI選択・文書検査・配布接点

[全体入口](../09_feature-map.md) / [描画](ci-distribution.svg) / [原本](ci-distribution.mmd)。基準main `9fca2c8`、候補`257d8f8`のsourceを本文確認した現状図。CIの実起動やrunnerの現metadata・割当可能性を調べた結果ではない。

責任境界は[factory-ci runbook](../../shared/runbooks/factory-ci.md)。各製品のworkflow/判定/公開は製品repo所有で、dotagentsのreusable workflowを他製品へ適用する図ではない。dotagents自身のgateと配布入口の対応を記す。

## eventから最終合否まで

| 窓口・実関数 | 入力と所有する処理 | 拒否・取消・不明・保持 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | main push/PR、月曜03:30 JSTの週次、手動environment/base入力。contents:read、workflow/refまたはPR番号でconcurrencyを分けreusableへcommandを渡す | cancel-in-progressはPR eventだけ。手動実行は単一環境も選択可能。このsourceはjob停止/再起動/Host変更の許可ではない |
| `scripts/dotagents-ci-plan.mjs:comparisonBase/resolveCommit/createPlan` | PR=BASE_SHA、push=BEFORE_SHA、dispatch/tag=明示DISPATCH_BASE。commit解決/HEADより前のancestorを確認。scheduleだけ現在SHAを解決し全環境 | base欠測/zero/同一/非ancestor/未取得/未知eventは明示失敗。HEADやorigin/mainを推測baseにしない。diffはno-renames/name-only/NUL区切り |
| 同`classifyPaths/fullPlan/requestedEnvironments` | pathをdedup/sort。`.md`/`.mdc`のみはproductChange:false/Linux。host固有はLinux+該当host、共通/未分類/空差分は3OS。dispatch/tagは明示環境、scheduleは3OS | `.mmd`/`.svg`はMarkdown-onlyに入らない。今回の図差分も将来CIでは全環境選択になる。分類を軽くするため拡張子やpolicyを変えない |
| 同`writeGithubOutputs/main(plan)` | GitHub outputへproduct_change/comparison_base/environments JSONをappendし、理由をstdoutへ返す | output path欠測/書込・Git例外はstderr/exit2。途中outputだけで分類成功にしない。library exportsは環境列挙/分類/結果照合だけ |
| `factory-full-ci.yml:classify` | Linux labelでfetch-depth:0、5分上限。plan→文書だけなら依存導入とdocumentation-command | dependency/文書gate失敗もclassify failure。文書だけのfull skipはここで選択理由が成立した時だけ |
| 同`full` | 選択環境matrix、fail-fast:false、30分上限。checkout→availableParallelismをFACTORY_CI_JOBSへ→依存導入→同full-command | Windowsは固定Git Bash path。失敗した1環境のため他環境の結果を打ち切らない。job timeout/cancelを成功へ変換しない |
| 同`gate`→`verifyResults/main(verify)` | always()/Linux/5分。classify successかつproduct=true/full success、またはproduct=false/full skippedだけ成功 | 未知/欠落出力、分類失敗、選択済みfullのskip/cancel/failureを拒否してexit2。matrix全体のjob resultを受け、任意の一成功を全OS成功へ一般化しない |

Workflowに公開、release upload、実Host setup、独自のjob取消cleanup stepは無い。GitHubのjob状態と製品テストの完了は別で、途中実行のtemp/子processが全て回収されたとsourceからは保証しない。factory runnerのhost label指定を実online/空き/組織repo access成立へ読み替えない。

## Makefileのgateと実ファイル

full-commandは道具の版表示後`make --jobs="$FACTORY_CI_JOBS" ci`。Makeが外側CPU予算を所有し、Node testは各gateで`--test-concurrency=1`。独立gateの並列とtest file内部の並列は別であり、論理CPU数を固定値にしない。PythonはWindowsのpythonまたはtomllibを持つPOSIX候補を選択し、PWDはexportしない。

| target | 呼出し先・契約 |
| --- | --- |
| `lint-sh/lint-py/lint-js` | install/bin/testsの対象shebang shellをshellcheck、Python shebangのbin.shとlib直下.pyをpy_compile、bin/scriptsの.mjsをnode --check。全lib/factoryの再帰構文検査ではない |
| `lint-md/lint-constitution/lint-current-docs` | 固定markdownlint設定、共通憲法生成一致、current state生成drift/local link。各検査範囲は下記の実装どおり |
| `lint-skills/lint-hooks` | skills/smoke、4親hook smoke。設定・静的契約と本番session発火を区別 |
| `test-constitution/test-current-docs/test-pick-model/test-ci-plan` | generator/文書parser・生成/候補選定/分類と最終gateの専用fixture |
| `test-install` | 1Password隔離Python、4config/引用hook/旧interpreter/unai/root前提/runner登録/profile/clean HOME/3POSIX setup fixture。1Password本体や利用者accountを必要とするという意味ではない |
| `test-update` | source同期/public setup/npm退避/runtime context/finalize/TypeSafe/Jev/失敗報告、Throughline bootstrapとcron環境fixture |
| `test-core-authority` | Python5入口とNode3file。source authorityの固定fixture、実issuer/hostの有効化ではない |
| `test-oracle/test-factory-core` | 互換Oracle wrapper、工場互換入口/退役接点のshell smoke |
| `test-factory-reporter/test-factory-scan/test-factory-wire` | reporter/scanの各.test.mjs glob、wire-v* fixture。新reader testも既globへ接続済み |
| `test-lattice-cutover` | inventory/wire-v4 fixtureと`lattice-todo-inventory --verify-cutover`。Lattice製品内部へTODOを書き込まない |

`ci`は全target、documentation-commandはlint-md/current-docs/constitution/skillsとtest-constitution/current-docsだけ。Makefileで列挙/選択された範囲と、repoに存在する全fixtureは同義ではない。OS skipやsource-only検査を実OS導入成功へ格上げしない。全fixture本文と未接続fileの確認は[残り索引](scope-review.md)を参照する。

## 文書生成・local link検査の実体

`bin/render-current-docs.mjs:loadFacts/renderCurrentState`は配備契約をimportし、製品区分/現役wire/endpoint/runner集合の整合を検査して`factory-current-state.md`を生成する。`listDocuments`はroot内.md/.mdcを再帰列挙、.git/node_modulesを除外しsymlinkを拒否。`localMarkdownTargets/markdownNodes/htmlAttributeTargets`はCommonMark/GFM/HTML/srcsetからlocal参照を抽出し、codeを除き、先頭slash/scheme/fragmentだけの参照は検査しない。URL decode後に実path存在を検査する。

`HISTORY_PATHS`に合うarchive/ADR/migration/evidence/rag/一部plan等はlink検査を省略する。closed current path台帳の検査ではない。checkは生成drift/link違反でexit1、引数/例外はexit2、成功は0。writeはlink検査成功後に出力1fileをmkdir→PID temp→renameし、複数file transaction/fsync/temp finally掃除は持たない。

`bin/lattice-todo-inventory.mjs:inventorySources/parseMarkdownInventory`は固定commitのGit blobから、fenceを除くcheckboxと見出し/親階層を抽出してdigestを返す。`verifyLiveSourceCutover`は現在worktreeの固定2参照にcheckboxが無いことを確認。sourceRefは安全なrepo相対pathとuniqueを検査し、CLI不正/読取失敗はexit1。inventory結果を製品の実TODO操作や現場受入に代入しない。

## 配布入口・helperと責任境界

実配布は既[install/verify](installation.md)、[setup/更新](setup.md)、[更新確定](update.md)が所有する。package.jsonはprivateで、このCI workflowはnpm配布物をpublishしない。scripts/開発用render-current-docsは通常bin配布から除外される。source tree/libの相対importを保ったbinリンクと、親sessionでの認識を区別する。

今回本文確認した公開relayは`factory-deployment-contract.mjs`、`factory-toolchain-contract.mjs`、`factory-jev-setup.mjs`、`factory-typesafe-setup.mjs`、`factory-product-setup.mjs`、`factory-npm-retired.mjs`、`factory-gh-auth-status.mjs`、`install-unai.sh`、退役`setup-wsl-factory.sh`。正常値/JSON/公開exitは各library/製品へ委譲し、引数不正・固定理由/例外の返し方は入口ごとに保持する。Jevは既定3製品を順次処理し1件失敗でも続行、product setupはfailedだけ非0、unaiは公式installerの結果とexitをそのまま使いtempをtrap回収する。外部導入は実行していない。

`caveat-update-owner.mjs:caveatUpdateOwner`はownership markerのENOENTだけlegacy factory writerを許し、managed存在/不明を区別する。`npm-retired.mjs:clearRetiredPackage/removeTree`はretire名とpackageを検査し、消せないものを同volume renameでpark、残りがあればCLI exit20で入替を見送る。processを停止せず、copyへfallbackせず、残parkを全消去済みとしない。`lib/platform.mjs`は現行世代のPOSIX chmod差だけで、旧wire内部を自動統合しない。

Windowsの`windows-native-product-smoke.mjs:assertWindowsNativeProductSmoke`はwire9/profile/platform/全ID inventoryだけを検査しpassedを返す。全製品readyや実使用は検査しない。`windows-factory-runner-job-started.ps1`とdedicated relayは優先度/CPU割当のsourceで、marker引数は互換受理だけ、読取も待機もしない。失敗はwarningとexit0。今回実process/affinity/runner設定を変更していない。

## 旧文書との不一致・検証境界

旧[ADR0136](../adr/0136-document-ci-ownership-and-base-relative-immutability.md)は比較元を全document checkへ渡し履歴を保護する記述を持つ。現sourceではcomparison_baseはoutputに出すが後段commandへ渡されず、rendererの引数にもbase-refは無い。現在の文書検査成功をbase相対のarchive不変性確認へ拡張しない。上の図はこの現sourceを表し、旧ADRや履歴を今回書換えて裁定を変更しない。

factory-ci runbookにあったbusy marker待機の説明は、[第3設計](../adr/20261103-feature-map-responsibility-phase3.md)で現Windows hook/既fixtureの「互換引数のみ、読取も待機もしない」へ訂正した。実Host上の導入版/設定は未探索のまま。ADR0136の要件と実装差は解消しておらず、要件撤回や履歴検査成功とはしない。新policy実装・修理例外・共有基盤運用の引受へ広げない。

`tests/ci/dotagents-ci-plan.test.mjs`本文は文書/host/共通/未分類/空差分/混在/週次/zero SHAと最終gateの拒否、専有Git履歴/出力を確認する。`tests/docs/current-docs.test.mjs`本文は生成/区分不整合/reference/HTML/srcset/code除外/履歴link除外/引数/LFを確認する。unai installer fixtureの公開exit保持も読取。これらを今回実行したとはしない。関連source/test/fixture/config/exportの固定索引は当席phase13-source-review.json/phase13-contacts.txtへ保存。

今回はdocsのみ、既122/60/native13/4host反復なし。全fixture/残る実行source・外部caller・実OS、実CIと公開/本番、最終Astra整合は未確認。実credential/送信/Host/runner metadata/未知trust探索/停止再起動0。
