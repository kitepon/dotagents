# hmer-006 比較送信を現行endpointへ直した記録

先の `hmer-006-publish.md` は commit 済みの evidence なので本文を変えていない。このファイルが送信先の訂正である。

`publishComparison` は、文書の endpoint と reporter config の path が `docs/factory-current-state.md` の本番 BugHub 行と一致するとき、その URL へ比較文書を POST する。別 path は使わない。

2026-09-22 の本番送信は HTTP 200。POST 先の path は `/api/factory/v9/reports` で、reporter config の path と一致した。`/api/summary` は HTTP 200 で、case `hmer-006` が2件返った。欠測は success、rework、audit_effort、total_tokens、duration_seconds である。既存画面の HTML に「推薦比較」がある。secret、任務本文、cookie、token は送っていない。

表示の内容は ServerManager `87cbf56` と一致する revert `20c186c` が本番に出ている。`40cfeb9` は戻してある。

focused test は `node --test tests/orchestrate/recommend-harness-cases.test.mjs`。結果は pass 6, fail 0。

必須CIは `make ci`。結果は exit 2。`lint-current-docs` は通った。`lint-skills` は orchestrate skill 参照の既存 drift で止まった。この drift は今回の送信先の修正対象にしていない。
