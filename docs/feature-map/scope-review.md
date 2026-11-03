# 全体の本文確認・接続と残り

[全体入口](../09_feature-map.md) / [検証対応](verification.md) / [Astra全体レビュー](final-review.md)。基準main `9fca2c8`。このページは現在の確認範囲を持ち、工程履歴は各ADRと当席progressに残す。

初期索引1397 tracked path/324 active file、phase13の317path、phase14の37path/181literal接点、phase17の120test pathは機械索引または読取scopeの記録であり、全意味確認の件数ではない。basenameの記載有無、glob所属、既reviewの記録有無だけで全文読了や未読を判定しない。

## 現在の所有窓口と確認範囲

| 機能 | 本文と状態/接続の正本 | 残る未確認 |
| --- | --- | --- |
| 規範生成/install/verify/config | [導入](installation.md)、[設定](configuration.md) | clean-home後半は本文確認済み。その他config/OS fixtureの全枝、実session、外部caller |
| source同期/日次更新/失敗state | [更新](update.md)、[setup](setup.md) | cron-envと失敗report fixtureはsection/接点中心。全fixture全文、実更新/配送は未確認 |
| 3OS setup/scheduler/公開setup | [setup](setup.md)、[runner](legacy-runners.md) | root/profile/Jev補助も本文接続済み。実OS登録/自然発火/Host導入版は未確認 |
| 公開診断・旧wire | [診断](diagnostics.md)、[旧v2/v4](legacy-diagnostics.md) | 各診断fixtureの未読枝、動的command/外部caller。実probeは未実行 |
| 配送/ACK/receipt/各排他 | [配送](delivery.md)、[関数](delivery-functions.md)、[runner](legacy-runners.md) | 旧transport/runner本文は接続済み。wire5〜8全case/実OS/中央UIは未確認 |
| GPT/Rabbit観測 | [観測入口](gpt-observation.md)、[writer/authority](deployment.md) | 通常閉鎖/過去限定scopeを保持。実permit/issuer/store/resource/allwriterは未確定 |
| Caveat managed/private候補 | [collectorと保持](caveat-evidence.md) | 実worker/channel/raw保存は未接続候補。synthetic fixtureを実OS受入にしない |
| 親hook/skill/model | [harness](harness.md)、[モデル](model-selection.md) | 実session発火と動的利用、fixture全枝。1Password任意化は全体完了後別差分 |
| 互換wrapper/補助relay | [runner](legacy-runners.md)、[setup](setup.md)、[CI配布](ci-distribution.md) | Oracle/sync/Community/公開setupのliteral接点を確認。外部利用不存在とはしない |
| CI/文書/配布 | [CI配布](ci-distribution.md) | ADR0136要件の実装差、実3OS full/branch protection/公開受入。Windows marker説明は訂正済み |

本文確認はsourceの責任と受渡しを説明する根拠であり、実動作の受入とは別である。他製品内部/Host/他writerを対象へ取り込まない。

## 採用した整理と整合判断

三つのADRで台帳reader、reporter CLI/巡回と8reader、scheduler stateを整理した。現状図と実関数は[台帳reader](toolchain-reader.md)、[配送関数](delivery-functions.md)、[runner](legacy-runners.md)を正本とする。旧wireの受理/重大度/理由指紋/ACK/保持と、v1/queue/event/nativeの異なる排他を共通化していない。

第3実装後の補助5source（agents-update-scheduler-contract、jev-products、deployment-contract、runtime-context、windows-powershell）の本文・逆caller接続は完了。postUpdateFailuresは通常source内のliteral実caller未確認でfixture利用を記す。新policy・実trustや成功既定portは追加しない。

Astra最終照合では三整理の責任分割と保持契約に新たな実装上の是正事項を見つけず、現状説明に残った古い未実装/未読記述を訂正した。採否と検証の妥当性、完成前の残りは[全体レビュー](final-review.md)が所有する。

## 残る工程

未変更fixture全体の全文再監査を三整理の受入条件へ後付けしない。一方、部分読取を全文読了へ格上げもしない。既局所受入60/122/第3関連60、全体lintと文書/CI分類の20試験は別の根拠で、実3OS fullや配布受入の代わりにはならない。

指導担当の独立成果確認を受け、具体的な不足が返れば対象file/function/callerだけを調査・是正する。実装変更ならSol Highの正式適用後に行い、その差分の必要試験/図同期後にAstraへ戻す。指導返信を新しい無関係作業のgateにしない。

公開/反映前は、固定候補に対する既CI契約の3OS受入と承認手順が残る。現工程から実CI/Host/metadata/credential/送信を開始しない。次の実作業では候補差分と既CI入力・未実行OS受入をレビュー可能な形へまとめ、具体的な成果に対する必要な判断へつなぐ。Mac指定既log、SEC002本人later/旧stage停止、native別候補、1Password任意化別差分の境界を維持する。
