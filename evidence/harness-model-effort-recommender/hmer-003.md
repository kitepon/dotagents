# hmer-003 02と推薦契約

## 作ったもの

`docs/02_models.md` の順位表は適性の文言の正本のまま残し、ハーネス・effort・pool・実行面だけを同文書の機械可読正本へ置いた。`node bin/render-model-candidates.mjs --write` が `lib/orchestrate/model-candidates.json` と候補表を同時生成する。契約の判断は `docs/adr/20260922-harness-model-effort-recommendation-contract.md` に固定した。

候補は 91 件。source digest は `57b3e1cf66a812c2ce9904ab298e06423436c42d607539fd63b68d067be792ca`。同じ Grok 4.6 の Cursor と Grok Build は別候補で、pool は `cursor-models-monthly` と `xai-grok-weekly`。公開 CLI 名は `recommend-harness`。実装入口は後工程。

先行工程の RAG 2件が document registry と `rag/INDEX.md` に無かった。現行文書 gate が未分類で落ちたため、その2件だけを既存の RAG と同じ current 分類と INDEX へ登録した。

## 別提供元の反証

gpt-connector の diagnostics は `overall=ready`、`cdpConnected=true`。ChatGPT（gpt-5.6 thinking）へ session `4a0957ba-611b-4106-9412-9ea09a60bb29` で反証した。

最初の指摘は、順位表の「Sol/Terraで独立確認」のように `×effort` でないセルを未知モデルへ置換しても `coverRankTable` が通る、というものだった。続けて次の置換が通ることを指摘された。`BogusModelで独立確認`、`Sol/BogusModelで独立確認`、`Sol/bogusmodelで独立確認`、`Sol/Grokで独立確認`、`Sol/AIで独立確認`、`Sol/Webで独立確認`。

修正後は、順位セルに残る英字トークンを検査する。既知モデル以外は拒否し、表にある散文語もスラッシュ区切りの順位指定としては拒否する。上の置換はすべて `RANK_LABEL_UNKNOWN` になり、現行の順位表は通る。

## 試験

作業ディレクトリは hmer-003 の専用 worktree。

`node --test tests/orchestrate/recommendation-contract.test.mjs`

結果: 7件すべて成功（pass 7, fail 0）。確認したのは、生成物の再生成一致、Cursor と直接ハーネスの別 pool、OpenAI family では Codex native が先、`none` と指定不可と sidecar の max 欠落、親を変えないこと、Aiterm を要求しないこと、Anthropic の二窓、Composer 2.5 を候補にしないこと、順位表の未知モデルと上の反例を生成検証が落とすこと。

`node bin/render-current-docs.mjs --check --base-ref HEAD`

結果: `render-current-docs: OK — mode=check documents=601`。反証後に変えたのは契約モジュール、試験、この証跡だけである。
