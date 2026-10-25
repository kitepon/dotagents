# GPT core原本の検証経路を接続するsource案

担当ドロシー。2026-10-25。寿命はtrusted loader・brokerの接続と通常統合が完了するまで。本書のsourceは通常CLIへ未接続。実issuer、npm artifact、通常PRCI/main、実配布、自然jobへの有効化は未成立である。

## 接続する位置と二つの検証元

製品の既存`CoreHelperBridge.exchange`を保つ。元controlをUTF8化したSHA/bytes、同run/mode、activation/期限、kernel process identity、前段public_setup_before原本ref、実entry path/SHAを一つのrequestへ束縛する。completionのWeakMap/tokenは製品process内に保持し、serializeしない。本文は既存stdin、結果は既存fd3を使う。

`lib/factory/update_context_trust.py`は専用authority channelと、既存`handle_core`へ渡す`verify_activation`/`verify_frame`を提供する。通常entryは`bin/factory-update-context-observer.py`である。現在このentryは両portをNoneとしてunknownを返す。未接続を成功へ変える変更は今回含まない。

工場が所有する固定bootstrapは、採用・配置済みのsourceにあるこのadapterを直接importし、`create_core_ports(channel, sender_identity=..., retain_original=...)`へ渡す。任意module名やportをcontrol/環境で選ぶ設定は作らない。bootstrap/authority brokerそのものも工場whole-source manifestへ含める。これらの実装と通常entryへの接続は次の差分であり、今回sourceから存在を推論しない。

| subject | 供給元・元検証の工程 | 保持する原本 |
| --- | --- | --- |
| factory | 通常Git sourceの最終採用・PRCI/mainと実配置。既writerの元provenance/adoption検証、source bundle、SH下verifyCurrentで実配置を照合 | 工場source bundleの元bytes、元receipt bytes、元provenance/adoption返却全体・current検証完了の私有記録 |
| product | 実npm artifactとsource/tree/manifest/adoption対応。既writerのverifyProvenance/verifyAdoption、source bundle、SH下verifyCurrentと既issuer信頼を使う | 製品source bundleの元bytes、元receipt bytes、同artifact bytes/tree digest、元provenance/adoption返却全体・current検証完了の私有記録 |

`factory.deployment-sources.v1`は既writerの返却subjectを追加fieldごと保持する。`verification_original`は新しい輸送用記録であり、既verifyCurrentの返却型を変更しない。verifyCurrentは成功時voidの既契約を維持し、固定brokerが実際にawaitした後で元receiptのSHAと実検証完了を記録する。前回の成功、callbackへ届いた事実、true、入力の期待SHAだけでは記録を発行しない。source bundle/receipt/manifestの元bytesと同じdigestを記録し、元provenance/adoption返却全体も保持する。既issuerと検証元が未接続ならbrokerはstatus unknownを返す。

このmoduleはissuerの再実装をしない。認証された既信頼brokerの出力について原本digest・subject・whole-source範囲・entry・runを確認する。任意に注入したfixture callbackやchannelを実trustの根拠へ昇格させない。

## 固定channelと権限の伝達

authorityは固定fd4のAF_UNIX/SOCK_SEQPACKET endpointで渡す案とする。工場processが対向endpointを保持し、製品/helperへ工場用endpointを渡さない。各helper呼出しは一要求でendpointを閉じる。製品は親側のdescriptorを保持してbegin/resultの子へ継承する。各要求はhelperのrandom challengeを含み、responseはrequest元bytes全体のSHAを返す。replayや並列混線は失敗とする。

fd4は通常stdin/fd3の代用ではない。送信元の検証はSO_PASSCRED/SCM_CREDENTIALSの各messageに付く実pid/uid/gidを使う。SO_PEERCREDはsocket作成時のprocessを示すため、継承後の実送信者を保証する根拠にしない。元factoryのkernel pid/start_ticksと一致し、そのidentityがpublic_setup_beforeと製品の祖先にあることを確認する。固定bootstrapが持つ採用済みprocess identityを使い、製品controlから期待送信者を選ばせない。

brokerは逆方向でも実送信helperをkernel credentialsで照合し、同product parent/entry、activation、run、controlSHAと元before refを確認してから答える必要がある。今回sourceはhelper受信とbinding検証を実装した。brokerの逆方向照合・既verifier呼出し・固定bootstrap・製品spawnは未実装であり、authenticated loader全体の完成とはしない。

responseは131072B以下、制御requestは16384B以下。authority受信1秒、既helper全体2500ms、元frame65536B、reply16384Bを維持する。verified subjectの原本はbase64/元SHA/元bytesを揃える。helperは同一private activationへ既publish/readbackを使い`core_begin.authority.json`又は`core_result.authority.json`を非置換保存する。保存・読戻しが成立するまでframeを認可しない。既metadataのprovenance_refはその所在とSHAを指す。

`verify_frame`は同adapterの私有policyとcontrol completion、元bodySHA/bytes、元write結果が一致する一回だけallowed_fullを返す。nested product JSONをparseせず、製品gateが発行したadmissionと元completionの対応を認証経路で確認する。metadata-onlyやwrite未完の分類は既96908dが所有し、通常出力の再実行をしない。normal_job_binding unknown、reporting/resource falseを維持する。

## 紅蓮への受渡しと次の実装

既CoreHelperBridgeへの適合判断は、(1)元controlのbytes化を一度に固定できるか、(2)固定entryとstdin/fd3にfd4を追加して同runのまま渡せるか、(3)私有completion/元frame/元write結果を再構成せず供給できるか、を対象にする。既serializer/alias/旧成功群の再走は求めない。必要な新製品差分だけ紅蓮が所有する。

当席の次工程は固定brokerの逆方向kernel照合と既writer原本の実検証口の合成、固定bootstrapでのentry配線、必要な専有process照合、通常PRCI/mainの統合である。live検証口が不足してもfactory rawmetadataはobserved_launcher/binding unknownとして分離できる。Fr二重source採否や将来deployment receiptの発行待ちを前段観測の待ち条件にしない。

実投入はEmmaの通常dispatcher/同principal-env・私有保存先・最大48h一回解除と実投入source wholepins・必要承認を一組にする別gate。Caveatの反映許可は流用しない。実host、cron、保存dir作成、NVM/Node/npm/resource採取、HTTP/ref/通常CLI有効化は実行していない。

## 適用範囲と今回の確認

| OS | Claude Code | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| Linux | source対象、通常経路未確認 | source対象、通常経路未確認 | source対象、通常経路未確認 | source対象、通常経路未確認 |
| macOS | 対象外（今回Linux kernel channel） | 対象外（同左） | 対象外（同左） | 対象外（同左） |
| Windows | 対象外（今回Linux kernel channel） | 対象外（同左） | 対象外（同左） | 対象外（同左） |

新しいfixture条件とkernel socketpair/fork条件、既private storeの非置換読戻しを11条件で独立実行し、pass11/fail0/skip0を確認した。AST2件とdiffcheckも成功。make test-core-authorityを通常CIの依存に追加した。通常CI自体は次の統合工程で行う。fixture検証元を実artifact・実issuer受入へ拡張しない。既13/14/26・native/NVM等は再走しない。
