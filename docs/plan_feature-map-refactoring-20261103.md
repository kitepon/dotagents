# Dotagents全体の図起点リファクタリング

対象はDotagents全体。担当ドロシー、2026年11月3日正式開始。通常の他担当依頼を遮断し、Owner新指示と既Ownerの限定Mac自然受入は保持する。Host/他製品/他writer/1Password端末導入管理は引き取らない。進行・Owner原文・モデル/予定の正本は当席docsに置き、本ページは製品repo内成果物への接続だけを持つ。

base main `9fca2c8bf002b9b0ac8bd22d13d8076142a02ff5`、tree `693448687f8314278c3d7a2dbac1a3b3f3f899c0`。branch `dorothy/feature-map-refactor-20261103`を通常checkoutから分離。初期HEADはbaseと同じ。新しいmain差分は固定baseとの差分を読んで採用判断し、無断で基準を動かさない。

## 成果物と現在地

- [全体の図入口](09_feature-map.md)→[規範生成・配布・導入検査](feature-map/installation.md)→実ファイル/関数。
- 全体は接続索引図の初版。未読の機能は破線と表に明記し、機械索引の件数を意味確認の完了数にしない。
- 規範生成/install/verifyとhost caller接続を最初のSol Highの調査まとまりにした。config applierは書込・rollbackと呼出し順の部分読取まで。source挙動の変更はまだ無い。
- 次のSol調査で[4config applier](feature-map/configuration.md)と[source同期/日次更新/台帳確定・失敗報告](feature-map/update.md)の本文を追跡した。現状詳細を追加し、実装の挙動差分はまだ無い。
- 責務分割・接続・代替案の設計と最後の図/コード整合は、利用可能な最新Astra xhighの適用後に行う。実コード調査/実装は最新Sol Highへ戻してから行う。fastは通常OFF。
- 適用済みAstraによる[第1責務設計](adr/20261103-feature-map-responsibility-phase1.md)を残した。v2/v4/v5の共通台帳readerを最初の構造整理に採用し、writer受理差・wire投影差・4applier保存差は保持する。接点の確定と実装は次のSolまとまり。全体の設計完了や最終整合とはしない。

## 完了まで残る工程

全機能の詳細調査/図と状態所有の確定、全caller/test/fixture/config/exportの手作業での追跡、Astra設計の採用/維持/代替案と理由、必要な段階的構造整理、変更範囲のfocused検証、図の描画/目視、Astra最終整合、指導担当の成果確認、既承認手順による公開/反映結果を区別して完了する。

本番操作・停止/再起動を今回の実装指示から許可しない。1Password任意化は全体完了後の別差分。既成功試験/4host照合/既完了SEC021等を理由なく再実行しない。

第1構造整理の[台帳reader](feature-map/toolchain-reader.md)を実装・局所検証した。診断からtransportの本文調査と全体の残りは継続する。

[配送・保持の現状図](feature-map/delivery.md)を追加。v5-v9共通reporter/fragment/ACK・契約とcommand終了を本文確認、旧transportと全製品診断深部は未調査。責務整理の追加採否はAstra設計へ渡す。

[第2責務設計](adr/20261103-feature-map-responsibility-phase2.md)で、同file内のCLI/queue巡回分割と8report readerの共有を採用。postOne/fragment/controlled/ACKの既責務は維持する。次のSolで全接点を確定して実装・図同期・局所検証し、旧transport/診断深部から全体の未読調査へ続ける。現時点で第2案のコード変更はない。

現在、第2案は[配送CLI/reader](feature-map/delivery-functions.md)へ実装・局所122試験済み。上の「次のSol」「変更はない」は設計時点の履歴。以後の[診断](feature-map/diagnostics.md)、[親hook/skill](feature-map/harness.md)、[3OS setup/scheduler](feature-map/setup.md)、[GPT writer/authority](feature-map/deployment.md)のsource調査を接続した。全fixture/CI配布/Caveat evidence/旧診断と最終Astra整合は継続し、全体完了とはしない。

[Caveat collector/非公開evidence](feature-map/caveat-evidence.md)と[旧v2/v4個別診断](feature-map/legacy-diagnostics.md)の本文対応を追加。managed診断のbinding原本と未接続pure candidateを分け、実worker/OS/channel/raw保存が実装済みという扱いにしない。旧wireの受理/重大度/ACK差と重複parserの観測を次の責務採否へ残す。全fixture/CI・配布、動的/外部caller・実OS・最終Astra整合は未完。

[CI・文書検査・配布接点](feature-map/ci-distribution.md)と[全体の残り](feature-map/scope-review.md)を接続した。現sourceの比較base/gateと、旧ADR/runner待機文書との不一致を観測として保持する。機械分類は全意味確認ではなく、外部イベント/観測入口/互換wrapper等の残る接点を有限に閉じて追加Astra設計へ渡す。

[外部イベント保存](feature-map/external-events.md)、[GPT/Rabbit観測入口](feature-map/gpt-observation.md)、[旧runner/互換入口](feature-map/legacy-runners.md)を本文から接続した。nonce lock本体の重複と、旧wire gate/保持・通常閉鎖・過去限定scopeの差を追加責務採否へ渡す。全fixture/外部caller/実OS・最終Astra全体整合は未完。
