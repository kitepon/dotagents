# 配送・保持・報告読取りの責務整理：第2設計

日付: 2026年11月3日。所有者: Dotagents。状態: 下記二点を採用、Solによる接点確定・実装待ち。main基準は`9fca2c8`、調査済み候補は`625a961`。Astra xhighの適用済みを確認して設計した。全体の最終整合確認ではない。

[全体入口](../09_feature-map.md)→[配送・保持の現状](../feature-map/delivery.md)を根拠とする。現状の状態遷移と失敗表はそちらだけを正本とし、本書は整理の採否と実装条件を所有する。[提案図](../feature-map/delivery-design.svg) / [原本](../feature-map/delivery-design.mmd)は未実装の構成である。

提案図は関数と依存の配置を示す。受付から失敗・取消・保持への遷移は現状図を維持し、次の表で返却と例外の境界を指定する。

## 採用する二点

1. `bin/factory-reporter-v5.mjs`の`main`からpreview、enqueue、flushのコマンド処理とqueue巡回を、同じファイル内の非公開関数へ分ける。新module、CLI、設定、exportは増やさない。
2. `lib/factory/contract.mjs`の8個の`readAndValidateReport*`に重複するfile読取り・UTF-8/JSON decode・既存validator呼出しを、同じファイル内の非公開`readValidatedReport(reportPath, validate)`へまとめる。8個の公開async関数とwire別validatorは残す。

前者は、一行の`main`に集まった受付・巡回・結果表示から、故障した段階へ直接辿れるようにするため。後者は、どのwireでも同じ読取失敗を扱う実装が8か所あるため。いずれも既存の所有ファイルで閉じ、共有stateや汎用配送基盤は新設しない。

## CLIとqueueの所有

以下の名前は実装先の具体案であり、現状の関数として記載しない。既存の`parseArgs`、`WIRE`、state helper、`postOne`は現在の窓口を使う。

| 計画する非公開関数 | 所有する責務・返却 | 保持する順序 |
| --- | --- | --- |
| `main()` | 引数、config、state path、wire endpoint検査、コマンドへの振分け | 現在の順序のまま。top-levelの`main().catch(fail)`へ例外を返す |
| `previewReport(config, options)` | 入力reportの読取・identity確認、preview JSONの出力 | read→identity→emit。stateを先に作らない |
| `enqueueReport(config, loc, options)` | reporting設定に応じたローカル受付と出力 | read→OFFならstats/出力で終了。ONだけidentity→ACK metadata→enqueue→stats/出力 |
| `flushReports(config, loc)` | flush開始条件、credential、lock、結果表示・exit | OFFならstats/出力のみ。ONはensureState→credential→withLock→結果/再集計→診断/exit |
| `flushQueue(config, token, loc)` | lock内の期限処理・順次巡回・処分と集計 | expire→entries→retry日時→postOne→action別保存操作→counter。既outcome objectを返す |

`flushQueue`は`withLock(loc, () => flushQueue(...))`の内部からだけ呼ぶ。lockの獲得、credentialの読取、最終statsを巡回関数へ移さない。各handlerは今のJSONを出力し、汎用の結果型やhandler registryは作らない。共通状態は既`WIRE`と定数のまま、context objectへ詰め直さない。

queueの処分とcounter更新は一つの巡回関数に残す。削除・隔離・延期がどこまで完了したかを同じ場所で読める。処分ごとの小さなwrapperや、actionを解釈する別moduleは今回不要である。

## 保持する配送の境界

`postOne(config, token, loc, entry)`は一件の配送判定を所有する窓口として**維持**する。内部の`retainFailure`、`complete`、`sendFragments`は既に役割を持つclosureであり、外へ出さない。元report、bytes、ACK、controlled状態を複数の関数へ受け渡す費用に対し、独立した再利用先がない。

| 窓口・状態 | 今回の決定と理由 |
| --- | --- |
| decode/identity | `postOne`の入口に維持。malformedとhost不一致はPOST前にdead判定する。enqueue時だけの検証で代替しない |
| controlled claim/hold | `RABBIT_OBSERVATION_ONCE`に維持。`postOne`の`hold`返却は既に保全を実行した後。巡回側は件数を数えるだけで、再度holdやretryを行わない |
| 通常POSTと既manifest | `postOne`に維持。既manifest再送、通常POST、413からのmanifest作成という順序とcatch境界を保つ |
| 受理後ACK | 内部`complete`に維持。通常受理・fragment全体受理の双方から同じ経路を使い、全ACK成功後だけdelete actionを返す |
| 通常失敗と限定一回失敗 | 内部`retainFailure`に維持。通常keepとcontrolled holdを共通retryへ丸めない |
| fragmentの仕様と送信 | `report-fragments.mjs`に維持。固定bytes/hash/IDと全体受理判定を所有し、manifest fileの保存・ACLはreporterに残す |
| queue処分 | 新`flushQueue`が既mainの操作を引き継ぐ。deleteは原本→retry→manifestの順。deadは既moveDead、keepは既postpone。成功した操作だけを数える |
| 公開ACK/command | `runtime-errors.mjs`/`command.mjs`に維持。allowlist、cursor、逐次ACK、timeout/出力量と子終了を変えない |
| receipt | schedule runnerに維持。個別受理から直接発行せず、finalizeでのflush成功後という既条件を残す |

actionは純粋な「これからする処分」だけを表さない。`hold`の保全、claim、manifest保存、先行ACKなどは返却前に起きる。HTTPとACKを一括transactionやrollback可能な処理へ見せる新しい結果型は採らない。

`return complete()`や`return sendFragments()`を機械的に`return await ...`へ置換しない。promiseの失敗がどのcatch/finallyを通るかも保持契約である。timeoutの範囲、先行ACK、受理後の取消/結果不明、途中cleanupを変える整理は、この採用範囲に含めない。

## 報告読取りの所有と公開契約

対象は`readAndValidateReport`、`readAndValidateReportV2/V4/V5/V6/V7/V8/V9`の8関数。wire 3を新設しない。各公開関数は現在のasync宣言・名前・一つの引数を維持し、対応する既validatorを非公開helperへ渡す。`validateReportVersion`と同様に既contract内で同型処理を集約するだけで、validator registryやplugin機構は作らない。

| 条件 | 維持する内容 |
| --- | --- |
| read | `readFile(reportPath)`をdecodeのtryより前に置く。file欠測・permission等の元errorをJSON errorへ包まない |
| decode | 既fatal UTF-8 decoder→JSON.parseの順。失敗は既文言`report JSONが不正です`だけに写す |
| validate | decodeのcatchの外で、各既validatorへ`report`だけを渡す。validatorの入力集合・戻り・throwを変えず、bytesやpolicyを追加しない |
| return | 読んだ元Bufferとparseしたreportをそのまま`{ bytes, report }`で返す。再serialize、正規化、cloneを行わない |
| state/取消 | 読取り以外の副作用、timeout、lock、retry、temp作成を加えない。I/Oや検証の失敗は既callerのcatchへ返す |
| v9限定窓口 | reporterの`WIRE.readReport`は既Rabbit wrapperのまま。これは独自の同期readと`validate(report, bytes)`を持ち、8readerのhelperへ含めない。通常v9 readerへの直接置換でcontrolled gateを迂回しない |

helperはexportしない。公開関数を削除したり、callerを新しい汎用関数へ移したりしない。既validator/ACK/scanの型やexportを変更する必要はない。

## 見送る代替案

| 案 | 判断と理由 |
| --- | --- |
| mainは一行のまま、説明だけ追加 | 不採用。コマンド受付、巡回、結果表示の責任をコードの関数へ辿れない。上記の同file内整理が必要 |
| queue/HTTP/CLIを新moduleへ全面分離 | 今回不採用。wire選択、diagnostic、ACL、state path、controlled gate等の受渡しが増える。同file内の所有分離で今回の問題を解決できる |
| postOneを通常/controlled/fragmentの汎用policy executorへ統合 | 不採用。再送可否、413/永久拒否、holdの副作用、ACK後の保持に実際の差がある。policy flagを増やす根拠がない |
| 8readerを現状の複製のまま維持 | 不採用。同じI/O・decode・失敗写像を一か所へ辿れる効果があり、private helper一つで足りる |
| report readerを新libraryへ公開し、全callerを置換 | 不採用。既contractが既に検証の所有者。外部callerへの破壊と追加exportを必要としない |
| 通常scanの空ACKを理由に互換ACKを削除 | 不採用。明示入力・既保存bundle・公開ACKの契約が別に存在する。旧v1試験をv9の実証とみなさない |
| 全stateのlock/fsync/cleanupを統一 | 保留。現状の保証差を維持する。今回のsource観測からsecurity例外や保持修理を開始しない |

## 次のSolで確定する全接点

この設計は既読の責務を比較したものであり、下表の全caller/fixture本文調査を済ませた意味ではない。literal索引は手掛かりに留める。確認できた範囲と外部/動的利用の未確定を記録してから実装する。

| 対象 | 実装前の確認と検証条件 |
| --- | --- |
| reporter CLI/alias | v5本体、v6〜v9薄い入口、拡張子なし配布名、schedule runner、updater、runbook/手動CLI、child-process fixtureを追跡。起動basename・major・endpoint/state/schema・top-level失敗codeを保持 |
| contract caller/export | 8readerの全import/re-export/呼出し、旧reporter v1/v2/v4とscan/runner、Rabbit wrapperを追跡。公開関数名・async/引数・Buffer返却・error境界を保持 |
| CLI分岐 | preview、enqueue ON/OFF、flush ON/OFFを隔離config/stateで確認。OFF enqueueはreportを読むがidentity/ACKを検査しない順序、enabled時のendpoint検査、stdout JSON/stderr/exitを保持 |
| queue/ACK fixture | `tests/wire-v5`〜`wire-v9`と`tests/factory-reporter`の実使用wireを区別して読む。duplicate/collision/capacity、期限差、deferred、lock、delete/dead/keep/hold、混在結果のcounter/診断優先順位を確認 |
| fragment/controlled | `tests/wire-v9/report-fragments.test.mjs`と`tests/factory-scan/rabbit-observation-once.test.mjs`の隔離fixtureを確認。全体受理前保持、固定manifest再送、終端応答消失、ACK失敗、一回予算hold/自動再送なしを保持 |
| readerの拒否試験 | 各世代の既report fixtureで元bytes/同じreportを確認。欠測の元error、不正UTF-8/JSONの共通error、wire/製品集合/privacy等validator errorの非置換を小さなparameterized試験で確認 |
| test/fixture/config | 既fixture builder/child helperを使う。必要な未カバー分岐だけを既wire/reporter testへ足す。source文字列検査があれば期待を無意味に削らず、新責務へ追従する |
| 配布/CI | 新module/CLI/configは不要。既Makefileのreporter/wire test glob、CIの共通JS分類、3OS契約を確認。新testは既gateで実行される場所へ置く。旧v2専用fixtureの既gate所属も確認し、wire globに入ると推測しない |

試験は実credential/実送信を使わず、既隔離HOME/state・fake intake/commandの方式で行う。既v1/v2/v4 fixtureは共有readerへの影響確認には使えるが、v9 queue/ACK経路を検証した根拠にはしない。

関連moduleの構文、共有readerのfocused試験、変更するreporterの既wire/fragment/制御fixtureを実行する。既台帳reader60試験や4host照合は、今回変更しない限り再走しない。実OS・最終CIを局所Linux確認で代用しない。新しいskip/権限/設定を通過条件へ足さない。

## 次のまとまりと完了条件

最新Sol Highの適用後に、接点調査→二点の構造整理→現状図/実関数対応の同期→関連検証を一つのまとまりとして進める。契約を保てない変更候補だけを止め、理由と影響を記録する。図を描画して目視し、提案から実装済みへの接続を明示する。

続けて、未読の旧transportと製品診断深部をSolで本文調査し、現役/互換/退役の窓口、入力・失敗投影・取消/不明を全体図へ接続する。その後も親hook/skill/model、3OS setup/scheduler/製品公開setup、GPT writer/lease/authority、CI/配布を残す。全体を配送や1Passwordへ縮めない。次の責務設計が必要なまとまりでAstraへ切り替える。

この設計の完了条件は二点の採否と保持/接点/次工程の確定であり、実装完了でも全体完了でもない。全体の最終Astra整合、指導担当の成果確認、既承認手順での公開/反映は別工程。1Password任意化は全体完了後の別差分、既選択の任意連携は保持する。限定Mac自然受入とSEC002本人later、Host/他製品/他writer/実trustの既境界を変えない。

## 第2実装への接続

採用した二点を実装し、[現在の関数配置・公開接点・検証](../feature-map/delivery-functions.md)へ接続した。上の未実装表記は設計時点の記録である。全体調査と最終Astra整合は継続する。
