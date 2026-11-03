# 配送CLIと報告reader：実装済みの責務

[全体入口](../09_feature-map.md) / [配送・保持の状態](delivery.md) / [関数の現状図](delivery-functions.svg) / [原本](delivery-functions.mmd) / [採否と理由](../adr/20261103-feature-map-responsibility-phase2.md)

第2設計を同file内で実装した。設計時の提案図は履歴として残し、現在の関数対応は本ページを正本にする。公開CLI、引数、JSON、exit、8readerのexport名を保持する。

| 所有 | 実ファイル・関数 | 入出力と失敗 |
| --- | --- | --- |
| CLI受付 | `bin/factory-reporter-v5.mjs:main` | parse→config→path→有効時endpoint→handler。例外は既top-level catchへ |
| preview | 同`previewReport` | WIRE reader→identity→JSON。identity不一致をOFFでも拒否 |
| ローカル受付 | 同`enqueueReport` | report読取後、OFFならACK/identityに進まずstatsを返す。ONだけidentity/ACK/enqueue、原本を上書きしない |
| flushの起動と表示 | 同`flushReports` | OFFはstatsだけ。ONはstate→credential→lock→巡回→stats/JSON/診断/exit。最終statsはlock外のまま |
| queue巡回 | 同`flushQueue` | lock内でexpire→entry→retry日時→postOne→処分/counter。途中例外は残りを成功扱いせず上位へ |
| 一件配送とACK | 同`postOne`と既closure | 本文を変更していない。受理/分割/ACK/keep/dead/holdの状態は配送・保持の現状図を参照 |
| reportの共通読取 | `lib/factory/contract.mjs:readValidatedReport` | private。file errorは元error、UTF8/JSONだけ既文言へ、validator errorは元のまま。元Buffer/reportを返す |
| 公開reader | 同`readAndValidateReport`、`V2/V4/V5/V6/V7/V8/V9` | 8個のasync関数から対応validatorを渡す。公開名/引数を維持しcallerを置換しない |

v9 reporterはRabbit独自readerを引き続き使う。その同期read/bytes付き検証は共有helperへ含めない。`gpt-observation-entry.mjs`の未完readinessで選ばれる通常readerは公開V9関数を参照するが、今回readiness・実trustを変更/確認しない。

## 接点と確認

リポ内literal参照を追い、report readerは旧reporter v1/v2/v4、v5-v8のWIRE、GPT観測entryで参照されることを確認した。v9のimportと実際のWIRE選択は区別する。新しいexport/re-exportはない。v6-v9薄いCLIはv5をimportし起動basenameでwireを選ぶ。schedule runnerの動的major名、updaterのrunner選択、installのbin配置を保持する。外部repo callerと動的aliasの全利用は未確定。

共有JSは既CI分類で3OS full対象。新reader試験は`tests/factory-reporter/report-reader.test.mjs`で既`test-factory-reporter` globへ接続。追加OFF/混在queue試験は既wire-v9 gateに入る。旧v2専用directoryは既Makefileのglobに含まれず、今回の局所試験では明示して実行した。CI gateの改修はこの構造整理に混在させていない。

Linux隔離試験は関連120件と、その後追加した2件が成功（計122、失敗/skipなし）。対象は8readerの元bytes/欠測/不正UTF8-JSON/wire/製品/privacy拒否、v1/v2/v4への共有reader影響、v5-v9契約、v9保持/分割/ACK再試行、Rabbit一回fixture、OFF順序、混在queueの受理/保留/不正/延期とlock清掃。全体CI・実Mac/Windowsの実証ではない。既台帳reader60試験は反復していない。

reporterのmainより前（postOneを含む）は変更前と同一、queue本文は空白以外同一と照合した。新しいlock/fsync/retry/ACLを追加しない。取消/応答消失/ACK途中成功/cleanup途中失敗の保持は既状態図の契約内である。実credentialや実受信APIを使った送信は行っていない。

## 旧transportの追加本文確認

v2/v4 reporter全体を確認。専用endpoint/state/envelope、2MiB/128件/30日、PID lock、期限隔離、指数retry、受理後ACKという構成を持つ。通常409/413/422はdead、他HTTP/timeout/network/ACK失敗はkeep。巡回でdeferredも非0へ含める。v9の分割/無期限保持/controlled holdを旧wireへ投影しない。v2とv4の相違はvalidator/ACK/名前空間と製品集合で、今回共通化しない。

v1 reporterも全本文を確認。ACK metadataをOFF判定より前に読む点、identityがconfig.host不在を許す点、retry/deferredを持つv2以降との違いがある。v1にはretry/deferred sidecarがなく、ACK失敗製品名を集計する。file読取失敗はdecodeのcatch外で巡回全体へ例外となり、原本を残す。Windows owner ACLの専用処理もv2以降と同じではない。旧世代の文書やfixtureの成功を現行v9経路の証明へ流用しない。

[旧scanと診断接続の調査済み図](diagnostics-legacy.svg) / [原本](diagnostics-legacy.mmd)。scan.mjsの1〜180行とscanResult/mergeServerManagerExternal/公開scanを本文確認。旧scanはprofile/archを拒否し、観測時刻を固定して順次公開診断を起動する。Throughline/Spotterのschemaが不正・command不成功ならunverified、Caveatは専用parserとexit整合を確認する。collection ONの旧経路ではruntime収集/ACK候補が存在し、server側のactive fingerprintと衝突する解決/ACKをmergeが抑制する。これは通常v5-v9の空ACKとは別経路。git revision取得失敗はreport構築を中断する。診断は外部製品内部を管理する意味ではない。

残りはscan.mjsの181〜533行の個別診断/third-party処理とv5診断深部、親hook/skill/model、3OS setup/scheduler、GPTwriter/lease/authority、CI/配布全体。動的/外部caller・実OS・最終Astra整合も未完。1Password任意化は全体完了後の別差分とする。
