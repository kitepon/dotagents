# 子のモデル候補選定と利用枠の入力

[全体入口](../09_feature-map.md) / [現状図](model-selection.svg) / [原本](model-selection.mmd)

`bin/pick-model.mjs`、`lib/pick-model.mjs`とcredential loaderを本文確認した。これはDotagentsの子候補を返すCLIの構造で、BellTeamのget_self/update_selfの実装や親モデル設定を所有する意味ではない。実API・実利用記録・credentialは読んでいない。

| 所有 | 実ファイル・関数 | 受渡し・失敗・保持 |
| --- | --- | --- |
| CLI | `bin/pick-model.mjs:main` | task一引数か`--closed harness --until time`。不正/失敗はstderrとexit2、成功JSONをstdoutへ返す |
| 候補正本 | `lib/pick-model.mjs:roles/modelOptions/tableRows` | 02_models.mdの役割・順位・諸元から統括以外を作る。未知model/harness/候補なしはthrow。モデル名を別台帳へ複製しない |
| 利用枠 | 同`latestRollout/codexUsage` | sessions配下でmtimeが最新のrolloutを選び、後ろからprimary rate_limitsを読む。記録不在はnull。JSON/IO等の異常は上位へ。live quota確認ではない |
| 閉鎖状態 | 同`closuresPath/readClosures/recordClosure` | XDG_STATE_HOME既定のharness-closures.json。欠測は空、期限内だけ返す。更新はharness/日時を検査しmkdir→直接write、排他/atomic/fsyncは追加されていない |
| 候補選択 | 同`pickModel/roleRequest/pickRequest/ask` | 02全文とtaskを使いroleを一回、その役割のopen候補を一回Jevへ問い合わせる。Codex100%以上ならresetまで候補から除く |
| API結果 | 同`ask` | 各requestは60秒AbortSignal。network/timeoutはJEV_UNREACHABLE、HTTPはJEV_HTTP、choice形/範囲不成立はJEV_INVALID_ANSWER。JSON parse例外は元のまま上位へ |
| credential | `lib/factory/typesafe-credentials.mjs:loadTypeSafeKey` | env→private fileの順。不在時だけ既SSH転送→保護directory→exclusive file保存。転送/ACL失敗は停止、既fileは上書きしない。実行・承認を今回増やさない |

候補結果はtask/role/harness/model/effort/confidence/閉鎖/利用枠を返す。CLIが子をspawnしたり親モデルを変更したりはしない。role問い合わせだけ成功して候補問い合わせに失敗しても、選定完了JSONを返さない。自動別モデルfallback/retryはない。途中取消では外部APIが処理済みか不明な場合があり、照会結果や取消receiptの永続化は行わない。

credential取得は選定APIより前に呼ばれ、後続失敗でも保存済みfileは戻さない。閉鎖更新の直接writeとAPI選定を一つのtransactionとして扱わない。通常選定時の期限切れ除外は読取結果のfilterで、明示閉鎖記録時だけstateを書き直す。

全リポliteral参照ではCLIと`tests/pick-model/pick-model.test.mjs`が公開libraryのcaller。binは既installの配布経路、fixtureは既Makefile test-pick-model globに入る。fixture本文から役割/候補、最新rollout、閉鎖期限、2段階fake request、HTTP失敗を確認した。今回は文書だけのため試験は反復していない。動的/外部caller、実platform、実API選定の結果は未確認。

親hook/skillと02本文・harness定義の調査は[harness詳細](harness.md)へ接続済み。実発火や動的利用は未確認。今回のsource読取だけで子モデル変更を適用したり、候補選定を運用上の許可とみなしたりしない。新しい汎用選定層や失敗fallbackは作らない。
