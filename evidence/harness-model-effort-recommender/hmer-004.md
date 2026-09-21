# hmer-004 推薦時の実残量取得

## 作ったもの

`collectHarnessQuotas` が推薦 catalog の pool を1回で集める。記録は pool 単位で、同じ pool の family を二重に数えない。

Cursor の2つの月次 pool、Grok 直接の週次 pool、ChatGPT は `observation_unavailable` のまま残し、割合を basis points にしない。Claude は statusline、Codex は token_count の既存投影だけを measured にする。認証失敗、タイムアウト、期限切れ、収集時刻と違う観測は snapshot にしない。秘密、cookie、token は読まない。

## 実接続

2026-09-22 に公開 CLI の help を見た。`agent` に account pool の quota command は無く、`grok usage` は session の token/cost である。account 残量の公開入口は無い、という工程1の結論と一致する。status や cookie は読んでいない。

## 試験

作業ディレクトリは hmer-004 の専用 worktree。

`node --test tests/orchestrate/quota-collect.test.mjs`

結果: 3件すべて成功（pass 3, fail 0）。確認したのは、catalog と同じ pool 数、Cursor と Grok が残量なし、Claude の 5h と 7d、Codex の1窓、割合の注入拒否、capture 欠如、認証失敗、タイムアウト、期限切れ、古い観測、未対応 entry、重複 pool である。
