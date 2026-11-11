# 3OS setup・scheduler・製品公開導入の現状

[全体入口](../09_feature-map.md) / [setup図](setup.svg) / [原本](setup.mmd) / [scheduler図](schedulers.svg) / [原本](schedulers.mmd) / [配置](installation.md) / [設定保存](configuration.md) / [更新・確定](update.md) / [配送](delivery.md)

基準main `9fca2c8`、候補`2a180c5`から本文調査。Mac/Linux common/Windows native setup、日次/毎時scheduler、公開製品setup helper、1Password入口を確認。sourceにHost変更・接続処理が存在することと、今回それを実行する権限は別である。実setup/登録/credential/Host探索は一切行っていない。

## OS別の所有と順序

| 所有する入口・実関数 | 入力・完了点 | 失敗・保持 |
| --- | --- | --- |
| `setup-macos-factory.sh:run_setup` | OS/command/Node/docker/gh読取確認→backup/git identity/toolchain→config→install→LaunchAgent→更新配送→verify | set-eで停止。先行導入/configを全体rollbackしない。Grok未loginはconfig適用をskip |
| 同`install_launch_agent` | 毎日02:00、RunAtLoad=false、agents-update入口。plist lint/既登録照会/内容比較/登録読戻し | 差替えは旧plist backup、必要時bootout。bootstrap失敗で復元を試みる。復元も成功保証ではなく、最終読戻し失敗は停止 |
| 同`run_factory_update` | 以前のreport IDと新batchを固定しagents-update --setup、同batch log/fresh report/receipt/製品集合を検査 | 更新子の非0、log/receipt不在/不一致は失敗。古い成功票や画面反映で代替しない |
| `setup-linux-factory.sh`と`setup-linux-workstation-factory.sh` | 実際のファイルは`setup-linux-factory.sh`と`setup-linux-workstation-factory.sh`。server/linux役割をcommonへexec | workstationだけ旧dotagentから正規pathへ条件付き移動して再exec。WSL再導入はしない |
| `setup-linux-common.sh:run_setup` | 前提→GitHub認証→runner/SSH→backup/git identity/enrollment/toolchain→config/install→cron→更新配送→verify | variant/OS拒否。途中失敗までのOS/package/config/接続stateは残る。server verifyは配送後にreadinessを検査 |
| 同`ensure_linux_prerequisites/ensure_node24` | root helper、nvm/Node、uv。非対話sudo/Desktop Polkit/terminal条件で前提を用意 | 不成立で停止。root helper本文は下記の補助source表へ接続済み。今回Host管理を引き取らない |
| 同`ensure_github_actions_runner` | serverは起動/登録しない。dedicated profileはUser/Group/群/NNP/capability/activeとonlineを検査 | dedicated停止時はsetupから起動しない。旧管理modeはrelease digest確認/登録/service/label変更を持つが今回は実行0。profile helperは下記へ本文接続済み、実metadataは未確認 |
| 同`ensure_main_server_ssh/ensure_main_server_reverse_ssh` | 専用鍵・公開鍵受入・reverse接続のsource上の手順 | 直接/逆SSHと遠隔設定変更を含む。失敗以前の鍵/config/authorized_keysを全体rollbackしない。実鍵/接続先状態は未確認 |
| 同`ensure_factory_reporter_enrollment` | linuxだけ、不成立時に公開管理CLIで発行/転送→private token→config→readback | token/configは別file、遠隔一時tokenの削除も別段階。読戻し成功は実trustの独立確認ではない |
| 同`install_cron/run_scheduled_update` | 日次02:00にwrapper --scheduled-update。予約はbackup/filter/install/一行読戻し、実行は環境復元→更新→fresh receipt | 他entry保持と旧更新entry回収。crontab書換後の失敗を自動復元しない。scheduled経路は初回前提/登録を再実行しない |
| `setup-windows-native-factory.ps1`本体 | Win32/PS7→手動のみ前提、private state/transcript、排他file→config→手動配線→更新配送/verify/receipt | 前提導入はsetup.lockより前。全setup rollbackなし。lockは処理finallyでDisposeするが、全例外で末尾Stop-Transcriptまで到達する保証ではない |
| 同`Normalize-WindowsReporterConfig` | scheduled時だけ一意なCodex cacheから復元候補、config/credential検査、backup/BOM無し正規化/ACL | 曖昧候補・credential不在を拒否。copy/config/ACLは別操作で部分保持し得る |
| 同`Get-MainServerKeyMode/Ensure-MainServerSsh/Assert-MainServerDedicatedKeyAccepted` | 鍵の形でmodeを決める: 秘密鍵＋公開鍵=file mode（Git同梱ssh、従来どおり）、公開鍵だけ=agent mode（1Password SSH agent、System32 OpenSSH）。固定host key、config/alias/直指定readback（IdentityFileはfile modeで秘密鍵、agent modeで公開鍵）、専用鍵だけのprobe（agent modeはagentがその公開鍵を出すことも確かめる） | 鍵が無い時は作らず、1Passwordで作って公開鍵を置くよう案内して停止する。秘密鍵だけの時は停止する。鍵非受入/host-key/到達不能/local-key/agent未提供/不明を区別。非受入なら公開鍵の登録担当へ渡して停止し、この入口から遠隔登録しない。Git同梱sshはWindowsのnamed pipe agentを使えない（2026-11-11 FOXで確認）ため、agent modeのmain-serverはSystem32 sshからだけ使える |
| 同手動分岐 | 旧毎時task停止/解除、旧cron回収→links/config→gh共有account切替→SSH→日次task登録 | 手動とScheduledRunの責任を分ける。setup sourceを読んだだけで停止/認証切替を実行しない |
| 同`Invoke-FactoryUpdate/Write-Receipt/Wait-ScheduledSmoke` | 環境を一時設定して更新子を呼びfinallyで復元、新ID/batch/配送票/製品inventory/verifyを確認。手動最後に日次taskを起動し最大20分のfresh票確認 | 更新失敗でも先行変更は残る。setup receiptとMSIX mirrorは順次保存。smokeの結果不明/timeoutを成功にしない。自然日次実行の証明とは別 |

Windowsの同時実行制御はFileShare.Noneのsetup lock、Task SchedulerのIgnoreNew、reporterのPID lockなど別の期間を持つ。POSIX setup全体を同じleaseで保護する実装ではない。取消/途中失敗時のpackage・HOME・OS予約・外部登録は各所有者へ残り、全体transactionとして説明しない。

## 日次と毎時の公開scheduler

| 窓口・helper | 仕様と副作用 | 拒否・後始末 |
| --- | --- | --- |
| `factory-reporter-scheduler.mjs:main/artifact/apply` | install/uninstall、既定dry-run、実OS一致のapply。config file/profile/endpoint/wireと実runnerを検査。Mac launchd/Linux cron/Windows taskの毎時17分を生成 | dry-runはartifactの説明で実起動検証ではない。登録操作途中の保存/旧停止は全rollbackしない。uninstallは予約/artifactを回収しoutbox等を消さない |
| 同`stableNodePath/nextCron/removeLegacyArtifacts` | Mac Homebrewのstable node、末尾marker所有entryだけのcron合成、旧scheduler artifact回収 | report/queue原本の回収ではない。configのreporting/collection flagを変えない |
| `agents-update-scheduler.mjs` | Windows日次02:00、PS7のsetup -ScheduledRunをwscript hidden launcherで起動、InteractiveToken/LeastPrivilege/IgnoreNew。status/install/uninstall | SID fixtureは非Windows install dry-runだけ。既task一致なら再登録せず、登録不能/読戻し失敗は非0。正常な予約は実実行完了ではない |
| `windows-scheduler.mjs` | hidden task/ACL/存在照会/日次契約照合/UTF16 XML+JS保存 | 文字列安全検査、PS7とexit codeで照会。不在と照会失敗を分ける。launcherとXML保存は一括transactionではない |
| `scheduler-path.mjs:extendedSchedulerPath` | POSIXは既PATHを保ち不足entry補完。先行nodeが実runtimeと異なる場合だけruntime directoryを前へ | Windowsは既PATHを返す。設定変更やshared runtime導入ではない。env nodeの解決と予約登録を同一視しない |

Windows手動setupは毎時reporter taskを退役させ、日次setupが更新と配送をまとめる。公開毎時schedulerの実装が残ることは、Windows上で新たに有効化する許可ではない。Mac既Owner残任務の自然log受入も、この図を理由に手動runやscheduler変更へ広げない。

## 製品公開setupの境界

`product-setup.mjs:PRODUCT_SETUP_COMMANDS/runProductSetup/setupOutcome`は製品の公開入口を引数配列で呼ぶ。stdinを閉じ、15分/1MiBと15秒ごとの経過表示を持つ。timerはfinallyで解除。ready、GPT partial/action_required、Lattice partial、failedを分け、製品内部の対応OS/登録内容を再判定しない。runner throwや表示先の例外は上位へ返る。外部製品の完了・認証待ちと工場全体の配送成功は別である。

`typesafe-setup.mjs:setupTypeSafe`はcredential取得→公式skillの4面導入→一覧/全agent確認→30秒実API分類smokeを順に行う。後半の失敗でも先行skill/credentialを戻さない。今回このAPIや導入を実行していない。

`jev-setup.mjs:setupJevProduct`はOS対応とfork設定形式を検査し、既checkoutのorigin/dirtyを拒否境界にする。上流/forkの取得、uv/npm/cargoによる導入、必要な版照合後にfork設定を解除する。途中失敗したcheckout/導入物は残る。公式releaseでのfork卒業判定は`jev-fork-release.mjs`の別責務。GUI起動や他製品の内部修理は含めない。

## setup補助のsource契約

| 実file・窓口 | 所有する処理 | 失敗と未確定 |
| --- | --- | --- |
| `bin/setup-linux-prerequisites-root.sh` | root/user/role/Ubuntuを検査、欠けたapt package、既Dockerが無い時の公式repository、cron/docker有効化。役割別sudoersをvisudoで検査、SSH設定を検査後reload、docker groupとsmoke | 先行package/設定/group/サービスを全rollbackしない。製品の明示bootstrap sourceであり、今回root実行やHost管理を引き受けていない |
| `bin/factory-runner-profile.mjs`→`lib/factory/runner-profile.mjs:readRunnerProfile/parseDedicatedRunnerProfile` | 固定profile path、不在ENOENTだけlegacy。root所有regular/non-writable/O_NOFOLLOWとlstat/fstat、固定dedicated identity/activeを検査。v2は契約の全instance（[runner capacity](runner-capacity.md)）を返し、setupはinstanceごとに同じ検査を行う | present malformed/foreign/trial/symlinkをlegacyへ落とさない。fdはfinally close。実metadataは今回読まず、GitHub組織runnerの現状態/割当可否を推定しない |
| `lib/factory/jev-fork-release.mjs:officialForkRelease/isTrackedJevFork` | tracked PR/forkだけ。gh APIでmerged/commit/time、前提PR順序、git compare ahead/identical、registry latest distributionを版へ照合 | 未merge/未包含/版不一致はnull、未知ID/command/不正返却はthrow。commandは30秒/1MiB、PyPI fetchには明示timeoutが無い。今回接続/版採取なし。fork解除はcallerで版照合後 |
| `bin/factory-update-context-observer.sh`、`lib/factory/update-context-observer.mjs` | opt-in phaseの非秘密限定入力/元返却hash/時間を固定Python helperへ渡す。shellのNode/npm解決はmetadataだけ | 観測失敗は警告と通常結果保持。private原本の非置換保存/core bridgeは[writer・authority](deployment.md)へ。実runtime/issuerの証明にしない |

Linux commonからroot前提helperへ、Linux setupから公開runner profile CLI/libraryへ、Jev setupからfork releaseへ、setup/update/public setupから観測helperへ接続する。固定path/環境変数や公開exportを現物から確認し、新configを加えていない。実OS/runner metadata/credential/接続/サービス操作は0。

## 1Passwordの明示setup

`setup-1password.sh`はPython入口、`.ps1`はPS7→Pythonへのnative relay。3OSの既定setup/agents-updateからこの入口を呼ぶliteral接点は今回見つからず、skillの既定配置と区別する。これは配布済み実物や第三者環境全体の監査完了ではない。

| 実関数 | 段階と保持 |
| --- | --- |
| `main/install` | profileと実OSを照合し公式package導入。configure-onlyでも導入/登録を行う。本体禁止やアンインストールの入口ではない |
| `mcp_command/mcp_probe/MCP` | serverはdesktop MCPなし。desktopは初期化/tool一覧を登録前に確認、必要時authenticate/list。request別timeout、finallyでterminate→5秒後kill。子全descendantや親強制終了時の清掃保証ではない |
| `register/backup/registration` | symlink/conflictを拒否し、変更前archive。公式3CLIとCursor fileへ順次登録、旧一致名を移行、Cursor enable、readback |
| `cli_probe` | whoami→必要時desktop signin。本人認証不能/複数account等は未認証状態に保持。server/configure-onlyは追加本人認証へ進まない |
| `provision_server` | 既認証時だけService Account/保管庫/正本itemと暗号化server資格情報を接続。秘密はstdin経由、sensitive失敗出力は非表示。既profile conflict/symlinkを拒否 |
| 完了返却 | readyならexit0、認証待ちはJSON付きexit3、所定例外はstderr JSON/exit2。導入/登録/本人認証/利用可能を区別。複数面・外部stateの全rollbackはない |

`register`は全4親CLIを必要とし、順次登録/enable後に失敗しても先行登録を戻さない。本人操作・OS credential・外部trustは各担当のまま。任意性の修理は全体リファクタ完了後の別差分に保持し、既選択の任意連携を外さない。

## 接点・確認・未読

callerはOS wrapper/既setup→agents-update→公開製品helper/既runner、日次/毎時CLI、Windows PS relay、installのbin配布。exportは公開setup command表/outcome/runner、TypeSafe/Jev setup、scheduler path/XML/ACL照合等。全literal候補を当席phase10-setup-contacts.txt、補助をphase11-source-review.jsonへ固定した。動的major名・外部caller・全fixtureの意味確認は未完。

対応fixtureは`tests/install/setup-{macos-factory,linux-common,linux-factory,linux-workstation-factory}.sh`、`tests/factory-reporter/{windows-native-setup,agents-update-scheduler,scheduler}.test.mjs`、`tests/update/{product-setup,typesafe-setup,jev-setup}.test.mjs`、`tests/install/onepassword.test.py`。今回は1Passwordの隔離登録/衝突/未認証/秘密出力/Windows限定fixtureの一部を本文確認。他は接点索引であり全意味確認・実行済みではない。コード変更なしのため既成功試験を反復しない。

この現状調査はOS別の副作用と保持を可視化したもの。共通化の採否を先取りして新lock/設定/修理を加えない。GPTwriter/lease/authorityのsourceは[詳細](deployment.md)へ接続した。Caveat/旧診断/CIのsource接続は[全体入口](../09_feature-map.md)に揃っている。全fixture本文と実OSは未確認。[全体レビュー](final-review.md)はこの限界を含めて判断する。

## 補助契約の実関数接続

`agents-update-scheduler.mjs:main`はparse直後に`agents-update-scheduler-contract.mjs:assertFixtureSidUsage`を呼ぶ。sid指定は非Windowsのinstall --dry-runだけを許し、apply/status/uninstall/WindowsへfixtureのSIDを流用するとOS操作前にthrowする。専用fixtureはtests/factory-reporter/agents-update-scheduler.test.mjsで、reporter gateに属する。

`jev-products.mjs`はJEV_PRODUCTS（3公式repo/agent-desktopだけdarwin）、jevCheckout（HOME/Developer/id）、jevSupportedだけを所有する。jev-setup.mjsはid存在検査後に対応OS/pathを使い、v9.mjsのjev診断も同じ窓口を使う。未知idを勝手に受理するvalidatorではない。tests/update/jev-setup.test.mjsとwire-v9系が接点。実checkout/導入は今回行っていない。

`deployment-contract.mjs`のhostProjectionはprofile/OS/arch/macOS majorを検査しrequired/unsupported/not_applicable集合をfreezeして返す。npmPackagesForHostはOS/arch別名を正規化して固定npm集合とdarwin-arm64のAIShellを返す。公開factory-deployment-contract CLI→3OS setup/updater、current-docs renderer、Windows smokeと専用deployment-contract fixtureが逆callerである。postUpdateFailuresはpost判定のexportで、通常source内の実callerはliteral検索で見つからず、tests/factory-reporterのscheduler/deployment-contract fixtureが使用する。server自身ingest stale限定例外・完全tuple allowlist・pending差を持つ。旧v2/v4runnerの別gateと統合していない。
