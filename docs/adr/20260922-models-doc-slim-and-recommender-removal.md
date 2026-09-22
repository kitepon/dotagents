# ADR: 02を役割・順位・諸元だけに絞り、推薦入口を撤去する

- Status: accepted
- Date: 2026-09-22
- Supersedes: [20260922-harness-model-effort-recommendation-contract.md](20260922-harness-model-effort-recommendation-contract.md)

## Context

子のモデル選定は、Jevに`docs/02_models.md`を渡して選ばせる運用になっている。02の8割以上は推薦入口用のJSONと生成表で、残りも根拠・評価経緯・effort規範などの文章だった。これらはJevの選定に使われず、世代交代のたびに陳腐化する。同日、Claude Opus 5.5とGPT-6 Sol／Lunaが公開され、Claude Fable 5.1とGrok 4.7も台帳に未反映だった。

## Decision

1. 02は「役割」「順位」「諸元」の3節だけを持つ。根拠・評価経緯・effort規範・機械可読JSON・生成表は置かない。
2. 掲載モデルはClaude（Fable 5.1、Opus 5.5、Sonnet 5）、Codex（GPT-6 Astra、GPT-6 Sol、GPT-6 Luna）、Grok（Grok 4.7）、Cursor（上記ClaudeとGrok 4.7、Composer 2.5）に限る。それ以外は掲載しない。
3. 推薦入口（`bin/recommend-harness.mjs`）、候補カタログ（`lib/orchestrate/model-candidates.json`）とその生成器、quota収集・実務比較の付随モジュールを撤去する。子のmodel×effortは02の順位表から選び、諸元表の入口で呼ぶ。
4. 入口の使い分け、公認projection、世代交代手順は[委譲契約](../../shared/orchestrate/delegation-contract.md)へ移す。
5. 反証は成果物を作ったモデルと別ベンダーのモデルで行い、順位表の候補が同ベンダーなら次順位を使う。この規則は[統括の共通契約](../../shared/orchestrate/contract.md)が持つ。
6. 順位はオーナーが決める。監査・発見は未測定のため暫定配置のまま置く。

## Consequences

02の変更は順位表と諸元表の書換えだけで済み、CIが02の本文を機械的に解釈することはない。pool残量に基づく自動除外と比較記録の掲載は失われる。必要になれば、02の外に新しい契約として作り直す。
