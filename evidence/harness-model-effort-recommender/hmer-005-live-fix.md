# hmer-005 追記 — 実任務で推薦が返らなかった欠陥と修正

## 欠陥（2026-09-22 02:04Z 実測、修正前 HEAD 09ab83d）

配布先 `bin/recommend-harness.mjs` へ任務だけを渡すと、4件すべて `no_candidate`（`jev chose none`）だった。

| 任務 | 結果 |
|---|---|
| repoのdocsの誤字を1箇所直す小さな修正 | no_candidate |
| 複数repoにまたがる認証設計を見直して、独立した反証も要る難しい設計判断 | no_candidate |
| Claude Code で難しい設計を高い effort でやる | no_candidate |
| Grokで小さな修正 | no_candidate |

推薦が返るのは harness・family・effort を全部 `explicit` で渡した時だけで、それは指定の言い返しである。hmer-005 の証跡が「実呼出し」として記録した1件も explicit 入力だった。

原因: Jev へ全 pool の観測（Cursor・Grok・ChatGPT は `observation_unavailable`、Claude・Codex は capture 不在で `error`）を渡し、「取得不能は残量ではない」と指示していた。Jev は候補の適合でなく残量の欠如で none を選んだ。focused test は fixture の残量で回していたため緑だった。

## 修正（commit d01626f）

- Jev は任務から family×effort だけを選ぶ。観測は Jev へ渡さない。
- コードが Cursor 優先の順で harness を決める。measured で残量 0、または窓が切れた pool だけを候補から外す。未観測 pool は候補に残し、`quota_comparison` は `not_established` のまま返す。
- 結果へ `observations`（pool ごとの状態）と `excluded_pools` を載せる。明示指定の pool が尽きていれば `quota_exhausted`。

## 修正後の実測（2026-09-22 02:15Z、Jev 実呼出し）

| 任務 | harness / family / effort |
|---|---|
| repoのdocsの誤字を1箇所直す小さな修正 | cursor-agent / claude-sonnet-5 / low |
| 複数repoにまたがる認証設計を見直して、独立した反証も要る難しい設計判断 | cursor-agent / claude-sonnet-5 / high |
| 既存のテストが落ちている原因を調べて直す中規模の修正 | cursor-agent / claude-sonnet-5 / medium |
| ChatGPTに設計のsecond opinionを聞く | cursor-agent / claude-sonnet-5 / medium |

effort は難度に追従した。全 pool 未観測のため `quota_comparison` は `not_established`。

## 試験

`node --test tests/orchestrate/recommend-harness.test.mjs tests/orchestrate/recommend-harness-cases.test.mjs` — 10 件 pass、0 fail。新規に、尽きた pool を候補から外して次の harness へ回す試験と、明示指定の pool 枯渇で `quota_exhausted` を返す試験を追加した。

## 残る未達（本追記では直していない）

- 残量は全 pool で未観測。Cursor・Grok は公開の取得口が無い（hmer-001/002）。Codex は product-owned session の `token_count` から取れるが、collect の「収集時刻と一致しない観測は snapshot にしない」規則の下では stale になる。Claude は稼働中 session の statusline が要る。
- 工程5の比較5項目（成功率・手戻り・監査工数・総 token・所要時間）は未計測のまま。
