# 報告の保存・送信・ACK・保持

[全体入口](../09_feature-map.md) / [更新確定との接続](update.md) / [配送図](delivery.svg) / [原本](delivery.mmd) / [保持図](outbox-retention.svg) / [原本](outbox-retention.mmd)

第2設計の実装後のCLI/reader関数配置と旧wire追加確認は[実装済みの責務](delivery-functions.md)を参照する。以下の配送・保持状態は維持する。

基準main `9fca2c8`、reader整理候補`eac9a51`から本文確認した現状。v5〜v9が共有するreporter、fragment、runtime ACK、report/config契約、command、v9 scan wrapper、通常scanのACK生成、限定一回観測の保存を対象とする。古いv1/v2/v4のtransport本文と全製品診断内部は未調査。実送信・credential・Host状態は確認していない。

## 完了点と所有

| 所有する状態・責務 | 実ファイル/関数 | 接続と完了点 |
| --- | --- | --- |
| 診断の合成 | `lib/factory/v5.mjs:scanV5WithAcknowledgements`→v6/v7/v8/v9 | 公開診断/版/台帳をreportに合成。追加製品は元observed_atへ束縛。全診断関数の意味確認は未完 |
| report/ACK sidecar | `bin/factory-scan-v9.mjs:atomic` | reportとACK metadataは別fileへ順次temp→rename。2file一括transactionではない。後段失敗でreportだけ新しい場合があり、ID照合で後続処理は拒否する |
| payload/config/privacy | `lib/factory/contract.mjs:readConfig/validateConfig/validateReportVersion/readAndValidateReportV*` | UTF-8/JSON、固定wire集合、時刻/状態/重複fingerprint、safe_context allowlist、禁止key/valueを検査。受付契約の成功であり配送成功ではない |
| CLI/wire選択 | `bin/factory-reporter-v5.mjs:main/parseArgs`とv6〜v9薄い入口 | 起動名からmajorを選びendpoint/state/outbox schemaを分離。preview/enqueue/flushの公開入口を所有 |
| outboxと再送metadata | 同reporter `locations/envelope/decode/enqueue/retryInfo/postpone` | 元bytesと同IDのACK metadataを単一private envelopeへ保存。duplicateは同bytesのみ。enqueue成功はローカル受付まで |
| 送信排他/HTTP/処分 | 同reporter `withLock/postOne/expire/moveDead` | flush lock、POST、受理応答、ACK、delete/keep/dead/holdを所有。各境界の失敗は下表へ |
| 分割manifest/送信 | `lib/factory/report-fragments.mjs:createFragmentManifest/validateFragmentManifest/fragmentEnvelope/sendReportFragments`、reporterのmanifest I/O | 原report bytes/hashと固定UUID群を持つmanifestを再利用。全体受理確認までACKしない |
| 公開ACK | `lib/factory/runtime-errors.mjs:validateAcknowledgementBundleV*/dispatchAcknowledgements` | report IDと固定製品/command/args/cursorを検査し、公開CLIで順番にACK。返却cursorが要求以上か検査。製品内部stateは工場の所有外 |
| 子commandの完了 | `lib/factory/command.mjs:run/runProcess/terminateProcess` | timeout/出力量超過でPOSIX process groupまたはWindows taskkillを試み、closeで返す。親runner強制kill後の全子孫終了を保証する意味ではない |
| receipt | schedule runnerの`writeDeliveryReceipt`、`delivery-receipt.mjs:assertDeliveryReceipt` | finalizeのflush子成功後、ONかつ対応wireで同report ID/batchを保存。新report/batch一致をwrapperが検査。受信UI反映の証明ではない |

**現在の通常scanはACK項目を生成しない。** v5が空配列を作りv6〜v9が継承する。LatticeとServerManager外部eventのruntime記録は製品が自分で送る。工場がsnapshotを収集し直す経路を図から追加しない。runtime adapter/ACKの公開契約と、既保存・明示入力bundleを配送できる経路は残っている。v9はcodex-sidecarを対象外へ投影しACK候補も除く。

## 保存と制限

stateはmajor別`factory-reporter-vN`にoutbox/dead-letter/retry/flush.lockを置く。state directoryの種類/mode/Windows ACLを検査・設定する。これは各outbox itemのsymlinkや競合すべてを同じ強さで検査する保証ではない。entriesはstat、decodeはJSON/metadata/bytesを検証する。

全majorのqueue件数は128。容量はv5〜v8が2 MiB、v9が256 MiBで、ACK envelopeのbase64分も数える。上限時は既queueを保持して新規reportを拒否する。enqueueは一時fileのexclusive作成→rename/finally清掃で、fsyncを実装していない。flushのmkdir/PID lockはenqueue全期間の排他ではない。同ID衝突検査を複数enqueue全体のtransactionと扱わない。

v5〜v8はmtimeで30日超のoutboxをdead-letterへ隔離。v9は期限で自動除外せず受理まで保持する。dead-letterは削除ではなく原本の移動。moveDeadはretry recordを消すがfragment sidecarの一般清掃は行わない。成功時のoutbox/retry/manifest削除も複数操作で、途中終了なら付随fileが残り得る。

retryはattempt最大16、100 msから指数増加し最大60秒。日時未到達はdeferredとし、同じflushで待機しない。retry fileは直接writeであり原本との一括transactionではない。生存/判定不能のflush lockは拒否、死んだPIDだけ回収候補。上位のschedule runnerは別のnonce lockを持つ。両者を全更新共通leaseとしない。

## 受理・失敗・不明の分岐

| 条件 | 原本/返却/次の処理 |
| --- | --- |
| reporting OFF/設定欠測 | reporterはnetworkを起動せず既queueを保持。enqueueしない。statsのためstate directoryは作り得る。schedule runnerは設定欠測を別途拒否 |
| enqueue前の不正report/identity/ACK | 非0。原queueを成功送信扱いにしない。ACK commandはbundleの固定allowlist外を拒否 |
| malformed outbox/host不一致 | POSTせずdead-letterへ隔離 |
| 通常POSTのokかつaccepted=trueかつ同report ID | ACKがあれば実行。全ACK成功後にdelete。HTTP成功だけでは削除しない |
| v5〜v8の409/413/422、v9通常POSTの409/422 | dead-letter。v9の413は別の保持/分割分岐 |
| 401/429/500等、accepted偽/ID不一致 | keep→postpone、原bytes保持。response.okでも受理条件を満たさなければ削除しない |
| timeout/network/応答消失 | keep。同じbytesの再POSTが可能で、相手が処理済みかはこの結果だけでは不明。unreachableに数えHTTP拒否と区別 |
| ACK途中失敗/応答不正/timeout | keep、ack_failed、非0。先行製品ACKを巻き戻さず、次回同reportの再受理後にbundle全体を再試行 |
| queue削除やsidecar清掃中の失敗 | 上位へ例外/非0。既に完了した受理/ACKは巻き戻さない。残ったfileと元状態を次工程へ渡す |
| deferred/dead/retained/ACK失敗/heldが一件以上 | flushはok=false/exit1。queue全体の成功と個別reportの受理を同一視しない |

通常POSTは10秒のAbortControllerを持つ。ACK CLIは各10秒/256 KiB上限。公開ACKの先行成功を取り消す処理は無い。受理の後、ACK前に強制終了した場合も再送可能な原本が残る。元reportを消した後の実UI反映はここでは観測しない。

## v9の分割と限定一回観測

通常v9 POSTの413が`report_too_large/split_supported/正のlimit_bytes`を返した場合だけmanifestを生成する。原本最大128 MiB、chunk最大1 MiB、最大128片。元bytesをそのまま切り、report/fragment hash、観測時刻、固定fragment IDを付ける。manifestはtempのsync→rename、POSIX directory syncまで行い、再送でUUIDを振り直さない。

各fragmentはredirect:error/10秒。202の片受付は完了ではない。200/accepted/complete/同report ID/同report hashで全体受理とし、その後ACKへ進む。全片202でも完了応答が無ければ原本/manifestを保持。manifest不正、分割失敗、409/413/422等のfragment応答も保持し、通常POSTのdead分岐へ丸めない。再送時は固定manifestの先頭片から送れる。staging期限や相手側dedupeは相手製品の契約であり内部をここへ複製しない。

`rabbit-observation-once.mjs`はcontrolled reportだけ別扱い。permit/主体/path/供給/窓/保存原本の照合、一回capture/send claimをfsyncして固定し、窓外・予算消費済み・失敗時はheld-outboxへhardlink→内容照合/sync→元outboxからunlinkする。controlled reportはredirect:errorで一回、分割fallback/自動再送を足さない。permitはOwner承認の独立証明ではない。固定scopeの実状態やGPT readiness/trustは未確認で、今回再開・探索していない。

## caller・fixture・exportと未確認

schedule runnerがscan→同ID report/ACK保存→必要時enqueue→flush→receiptを呼ぶ。日次updateのpost-updateはscanし旧queueのflushも行うが、新観測をenqueueしない。finalizeは既IDへ台帳だけ再投影する。その他に手動CLI preview/enqueue/flush、v6〜v9薄い入口、bin配布symlinkがある。外部caller/動的alias全利用は未確定。

関連fixtureは`tests/wire-v5`〜`wire-v9`、`tests/wire-v9/report-fragments.test.mjs`、`tests/factory-reporter/{runtime-error-ack,factory-reporter,scheduler}.test.mjs`、`tests/factory-scan/{runtime-errors,product-owned-runtime-errors,rabbit-observation-once,command-timeout}.test.mjs`。今回はfragmentのfake intake/ACK/部分失敗・終端消失・固定片再送、product-ownedの空ACK、旧wire fixtureとの区別を本文で確認。全fixtureの意味確認/試験再走はしていない。

exportはfragment4関数、config/report検証/読取/identity、runtime bundle/collect/ACK群、commandのrun/timeoutReason等。reporter binはCLI契約でトップレベルmainを起動し、queue/HTTP内部関数をlibrary exportしていない。`runtime-context.mjs`は現processの設定presenceだけを記録し、証明範囲を限定する。CA store探索やTLS probeではない。

このまとまりは現状図の追加。[第2責務設計](../adr/20261103-feature-map-responsibility-phase2.md)にCLI/巡回と共有report readerの採用案、配送・保持の維持理由を接続した。提案は未実装。未読は旧transport、scan.mjsの全製品診断、v5の個別診断深部、親hook/skill/model、3OS setup/scheduler、GPT writer/authority、CI/配布全体。機械参照の件数を全caller意味確認にしない。
