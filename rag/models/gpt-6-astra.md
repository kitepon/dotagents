# GPT-6 Astraの公式指針とdotagentsへの適用

- 出典: [公式モデルガイド](https://developers.openai.com/api/docs/guides/latest-model)、[モデル仕様](https://developers.openai.com/api/docs/models/gpt-6-astra)
- 取得日: 2026-09-08。公式Docs MCPからMarkdown本文を取得。
- 確度: 公式仕様と静的な指示・設定の不一致は確認済み。Astraでの比較実験・役割順位の評価は未実施。
- 一次ソースの固定参照: [取得記録](raw/openai-gpt-6-astra-20260908.md)

## 公式が示す特徴

Astraは指示への感度が高く、曖昧なskillやAGENTS.mdによって承認待ちが生じ得る。ユーザーの指示と既存の承認範囲を優先し、明確な実行依頼では作業を続ける。文章の長さ自体を欠陥とせず、停止条件・責務・例外が一致しているかを確認する。

委譲量は用途と実行環境に合わせて調整する。小さな変更では検証が広がり得るため、必要な確認が済んだ後に繰り返すのは、新たな変更・失敗・未解決の懸念がある場合だけとする。独立受入を要求する契約や秘密・権限の境界は維持する。

## 移行時の確認

- reasoning effortは、移行前がnone／minimalならlowから比較し、それ以外は現在の実効値を維持する。APIの対応段階はlow／medium／high／xhigh／max。Codexの段階は実効catalogで確認する。
- tool callingにはResponses APIを使う。temperature、top_p、top_logprobsは非対応。Chat CompletionsのlogprobsとResponsesのmessage.output_text.logprobs指定も外す。
- GPT-5.5以前からの移行ではprompt_cache_retentionをprompt_cache_options.ttlへ見直す。これは該当API実装の移行条件で、Codex設定へそのまま転記しない。
- async tool calling・mid-turn steeringは実行環境の対応を必要とする。モデルの対応だけを根拠に、外部ツールの待機・回収契約を廃止しない。

## dotagentsの監査判断

修正対象は、Latticeの明示適用条件、デプロイスキルの承認条件、ControlのPacket適用範囲、characterizationテストの範囲、配置表と軽作業設定の一致、Astraの移行説明と評価状態、Oracleの発見用description、会話と実行の区別、外部委譲の費用判断、親によるgate再実行条件である。修正の正本は共通憲法・各skill・委譲契約・モデル配置表に置く。

所有境界、秘密保護、破壊操作前の退避、公開commitの条件、監査後に意匠を選ぶ手順、routing回避策は残す。旧モデルの履歴・fixture・役割別配置を一括置換しない。親のモデル設定はオーナー領分のままとする。

現行の配置は[モデル配置表](../../docs/02_models.md)、Codexの設定指針は[設定文書](../../docs/05_codex-fragments.md)が正本。
