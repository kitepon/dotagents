# 候補の検証対応と未確認

[全体入口](../09_feature-map.md) / [確認範囲](scope-review.md)。基準main `9fca2c8`、第3実装`095455f`を対象に、変更窓口の受入と未変更fixtureの調査深度を区別する。本書は実Host/中央表示/全fixture全文の合格証明ではない。各状態・失敗処理の正本は各機能詳細に置く。

## 構造整理と受入根拠

| 変更する責務 | caller・fixture・gate | 確認した結果と残り |
| --- | --- | --- |
| 台帳path/reader | v2/v4/v5→v6-v9 scan/finalize。toolchain-ledger-reader、v2 scan、finalize、writer、schedulerの既5file | 既60成功、構文・移動前後本文照合。[reader](toolchain-reader.md)。新state抽出後のfinalize/schedulerは第3試験で再確認。実OS保存/全writerは未確認 |
| reporter CLI/巡回・8reader | 旧v1/v2/v4、v5-v8 readerとv9 Rabbit専用reader、wire CLI/queue/fragment/ACK fixture | 既122成功、元bytes/失敗/保持と既本文一致。[配送関数](delivery-functions.md)。今回この122全量は再走していない |
| scheduler state/nonce/ACL | v2/v4/v5とv6-v9 relay、新state/scheduler/PS7/finalize/v9flag/旧gateの6file | 第3実装60成功/skip0、新module/3runner構文、helper本文export以外とrunner残部一致。[runner](legacy-runners.md)。新testは既reporter glob、Windows ACLの実OS実行は未確認 |
| 全体の静的・文書接続 | Makefileのlint全target、test-current-docs、test-ci-plan | 自席envを読み込んだ`make lint test-current-docs test-ci-plan`成功。Markdown267file/0error、current-docs656文書、文書10・CI plan10試験成功。履歴不変性や実CIの合格へ拡張しない |

最初のlintはShellCheckがPATHに無くexit127で停止した。自席の既保存0.11.0とmanifestを既setup補助で検証し、既environment/env.shを読み込んで再実行した。検査条件・製品source・共通Host設定は変えていない。構文検査によるPython cache等は製品成果物に含めない。

## fixtureの意味と実行範囲

| 機能と実窓口 | 本文・接点の確認 | gate・OS・未確認 |
| --- | --- | --- |
| install/config保持 | clean-home.shのofficial/legacy面、廃止link回収、未知hook/model保持、外部CODEX_HOME backup、安全なmember名、非symlink、空file復元と2本目replace失敗rollbackまで確認 | test-install。POSIX権限検査はWindowsで明示省略、Windowsはnative symlink/引用の分岐。親session発火や実アカウント認証を検査しない。今回は本文確認で実行していない |
| 旧v2配送 | tests/factory-reporter-v2/factory-reporter-v2.test.mjs全文。v2 CLI・schema2・偽loopback受信・fake ACK、128件容量、応答消失、deferred、受付後ACK失敗/成功の原本保持 | Makefileのreporter glob外で、先の第2受入では明示実行。XDGだけを隔離する古いfixtureであり、Windows state/HOME完全隔離やspawn error cleanupを新fixtureと同一にしない。今回は再走せず、gate改修も加えない |
| authorityの合成 | context_trust_adapter_test.py、context_authority_phase_test.py、context_bootstrap_broker_test.py全文。合成subject/issuer/SHと原本、phase/run/receipt不一致、実kernel wireでもfixture_core、許可falseを維持 | test-core-authority。store/SCM_CREDENTIALS/forkはLinux限定。実issuer・Host/store・全writerは検査しない |
| 元Node/採用登録 | context_original_node_test.py、context_public_registration_test.py全文。元Node/独立receiver・fd4/5/6/7、同じregistration identity、元exit2保持、欠測issuer/whole-source role/誤pid、UTF8/partial/EOF拒否 | test-core-authority。Linux専用、node/helper/専有tempを使う。CORE_PRODUCT_BRIDGE_SOURCE等の任意外部注入口は今回供給せず実行もしていない |
| authority専用helper | node_factory_bootstrap_fixture.py→original_node_factory_fixture.mjs→core_bootstrap_product_fixture.mjs、public_core_origin_fixture.py→public_core_wire_fixture.mjs、public_registration_fixture.mjsの接続を確認 | Python testから間接実行。合成source/issuer/SHと通常製品setupを区別。public_core_wireは別の独立統合入口も持つ。helper存在を通常composition配線済みとしない |
| 旧観測/metadata独立試験 | context_core_observer/context_observer/context_operation_observer、core_metadata_wireとcore_observer_fixtureの接続を確認。core_observer_fixture/core_metadata_wire本文は確認 | Makefileから直接は呼ばれない。固定の過去artifact rootや独自env出力を持つ。未読本文の残部と既原本は下記一覧で区別し、現在Hostの採取や無根拠な再走へ流用しない |
| Caveat private contract | caveat-evidence-contract/state fixture→tests/fixtures/caveat-private-evidenceのcontract/provenance/schema。既[保持詳細](caveat-evidence.md)へ接続 | test-factory-scanから読込。純粋な状態/contract fixtureであり、実worker/channel/raw保存は未接続候補。OS条件付きcaseを全OS受入にしない |
| wire5〜9 | 各wire testのschema/CLI/endpoint/stateは世代別。wire9 fragmentはv9 transport、旧v8集合保持はv9 suite内にもある。basenameによるrunner選択を確認 | test-factory-wire。case/接点索引と全文確認は別。旧wire成功はv9原本保持や通常空ACKの実証ではない |
| 公開診断/親hook/skill/model | 各診断・harness詳細→scan fixture/4親smoke/skills/pick-modelの入口 | test-factory-scan/lint-hooks/lint-skills/test-pick-model。今回hook/skill静的smokeは成功、実親session/製品probeは未実行 |

## 未読・未実行の正確な扱い

当席phase17-fixture-review.jsonは、全tests pathについて既review記録、新たな全文/section、直接Make所属、OS条件のliteral候補を対応させる。これは手掛かりの一覧であり、本文を今回全部読んだ件数ではない。間接helperやglobの一致だけで既gate実行・OS分岐・意味の受入を推測しない。

既記録に全文scopeが無いfileには「全文確認を保証しない」を残す。特に未変更の診断個別case、旧観測3Python本文の残部、wire5〜8の各case全体、config/hook/公開setupの全fixture枝は、今回全量監査したとはしない。変更した共有窓口の受入は上表と各実装記録のfocused fixtureで示す。全fixture全文の確認と最終Astraの対象範囲判定は別であり、この未確認を消して全体完了にはしない。

実Mac/Windows、実CIの3OS full、branch protection、動的/外部caller、親session認識、中央画面反映、実issuer/store/resource/allwriterは未確定。repo内共通JS/図変更のCI分類は3OS fullのまま。実CI起動・Host/runner metadata・credential/送信/permit/trust探索をこの確認から開始しない。

ADR0136のclosed current/履歴保護と比較base未伝搬の要件差、通常GPT入口の欠測factによる閉鎖、Rabbit過去scope、native別候補、Caveat未接続workerを既知の制限として維持する。次のAstraは図/実装/採否/受入とこの未確認を全体で照合し、追加確認が必要なら具体的窓口へ返す。候補の公開・本番反映はまだ行わない。
