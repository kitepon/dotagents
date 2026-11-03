# GPT観測入口とRabbit一回枠

[全体入口](../09_feature-map.md) / [診断](diagnostics.md) / [配送](delivery.md) / [writer・authority](deployment.md)。base `9fca2c8`、候補`f05b395`のsource本文を確認。[描画](gpt-observation.svg) / [原本](gpt-observation.mmd)。実permit・実観測・credential・Hostへ接続していない。

## 同reportの観測と通常入口

`gpt-observation-context.mjs:readGptObservationContext`は7個の固定keyと文字列enumだけを受け、descriptorを検査してgetterを呼ばずclone/freezeする。空/省略は省略、部分群/未知key/矛盾は固定error。HTTP非2xxのuserはuninspected、bridge不在時の部品もuninspectedを要求する。

`preserveGptObservationChecks`はnative checkと同indexの観測を明示enabled時だけ投影へ残す。`validateGptObservationReportV9`はGPTのchecks/runtime_errors上の群を検査し、拡張だけを除いたcloneに既v9の全privacy/status/製品検証を適用する。原reportと履歴所属を変更しない。`projectSameReportGptObservation`は現checksの全非空群が一致する時だけreport_id/host_id/時刻/任意版と群を返す。履歴を現観測へ混ぜず、不一致/省略はnull。中央保存・画面表示・元HTTPの取得処理はこのmoduleに無い。

`gpt-observation-entry.mjs:createGptObservationEntry`はsource側のcentral release/validator/product CLI/factory entryの4採用factを検査し、argv・projector option・validator・readerを一組に固定する。これはreceiptの独立検証器ではない。`LEGACY_GPT_OBSERVATION_ENTRY`はfactなし、`DEFAULT_GPT_OBSERVATION_ENTRY`もproduct_cli_adoption:nullなので閉じたまま。env/config/report内の値だけで開かない。

閉じた入口は通常`factory-diagnostics --json`一回と既readerを使う。全fact成立時だけ`--include-observation-context`と専用validator/readerを使い、file errorとUTF8/JSON/validator errorの返却境界を保つ。`v5.mjs:gptObservationProduct`→`projectGptConnectorFactory`は既status/reason/版を保持し、parse/投影不成立はunverifiedへ返す。v9 CLIはDEFAULTを渡し、既v5-v8の既定LEGACYと区別する。

## Rabbitの取得・送信・保持

`rabbit-observation-once.mjs:createRabbitObservationOnce`は固定JSON scopeをclone/hashする。scopeのprincipal/pathはhistorical_expected_readback_requiredで、既知の過去期間は**2026年10月26日05:15〜05:25 JST**。scopeを現在のHost状態や新しい承認へ読み替えない。通常sourceに新しいscope/許可/期限を補わない。

| 実関数 | 条件・所有する原本 | 部分失敗・不明・保持 |
| --- | --- | --- |
| `parent/read/once` | Linux/uid、正規実directory0700・非symlink、所有file0600・size境界。O_NOFOLLOW/NONBLOCKで読取、O_EXCLで一回原本作成、file/parent fsyncと読戻し | parentを自動作成しない。既存claimはfalse。途中write/fsync失敗の原本を消して枠を復活しない。permit欠測/不正はnull |
| `permit` | approved-permit.jsonのscope hash/Owner参照形式/供給receipt/Host読戻し/版/hash/期限/4readiness/各一回予算を照合 | ローカル原本はoperator supplied factで、Owner判断やissuerの独立証明ではない。現物を今回探索していない |
| `begin` | host/実uid/platform/現在時刻/permit→capture.claim.jsonを先に予約→entryと固定reportIdを返す | 不成立はnull。予約後の子command失敗でも二度目を許さない |
| `finish/validateControlled/validateReport/readReport` | 観測時刻/host/profile/installed版/reporter revision/claimを束縛。captured-report.jsonへ上限内の正確なJSON+LF bytesを一回保存、再読は完全bytes一致 | finishは現在時刻ではなくreport.observed_atの固定窓を検査する。通常reportはDEFAULT検証、controlled reportはpermit欠測/原本不一致を拒否。file/decode/validatorの例外を残す |
| `claimSend` | exact captured reportと現在の窓を検査し、send.claim.jsonをPOST前に予約 | 枠使用済/期限外はfalse。POST前停止でも枠を戻さず、結果不明を再送しない |
| `recordSend` | send.result.jsonへHTTP status/accepted/時刻を一回保存 | HTTP受理と製品ACK完了は別。保存失敗から中央未受理を推定しない |
| `holdOutbox` | 固定outbox名/所有modeを検査しheld-outbox.jsonへhardlink、同bytes読戻し/file-parent fsync後だけ元queueをunlink/queue fsync | 保留原本とcaptured原本を維持する。失敗を削除成功にしない。自動再試行/期限掃除/claim取消の窓口なし |

`bin/factory-scan-v9.mjs`はcollection ONかつ明示一回flagでbegin、通常scan一回、identity検査、finish/validateの後にreportとACKを別々にtemp→renameする。途中失敗はexit1で原本/claimを保持し、report/ACK二fileのtransactionや全temp清掃は持たない。通常runnerはv9のpost/finalize以外のcollection時だけflagを渡す。固定scopeの期限を延長しない。

`bin/factory-reporter-v5.mjs`のv9 WIRE reader/validatorと`postOne`がこの窓口を使う。controlled reportはclaim済ならhold、初回POSTはredirect:errorで一回。分割・413 retryへ進まず、HTTP不成立/network/timeout/ACK失敗はholdする。肯定的受理とACK成功時だけqueue削除。通常reportはこの一回枠を消費せず、既retry/fragment/ACK契約に従う。raw token/body/HTTPを今回採取していない。

## 接点とfixture

library import callerはv5 projector、v9 scan、v9 WIRE経由reporter、専用fixture。scope JSONはmodule相対で読み、installのbinリンクは元source tree/libとの相対接続を保持する。公開exportとliteral caller候補は当席phase14-contacts.txtに記録。`projectSameReportGptObservation`の非test内部callerはliteral検索で未確認であり、UI配線済みとはしない。

専用`gpt-observation-context.test.mjs`/`gpt-observation-entry.test.mjs`/`rabbit-observation-once.test.mjs`本文を確認した。省略/矛盾/getter拒否/通常閉鎖/全fact/元bytes、一回予約・期限/unsafe permit/部分claim/誤版・source/hold/偽transport1回を扱い、scan gateへ接続。Rabbit fixtureはLinux限定caseを含む。既成功試験は今回再走していない。実供給/承認/Host・中央表示の受入をfixtureから補完しない。
