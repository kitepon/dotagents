# 公開診断・親配線・toolchain版の投影

[全体入口](../09_feature-map.md) / [現状図](diagnostics.svg) / [原本](diagnostics.mmd) / [旧scan](diagnostics-legacy.svg) / [保存・配送](delivery.md) / [更新台帳](toolchain-reader.md)

基準main `9fca2c8`、第2構造整理候補`619a953`からの本文調査。`scan.mjs`、`v5.mjs`、`caveat-diagnostics.mjs`、`toolchain-contract.mjs`とv6-v9の合成を確認した。候補`5c5890d`で[旧v2/v4個別診断](legacy-diagnostics.md)と[Caveat collector/非公開evidence状態](caveat-evidence.md)を追加調査した。外部製品の内部状態や実hostを観測した結果ではない。全fixture意味確認・CI/配布全体はまだ残る。

[外部イベント台帳と公開readiness](external-events.md)、[GPTの観測選択とRabbit一回保持](gpt-observation.md)へ保存/許可/ACKの実関数対応を接続した。

## 状態の所有と実関数

| 窓口 | 所有・入力と返却 | 失敗・保持 |
| --- | --- | --- |
| `scan.mjs:nativeCli/projectNativeStatus` | 旧wireの公開診断起動と状態投影 | 不正JSON/非成功/形不一致はunverified。旧固定Codegraph欄はnot_applicableで再導入しない |
| 同`latticeProduct/latticeNative` | `lattice factory-diagnostics --json`→版/overall | exitとoverallの整合を検査。ENOENTはmissing、timeout/不正はunverified。個別checkを再集約しない |
| 同`aishellProduct/aishellNative` | Mac profileだけ`aishell-mcp`にinitialize→factory_diagnostics。専用factory profileを渡す | 非Macは起動せずunsupported/not_applicable。ready/版/runtime metadataだけ投影し、内部issues/pathを転送しない |
| 同`codexSidecarNative/aitermNative` | 旧sidecar readiness/3package版照合、aiterm MCPのdiagnostics | 未確認/不整合をinstalled成功へしない。旧sidecarを現行の管理対象へ復帰させない |
| 同`projectServerManagerProbe/serverManagerNative` | serverだけ`bughub-external-probe --json`、外側7秒。固定6check/理由/版/revisionとexitを検査 | 不正/到達不明はunverified。database/schemaのfailはfatal、他はhigh。旧経路のresolution生成と現行scanでの除外は別段階 |
| 同`thirdParty/thirdPartyVersionCheck` | 旧MarkItDown/Oracleの版と対応major/minor、fixture/doctor | 版不明はunverified、prerelease/範囲外はunsupported。MarkItDown tempはfinallyで削除 |
| `v5.mjs:native/nativeResult` | 公開commandのstdoutをparseし、製品別parserで返却形を作る | parse失敗はunavailable。parser/exit不整合はcheckのunverified。runner自体のthrowは全scanへ伝播し得る |
| 同`throughlineDiagnostic/spotterDiagnostic/aitermDiagnostic/sidecarDiagnostic` | 記録に必要な版/status/部品だけを検証 | Throughline部品のstatus/reason、Spotter互換判定とexit、aitermの3部品、sidecar overallを各契約で検証。未使用製品内部を検査し直さない |
| `caveat-diagnostics.mjs:parseCaveatDiagnostic/parseCaveatComponents`→`v5.mjs:caveatChecks` | 製品overall/DB/migrationと固定部品を投影 | 出力にない部品は足さない。不正部品だけunverified。部品not_readyはwarn、fingerprintは製品+checkだけ。overallを部品から再計算しない |
| `v5.mjs:gptObservationProduct/projectGptConnectorFactory` | 選択済みentryの公開診断、版/状態/各checkを投影 | auth_requiredはskipped、他not_readyはfail。実runtime記録は製品が送る。readiness不明を新しい観測許可にしない |
| 同`npmGlobalPathEnv/npmCli` | npm global側の版、registry latest、既SemVer比較、親integration | global prefix/版のtimeoutはPATHの別導入に置換しない。非timeout読取失敗時は既fallback。registry不明/降格はunverified。インストール・更新は行わない |
| 同`claudeIntegration/claudeRequiredHooksPresent` | HOME settingsと固定PreToolUseのBash/PowerShell hookを検査 | 二重/欠落/command違いはrequired_hooks fail。検査がpassでもhookが実sessionで発火した証明ではない |
| 同`codexIntegration/canonicalCodexHookCommand` | features list、TOML routing/features、hooks.jsonの同期PreToolUse | parser timeoutはunverified、その他parser失敗はfail。config/hook不正は固定fingerprintのfail。設定は修復しない |
| 同`grok/grokUpdate` | `grok update --check --json`のstable公開契約 | spawn不成立はnot_applicable、timeout/不正/降格はunverified。内部updaterやautoupdate設定を変更しない |
| `toolchain-contract.mjs`の公開parse/compare群 | strict SemVer、npmの単一JSON/単一配列、Grok exact keys/版関係 | BigIntで比較、prereleaseの数字先頭0/複数latest/不整合を拒否。台帳readerの許容形式へ黙って適用しない |
| `v5.mjs:applyToolchainLedger/finalizeToolchainReport` | 既台帳のlast_update投影。finalizeは同IDの更新3製品だけ | 版/他診断/時刻を保持。launch可の更新失敗warn、最新版確認だけ失敗はunverified、gate失敗もunverified。旧wireのfailへ統一しない |

公開commandのtimeout/出力量・子終了は既`command.mjs`が所有し、原stdout/stderrをreportへ保存する窓口ではない。途中終了は完成reportの受付ではない。生成前の例外はscan CLI/runnerへ戻り、既queueを新成功で消さない。MarkItDownのfinallyも親process強制終了後のtemp清掃を保証しない。新しい取消APIや全scanのtransactionはない。

## v6-v9とregistered Caveatの接続

v6はv5の固定集合を版替えして保持。v7 `peertableProduct/projectPeertableFactory`は`PEERTABLE_URL`を空にして公開CLIのoverall/checkを投影し、LAN room接続を健全性へ結合しない。v8 `unaiProduct/projectUnaiFactory`は公開overall/checkとskill_projectionsを写す。両者は追加failureの時刻を元report.observed_atへ束縛する。未知fieldを製品内部まで検査せず、overallをcheckから再集約しない。

v9 `jevProduct`は対応OSで公開version、Jevのoffline metadata、checkout revision/browser-harness版を読む。GUI/runtimeはon_demand_onlyで起動しない。sidecarは最終結果でretired/not_applicableへ上書きされるが、先行v5の診断呼出しまで省略する意味ではない。通常scanは全世代合成を通して空ACKを返す。

v9 CLIの明示managed-entry時は`caveat-entry.mjs:createCaveatDiagnosticPort`を渡す。選択前後のdescriptorを取り、command/args/entry/登録hash/版のidentityを比較し、stdout版も照合する。製品所有`caveat-product/diagnostic-descriptor.mjs`が4client登録/選択payloadを判定する。失敗は固定拒否理由とunverified bindingへ写し、得られた通常診断を消したり旧PATHへfallbackしたりしない。evidenceはport内の保持値をcloneして返す。collectorの出力はhash/bytes receiptとして記録し、例外の自由文を公開理由へ出さない。

製品所有`read-host.cjs`とprivate evidenceの4純粋module/schema/状態fixtureは[詳細](caveat-evidence.md)へ接続した。通常managed診断のbinding原本と、実worker/OS pipe/raw保存を持たない未接続候補は別である。配布pin/実3OS/親全組合せ、実inventory/permit/trustは未確認。

## 全接点と検証の境界

公開exportはscan/lattice/aishell/ServerManager投影、v5の製品parser/GPT投影/scan/finalize、v7/v8 projector、v9 Jev、Caveat parser/部品表/表示、toolchain parse/compare。v5はscan.mjsの既adapterをimportし、v6→v7→v8→v9へ合成され、各scan CLI/runnerへ返る。旧v2/v4の個別投影は別実装で、同じ関数名や定数のliteral参照だけで同一契約としない。

参照候補を当席のphase8-diagnostic-contacts.txt/phase8-projection-contacts.txtへ固定した。動的runCommand、Caveat port、entry選択、外部callerは機械索引だけでは網羅を証明できない。設定面はHOME settings/TOML/hooks、npm PATH/APPDATA、台帳path、PEERTABLE_URL、AISHELL_TOOL_PROFILE。新しい設定や権限は足さない。

既fixtureは`tests/factory-scan`のaishell/lattice/servermanager adapter、caveat-diagnostics/components/sync-message/reporting-specificity、v5-aiterm-cursor、command-timeout、更新系toolchain fixture、およびwire-v7/v8/v9を対応先に持つ。今回aishell/servermanager/caveat-diagnosticsの本文を確認し、残るfixtureは接点索引と既調査に留まる。全意味確認・実行済みとはしない。コード変更のない調査なので既122試験や他host試験は反復していない。

## 維持する構造と残り

ここでは新しい構造整理案を追加しない。起動/parse/投影/世代合成は既に関数で辿れ、Caveat/各製品のoverall、重大度、fingerprint、旧wire、timeoutの意味に差がある。共通化のためのpolicy flagを先に作る根拠はない。新たな採否が必要なら、親hook/skill/modelとの全接点が揃った責務設計のまとまりでAstraへ渡す。

全体の[親hook/skill/model](harness.md)、[3OS setup/scheduler/公開setup](setup.md)、[GPTwriter/lease/authority](deployment.md)にも本文対応を接続済み。CIのsource接点は[CI配布](ci-distribution.md)へ接続済み。全fixtureの残部、動的/外部caller、実OSは未確認。Astraの判断は[全体レビュー](final-review.md)を参照する。1Passwordの現在接点も全体に含め、任意化の振舞い修理は全体完了後別差分とする。
