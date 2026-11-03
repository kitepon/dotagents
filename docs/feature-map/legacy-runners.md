# 世代別runnerと互換入口

[全体入口](../09_feature-map.md) / [scheduler登録](setup.md) / [更新確定](update.md) / [配送](delivery.md)。base `9fca2c8`、候補`f05b395`のsource本文とv2→v4全差分を確認。[描画](legacy-runners.svg) / [原本](legacy-runners.mmd)。実scheduler/process/Hostを変更していない。

## 登録・呼出し・公開返却

install.shは各binを拡張子なしリンクで配布。`factory-reporter-scheduler.mjs`はwireからrunner名/stateを選び、既定majorはv4。3OS公開setupとagents-update-schedule-runnerは別にv9 runnerを指定する。生成設定/実OS発火/子完了/配送受理/UI反映を区別する。v6-v9はv5 runnerをimportする薄い入口で、v5がprocess.argv[1]のbasenameからwireを選ぶ。動的majorや外部alias全利用は未確定。

| 世代・実file/function | 正常・OFF・更新時の責任 | 失敗・保持・終了 |
| --- | --- | --- |
| v1 `factory-reporter-schedule-runner.mjs` | 固定config/platformを検査。通常OFFはstate未作成でskip。collectionならscan→enqueue、reportingならflush | directory型schedule.lockとpid。ESRCHだけstale扱い、判定不能は拒否。finallyでlockを除去。post/finalize/receiptなし |
| v2/v4各runner | 通常/--post-update/--finalize-updateを受け、wire専用state。post時は製品check gate、finalize時は再scanしpending台帳を拒否。通常collection/finalize reportingはenqueueし、reportingならflush | owner-only Windows ACL/5秒PS7とPOSIX modeを適用。子spawn失敗/非0/途中失敗はstderr/exit1。scan済report/ACK/queueをrollbackしない |
| 同`gateFailures/hasPendingToolchainLedger` | v2必須製品へv4だけLatticeを追加。profile別CLI/ServerManager/既allowlist差を維持 | post_gate_pendingはpostでのみ許容。post失敗はfailed_checksとexit1。v4とv2の差はstate/CLI/log名とLattice必須化だけで、全wireを同じpolicyにしない |
| v5-v9共通runner | expectedReportId付きfinalizeは再probeせず既reportへ台帳確定だけを適用。v9だけmanaged flagと通常一回観測flagを渡す。v7-v9 reporting finalizeの完了後にdelivery-receipt保存 | v2/v4のgateFailuresは持たず、post status successを製品全readyへ読み替えない。receiptは子flush成功後のbatch/report対応記録で中央UIの独立証明ではない |
| 共通runner`writeStateJson/writeDeliveryReceipt` | UUID temp/wx→ACL/mode→rename→ACL/mode、temp finally掃除。batch token形式を検査 | rename後ACL失敗なら旧fileへ戻らない。file/parent fsyncはこのhelperにはない。途中receipt失敗を配送再実行の許可にしない |

## v2/v4/v5のcontender所有

`privateState/parseLockOwner/processIsAlive/publishContender/releaseContender/rejectLegacyLock/acquireContender/withLock`の責務は`lib/factory/scheduler-state.mjs`にある。nonce/pid/acquired_at付きowner原本を一時fileへ書き、hardlinkで公開。legacy schedule.lockが存在すれば明示回収を要求し、ageだけで奪わない。別ownerは非symlink/4096bytes/名前とnonce一致を確認し、PIDが死んだ時だけ回収。live/EPERM/不正なら拒否し、自分のnonceだけfinallyで解放する。

このnonce lock本体はv2/v4/v5で同一本文。Windows ACL/privateStateとともに専用moduleへ抽出した。v1のdirectory lock、reporterのqueue lock、external-eventsのpid file lock、GPTのnative leaseと自動統合しない。強制終了はfinallyが走る保証を持たず、子spawnには専用取消/全子孫停止/timeoutが無い。子のclose非0を受けても途中の保存原本を消さない。抽出の採否は[第3設計](../adr/20261103-feature-map-responsibility-phase3.md)、その実装を本ページに反映済み。排他アルゴリズムの新設やlock修理は含まない。

## 互換wrapperと補助操作

| 公開入口・caller | 入出力と副作用 | 失敗・完了境界 |
| --- | --- | --- |
| `oracle-mcp-stable.sh`→`oracle-chrome-shim.sh` | ORACLE_NODE_BIN/ORACLE_DISTまたはnode/npm global-rootを解決しMCPまたは明示cliへexec。Socket.setTypeOfServiceの例外guardを注入。ChromeはOS別探索/明示env、固定負座標を追加してexec | entry/Chrome欠測は非0。exec先の終了を引継ぎ、専用rollback/取消掃除なし。固定座標は非可視保証ではない。通常GPT経路への切替や実ブラウザ起動は今回なし |
| `verify-install.sh`、Codexの`skills/oracle/SKILL.md` | wrapper実行可能性と明示互換利用の接点。config applier/setupのOracle removalは既[親設定](configuration.md)が所有 | 実行可能性検査を製品認証/利用成功にしない。外部MCP登録/実利用は未確定 |
| `sync-sweep.sh` | 明示rootまたは既定Developer直下を列挙しrepoごとfetch、branch/ahead/dirty/stash/ignored候補をMarkdown stdoutへ | repoごとの失敗は行の注記へ残し続行。全repoの成功集約exit/保存台帳は持たない。worktreeの.git fileはdirectory判定で非git扱いになる。修理/他repo操作は今回なし |
| `update-grok-community-overlay.sh` | 明示root/env、任意--pushを製品所有scripts/update-overlay.shへdesktop→AFKの順に委譲 | 不正引数exit2/入口欠測exit1、set-eで失敗時打切り。先行成功をrollbackしない。製品内部のbuild/検証/公開契約を引き取らない |

wrapperにはinstallのbin glob以外の自動起動callerをliteral検索で確認できないものがあり、外部の利用者caller不存在とはしない。`tests/oracle/wrappers.sh`全文は偽Node/Chromeのargv引継ぎ、`tests/wire-v6/wire-v6.test.mjs`該当caseは二製品への順序とpush引数を検査する。sync-sweep専用fixtureは候補索引で未確認。Makefile test-oracle/wire globとの接続を記録し、実行はしていない。

runner関連fixtureはscheduler.test.mjsのwire別生成/非0/legacy lock/live/dead owner、lattice-cutover/wire-v4.test.mjsの必須製品差、finalize-report.test.mjsのreport-id再利用、caveat-entry-cliのv9flag等。今回読んだsectionと全fileを当席phase14-source-review.jsonで区別する。全fixture本文/全OS/同時実行・電断・未知callerは未完。既成功122/60/native13/4host試験の無根拠反復はしない。

## 第3設計への接続

[採否と保持条件](../adr/20261103-feature-map-responsibility-phase3.md)で、v2/v4/v5の同一state/nonce lock/ACLだけの抽出を採用した。採用した抽出を実装した。上記の現状は共有moduleと各runnerの所有を示す。設計時にscheduler.test.mjs全文、windows-powershell.test.mjsとchild-process fixtureを確認し、移動先と各callerへsource検査を追従する必要を特定した。v1/queue/event/nativeの排他と世代別gate/receiptは抽出対象に含めない。

## scheduler stateの実関数と検証

`lib/factory/scheduler-state.mjs`は`privateState(state)`、`withLock(state, task)`、`ownerOnlyAcl(path)`だけをexportする。v2/v4は前2つ、v5は3つを相対importし、v6-v9は既relayからv5へ入る。state path/config/OFF/PATH補完とtask内scan/reuse/enqueue/flush/receiptは各runnerが所有する。v5のwriteStateJsonはtemp/rename後に同じACLを使う。installのbinリンクと元repo/libの相対接続を使い、新CLI/env/HOME linkは無い。

module内部のparseLockOwner/processIsAlive/publishContender/releaseContender/rejectLegacyLock/acquireContenderは非公開。前述のowner検査と原本保持、例外/finallyをそのまま移した。task返値/throwは自nonce解放後に伝搬し、解放失敗も隠さない。上位の部分report/ACK/queueを巻き戻さず、強制終了/電断/全子孫終了の保証も増やさない。

`windows-powershell.mjs:resolveWindowsPowerShell7`はwhere.exeから絶対pwsh.exe・WindowsApps除外・Core7以上を検査し、既定resolverだけ成功結果をcacheする。呼出時解決のthrowはACL/runnerへ伝搬。`runWindowsPowerShellScript`は絶対通常ps1と固定上限を検査し、spawn/timeout/output_limit/exitの結果を返す別窓口であり、今回のACLをそのasync APIへ置換していない。

新`tests/factory-reporter/scheduler-state.test.mjs`はv2/v4/v5/v9のOFF・live owner拒否・原本保持・空queue cleanup、moduleのtask返値/throw解放・不正peer保持・nonce不一致保持を検査する。既schedulerのACL/hardlink source検査とPS7 source一覧は新所有者へ追従し、各runner委譲も新fixtureで確認。新testはMakefileのtest-factory-reporter globへ入る。新module/3runner構文と6fileの関連60試験がLinuxで成功した（本工程の60件であり、過去の台帳reader60件とは別）。Mac/Windows実行や電断の受入は未確認。

第3提案図は設計時点の履歴。現在の接続は本ページと現状描画を正本とする。
