# Dotagents全体の図起点リファクタリング

対象はDotagents全体。担当ドロシー、2026年11月3日正式開始。通常の他担当依頼を遮断し、Owner新指示と既Ownerの限定Mac自然受入は保持する。Host/他製品/他writer/1Password端末導入管理は引き取らない。進行・Owner原文・モデル/予定の正本は当席docsに置き、本ページは製品repo内成果物への接続だけを持つ。

base main `9fca2c8bf002b9b0ac8bd22d13d8076142a02ff5`、tree `693448687f8314278c3d7a2dbac1a3b3f3f899c0`。branch `dorothy/feature-map-refactor-20261103`を通常checkoutから分離。初期HEADはbaseと同じ。新しいmain差分は固定baseとの差分を読んで採用判断し、無断で基準を動かさない。

## 成果物と現在地

- [全体の図入口](09_feature-map.md)→[規範生成・配布・導入検査](feature-map/installation.md)→実ファイル/関数。
- 全体は接続索引図の初版。未読の機能は破線と表に明記し、機械索引の件数を意味確認の完了数にしない。
- 規範生成/install/verifyとhost caller接続を最初のSol Highの調査まとまりにした。config applierは書込・rollbackと呼出し順の部分読取まで。source挙動の変更はまだ無い。
- 責務分割・接続・代替案の設計と最後の図/コード整合は、利用可能な最新Astra xhighの適用後に行う。実コード調査/実装は最新Sol Highへ戻してから行う。fastは通常OFF。

## 完了まで残る工程

全機能の詳細調査/図と状態所有の確定、全caller/test/fixture/config/exportの手作業での追跡、Astra設計の採用/維持/代替案と理由、必要な段階的構造整理、変更範囲のfocused検証、図の描画/目視、Astra最終整合、指導担当の成果確認、既承認手順による公開/反映結果を区別して完了する。

本番操作・停止/再起動を今回の実装指示から許可しない。1Password任意化は全体完了後の別差分。既成功試験/4host照合/既完了SEC021等を理由なく再実行しない。
