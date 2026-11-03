# source同期・日次更新・台帳確定・失敗報告の現状

[全体入口](../09_feature-map.md) / [更新確定の描画](update-finalization.svg) / [原本](update-finalization.mmd)

基準main `9fca2c8`。updater/source同期、toolchain台帳、失敗記録/送信、v5共通schedule runner、finalizeToolchainReport、receipt検査の該当本文を確認した。更新・送信・credential読取・Host操作は今回実行しない。製品公開setupの内部、診断全体、transport全分岐、OS schedulerは別の詳細調査を残す。

## 責任と状態所有

| 所有者・入口 | 実装・状態 | 受渡し・完了点 |
| --- | --- | --- |
| source同期 | [agents-source-update.mjs](../../bin/agents-source-update.mjs)のexport `updateSource`とCLI | checkout root realpath/main/origin/追跡dirtyを検査、fetch→ancestor→ff-only。成功/失敗JSONを既logへappendしBashを再open。失敗flagを渡して製品更新は続ける。append不能や再起動不能は別の失敗 |
| 更新の順序/集約 | [agents-update.sh](../../bin/agents-update.sh) | PATH/NVM復元、deployment契約のOS/arch集合、npm/Grok等の公開更新、製品setup、後段報告を所有。`--setup`ではself-syncしない。更新成功と報告成功を別flagで持ち、どちらか失敗ならexit1。終了結果は`tee`経由で既logへ残す |
| 3CLI更新台帳 | [factory-toolchain-ledger.mjs](../../bin/factory-toolchain-ledger.mjs)の`parse/validateLedger/withLock/atomic` | `toolchain-ledger.json`のclaude-code/codex-cli/grok-buildを工場が所有。operationとpost-gateを別項目にし、前半pending→後半success/failedをrecord。親はhelper失敗を検出して後段の送信を抑止 |
| 公開version/更新JSON契約 | [toolchain-contract.mjs](../../lib/factory/toolchain-contract.mjs)の`parseStrictSemver/compareSemver/parseNpmLatestJson/validateGrokUpdateCheck`、bin wrapper | strict SemVerとnpm単一結果、Grok stable JSONのexact keys/前後版を検査。downgradeを拒否。parser入力上限と公開safe codeをbinが所有 |
| 診断と最終投影の順序 | [v5共通runner](../../bin/factory-reporter-v5-schedule-runner.mjs)、v6〜v9薄い入口、[v5.mjs](../../lib/factory/v5.mjs)の`finalizeToolchainReport` | private stateのlatest-report/latest-acksを所有。post-updateはscanしてreport IDを返し、finalizeで同reportの3CLI last_updateだけを再投影。report_id/observed_at/他製品の診断を保持。CLI status successは全製品checkがpassの意味ではない |
| toolchain投影 | `readToolchainLedger/applyToolchainLedger` | 台帳が不正/不在ならunverified。pending/後段gate失敗/版driftを区別。CLIが起動できる観測を基にwarn/high等を投影する。schema/許可reason等がwriterとreaderに各々存在する |
| 配送receipt | [delivery-receipt.mjs](../../lib/factory/delivery-receipt.mjs)の`assertDeliveryReceipt`、runnerの`writeDeliveryReceipt` | finalizeのflushコマンド成功後、reporting ONの対応wireでreport ID/batch tokenを保存。Windows日次wrapper/host setupがfresh IDと同batchを検査する。receiverの画面反映確認をreceiptの意味へ追加しない |
| 工場自身の更新失敗 | [factory-update-failure-report.mjs](../../bin/factory-update-failure-report.mjs)→[update-failure-report.mjs](../../lib/factory/update-failure-report.mjs) | 別の`update-failures.json`とopt-in設定を所有。ran/failedの固定step名/回数/時刻だけで記録。製品CLIのエラー本文は載せない。保存失敗をupdaterはWARNにし、更新・通常報告の結果flagは上書きしない |

`record_toolchain`は通常toolchain更新の台帳であり、GPT deployment writer/lease/store/trustの台帳とは別物である。両者の排他・原子性・受入条件を混同しない。

## 更新の分岐と保持

`updateSource`は許可したorigin形式とmain/cleanを要求し、stash/resetを行わない。衝突する未追跡ファイルもgitのff-onlyにより保持する。同期失敗の後も旧/現在のsourceで更新を再開し、`DOTAGENTS_SOURCE_UPDATE_FAILED`がdotagents-source失敗として後段記録へ入る。git子には120秒上限、Bash再起動自体にはこの入口の独自timeout/全更新rollbackは無い。

updaterは各製品のエラー後も残りの製品・報告へ進む。Claude/Codexはbefore/latest/after/operationを台帳へ運び、最新版不明・downgrade・既に最新・入替失敗・後続版不明を分ける。Caveat更新ownerがfactoryでなければnpm install/initをskip、Throughlineは公開self-update/初回installへ渡し内部出力を解釈しない。MarkItDown/unai/Grok/TypeSafe/Jev/他製品setupの内部受入は各公開契約が所有する。

3CLIのpending record→post-update scan/旧queue flush→final record→同report IDのfinalizeという順序がある。final record失敗・report ID欠測・pending残留・ID不一致で最終送信へ進まない。`report_delivery_deferred`はflushのretained/unreachable/dead/deferred/ack_failedを見て、単なる到達不能だけを工場report手順の失敗記録から外す。updater全体の終了ではreport失敗として残す。HTTP拒否/隔離/ACK失敗を同じ到達不能へ丸めない。

finalizeは製品probeを全面再実行せず、`finalizeToolchainReport`でlast_updateを差し替える。元診断reportとACK metadataは同private stateに残し、送信/ACK後の保持判断は別のoutbox処理が所有する。受信accepted、公開ACK、delivery receipt、利用者の画面反映は別の段階として扱う。

## 排他・途中失敗・取消・後始末

toolchain台帳はmkdir lockとowner PIDを持ち、競合を30秒待つ。owner不在は回収候補、owner欠測/不正は5分経過の扱いがある。writeは同directoryのexclusive temp→rename、finallyでtemp/lockを削除する。Windowsはowner-only ACLを設定する。ここにfsyncや全更新期間のleaseを実装しているとは扱わない。

report schedule runnerはnonce付きowner fileをhardlinkで公開し、生存contenderがいれば失敗する。旧形式lock/不正ownerは明示回収を要求。finallyで自分のnonceが一致するownerとtempを削除する。強制終了時には残る可能性がある。scan/flush子の終了を待つが、上位runner自体の強制kill後の子孫終了保証はこのsourceだけでは確定しない。

updater自体は全工程を一括transactionにしない。途中失敗/強制中断では完了した製品更新、前半pending台帳、診断原本、queue等が残る。top-level全期間の直列化はupdaterだけから保証せず、未調査のOS/host caller側の仕組みを先回りして断定しない。

更新失敗stateは不正JSON/不正schema/symlinkを上書きせず失敗する。owner-only temp→renameで保存するが、このmodule/CLIにread-modify-write全体のlockは無い。並行利用の可否はcaller含む調査が必要で、atomic renameをlost-update防止の証明にしない。

## 工場自身の失敗報告の状態

`applyRun`は今回failedのstepをopen/回数増加、今回ranで成功した既openだけをresolved/resolution_unsentにする。今回動かなかったstepは触らない。古い重大度は新しい起動根拠が無ければ保持し、再発の最初の1回には古い根拠を持ち越さない。`readRunReport`は同run evidence候補に型/サイズ/6時間の鮮度上限を適用し、読めなければ根拠なしで記録を続ける。

設定OFF/credentialなしはnot_sentで原状態を保持。設定ON時は現在のopen/resolutionをHMAC署名し1回送信、200/accepted/同report ID/応答署名一致の時だけmarkAcceptedする。到達不能/拒否/署名未検証はmarkFailedでunsentを保持し、次のrecord/flushへ渡す。受理後は送れたresolutionを再送対象から外す。製品本体のsource/診断の成功だけでこの状態を消さない。

## caller・test/fixture・config・export

主要callerはMac/Linux/Windows setupとOS日次入口。Windows `agents-update-schedule-runner.mjs`はbatch tokenを生成してGit Bashを起動し、終了log/fresh report/delivery receiptを照合する。configはruntime OSとXDG/LOCALAPPDATA/HOMEで解決、wireは実reporter config endpointから選ぶ。config未読時にv9を選ぶがrunnerが設定欠落を明示失敗とし、旧wireへ黙ってfallbackしない。

直読した関連fixtureは`tests/update/source-update.test.mjs`、`toolchain-ledger.test.mjs`、`finalize-report.test.mjs`。`cron-env.sh`は模擬NVM/CLI/runner/台帳失敗等の一部を読んだ。失敗報告testはfake intake/HMAC fixtureと存在の確認までで438行すべての意味確認は未完。config関連と同じく全literal候補を進行正本側`config-update-caller-candidates.json`へ残した。動的wire名、拡張子を外したbin入口、外部repo caller、環境変数overrideの全経路は今後の確定対象である。

公開exportは`updateSource`、toolchain contractのparser/comparator群、失敗report moduleのstate/署名/I/O/送信群、`finalizeToolchainReport`、`assertDeliveryReceipt`。bin側はCLI契約も持つ。初回の現状調査では既fixtureを再走していない。

[追跡するsource/test参照候補（path・line・context）](config-update-references.json)を同じrepoへ保存する。固定baseの機械抽出候補であり、全callerの意味確認完了ではない。

第1構造整理でv2/v4/v5のpath/readを共通moduleへまとめた。[現在の所有・caller・検証](toolchain-reader.md)を参照する。世代別投影とrecord CLIは保持した。

配送と保持の詳細は[reporter・outbox・分割・ACK](delivery.md)。通常v5-v9 scanのACK一覧は空で、公開ACKの互換経路と区別する。
