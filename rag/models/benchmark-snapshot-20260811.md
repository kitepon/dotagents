<!--
source: https://artificialanalysis.ai/models/gpt-5-6-luna/
        https://artificialanalysis.ai/models/gpt-5-6-terra
        https://artificialanalysis.ai/models/gpt-5-6-sol
        https://artificialanalysis.ai/models/claude-sonnet-5
        https://artificialanalysis.ai/models/claude-opus-5
        https://artificialanalysis.ai/models/claude-fable-5
        https://artificialanalysis.ai/models/grok-4-5
        https://evals.report/benchmarks/swe-bench-pro?tab=scores
fetched: 2026-08-11
confidence: 高（取得値）〜中（異なる agent harness / effort をまたぐ解釈）
-->

# モデル選定用 benchmark snapshot — 2026-08-11

この snapshot はモデルの「幅広い思考力」を順位づけるものではない。特定の task 集・agent harness・effort・token budget で観測した局所性能を、配置仮説の入口にするための資料である。総合点でモデルを自動選定しない。

## Artificial Analysis Intelligence Index v4.1.1

GDPval-AA v2、τ³-Banking、Terminal-Bench v2.1、SciCode、Humanity's Last Exam、GPQA Diamond、CritPt、AA-Omniscience、AA-LCR の9評価を合成した独立測定。名称に Intelligence とあるが、対話の設計力、仕様の曖昧さを解く力、価値判断、長期 campaign の安定性を網羅しない。

| model / effort | index | output speed | 評価時 output tokens | 読み方 |
|---|---:|---:|---:|---|
| Claude Opus 5 / max | 63 | 54.1 tok/s | 100M | 最高帯だが遅く高価 |
| Claude Fable 5 / max + Opus 4.8 fallback | 62 | 67.3 tok/s | 83M | fallback 込みで純粋な単体比較ではない |
| GPT-5.6 Sol / max | 61 | 68.0 tok/s | 70M | 高能力・比較的 concise |
| GPT-5.6 Terra / max | 57 | 148.9 tok/s | 96M | 中位の均衡候補 |
| Grok 4.5 / high | 56 | 58.0 tok/s | 60M | concise だが遅い |
| Claude Sonnet 5 / max | 55 | 74.5 tok/s | 300M | 高 token 消費に注意 |
| GPT-5.6 Luna / max | 52 | 201.5 tok/s | 130M | 最速・安価だが verbose |

この表から言えるのは、Luna×max がこの9評価の合成では Sonnet 5×max の3点差まで入ること、速度と token 数の性格が大きく違うことまで。**Luna が設計・監査・会話でも Sonnet と同等、とは言えない**。

## SWE-bench Pro snapshot

professional repository の issue を agent が解決できた割合。局所 coding には上の合成指数より直接的だが、entry ごとに harness・effort・検証 status が揃わない。

| model | resolved | status |
|---|---:|---|
| Claude Fable 5 | 80.0% | Verified |
| Grok 4.5 | 64.7% | Verified |
| GPT-5.6 Sol | 64.6% | Verified |
| GPT-5.6 Terra | 63.4% | Verified |
| Claude Sonnet 5 | 63.2% | Unverified |
| GPT-5.6 Luna | 62.7% | Verified |

Luna と Terra/Sonnet の差が小さいため、仕様固定・focused test ありの局所 coding で Luna を先に試す仮説を補強する。一方、Fable の大差は難しい repo issue で上位 model が効く局面も示す。単一表から全実装を Luna または Fable へ寄せない。

## 運用ルール

- benchmark 名ではなく、測っている task 型を先に選ぶ。
- score と同時に effort、harness、token、latency、cost、verified status を見る。
- 公表値は配置仮説まで。正本の裁定は dotagents の実 task での成功率・手戻り・総時間で更新する。
- 数値は時点 snapshot。モデル選定正本へ自動同期せず、オーナーの世代交代宣言時だけ再取得する。

## 関連

- [[../../shared/runbooks/02_models.md]] — 役割→モデル×effort の正本
- [[gpt-5.6-family.md]] — GPT-5.6 の価格・effort
- [[claude-5-family.md]] — Claude 5 の役割・価格・effort
