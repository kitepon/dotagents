# hmer-006 掲載と必須CI

`evidence/harness-model-effort-recommender/hmer-006.md` は最初の commit 以降、本文を変更できない。送信と必須CIの記録はこのファイルに置く。

比較文書は reporter config の host へ `POST /api/factory/comparisons` で送った。文書の endpoint は `docs/factory-current-state.md` の本番 BugHub 行のままである。`/api/factory/v9/reports` の schema 9.0 の検証と保存は変えていない。

送信は HTTP 200。本番の `/api/summary` は HTTP 200 で、case `hmer-006` が2件返った。欠測は success、rework、audit_effort、total_tokens、duration_seconds である。既存画面の HTML に「推薦比較」がある。secret、任務本文、cookie、token は送っていない。

表示の commit は ServerManager `40cfeb93bdafe32dbc575a5527d97f5eba2104bd`。`deploy.sh --apply` で本番へ出してある。戻しは ServerManager の `40cfeb9` と `87cbf56` を revert して `deploy.sh` で戻す。

focused test は `node --test tests/orchestrate/recommend-harness-cases.test.mjs`。結果は pass 6, fail 0。

必須CIは `make ci`。結果は exit 2。`lint-current-docs` は通った。`lint-skills` は orchestrate skill 参照の drift で止まった。この drift は hmer-006 の変更を戻した commit でも再現する。生成物の書き換えはこの修正に入れていない。
