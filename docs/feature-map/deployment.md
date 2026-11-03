# GPT deployment writer・authority・原本保持

base main `9fca2c8`からの現状本文調査。台帳writerのsourceと通常更新を区別し、実issuer/store/資源集合/全writer参加を図から補完しない。[全体入口](../09_feature-map.md)と[公開setup](setup.md)から接続する。設計提案やHost有効化の図ではない。

[writer/reader描画](deployment.svg) / [原本](deployment.mmd)。[authority/観測描画](authority.svg) / [原本](authority.mmd)。既採用の詳細契約は[authority計画](../plan_gpt-core-authority-channel.md)。このページは現在の実file/functionと状態所有を持ち、過去のCI待ちや他担当の仕事を再開条件へ復活させない。

[GPT観測入口とRabbit一回枠](gpt-observation.md)は別の状態所有を持つ。private coreの原本/issuer許可と、report safe_context・過去の一回取得/送信claimを同一視しない。

## writerとreaderの所有

| 実file・関数 | 所有するもの・受渡し | 失敗・保持・後始末 |
| --- | --- | --- |
| `lib/factory/deployment-writer.mjs:canonicalDeployment/requestCopy` | plain JSONのkey順、finite値、identity、絶対正規形path、sorted unique資源、期限を検査し入力をclone | lexical pathはnative alias/case/overlap/全writer参加の証明ではない。入力/必須port検査は外側catch前でthrowする |
| 同`writeDeployment` | 提供されたEX lease下で資源確認→旧committed読取→新generationのmutating/receipt:null保存→retire前→install→retire後→capture→provenance/adoption→receipt→source evidence読戻し→committed保存 | mutating保存前にprefix操作しない。以後の失敗は同EX下でincomplete/receipt:null保存を試み、persistence=saved/unknownとpackage_resultを返す。rollbackや成功receipt復活はしない |
| 同`guard/check/context` | 期限・abort・assertCurrentを外部port前後に確認。readerではSH mode/resource/generationも照合 | adapterの取消は非同期操作がsettleしてから解放する契約。timerとのraceで動作中installerを放置しない |
| 同`readDeployment` | committed handoffだけを受け、SH下のstate/scope/generation/receipt完全一致とverifyCurrent後にcallback | callback結果とlease解放後のcompletedは別。途中/解放失敗はblocked。既に得たnormal_resultは残し、callback再実行や成功への格上げをしない |
| 提供元の`withWriteLease/withReadLease/store` | native排他、atomic durable full replace/CAS、資源正規化、実配置・全writer参加 | このmoduleは既定のOS lock/store/trustを持たない。acquire/release失敗はblocked。committed callbackだけではhandoff成立にしない |
| 提供元の`capture/verifyProvenance/verifyAdoption/issueReceipt/readSourceEvidence` | 原manifest bytes/tree/artifact、検証返却subjectと採用原本、issuer receipt、正確なsource bundle保持 | source欠測/不一致を拒否。工場sourceだけでtrustを発行しない。未知port例外は固定理由へ抑え、任意の生例外を公開しない |

`writeDeployment`の公開結果はcommitted/incomplete/blocked。committed保存後でも最後のguard失敗ならincompleteへの保存を試み、lease wrapperの終了失敗ならblockedになる。初回mutating保存失敗はprefix未変更でもpersistence=unknownであり、state耐久性を推定しない。受理・package成功・receipt発行・保存確定・排他解放は別段階で、画面反映や通常配送ACKを表さない。

## 二つのSHとauthorityの所有

`lib/factory/core-authority-sources.mjs:withCoreAuthoritySources`はinput/writerとbound portを最初に固定し、既`readDeployment`のfactory SH→product SHを入れ子にする。`readSubject/current`は両SHを保持したまま再検証し、source/receipt/検証返却のcanonical JSON bytes/hashを運ぶ。storeファイルの空白込みOS bytesを採取したという意味ではない。productはartifactを要求しtreeだけでは受けない。

private `verifySubjects`は外部I/Oより先にpending promiseを予約する。callback終了時にheld=falseとし、開始済みの全I/OのallSettledまで元SH callbackを保持する。解放後に捕まえたverifierを使うと拒否する。factory/productの原本とissuer解決はそれぞれの明示port所有であり、成功既定口はない。

| 窓口 | 接続と責任 | 拒否・不明・取消 |
| --- | --- | --- |
| `product-setup.mjs:runProductSetup` | 既通常公開入口。GPT前後の観測、任意の`gptCoreExecute`注入口 | 通常callerはauthority executorを自動生成しない。観測失敗は通常結果保持。setup結果とcore原本は別 |
| `update-context-public-executor.mjs:createPublicCoreExecutor` | 明示composition。引数/options/envを固定、最初に一回予約、二SH内でinstalled launchとwhole-source role/hashを照合。child一回・元executor結果を保持 | SH試行前の条件不足なら通常入口一回。SH試行後の未起動declineはprivate sentinelを両wrapperがcompletedで返した時だけfallback。blocked/throw/不明なら起動0。予約後は再実行しない |
| `update_context_socketpair.py:exec_original_factory` | 採用済みdispatcher source port。元Nodeへfd5/6を継承、productへfd6→fd4。fd既使用なら拒否 | 通常CLI/env switchはない。実dispatcherへの登録を推定しない。失敗時に所有fdをclose |
| `update-context-node-broker.mjs:createOriginalNodeAuthorityBroker` | 元Nodeがfd5へ応答。`receive`が固定Python receiverへkernel受信だけ委譲。phase begin→result、challenge/run/identityを照合し二SH検証結果を運ぶ | receiver失敗・size/time/identity不一致は拒否。verifier欠測/例外はunknown応答。元Nodeの送信資格をreceiverの資格へ置換しない |
| `bin/factory-core-authority-receiver.py`→`update_context_broker.py:CoreAuthorityBroker` | Linux/fd4/SOCK_SEQPACKET/SCM_CREDENTIALS、helper/product/元Nodeのpid/start/uid/gid/argv/entryと元control bytesを束縛 | receiverはissuer検証もsocket応答も行わない。2秒alarm/固定scope/出力上限。別pid・再送challenge・切断・truncation・短いwriteは成功でない |
| `update-context-preload-record.mjs`→`update-context-product-preload.mjs` | 固定fd7、16KiB/1500ms EOF/strict UTF8、private activation、期限、entry/registration/preload実file hash。元CLIと同じESM登録identityへ固定bootstrapを注入 | byte/role/path/EOF不一致は未登録。通常body/exitを置換せず、任意module/env/CLIからtrustを選ばない |
| `update-context-core-bootstrap.mjs:createFixedCoreHelperBootstrap` | 固定Python-I-S/helper entry、元control文字列、fd3 private reply/fd4 authority、2500ms上限 | このportはcredentialやverifierの既定実装を持たない。helper失敗を製品結果の再実行へ変えない |

元Node側brokerの受信補助を含むwhole-source roleの検査と、kernel資格情報の検査は別の責任である。pid/entry測定だけではissuer信頼や採用済みpackage artifactを証明しない。

## 観測原本とcore frameの保持

`bin/factory-update-context-observer.py:collect`は明示非秘密whitelistの存在/export/value、限定`/proc` identity/親子、entry hash、既処理の返却値/時間を採取するsource。commandの解決metadataから実Node/npm版・NVM分岐実行を推定しない。launcher原本とphase先行原本hashを結び、48時間以内・private0700/0600・同principalを検査する。今回この採取は実行していない。

`publish_original`はO_EXCL pending→file fsync→hardlinkで非置換publish→pending unlink→directory fsync、必要時bytes読戻し。既最終原本やpendingは推測削除せず、途中失敗なら原本を保持して次の採取を止める。private fd/dirはfinallyで閉じる。これは外部製品の保存adapterや電断保証の代替ではない。

`update-context-observer.mjs:observePublicSetup`はopt-in環境の元public-before receiptだけをprivate WeakMapに保持する。`preparePublicCoreBootstrap`は同じobjectだけを受け、固定`update_context_prepare.py:prepare`で元before hash/bytes/親identityを再確認する。返るrecorded_rawはmetadataであり、issuer/lease/trust/resource読取許可ではない。

`update_context_bootstrap.py:create_ports`が固定trustを接続し、`update_context_trust.py:AuthorityChannel/create_core_ports`は一回challenge・SCM_CREDENTIALS・同元Node・request hashを検査する。factory/product二subjectの原本/全role/manifest/issuer返却を束縛し、phase別authority原本を同private storeへ非置換保存する。begin/resultの同run activation subjectとphase固有の検証bytesは分けて保持する。

`update_context_core.py:handle_core`は元entry/runtime/親子/launcher/before/期限と元begin参照を検査する。通常CLIでverifierが無ければunknown。製品が一度行ったnested JSON admissionを再実装せず、64KiBまでの同frame bytes・UTF8・末尾LF・digest/length・stdout callback完了・full_frame採用を照合する。metadata_only/出力不明/拒否はframeを保存せず、metadata原本だけ残せる。full frame保存後のcrashでframeだけ残れば次回はorphanとして拒否し、再生成しない。

`write_reply`はstdoutと異なるpipe/socketのfd3へbounded JSONを返す。frame保存・recorded_rawでも`reporting_allowed=false/resource_read_authorized=false/normal_job_binding=unknown_until_dispatcher_source_correlation`を維持する。一般配送の受付/ACK/receiptや利用者画面の反映と接続済みにはしない。

## native保存adapterの別候補境界

既Linux fixtureの固定候補`539896bd38d0e0da7600139d30fdb767212deca4`は、現在の製品treeに`linux-fixture-native.mjs/native/linux_helper.py`を含まない。旧候補のsourceを読んだだけで、このbranchへcopy/有効化していない。正本は当席`docs/gpt-ledger-writer-20261025/native-implementation-result.md`。過去13成功はLinux専有fixtureの結果で、今回再走していない。

Node adapterはAsyncLocalStorageでlease所有を束縛、helper RPCを直列化し、abort/deadline時もclose/release・helper exitまで待つ。Python `Session`はprivate UUID fixture/固定stateRoot/同device/許可FS/固定inodeを検査、sorted resource flockと別store.lock、generation CASを所有する。journal入れ子は親deployment SHと重ならない資源だけ。state/evidenceはfile+parent fsyncのintent→pending→replace→intent除去を持つ。残intentは不明停止、旧receiptを復活させない。

固定fixture childはmutating EX下だけ起動、取消/親EOFで自己所有process groupをterminate/kill/waitしてから解放する。helper強制消失・alias差替え等は成功や自動復旧にしない。通常npmを実行するport、実host/prefix、Mac/Windows、電断/実storage、実全writer参加/issuer/storeは範囲外・未成立のままである。他writer管理を引き取らない。

## caller・test・fixture・config・export

公開exportは`canonicalDeployment/writeDeployment/readDeployment`、`withCoreAuthoritySources`、`createPublicCoreExecutor`、`createOriginalNodeAuthorityBroker`、preload recordのvalidate/encode/decode、fixed bootstrapと観測2関数。Pythonは固定loader/固定source呼出しとfixture import。`gptCoreExecute`の通常source注入口はproduct-setupで、literal factory構築callerはfixture側である。writeDeploymentの現製品tree内の実起動callerは見つからず、readDeploymentは二SH compositionが使う。動的/外部callerの不存在は証明しない。

通常の観測接点はsetup-linux-factory/common→observer.sh、agents-update.sh→同helper、product-setup→observer.mjs。新しいCLI/config/exportを今回追加していない。関係する環境変数は観測opt-in/明示出力/期限/source rootであり、authority/trustを有効化する一般switchではない。installのbinリンク配布とrepo相対lib/helper参照も配布接点に含める。

既gateはMakefile `test-core-authority`のPython5入口とNode3file、`ci`依存。`test-update`はproduct-setup等、`test-install`はroot前提/runner登録/profile fixtureを持つ。core observer/operation observer等は独立fixtureも存在し、全fileがこのgateから実行されるとはしない。`.github/workflows`/CI planの選択・配布条件は[CI配布](ci-distribution.md)へ本文接続済み。

今回本文確認したfixtureは`tests/update/core-authority-sources.test.mjs`（subject保持/固定port/非同期I/O解放順）、`public-core-executor.test.mjs`（一回予約/元結果/例外）、`public-executor-release.test.mjs`（解放不明で起動0、両解放確認後だけ通常一回）、`tests/install/runner-profile.test.mjs`。authorityの5Python/helperは後続の[検証対応](verification.md)で本文確認した。旧独立observer等の残部は索引/sectionであり、全fixture本文・実行完了にはしない。当席phase11-writer-contacts.txt/source-review.jsonに固定する。

## 確認済みと残り

writer/source authority/固定bootstrap/観測store、setup補助の本文と上記fixtureを確認。今回docsのみ、旧122試験/4host/native成功を反復せず、実credential/送信/Host/runner metadata/未知trust探索0。新lock・fsync・security修理を追加しない。既writerとnested reader/bridge/storeは別責務として現存しており、実port未供給を新たな成功既定口で埋める案は採らない。追加の責務採否は全体接点を揃えたAstra設計へ渡す。

Caveat/旧診断/CIのsourceは[全体入口](../09_feature-map.md)から接続済み。全fixtureの残部、動的/外部caller・実OS、実live/issuer/store/allwriter/resourceは未確認。SEC002本人later/旧stage停止を維持し、[全体レビュー](final-review.md)を実authority成立の証明にしない。
