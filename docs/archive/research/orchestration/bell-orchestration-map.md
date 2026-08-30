# ベルのオーケストレーション全景マップ

**出典**: 2026-07-12、オーナー（クオ）の「オーケストレーションの全容を把握したい」依頼で作成。正典（[claude/CLAUDE.md](../../claude/CLAUDE.md) 多モデル統括節・[orchestrate SKILL.md](../../claude/skills/orchestrate/SKILL.md)・[docs/02_models.md](../../docs/02_models.md)）を1枚に図解。
**確度**: 2026-07-16の二レーン裁定と照合済み（**v3**。通常レーンは統括機構を通らず、F/A/Hと配置は統括レーンだけで使う）。
**図**: [bell-orchestration-map.svg](bell-orchestration-map.svg)（`<style>` に色を焼き込み済み＝単体でもライト/ダーク対応で開ける）。

## 一望

`依頼 → ① レーン選択 → 通常なら親直で原子的に完了／統括ならF/A/Hと必要な配置 → ② 統括ゲート（検証）→ ③ 還流`。

統括レーンに入った後のアクセント枠（**レーン選択・統括ベル・統括ゲート**）が制御点。中核思想は「**品質はモデルの賢さでなく構造から出す**」だが、通常レーンには統括構造そのものを持ち込まない。

## F/A/H と委譲先

- **F＝契約クリティカル**（認可・tx・公開API バイト互換・依存方向・本番操作）→ 統括直轄
- **A＝仕様固定の物量**（委譲利益が明確な時だけ）→ 書ける手足4枠:
  | 入口 | 特徴 | 枠 |
  |---|---|---|
  | Codex sidecar | 非対話・隔離 worktree | OpenAI・**第一選択** |
  | Grok | `grok -p` 非対話・composer | xAI・**並ぶ第一選択** |
  | aiterm 対話 | codex/grok/composer TUI | 対話・試行錯誤 |
  | Claude 内 | sonnet/haiku・implementer | Anthropic・**次善** |
- **H＝人手** → オーナー
- **Oracle**＝物量フローの外。純推論の相談窓口（**書けない**・ChatGPT 枠）で統括の裁定/設計へ**破線**接続。

## 正典との対応（照合で確認）

| 図の要素 | 正典の裏付け |
|---|---|
| レーン選択・統括時のF/A/H | CLAUDE.md「作業レーンと統制」・C4 hook 文言 |
| 統括 L0・委譲先・レート分散（外部枠優先） | 02_models.md:9-16,40 / orchestrate SKILL.md:27-34 |
| Oracle は書けない（相談のみ・別カテゴリ） | 02_models.md:40「—（Oracle は書けない）」 |
| Grok Composer が"並ぶ第一選択"の物量 | 02_models.md:40 |
| 統括ゲート（検証2票・refuter・迷ったら棄却） | orchestrate SKILL.md:74-76 |
| 還流（push・memory/caveat/rag） | orchestrate SKILL.md:21（憲法8） |
| ⚡ 呼びかけ hook が注入 | [完了記録](../../docs/archive/plan_callout-hooks.md)・[callout-hooks-firing-behavior](../hooks/callout-hooks-firing-behavior.md) |

## 図に収めなかった奥行き（矛盾ではなく簡略化）

- **この縦フローは「1実装ユニットの断面」**。大規模作業（監査・リファクタ・移行）では統括ベルの**手前**に L1 監査（Workflow で並列多視点→指摘ごとに敵対的反証→網羅性 Critic が盲点→第2ラウンド）と L2 設計（2〜4視点の Plan 並列→割れは統括が根拠で裁定・多数決禁止）が付く。フェーズ順は 0ベースライン→1監査→2設計→3安全網→4実装→5挙動修正→6還流（orchestrate SKILL.md:39-47）。
- **hook との関係**: 図＝設計、⚡hook＝案内。C4はレーン選択、C1は実際に委譲する時の契約参照をコンテキストへ注入し、通常レーンへ統括成果物を強制しない。発火挙動の実測は [callout-hooks-firing-behavior](../hooks/callout-hooks-firing-behavior.md)。
