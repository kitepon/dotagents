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

## 第二の欠陥 — 判断基準を渡していなかった

修正後の 4 件はすべて Sonnet 5 で、02 の順位表と照らすと一致は 4 件中 1 件だった（軽作業の 1 位は Luna、設計は Opus、相談は ChatGPT）。Jev に渡していたのがモデル名と effort だけで、オーナーが実測で決めた順位表を渡していなかったため、Jev は一般知識で無難なモデルへ寄った。「順位表は Jev へ送らない」は hmer-005 の証跡にだけ書かれ、計画にも ADR にも根拠が無い。

### 修正（commit 後述）

- `parseRankTable` が `docs/02_models.md` の順位表を実行時に読む（役割 → 順位付き family×efforts。統括は親の役割なので除く。`low〜medium` は範囲、Haiku と ChatGPT は effort 無し）。順位表の複製は持たない。
- Jev には任務と役割一覧を渡し、「どの役割の仕事か」と「難度（light / ordinary / hard）」だけを選ばせる。モデルは選ばせない。
- コードがその役割の順位を 1 位から辿り、effort 範囲は難度で決め（hard なら上端、他は下端）、Cursor 優先の harness 順と pool の除外を適用する。全 harness が尽きた順位は次の順位へ回す。

### 修正後の実測（2026-09-22 02:26Z、Jev 実呼出し）

| 任務 | 結果 | 02 の順位 |
|---|---|---|
| repoのdocsの誤字を1箇所直す小さな修正 | codex-native / luna / low | 軽作業 1 位 |
| 複数repoにまたがる認証設計、独立反証も要る | cursor-agent / opus-5 / high | 設計 1 位 |
| 落ちているテストの原因調査と修正 | codex-native / luna / medium | 局所コーディング 1 位 |
| ChatGPTに設計のsecond opinionを聞く | gpt-connector / chatgpt | 相談 1 位 |
| 監査指摘が正しいか反対仮説を立てて潰す | cursor-agent / grok-4.6 / high | 反証 1 位 |
| 受入条件が数値で書けている機能の実装 | codex-native / terra / high | 実装 1 位 |
| 外部ライブラリの最新仕様をWebで調べる | cursor-agent / grok-4.6 / low | 調査 1 位（low〜medium の下端） |

7 件すべて 02 の 1 位と一致した。

## 試験

`node --test tests/orchestrate/recommend-harness.test.mjs tests/orchestrate/recommend-harness-cases.test.mjs tests/orchestrate/recommendation-contract.test.mjs` — 19 件 pass、0 fail。順位表の読取り、役割と難度からの選択、effort 範囲、pool 枯渇時の harness 送りと順位送り、明示指定の枯渇を試験に加えた。

## 残る未達（本追記では直していない）

- 残量は全 pool で未観測。Cursor・Grok は公開の取得口が無い（hmer-001/002）。Codex は product-owned session の `token_count` から取れるが、collect の「収集時刻と一致しない観測は snapshot にしない」規則の下では stale になる。Claude は稼働中 session の statusline が要る。
- 工程5の比較5項目（成功率・手戻り・監査工数・総 token・所要時間）は未計測のまま。
