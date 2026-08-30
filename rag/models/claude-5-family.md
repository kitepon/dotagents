<!--
source: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
        https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8
        https://platform.claude.com/docs/en/build-with-claude/effort
        https://platform.claude.com/docs/en/about-claude/models/overview
        https://www.anthropic.com/news/claude-sonnet-5
        https://x.com/claudeai/status/2086891169217122586
        https://vulcanbench.com/benchmarks/10-opus5-effort.html
        https://www.coderabbit.ai/blog/opus-5-model-review
        https://x.com/ArtificialAnlys/status/2080777718933995967
        https://x.com/1337hero/status/2085050844622569646
        https://x.com/joshmanders/status/2085513363010810013
        https://x.com/Santosh74038967/status/2085239853218967741
        https://x.com/mityarko/status/2082243771564007843
fetched: 2026-08-11／2026-08-14
confidence: 高（価格・対応effortはAnthropic一次資料）／中（複数task benchmark内のeffort比較）／
  低〜中（Xの利用報告。scope creep仮説の傍証であり一般特性へ拡張しない）。
-->

# Claude 5 ファミリー（Fable / Opus / Sonnet）と Haiku 4.5

## 現行の選択肢

| model | 位置づけ | 標準 API 価格（入力/出力、per Mtok） | effort の出発点 |
|---|---|---|---|
| Claude Fable 5 | 公開モデル中の最高能力・長期 agent | $10 / $50 | high。能力感度が高い時だけ xhigh |
| Claude Opus 5 | 複雑な agentic coding・enterprise work | $5 / $25 | scoped工程はmedium、長期agentはhigh |
| Claude Sonnet 5 | coding・agent・tool use を量産できる中位 | **$2 / $10** | medium を費用対効果の起点にできる |
| Claude Haiku 4.5 | 高速・大量・軽量 subagent | $1 / $5 | **effort非対応** |

Claude Code では日付付き ID を固定せず、dotagents の規約どおり `fable` / `opus` / `sonnet` / `haiku` の floating alias を使う。API の model ID は別の versioning 契約である。

## 2026-08-11 の更新判断

- **通常上位を Opus 4.8 から Opus 5 へ更新**。Anthropic は Opus 5 を Opus 4.8 からの step-change とし、深い推論、長期 agentic task、複数ファイル実装、review、追加 effort の効きに強みがあるとしている。
- **Sonnet 5 の $2/$10 は恒久価格**。Anthropic公式アカウントが2026-08-10に恒久化を明記し、現行model overviewも同額を掲示する。これは運用裁定ではなく一次事実である。
- Sonnet 5 は Opus 4.8 に近い性能帯と説明され、medium effort の費用対効果が高く、高 effort では一部 task で Opus 4.8 相当。ただし新 tokenizer により同じ入力が旧世代の約1.0〜1.35倍の token になるので、request 単価は nominal rate だけで比較しない。
- Fable/Opus/Sonnet 5はlow/medium/high/xhigh/maxを持ち、highがAPI既定。Haiku 4.5はeffortを持たない。effort変更はprompt cacheを無効化するため、同一conversation中の頻繁な切替をコストゼロとみなさない。

## Opus 5のscopeとeffort

VulcanBenchは実PR 23件でlow 20/23、medium 19/23、high 18/23の成功を報告し、高effortほどtokenとwall-clockが増え、highではtimeoutが増えた。CodeRabbitの約100 review pattern×3回でも、effort増加はreview品質を一貫して上げず、xhighはselectiveでcoverageが落ち、noiseも残った。Artificial Analysis Briefcaseでは逆に、長い知識仕事でlow 1223、medium 1470、high 1606、xhigh 1693、max 1720と追加effortが効いた。

つまりOpus 5は「高いeffortほど常に良い」のではなく、**長く探索する価値があるtaskほど効く**。工程が限定された実装・reviewはmedium、長期agent・複雑設計はhighを起点にし、xhigh/maxは当該taskで測定差が出た時だけ使う。

Xには、任された工程を越えて独自の物語・要件・追加変更を進めたという複数の利用報告がある。これは単発の印象だけで断定せず、上記のcontrolled benchmarkが示す計算量・所要時間・timeout増加と合わせて、権限境界の緩い工程へ高effort Opusを置かない理由とする。仕様、write scope、停止条件を明示し、scope逸脱が出たtaskは同じpromptでmedium/highを比較する。

## dotagents への含意

- Claude 枠の通常実装・finder の第一候補は Sonnet 5。持続的 tool use を伴う実装レーンにも置ける。
- 契約クリティカルな設計・長期の複雑実装はOpus 5。最高能力が本当に必要な一点だけFable 5をスポットで呼ぶ。限定工程へOpusを置く時はmediumを先に試す。
- provider 間 benchmark は harness・token budget・価格前提が揃わないため、順位表を配置正本にしない。実際の repo task で成功率、総 token、所要時間、手戻りを測る。
- 2026-08-11 の横断benchmark snapshotと限界は [[benchmark-snapshot-20260811.md]]、Grok 4.6との比較は[[xai-grok46.md]]に分離した。

## 関連

- [[../../docs/02_models.md]] — 役割→ティア×effort の正本
- [[gpt-5.6-family.md]] — Codex レーンの現行ファミリー
- [[xai-grok46.md]] — xAI現行レーン
- [xAI旧世代snapshot](../../docs/archive/research/models/xai-grok45-composer25.md)
