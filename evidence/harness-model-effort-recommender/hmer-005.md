# hmer-005 Jevによる3点の推薦CLI

## 作ったもの

`bin/recommend-harness.mjs` が stdin の任務 JSON を1回受け、候補・pool・理由・観測時刻を返す。子ハーネスは起動せず、`parent_changed` は false だけである。

Jev へ渡すのは任務と pool の状態（pool id、status、観測時刻）と、実在する候補 ID の短い基準だけである。順位表は送らない。選ばれた ID が候補一覧に無いときは推薦にしない。理由はコードが候補 ID と pool の観測状態から組み立てる。

明示の harness / family / effort が候補にあるときはその候補を返し、Jev で上書きしない。無いときは `explicit_unsupported` である。

## 実呼出し

2026-09-22、公式 `POST https://api.typesafe.ai/v1/systemone`、model 要求は `jev-latest`、応答 model は `jev-1.13.0`。任務「Claude Code で claude-fable-5 の high を、pool anthropic-claude で使う」に対し、`claude-code/claude-fable-5/high` が返った。`quota_comparison` は `not_established`。この呼出しは product session の capture を渡していない。秘密は出力していない。

## 試験

作業ディレクトリは hmer-005 の専用 worktree。

`node --test tests/orchestrate/recommend-harness.test.mjs`

結果: 3件すべて成功（pass 3, fail 0）。確認したのは、実在 ID だけを返すこと、順位表を Jev へ送らないこと、none と未知 ID と HTTP 401 を成功にしないこと、明示指定と measured の比較、子プロセスを起動しないことである。
