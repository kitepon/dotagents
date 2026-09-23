<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
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

候補群は、役割ごとに同じ優先度に置くモデル×effortの集合で、左ほど優先する。ハーネスはモデルを実行する製品（Codex、Claude Code、Grok Build、Cursor）を指す。利用枠はハーネスの契約で使える残量を指し、Claude Codeの5時間利用枠、Codexの週次利用枠、Grok Buildの直接利用枠、Cursorの利用枠は別々に判定する。

| 役割 | 第1候補群 | 第2候補群 | 第3候補群 |
|---|---|---|---|
| 統括 | オーナー指定 | — | — |
| 反証 | GPT-6 Sol×high、Grok 4.7×high（同格） | Opus 5.5×high | — |
| 監査・発見 | Grok 4.7×medium、Sonnet 5×medium（同格） | GPT-6 Sol×medium | — |
| 設計 | Opus 5.5×high、GPT-6 Sol×high（同格） | Grok 4.7×high | — |
| 相談 | GPT-6 Astra×high | Fable 5.1×high | Grok 4.7×medium |
| 実装 | GPT-6 Sol×high、Opus 5.5×medium（同格） | Grok 4.7×medium | — |
| 局所コーディング | GPT-6 Luna×high、Sonnet 5×high（同格） | Composer 2.5 | — |
| 軽作業 | GPT-6 Luna×high、Sonnet 5×high（同格） | Grok 4.7×high | — |
| 調査 | Grok 4.7×medium、GPT-6 Sol×medium（同格） | Opus 5.5×medium | — |
| 難問・研究 | Fable 5.1×high | Opus 5.5×high | GPT-6 Astra×high |

## 同格候補のハーネス選択

Codexを基本の親とする。子のモデルは候補群を左から選ぶ。同じ候補群に複数モデルがある場合は次の条件を上から判定し、成立した時点でモデルとハーネスを確定する。後続の条件は判定しない。

1. 候補群にClaudeのモデルがあり、Claude Codeの5時間利用枠を使えるなら、そのモデルをClaude Codeで使う。
2. 1が成立せず、Codexの週次利用枠の使用率が、週次利用枠をリセット時にちょうど使い切る均等ペースの1.2倍以上で、候補群にGrokのモデルがありGrok Buildの直接利用枠を使えるなら、そのモデルをGrok Buildで使う。均等ペースの使用率は`100 × (現在時刻 − (リセット時刻 − 週次期間)) ÷ 週次期間`で求める。
3. 1と2が成立せず、Grok Buildの直接利用枠が尽きたと確認でき、Cursorの利用枠を使えるなら、候補群にあるモデルをCursorで使う。

## 諸元

| モデル | ベンダー | ハーネス | ID | 価格 入力/出力（per Mtok） | context | effort（既定） |
|---|---|---|---|---|---|---|
| Fable 5.1 | Anthropic | Claude Code / Cursor | `fable` | $10/$50 | 1M | low〜max（high） |
| Opus 5.5 | Anthropic | Claude Code / Cursor | `opus` | $4/$20 | 1M | low〜max（medium） |
| Sonnet 5 | Anthropic | Claude Code / Cursor | `sonnet` | $2/$10 | 1M | low〜max（high） |
| GPT-6 Astra | OpenAI | Codex | `gpt-6-astra` | $10/$50（272K超 $20/$75） | 1.05M | low〜max |
| GPT-6 Sol | OpenAI | Codex | `gpt-6-sol` | $2/$10 | 1.05M | none〜max（medium） |
| GPT-6 Luna | OpenAI | Codex | `gpt-6-luna` | $0.10/$0.50 | 1.05M | none〜max（medium） |
| Grok 4.7 | xAI | Grok Build / Cursor | `grok-4.7` | $2/$6（200K超 $4/$12） | 500K | low〜xhigh（high） |
| Composer 2.5 | Cursor | Cursor | Composer 2.5 | $0.50/$2.50 | 1M | なし |
