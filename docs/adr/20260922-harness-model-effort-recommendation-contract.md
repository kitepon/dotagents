# ADR: ハーネス・モデル・エフォート推薦契約

- Status: accepted
- Date: 2026-09-22
- 工程: Lattice `dotagents` / plan `harness-model-effort-recommender` / task `hmer-003`

## Context

工程1の実測で、Cursor は月次の Cursor Models と Other Models を分け、Grok 直接契約は週次の SuperGrok Heavy を使う。同じ family でも消費 pool は共有しない。Cursor の effort は model ID に含まれ、Grok の `none` は有効値ではない。Haiku は effort を持たない。Codex native と sidecar では渡せる effort が違う。既存の `rate-selector` は executor の pool 選択であり、その閾値を推薦へ持ち込む根拠は無い。

## Decision

1. 役割順位の文言は `docs/02_models.md` の順位表だけが持つ。ハーネス、effort の指定可否、pool、実行面は同文書の機械可読正本だけが持ち、`bin/render-model-candidates.mjs` が候補 JSON と候補表を同時生成する。
2. 候補 ID は `harness/family/effort` とする。同じ family の Cursor と直接ハーネスは別候補であり、別の `pool_id` を持つ。
3. Cursor 優先は Claude Fable 5、Opus 5、Sonnet 5、Grok 4.6 に限る。OpenAI family の既定順は Codex native、Codex external、Cursor の順である。残量の割合は同じ pool の中だけで比較し、pool をまたぐ残量率やプラン価格での比較は成立扱いにしない。
4. `none` は、その family の harness が有効値として列挙したときだけ候補になる。effort を渡せない候補は `unsupported` とし、省略や別値への変換をしない。
5. ハーネス選択は Aiterm 起動を意味しない。Codex native は `native-subagent`、sidecar は `sidecar`、Claude Code・Cursor Agent・Grok Build は `direct-harness`、ChatGPT は `consultation` である。
6. 推薦結果は子の候補だけを返し、`parent_changed` は false だけを正当値とする。公開 CLI 名は `recommend-harness`（入口 `bin/recommend-harness.mjs`、実装は後工程）。
7. 比較結果の掲載先は ServerManager の BugHub WebUI である。ingest の現行 path は `docs/factory-current-state.md` の本番 BugHub endpoint を読み、この契約へ path を複製しない。成果物 schema は `dotagents.recommendation-comparison.v1`。載せる項目は case、候補、成否、手戻り、監査工数、総 token、所要時間、pool、観測時刻、欠測である。秘密、任務本文、cookie、token は載せない。新しいダッシュボードは作らない。
8. Cursor Models を共有する Composer 2.5 は catalog 確認まで `unsupported` とし、推薦候補にしない。Grok 4.5 は pool 共有の説明にだけ使い、順位表に無いので選択しない。Astra は役割比較が済むまで候補にしない。

## Consequences

工程3は、programmatic に取れる観測だけを新しい型へ接続する。dashboard しか無い pool は `observation_unavailable` のままにし、割合を basis points の現行値として埋めない。工程4が Jev と CLI をこの候補 ID の上に実装する。
