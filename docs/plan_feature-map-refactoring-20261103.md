# Dotagents全体の図起点リファクタリング

対象はDotagents全体。担当ドロシー、2026年11月3日正式開始。通常の他担当依頼を遮断し、Owner新指示と既Ownerの限定Mac自然受入は保持する。Host/他製品/他writer/1Password端末導入管理は引き取らない。進行・Owner原文・モデル/予定の正本は当席docsに置き、本ページは製品repo内成果物への接続を持つ。

基準main `9fca2c8bf002b9b0ac8bd22d13d8076142a02ff5`、初期tree `693448687f8314278c3d7a2dbac1a3b3f3f899c0`。branch `dorothy/feature-map-refactor-20261103`を通常checkoutから分離。新mainの差分を採る場合は固定baseとの差分を読み、基準を無断で動かさない。

## 成果物と現在地

[全体図入口](09_feature-map.md)から、導入/設定/更新、診断/配送、親hook/skill/model、3OS setup/scheduler、GPT writer/authority、Caveat、外部イベント/観測/互換wrapper、CI/配布の詳細と実ファイル・関数へ接続した。[確認範囲](feature-map/scope-review.md)と[検証対応](feature-map/verification.md)に未読/未実行を残す。機械索引を全意味確認の件数にしない。

| 採否と理由 | 実装済みの所有窓口 | 局所受入 |
| --- | --- | --- |
| [第1ADR](adr/20261103-feature-map-responsibility-phase1.md) | [共有toolchain台帳reader](feature-map/toolchain-reader.md) | 関連5file60成功 |
| [第2ADR](adr/20261103-feature-map-responsibility-phase2.md) | [reporter CLI/巡回と8report reader](feature-map/delivery-functions.md) | 関連122成功 |
| [第3ADR](adr/20261103-feature-map-responsibility-phase3.md) | [scheduler state/nonce/ACL](feature-map/legacy-runners.md) | 関連6file60成功。第1の60件とは別 |

ADRsと提案図の未実装表記は設計時点の履歴である。現状詳細に実装後の関数・全接点・保持契約を置く。既parser/各排他/ACK/原本保持の差を統一せず、Windows markerの説明だけ現sourceへ訂正した。ADR0136のclosed current/履歴保護と比較base未伝搬は未解消要件として保持する。

実コードの調査/実装は最新Sol High、設計と最後の整合確認は最新Astra xhighを正式適用して進めた。fastはOFF。[Astra全体レビュー](feature-map/final-review.md)に整合判断と確認範囲の妥当性を固定する。

## 完成前に残る工程

指導担当の独立成果確認、固定候補の既CI契約による3OS受入、既承認手順による公開/反映と結果確認は未完。局所Linux成功を全OS成功へ拡張しない。未変更fixtureの未読枝・実session/中央UI・外部caller、native別fixture/未接続worker・実issuer/store/resource/allwriterも、sourceレビューで解消したことにしない。

具体的な是正があれば、その窓口の本文調査・必要実装/試験/図同期を行って最終整合を更新する。新規codeが無ければ既60/122/60/native13/4hostの無根拠な反復はしない。

本工程では実CI/probe/実台帳/credential/送信/Host/runner metadata/未知trust探索を行わない。公開・本番反映は完成した候補への既承認手順に従い、停止/再起動の許可へ広げない。SEC002本人later/旧stage停止を維持し、1Password任意化は全体リファクタ完了後の別差分とする。
