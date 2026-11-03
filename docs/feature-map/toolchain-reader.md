# toolchain台帳読取り：共通所有者と保持契約

[全体入口](../09_feature-map.md) / [更新と確定](update.md) / [採用理由](../adr/20261103-feature-map-responsibility-phase1.md) / [現状描画](toolchain-reader.svg) / [原本](toolchain-reader.mmd)

基準main `9fca2c8`からの第1構造整理。v2/v4/v5で同一だった読取/path/helper本文を照合し、[toolchain-ledger.mjs](../../lib/factory/toolchain-ledger.mjs)へまとめた。書込みは既[record CLI](../../bin/factory-toolchain-ledger.mjs)が所有し、schema/受理差は保持する。

| 処理 | 実装とcaller | 受渡しと保持 |
| --- | --- | --- |
| 既定path | `defaultToolchainLedgerPath(targetPlatform)`、v2/v4/v5 scanとv5 finalize | 呼出時のHOME/XDG/Windows環境からpathを得る |
| 読取り・検査 | `readToolchainLedger(path)`→private `validateLedger/exact/semver/utc` | regular file/symlink/1 MiB/mode、JSON/exact schema検査。元値またはunavailableを返す |
| 世代別投影 | 各wireの`applyToolchainLedger` | v2/v4の旧失敗投影とv5の起動根拠による重大度/post-gate写像を保持 |
| 同report確定 | `v5.mjs:finalizeToolchainReport`→schedule runner | 既ID/時刻/他製品結果を保持。配送/ACK/画面反映とは別 |

v6→v5、v7→v6、v8→v7、v9→v8の公開scan接続を確認。v2/v4/v5のbin scanも既exportを使う。拡張子なしbin入口、薄いwire入口、configは保持。新moduleはrepo内相対importで到達するlibで、新CLI/HOME linkを足さない。外部repo caller/動的aliasの全利用は未確定だが、既公開export名/引数/返却は保持した。

失敗は`{ value: null, error: 'toolchain_ledger_unavailable' }`で、欠測/不正/権限不足を成功へ丸めない。stateの修復/削除、retry/lock/temp/AbortSignalを加えない。強制終了の完了有無は不明のまま。mode検査は既存のprocess.platform、path選択はtargetPlatformを使用する。writerの暗黙version型変換、readerの文字列型検査、更新のstrict SemVerを一括統合していない。

## 検証と残り

[reader試験](../../tests/factory-scan/toolchain-ledger-reader.test.mjs)は`make test-factory-scan`の既globに接続。正常/空ledger/status集合/許容version、型/key/product/status/reason/UTC/JSON拒否、元bytes保持、欠測/directory/サイズ、POSIX symlink/mode、呼出時pathを隔離確認する。

当席Linuxで新reader・既v2 scan・finalize-report・台帳writer・schedulerの5file、60 PASS/0 FAIL/0 SKIP。4moduleのnode構文検査成功。3wireの残り本文が固定前候補と同一であることも、reader/path除去とimport変更を除いて照合した。世代別投影は変更していない。

共通JSのCI分類は3OS full対象。最終全体CI/実Mac/Windows/Host更新は未実行。Windows実ACLを模擬合格へ数えず、既成功4host照合も反復しない。診断/outbox/ACKは各詳細へ接続済みで、全fixture全文は未確認。Astraの判断は[全体レビュー](final-review.md)を参照する。
