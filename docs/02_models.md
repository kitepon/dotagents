# 02_models — 役割×モデル順位表

## 役割

1. **統括** — campaign/会話の主体。裁定・受入・commit
2. **反証** — 実ファイルを読んで主張を殺しにかかる
3. **監査・発見** — 自成果物の欠陥出し
4. **設計** — 実装前の構造・境界・停止判断の案出し
5. **相談** — 実読不要の純推論second opinion
6. **実装** — 仕様固定済みのまとまった実装・テスト・移設
7. **局所コーディング** — focused test付きの狭い修正
8. **軽作業** — 分類・抽出・字面回収
9. **調査** — 外部事実の回収〜統合
10. **難問・研究** — 既知の解法では前進できない問題の突破、研究レベルの探索

## 順位

| 役割 | 1位 | 2位 | 3位 |
|---|---|---|---|
| 統括 | オーナー指定 | — | — |
| 反証 | GPT-6 Sol×high | Grok 4.7×high | Opus 5.5×high |
| 監査・発見 | Grok 4.7×medium | Sonnet 5×medium | GPT-6 Sol×medium |
| 設計 | Opus 5.5×high | GPT-6 Sol×high | Grok 4.7×high |
| 相談 | GPT-6 Astra×high | Fable 5.1×high | Grok 4.7×medium |
| 実装 | GPT-6 Sol×high | Opus 5.5×medium | Grok 4.7×medium |
| 局所コーディング | GPT-6 Luna×high | Sonnet 5×high | Composer 2.5 |
| 軽作業 | GPT-6 Luna×high | Sonnet 5×high | Grok 4.7×high |
| 調査 | Grok 4.7×medium | GPT-6 Sol×medium | Opus 5.5×medium |
| 難問・研究 | Fable 5.1×high | Opus 5.5×high | GPT-6 Astra×high |

## ベンチマークで同格の場合のハーネス選択

Codexを基本の親とし、同格モデルの入口は次の順に選ぶ。

1. Claudeの5時間枠を積極的に使う。
2. Codexの週次使用率が、週次枠をリセット時にちょうど使い切る均等ペースの1.2倍以上なら、Grokを積極的に使う。均等ペースの使用率は`100 × (現在時刻 − (リセット時刻 − 週次期間)) ÷ 週次期間`で求める。
3. Grokの枠が尽きたと確認できたら、Cursorを使う。

## 諸元

| モデル | ベンダー | 入口 | ID | 価格 入力/出力（per Mtok） | context | effort（既定） |
|---|---|---|---|---|---|---|
| Fable 5.1 | Anthropic | Claude Code / Cursor | `fable` | $10/$50 | 1M | low〜max（high） |
| Opus 5.5 | Anthropic | Claude Code / Cursor | `opus` | $4/$20 | 1M | low〜max（medium） |
| Sonnet 5 | Anthropic | Claude Code / Cursor | `sonnet` | $2/$10 | 1M | low〜max（high） |
| GPT-6 Astra | OpenAI | Codex | `gpt-6-astra` | $10/$50（272K超 $20/$75） | 1.05M | low〜max |
| GPT-6 Sol | OpenAI | Codex | `gpt-6-sol` | $2/$10 | 1.05M | none〜max（medium） |
| GPT-6 Luna | OpenAI | Codex | `gpt-6-luna` | $0.10/$0.50 | 1.05M | none〜max（medium） |
| Grok 4.7 | xAI | Grok Build / Cursor | `grok-4.7` | $2/$6（200K超 $4/$12） | 500K | low〜xhigh（high） |
| Composer 2.5 | Cursor | Cursor | Composer 2.5 | $0.50/$2.50 | 1M | なし |
