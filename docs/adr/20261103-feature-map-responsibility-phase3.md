# 全体責務とscheduler stateの整理：第3設計

日付: 2026年11月3日。所有者: Dotagents。状態: 下記のscheduler専用抽出と現行説明の訂正を採用、実装はSol適用後。基準main `9fca2c8`、調査候補`8f57155`。Astra xhigh/fast OFFの適用acceptedを確認して設計した。全体の最終整合確認とは別工程である。

[全体入口](../09_feature-map.md)→[確認範囲と残り](../feature-map/scope-review.md)、[runner現状](../feature-map/legacy-runners.md)、[旧診断](../feature-map/legacy-diagnostics.md)、[CI配布](../feature-map/ci-distribution.md)、[外部イベント](../feature-map/external-events.md)、[観測入口](../feature-map/gpt-observation.md)、[writer/authority](../feature-map/deployment.md)を根拠にする。現状の状態遷移は各詳細だけを正本にし、本書は採否・保持条件・次の実装範囲を所有する。

## 採用する最小変更

`bin/factory-reporter-v2-schedule-runner.mjs`、v4、v5の同一なscheduler state/nonce contender処理を、計画配置先`lib/factory/scheduler-state.mjs`へ移す。v5をimportするv6-v9も同じ窓口を通る。新moduleはまだ存在しない。[提案図](../feature-map/scheduler-state-design.svg) / [原本](../feature-map/scheduler-state-design.mmd)は未実装の配置であり、現状図へ混ぜない。

3fileの`privateState`から`withLock`末尾まで3756bytesが完全一致し、`ownerOnlyAcl`も1865bytesが完全一致する。前者のSHA256は`fcb39eb9ad47698fda6257813a49117a7519ef8f50e332bedf5903723238ddc0`、後者は`52ff9de6bc88bb537a1fa3c9a4493a0395dd96f1eff1815a731fee7c8d98c6e7`。単なる名前の類似ではなく、同じstate形式・検査・失敗・後始末を三か所で所有していることが抽出の根拠である。

現状維持は新importを避けられる一方、同じlock原本を扱う責任窓口が三つ残る。専用module一つへ既関数を移せば、世代選択や診断を受け渡さず重複を除けるため採用する。3runner全体の統合や汎用lock基盤は不要である。

## 窓口と移動範囲

| 計画するmodule export | 入出力と所有 | callerに残すこと |
| --- | --- | --- |
| `privateState(state)` | 既directory検査・作成・POSIX mode/Windows ACL。既async返却と例外 | state path選択、config/platform検査、通常OFF判定。OFFでは呼ばない |
| `withLock(state, task)` | 既contender獲得→`await task()`→finally自nonce解放。taskの値/例外を返す | 先行する`privateState`呼出し、lock内のscan/reuse/enqueue/flush/receipt順序 |
| `ownerOnlyAcl(path)` | scheduler stateと保存file向けの既Windows同期ACL。非Windowsは何もしない | v5の`writeStateJson`がtemp/rename後に同じ順で呼ぶ。保存本体・receipt条件は移動しない |

`parseLockOwner/processIsAlive/publishContender/releaseContender/rejectLegacyLock/acquireContender`はmodule内部のまま。上の3exportは製品内部の相対import接点で、新CLIや設定ではない。v2/v4は最初の2関数、v5は3関数をimportする。v5のUUID/temp/rename・chmod等、残る実使用importを誤って除去しない。ACLのためだけに新しいmode/policy引数やcallback注入を作らない。

新moduleはNode標準libraryと既`windows-powershell.mjs`だけへ依存し、runnerをimportしない。PATH補完は各runnerの現在位置に残す。PowerShell解決は従来どおりACL呼出時で、import時の実行・環境の固定・state作成を加えない。v5の`HERE/ROOT`、起動basenameからのwire選択、v6-v9 relay、拡張子なし配布名を保持する。

## 保持する契約と保証しないこと

| 境界 | 移動後も保持する内容 |
| --- | --- |
| state | 非symlink directoryのlstat、欠測時だけrecursive mkdir、POSIX0700矯正。親directory全体の安全性検査を追加したと扱わない |
| Windows ACL | current SIDのみFullControl、継承遮断、LiteralPath、FileSystemAclExtensions、検証済み絶対PS7、5秒、既3種error。resolver自身のerrorも既位置で伝搬 |
| owner受理 | exact4keys、既schema、36文字nonce正規表現、正のsafe PID、Date.parse可能時刻。UUIDやcanonical UTCへ新たに厳格化しない |
| 公開 | 固有tempをwx/0600→mode/ACL→hardlink owner公開→temp finally削除。file/parent fsyncやrenameへの変更なし |
| 競合 | 旧`schedule.lock`があれば拒否。owner名、非symlink通常file、4096bytes上限、名前とnonce一致を検査。live/EPERMは拒否、ESRCHだけ回収。age/TTLで奪わない |
| 解放 | acquire失敗は自ownerのreleaseを試みる。taskの正常/throw後もfinallyで、読戻したnonce一致時だけ削除。ENOENTだけ許容し、他errorを隠さない |
| 部分失敗 | cleanup例外が元例外/返値を置換する既catch/finally境界も保つ。公開後temp削除失敗でownerが残る場合や、強制終了でfinally未到達の場合を自動復旧済みにしない |
| 保存物 | scan済report/ACK/outbox・receiptをlock失敗から巻き戻さず、既stateを移設/正規化/掃除しない。reportとACKの一括transaction、電断耐久性を追加しない |
| 子process | spawn error/close非0の伝搬を維持。新timeout、AbortSignal、全子孫終了保証を追加しない。子の途中副作用と結果不明は残る |
| 世代差 | v2/v4の製品gate・Lattice差、再scan finalizeとv5以降のreport-id再利用、v9flag、v7-v9 receipt条件、stdout/stderr/exitを維持 |

この抽出は新しい排他アルゴリズムの正しさの認定でもsecurity修理でもない。競合中のfile消失、PID再利用、実OSのACL/保存、電断を含む保証を、本文一致やLinux fixtureだけから増やさない。

## 全体の責務採否

| 機能と現在の所有窓口 | 採否と理由 |
| --- | --- |
| 規範合成/install/verify、親別applier | 維持。生成・配置・検査と親固有の保存/rollbackが分かれている。汎用transactionや親横断parserを足さない |
| source同期/updater/公開製品setup/退役park | 維持。製品所有入口へ委譲し、部分成功と既record/finalize順序を持つ。製品内部や他writerを取り込まない |
| 台帳読取りとwire投影 | [第1設計](20261103-feature-map-responsibility-phase1.md)を維持。共有readerの同一検査と世代別投影を分離。writer受理差を統一しない |
| reporter CLI/queue/reader | [第2設計](20261103-feature-map-responsibility-phase2.md)を維持。同file内handler・巡回と8readerを整理済み。postOne/fragment/ACK/holdに新policy層を足さない |
| scheduler登録と世代別runner | 登録artifact/OS操作は既窓口を維持。今回だけ同一state/nonce lockを抽出。v1 directory、queue PID、外部event PID、native SH/EXの各排他は統合しない |
| 旧v2/v4 private診断parser | 今回は維持。Caveat受理/引数/exitとLattice有無、high/理由込みfingerprint、collection ACK差が残る。同一部分だけの追加抽出も、既投影・補助関数との切断面と未読fixture追従を増やすため採らない |
| 現行公開診断/外部event | 維持。製品公開診断の投影、旧event append/prefix ACK、現行readiness/通常空ACKは別契約。旧原本を現行へ戻さず、削除もしない |
| GPT観測context/entry/Rabbit | 維持。値検証・採用factの選択・一回claim/原本保持は異なる責任。通常product CLI fact欠測で閉鎖、Rabbitの10月26日過去枠を現在承認へ読み替えない |
| GPT writer/authority/観測store | 維持。EX/二SH・issuer照合・原本store・通常結果の境界を保つ。実port未供給を成功既定口で埋めない。別native fixtureを取り込まない |
| Caveat collector/worker/private候補 | 維持。製品コピーcollectorと未接続pure状態候補を区別。実worker/channel/raw保存の新実装をrefactorに混ぜない |
| 親hook/skill/modelと互換wrapper | 維持。各親契約、明示Oracle rollback、syncの失敗行、Communityの順次委譲は独立した入口。共通executorへ集約する実益が無い |
| CI/配布/文書 | event/base分類・最終gateとinstall配布を維持。下記の現行説明だけ訂正し、新CI policy/履歴検証実装を追加しない |

維持は「全fixture確認済み」や「現契約に不足が無い」という意味ではない。未確認は後段へ残すが、似た名前や行数だけを根拠に追加分割しない。

## 旧文書との差の扱い

**Windows marker説明は現sourceへ訂正する。** `shared/runbooks/factory-ci.md`の待機説明は、現`windows-factory-runner-job-started.ps1`とdedicated relay、および既fixtureの「互換引数を受けるだけで読まず待たない」に合わせる。優先度/CPU処理やHost管理の責任は変えない。これはrepo内の現挙動の説明で、実Host導入版の確認やhook反映を済ませた意味ではない。

**ADR0136は書き換えない。** Acceptedの決定4〜8が要求するclosed current集合/履歴保護と、現renderer/Makefile/workflowとの実装差を維持する。現CIは比較baseを分類outputへ出すが後段へ渡さず、rendererに`--base-ref`は無い。current-docs成功は生成drift/local linkだけの検査である。現runbookからこの差を示す詳細へ接続し、要件を撤回したり実装済みと見せたりしない。

履歴保護をここで実装する案は不採用。台帳/role/既archive/分類入力の新検査が必要で、同一挙動の構造整理には収まらない。新しいpolicyやsecurity修理を今回の権限から導かない。要件と実装の未解消差として最終全体確認にも残し、現CI合格だけで要件適合を宣言しない。

## Sol実装時の全接点と必要検証

| 接点 | 実装・確認する範囲 |
| --- | --- |
| 直接caller/export | v2/v4/v5の2呼出し、v5保存時ACL、既importの全実使用。新3export以外を公開せず、call順・error境界の移動前後を照合 |
| relay/動的caller | v6-v9 relay、`factory-reporter-scheduler.mjs`のwire選択、`agents-update.sh`/日次runner、3OS setup。CLI名/alias/state path/設定生成を保持。未知の外部caller不在を断定しない |
| 既scheduler fixture | `tests/factory-reporter/scheduler.test.mjs`全文確認済み。RUNNERはv4、V8_RUNNERはv8。OFF/flush/legacy/live/dead/symlink/mode/失敗/receiptを区別し、ACLとhardlink source検査は新moduleと各runner接続へ追従 |
| PS7 source fixture | `tests/factory-reporter/windows-powershell.test.mjs`の直接spawn一覧を新moduleへ追従。3runnerの委譲を別に確かめ、期待削除だけで合格させない。resolver自身の挙動は変更しない |
| 世代別fixture | `tests/lattice-cutover/wire-v4.test.mjs`のrequired差、`tests/update/finalize-report.test.mjs`の同ID再利用、`tests/factory-scan/caveat-entry-cli.test.mjs`のv9flag、日次schedulerのreceipt source検査、wire6〜9/3OS setupの生成接点を確認 |
| 隔離fixture | 既`fixtures/child-process.mjs`の隔離HOME/stateを使用。現scheduler試験のv4偏りを補う小さな世代別caseで、v2/v4/v5/v9のOFF・live owner拒否・空queue後cleanupを確認。新moduleはtask返値/throw後解放、不正owner原本保持、自nonce不一致時の保持を既case不足分だけ追加 |
| 配布/config | installの既binリンクとrepo相対lib参照。新HOME link、CLI、env、package依存、設定移行は不要。新testは既reporter globへ置き、libの構文は明示検査する |
| gate | 新module/3runnerの構文、focused state試験、変更するscheduler/PS7 fixture、再利用finalize/v9flag/旧gateの関連case。新しい変更の根拠がある範囲だけ実行し、既60/122全量・native13・4hostを習慣で反復しない |
| 図/文書 | 実装と同差分でrunner現状図→新実関数/export/testへ接続。提案図は履歴として残す。描画/目視、markdownlint/current-docs/diff確認 |

Windows専用caseのskipを実OS合格へ数えない。新しいskip・許可・fallbackを試験通過のために足さず、実credential/probe/送信/Host操作を行わない。契約差が見つかれば抽出候補だけ止め、差を記録して設計へ返す。

## 有限に残す本文工程と完了条件

既索引のbasename不足は未読の証拠ではなく、wildcard/世代名で接続しているfileもある。次のSolでは、`lib/factory/agents-update-scheduler-contract.mjs`、`jev-products.mjs`の独立した窓口と、`deployment-contract.mjs`/`runtime-context.mjs`の関数・逆caller対応を本文で再照合し、setup/update/delivery/CI詳細へ不足分だけ接続する。今回読んだ`windows-powershell.mjs`もscheduler側から呼出し/返却を明示する。これらを有限のsource接続工程とし、機械317pathや37path/181literalを完了数にしない。

全fixtureの未読は、変更する接点を先に読み、残りを機能別に列挙して既gate所属/OS条件と結ぶ。親の実session、動的alias/外部caller、実OS、実CI/配布受入、実live/issuer/store/resource/allwriterは別の未確定であり、source確認では解消しない。

この設計の完了条件は、採否/保持/全接点/必要検証を候補へ固定し、図と文書を確認してSolの正式次工程へ渡すこと。最新Sol Highを一回正式変更し、次ターンaccepted後に実装する。実装・必要検証・現状図同期と残るsource接続の後、最新Astra xhighの最終全体整合と指導担当の成果確認へ進める。

全体完了、公開/本番反映、停止/再起動は今回行わない。Host/他製品/他writer管理外、SEC002本人later/旧stage停止、Mac指定既logの自然受入、native別`539896`fixture、1Password任意化は全体完了後の別差分という既境界を保持する。

## 第3実装への接続

採用したscheduler state抽出を実装し、[runner現状・実関数・検証](../feature-map/legacy-runners.md)へ接続した。提案の未実装表記は設計時点の履歴である。残る補助sourceもsetup/delivery/CIへ本文対応を追補した。全fixture未読の整理と全体確認・最終Astra整合は継続する。
