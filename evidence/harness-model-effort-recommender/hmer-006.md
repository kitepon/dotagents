# hmer-006 実務比較と配布

## 作ったもの

`recommendByRemaining` が catalog の並びと、収集レコードの `remaining_bp` だけで harness / family / effort を返す。Cursor 系で枠が measured かつ残っていれば Cursor を選ぶ。残量が 0、または窓が expired なら次の適合候補と、飛ばした pool を理由に出す。両方無ければ推薦しない。

同じ `pool_id` は候補が複数でも残量は1つである。catalog に無い組合せ、非対応 effort、`none` が無効な family は候補を返さない。明示の harness / family / effort は残量があっても差し替えない。独立性は provider が2つ以上あるときだけで、ハーネス名では決めない。

比較文書の schema は `dotagents.recommendation-comparison.v1`。掲載先は `servermanager-bughub-webui`。endpoint は `docs/factory-current-state.md` の本番 BugHub 行を実行時に読む。wire report へは送らない。secret、任務本文、cookie、token は載せず、成功率・手戻り・監査工数・総 token・所要時間は今回測っていないので `missing` に入れる。親が 02 を読む方式との削減率は出していない。

公開入口は hmer-005 の `bin/recommend-harness.mjs`。この工程の宣言 path に install と他製品の release は無い。

## 試験

作業ディレクトリは hmer-006 の専用 worktree。

`node --test tests/orchestrate/recommend-harness-cases.test.mjs`

結果: 5件すべて成功（pass 5, fail 0）。

Cursor と Grok の現行 programmatic は `observation_unavailable` である。ケースの残量は fixture の収集レコードで、dashboard の値から basis points を作っていない。欠測の pool は推薦成功にしていない。
