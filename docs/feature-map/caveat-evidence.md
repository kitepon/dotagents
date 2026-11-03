# Caveat managed診断と非公開evidence候補

[全体入口](../09_feature-map.md)→[公開診断](diagnostics.md)からの詳細。基準main `9fca2c8`、候補`5c5890d`の本文を調査した。managed診断の私有binding原本と、通常scanへ未接続のprivate evidence候補を別の状態所有として扱う。

通常managed接続は[診断図](diagnostics.svg)、純粋候補の[状態図](caveat-evidence.svg) / [原本](caveat-evidence.mmd)。元契約は[製品所有collector/selector](../../lib/factory/caveat-product/README.md)と[isolated evidence](../../lib/factory/evidence/README.md)。この図を採取/worker/配布/Host有効化の許可にしない。

## managed診断の所有・処理順

| 実file・関数 | 入出力・副作用 | 拒否・保持・取消/後始末 |
| --- | --- | --- |
| `caveat-entry.mjs:createCaveatDiagnosticPort/descriptor` | 明示port。実collectorまたは注入inventory→製品selector→clone。公開診断の前後にfresh descriptorを採る | 前読取失敗はresult:null/binding unverified、旧PATHへfallbackしない。後読取失敗/identity・版不一致でも得た通常resultとseverityは残す。collector throwは固定phase/reason |
| 同`collectorReceipt/selectorRejection` | collector exit/reason/spawn codeとstdout/stderrのhash/bytesだけ、固定selector拒否label | 未知例外の自由文/collector原ログをreportへ出さない。`port.evidence()`は最後の値をclone、永続queueではない。診断runCommand自体のthrowは上位へ返り、新完成reportではない |
| 製品所有`caveat-product/read-host.cjs:rootForFile` | 既知managed entry/metadata readerの固定hashを検査して製品の公開readerをimport。選択pointer/manifest/runtime/package版を採る | managed metadata拒否はglobal packageへfallbackしない。製品sourceを無変更コピーした境界で、工場が独自のmanaged parser/修理を追加しない |
| 同`findCommand/parseTomlCaveat/nodeVersion` | 4親config、登録command/引数、指定PATHでの解決。TOMLは導入済みparserか限定literal fallback。識別済みNodeだけ`--version`を5秒/4096bytesで起動 | 親harnessの実env/実sessionを起動していない。未知shimの実interpreterを推定しない。collectorはCaveat/AI CLI/auth/networkを書込・起動しない |
| 同package inventoryと終端照合 | package/dist/node_modulesのfile hash、外部依存manifest/source map版候補、pointer/entry/runtime/configの再読hash。saved reportは過去観測として参照 | 上限8192file/128MiB、symlink/missing/不正はrevision候補を不成立にする。bundleの動的依存closure/実稼働healthは未証明。collector全体の外側制限はcommand runner所有 |
| 製品所有`diagnostic-descriptor.mjs:diagnosticDescriptor` | 4親のenabled/解析/同Node/同entry/同payload/設定hashとmanaged版を検査。固定command/args/identityを返す | 多数決やPATH優先で選ばない。boundは診断結果readyと別。工場の前後照合は設定時刻/key順をidentityに含めず、設定fingerprintと対象を保持 |
| `bin/factory-scan-v9.mjs:atomic` | 明示`--caveat-managed-entry`→port注入。完成report bytes保存→任意ACK出力→`<output>.caveat-binding.json` | 補助保存失敗はstderrとbinding_evidence_status:failed、既reportの通常配送を止めない。rename/0600はcrash durabilityや永続receiptではない。途中temp/親強制終了の清掃を保証しない |

collector/通常診断の子終了・timeout/出力量は既`command.mjs`へ委譲し、別の全scan取消APIやworkerを作らない。今回collector、Node --version、実configや保存reportの読取を実行していない。

scan bindingの`scan_report_sha256`は生成時の正確なbytesに対応する。後のtoolchain finalizeで同IDの本文が変わっても、そのhashを新本文の証明へ読み替えない。配送のServerManager受付、製品ACK、receipt、UI反映とは別である。

## 未接続のprivate validation候補

`lib/factory/evidence/`の4moduleはpure validator/metadata transitionだけ。public scan/command/scheduler/reporter/updateはimportしない。今回の全literal caller索引でも利用は専用testであり、外部/動的caller不存在の証明ではない。実worker/OS adapter/channel/raw file writer/capability discovery/cleanup実行はここに無い。workerSnapshot/osSnapshotのtrueは注入したassertionで、native証明ではない。

| 実関数 | 境界・返却 |
| --- | --- |
| `strict-json.mjs:parseStrictJson` | private入力だけのUint8Array/budget/strict UTF8/コメント・末尾comma・重複key（escape同値含む）/深さ64検査。JSON.parseのown `__proto__`を保持し、optionsへmergeしない。公開投影parserは変更しない |
| `private-contract.mjs:createPrivateValidator` | 製品所有schema3本を注入しAjv2020 strict/no-coerce/no-default/no-removeでcompile。探索・schema更新・OS証明はしない |
| 同`validateRequest/selectCapability/checkWindowsDescriptor` | OFFは補助値を読まず終了。UUID/nonce/限定channel、製品版/OS/launchPath/transportとadapterSupported:trueを確認。Windows descriptorはlocal pipe/実測server pid/start/SIDとの一致を要求 |
| 同`validateTranscript` | 16KiB/EOF:true/NDJSON hello→resultの2行/同executionとnonce/版/transport/peer実測identityを検査。public bytes一行LF/64KiB上限/hash/版/overall/planned exit/sync/HEAD比較/repo理由を照合。not_supported/partial/unverified/validatedを返す |
| 同`simulateEvidenceCollection/localStatus` | OFFは通常callback一回の同一結果だけ。ONも通常処理を先に一回、OS/worker/capacity snapshotとevaluateで固定local statusを付加。private失敗はpublic結果を書換えない |

通常callbackのthrowはそのまま上位へ返る。ON後段の例外だけunverifiedへ投影する。公開diagnosticのexit codeや配送結果をprivate採取成功に置換しない。validation成功もraw保存完了ではなく、fake seamの成功はpendingである。schema上もoperation receiptとahead/behind countsはnot_supported、実HEAD/実accountをfixtureから捏造しない。

fixture schemaは[provenance](../../tests/fixtures/caveat-private-evidence/provenance.json)のCaveat所有固定copy。synthetic capabilityはschema検査用であり、配布packageがtransportを公開した証拠ではない。schema JSONをcompact表示して全field/制約、contract synthetic fixtureを本文確認した。元製品repo内部の更新や配布採用は今回引き取らない。

## report bindingと保持の状態所有

`report-binding.mjs`のstateはcaller所有JSONで、index/outbox/filesystemを開かない。

| 窓口 | 状態遷移と拒否 |
| --- | --- |
| `prepareBinding/inspect/addPrepared` | strict v9 bytesと末尾LF込みbody hashを固定。prepared recordはfreezeし元入力を変更しない。同collectionの同recordはreused、異なるものはbinding_conflict |
| `finalizeBinding` | 同host/report IDのpreparedが一つだけ必要。3toolchainのlast_update check除外+key sortで正規化し、それ以外とCaveat公開投影の一致を要求。親欠測finalized_unbound/多重・変化conflict。新finalizedを別recordとして保持 |
| `recordDelivery` | finalized report ID+正確なbody hashへaccepted/deferred/rejected/unreachableの個別eventを付加。aggregate sent数や異なるbytesは結ばない。同event重複はreused/変更conflict |
| `retention.mjs:reserveCapacity` | 検証済みlock/inventoryとowner pid/boot/creation/nonceを要求し、採取前に上限を予約。同ID拒否。最大7日/256collection/32MiB、1run256KiB、同時4/worker1MiB。managed/temp bytesも課金 |
| 同`settleReservation` | 同ownerの予約を実bytes以下でcomplete/partialへ。partialはfinishedAt:null、容量を保持。入力不正・過大はstateを変更しない |
| 同`planRetention` | 同owner/identity/ownershipの肯定確認とalive:falseだけが候補。不明/live/PID再利用は保持。partial/reservedは24h経過後だけ。期限優先・古い順で必要分をtombstone化 |
| 同`acknowledgeDeletion` | tombstoneも容量を課金したまま。別のdeletionVerified:trueと同ownerの削除ACKで初めてrecordを外す。計画だけで容量を空けない |

保持期限は計算上の選択条件で、cronや常駐cleanupが稼働している意味ではない。dead確認が無ければ古い原本も保持する。これらのmetadata APIにOS取消/物理削除の実装はなく、強制中断で原本が清掃されたという主張もしない。

## 全接点・確認と未確認

managed入口はv9 scan/schedule-runnerの明示flag、scheduler定義へのflag伝播、v9→v5のport注入、binリンク配布とrepo相対libを持つ。既config/CLI/exportは維持し、private候補をそこへ接続しない。公開exportsはport、製品selector、private validator/status/seam、binding各transition/hash、retention各transition/LIMITS。新export/config/dependencyを今回追加していない。

Makefile `test-factory-scan`の`tests/factory-scan/*.test.mjs`が専用契約/状態とmanaged-entry testの入口。今回`caveat-evidence-contract.test.mjs`/`caveat-evidence-state.test.mjs`、`caveat-entry-cli.test.mjs`/`caveat-entry-phase.test.mjs`を本文確認した。raw byte保持/拒否/OFF一回/容量/tombstone/再利用PID/補助保存失敗/flagだけの定義差をfixtureで述べる。CLI fixtureの一部はWindows skip、synthetic Windows peer検査は実pipe/DACL試験ではない。今回実行していない。

全literal接点と固定source/schema hashを当席phase12-source-review.json/phase12-contacts.txtへ保存する。残る全fixture・CI/workflow選択・配布pin/実package・3OS×4親の実利用は未確認。実probe/credential/送信/Host/未知trust探索0。既成功試験は反復しない。
