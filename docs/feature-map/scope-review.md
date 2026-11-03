# 全体の本文確認・接続と残り

[全体入口](../09_feature-map.md)。base `9fca2c8`、候補`257d8f8`時点の既機械索引と現状詳細を照合した。初期索引は1397 tracked path/324 active file、今回の機能別分類は317pathで、定義・export・設定の初期候補pathを含む。分類対象数を全意味確認の件数にしない。各fileのhash/機械分類/図への文字参照/今回の本文確認は当席phase13-coverage-index.json/source-review.jsonで区別する。basenameが文書に無いだけでは未読と断定せず、文字参照が有るだけでも本文確認済みにしない。

## 現状の所有窓口

| 機能 | 現状詳細と接点 | 追加確認が残る範囲 |
| --- | --- | --- |
| 規範生成/install/verify | [導入](installation.md)、[親hook/skill](harness.md) | clean-home等の全fixture後半/実session、未列挙alias/外部caller |
| config applier/source同期/更新 | [設定](configuration.md)、[更新確定](update.md)、[setup](setup.md) | 他製品更新relay/退役parkと実callerの逆対応、全fixture |
| 3OS setup/scheduler | [setup](setup.md)、[CI配布](ci-distribution.md)の補助入口 | [世代別runner](legacy-runners.md)へ差を接続済み。全fixture/動的caller/実OS |
| 公開診断・旧wire | [診断](diagnostics.md)、[v2/v4](legacy-diagnostics.md) | 実probe不要。診断の全fixtureと動的command/版alias |
| 配送/ACK/receipt | [配送](delivery.md)、[CLI/reader](delivery-functions.md) | [外部イベント](external-events.md)・[旧runner](legacy-runners.md)へ保存/ACK/世代差を接続済み。全fixture/外部callerは残る |
| GPT/Rabbit観測・permit境界 | [writer/authority](deployment.md)、[診断](diagnostics.md) | [観測入口/一回保持](gpt-observation.md)へ本文/原本/許可/接点を接続済み。実permit/trustは未探索 |
| Caveat managed/private candidate | [collector/保持](caveat-evidence.md) | native worker/channel/raw保存は未接続候補。全fixture/配布実物/実OSを成功扱いしない |
| model/4親hook/skill/agent | [harness](harness.md)、[モデル選定](model-selection.md) | 親session実発火と動的利用。既1Password接点保持、任意化は全体完了後別差分 |
| 開発文書/CI/Lattice inventory | [CI配布](ci-distribution.md) | 旧ADRと実比較base経路、busy marker文書差、全fixture/branch protection/実CI・公開 |

全fileを同じ深さで再調査するのではなく、機能全体から責任窓口・状態と全接点を辿れるかを確認する。候補の二つの構造整理を全体リファクタ完了へ置換しない。

## 今回閉じた補助入口と残る本文のまとまり

CI/renderer/Lattice inventory、公開製品setup relay、factory deployment/toolchain CLI、gh auth status helper、npm退避、Caveat更新owner、Windows report inventory/runner capacity source、platform chmod helper、unai installer、退役WSL2入口を本文確認した。これらの実操作は行っていない。

Oracle互換`oracle-mcp-stable.sh/oracle-chrome-shim.sh`、`sync-sweep.sh`、`update-grok-community-overlay.sh`も本文を読んだ。前者は通常gpt-connectorと別の明示rollback入口で、Node/global-root/Chrome解決とexec、QoS guard、負座標の非可視非保証を保持する。sync-sweepは各repoをfetchして台帳をstdoutへ出し、失敗を行に残す。Community overlayは製品所有scripts/update-overlay.shへ順次委譲し、--pushは明示引数だけ。成功済み最初の製品を第二の失敗でrollbackしない。製品内部・他repoの操作を今回引き受けない。今回[世代別runner/互換入口](legacy-runners.md)へ配布/全literal接点/test/設定の対応を接続した。動的/外部利用者は未確定。

外部イベント系とGPT/Rabbit観測選択系、旧v1/v2/v4runnerとv5共通runnerを本文確認し、上の詳細へ接続した。各public export、library import、CLI/bin配布、fixture/gateのliteral候補を当席phase14-contacts.txtに固定。runtime-context/deployment-contract等の参照済み窓口も含めた、未列挙alias/動的・外部callerと全fixtureの意味確認は残る。次は既2構造整理と新たに見えた重複・保持差・旧文書差の責務採否を、Astra適用後にまとめて判断する。

これは未確定のsourceだけの工程で、実runtime/実credential/permit/実観測/他writer参加の探索ではない。旧live/issuer/store/resource/allwriter未確定とSEC002本人later/旧stage停止を保持する。

## 設計・実装・検証の残り

追加の責務分割・重複整理・代替案採否は、残る接点を揃えて最新Astra xhigh適用後の設計まとまりへ渡す。旧wireのexact受理、Caveat parser差、重大度/指紋、collection/空ACK、各保存/取消・結果不明を機械的に統一しない。採否前の実装は行わない。

変更範囲の必要fixtureと全体確認、図の実描画/目視、適用済みAstra最終全体整合、指導担当の成果確認、完成候補と既承認手順による反映結果は別工程。今回の文書確認だけでruntime gate/CI/3OS受入を再実行済みにしない。実動作なしのdocs調査を続けるたびに既122/60/native13/4host試験を反復しない。

## 第3採否後の具体工程

[第3責務設計](../adr/20261103-feature-map-responsibility-phase3.md)でscheduler専用state/nonce lock抽出を採用した。全体の所有窓口は同ADRの採否表にまとめ、旧parser/観測/各lockの異なる契約は維持する。Windows marker説明は訂正済み、ADR0136の要件と実装差は未解消のまま。実装はSol適用後である。

次は新module/3runnerと全relayの接点を確定し、既scheduler/PS7 source fixtureを追従、必要な世代別・原本保持caseを隔離検証して現状図へ接続する。既読scheduler fixtureのRUNNERはv4であり、全世代の挙動確認へ代用しない。

残るsource接続は、`agents-update-scheduler-contract.mjs`、`jev-products.mjs`の窓口と、`deployment-contract.mjs`/`runtime-context.mjs`の実関数・逆caller、今回確認した`windows-powershell.mjs`の返却を有限に照合する。setup/update/delivery/CI詳細へ不足分だけ補う。aliasやfile名が詳細本文にない候補を機械的に未読へ分類し直さない。全fixtureの未読一覧/既gate所属/OS条件、動的・外部caller、実OSと実CI/配布受入は引き続き残る。

## 第3実装後

scheduler state抽出とsource fixture追従、関連6file60試験を実施し、[runner](legacy-runners.md)へ同期した。補助5sourceの本文・逆callerを[setup](setup.md)/[配送](delivery.md)/[CI](ci-distribution.md)へ追補し、前段で挙げた有限source接続を閉じた。これは全fixture/全OS/動的外部callerの完了ではない。

次は既source-reviewの全文/section根拠と全tests/helper/configを照合し、未読fixtureを機能別・既gate・OS条件へ対応させる。特にclean-home後半、旧v2専用fixtureのgate外配置、authority Python/Node helper、Caveat private fixtureの実worker未接続、wire別の実使用majorを維持する。必要な全体検証範囲をこの対応から確定して実施し、図の全体から実関数/失敗保持までの最終確認資料をAstraへ渡す。既成功試験を理由なく全量反復せず、実OS受入・公開の不足を局所Linux試験で補完しない。
