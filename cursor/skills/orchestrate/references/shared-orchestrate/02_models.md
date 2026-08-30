<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
# 02_models — 役割→モデル×エフォート順位表（唯一の参照点）

<!-- 前提: 2026-08-19 更新（Claude 5 / GPT-5.6 / Grok 4.6 世代）。バージョン固定禁止（PLAN 原則9）。モデル名を判断としてこの表以外へ書き散らさない。runtimeが具体値を要求する実行projectionだけは下記の公認面へ置き、CIで本表との一致を固定する -->

方針: skill・agents・委譲契約・スクリプトは**役割名**でモデルを指し、具体名への判断はこの表だけが担う。本書は役割を先に定義し、役割ごとに適したモデル×effortを1位〜3位で与える。ベンダー別レーンの表構造は撤廃した（オーナー裁定 2026-08-19）。runtimeが具体値を要求する`codex/agents/*.toml`、`.codex-sidecar.yml`、`claude/agents/*.md`のfrontmatter、Claude Workflowのper-call引数は公認projectionであり、別の判断正本ではない。世代交代時は**この一枚と公認projectionを同じcommitで更新し、CIで一致を確認してpushする**。更新トリガーはオーナーの宣言（PLAN 原則6）。

背骨: **役割が要求する能力で選び、順位は実測で昇降格する。ただし、現状維持に候補側だけの立証責任を負わせない。** 新しい有力候補は代表実務へ期限・範囲を切って投入し、成功率・手戻り・監査工数・総token・所要時間・quotaで現役と比較する。未検証の現役を「安全」、未検証の新顔を「危険」とは扱わない。

本書の根拠は次の4種を混ぜない。

1. **一次事実**: model提供元公式の価格、context、対応effort、live catalog。
2. **外部観測**: benchmark、Xの利用報告、独立評価。harness・標本数・再現条件を併記する。
3. **dotagents実測**: 当工場のtask、監査通過率、配線実測。一般性能へ拡張しない。
4. **運用判断**: 上記を踏まえた配置。客観的に確定した事実を「オーナー裁定」と呼ばない。

**親のモデル×effortはオーナーの領分**であり、規範・AIはピンを打ち替えない。親候補と根拠は提示し、子の配置はこの表で解決する。

## 役割の定義（9つ）

1. **統括** — campaign/会話の主体。裁定・契約クリティカルな受入・commit
2. **反証** — 実ファイルを読んで主張を殺しにかかる
3. **監査・発見** — 自成果物（repo・設計・文書）の欠陥出し。誤検知は後段が裁く（第三者reviewを含む）
4. **設計** — 実装前の構造・境界・停止判断の案出し
5. **相談** — 実読不要の純推論second opinion
6. **実装** — 仕様固定済みのまとまった実装・テスト・移設
7. **局所コーディング** — focused test付きの狭い修正・実装
8. **軽作業** — 分類・抽出・字面回収
9. **調査** — 外部事実の回収〜統合（浅↔深はeffortで刻む）

## 順位表（役割→1位〜3位）

「実測」= dotagents 2026-08-19 役割配置実験（実験記録、各セルn=1）。

| 役割 | 1位 | 2位 | 3位 |
|---|---|---|---|
| 統括 | **オーナー指定**（参考候補: Opus 5×high、Grok 4.6×high、Fable 5×highスポット。順位は参考情報でpinはオーナー） | — | — |
| 反証 | Grok 4.6×high（実測14/14） | Sol×high（実測14/14。同着はGrok優先＝オーナー裁定 2026-08-19） | Opus 5×high（実測13/14。唯一の誤りは真だが無害な指摘を殺した方向） |
| 監査・発見 | Grok 4.6×medium（実測recall 7/10・FP 0） | Sonnet 5×medium（実測6/10＋partial 1・FP 0） | Terra×medium（実測6/10・FP 0） |
| 設計 | Opus 5×high（GDPval-AA・APEX首位 2026-08-19時点） | Grok 4.6×high（独立視点） | Sol×medium（過剰設計報告に注意） |
| 相談 | ChatGPT（gpt-connector・別quota。06_gpt-connector.md） | Grok 4.6×medium | Fable 5×highスポット（契約critical） |
| 実装 | Terra×high（Terminal-Bench 2.1 78.4%） | Sonnet 5×medium〜high | Grok 4.6×medium（repo横断・長時間はhigh） |
| 局所コーディング | Luna×medium（実測: maxと品質差なし・14/14） | Sonnet 5×medium | Grok 4.6×medium |
| 軽作業 | Luna×low〜medium | Haiku（Claude枠で閉じる時。effortなし） | Grok 4.6×low |
| 調査 | Grok 4.6×low（字面）〜medium（統合）。X直結は唯一 | Sonnet 5×medium＋Web | Sol/Terraで独立確認 |

### 構造規則（3つ）

1. **反証の1位は、成果を作ったモデルと別ベンダーから選ぶ。**
2. **順位は既定であって拘束ではない。** quota逼迫・入口障害・catalog不在時は次順位へ落とし、落とした事実を報告する。存在しないmodel/effortへはfallbackせず明示エラーにする。
3. **見逃し対策は2段構造で行う。** finderの増席でなく「疑いを列挙→反証役に裁かせる」工程を挟む（実測: finder 3席が全員見逃した欠陥3件を反証工程が回収した）。

## モデル台帳（slug・価格の解決はここだけ）

| モデル | slug | API定価（入力/出力 per Mtok） | context | effort段階 |
|---|---|---|---|---|
| Claude Fable 5 | alias `fable` | $10/$50 | 1M | low〜xhigh/max |
| Claude Opus 5 | alias `opus` | $5/$25 | 1M | low〜xhigh/max |
| Claude Sonnet 5 | alias `sonnet` | **$2/$10（恒久価格）** | 1M | low〜xhigh/max |
| Claude Haiku 4.5 | alias `haiku` | $1/$5 | 200K | **effortなし** |
| GPT-5.6 Sol | `gpt-5.6-sol` | $5/$30（長contextは$10/$45） | 1.05M | none〜max（Codex CLIはultraあり） |
| GPT-5.6 Terra | `gpt-5.6-terra` | $2/$12（長contextは$4/$18） | 1.05M | 同上 |
| GPT-5.6 Luna | `gpt-5.6-luna` | $0.20/$1.20（長contextは$0.40/$1.80） | 1.05M | none〜max（ultraなし） |
| Grok 4.6 | `grok-4.6` | $2/$6（200K超は$4/$12） | 500K | low/medium/high（既定）/xhigh |

価格は標準API定価であり、Claude Code・Codex・Grok Buildのsubscription quotaとは別物。OpenAIの長context課金は階層制（境界と現行値は公式pricingを実行時に確認）。Grok Buildのcatalogに`grok-build-0.1`（Composer 2.5系）の記載が公式docsにあるが、端末live catalogでの実在は未検証——Composer入口はcatalog確認まで`unsupported`のまま、Grokへfallbackしない。根拠は GPT-5.6、Claude 5、Grok 4.6。

### 消費枠（quotaの独立勘定。規則2のfallback判断に使う）

Anthropic（Claude Code本体・Agent/Workflow）／OpenAI Codex（Codex CLI・codex-sidecar・aiterm codex_agent）／OpenAI ChatGPT（gpt-connector・API fallback禁止）／xAI（Grok Build・aiterm grok_agent）の4枠は別勘定。同役割の次順位が別枠なら、quota逼迫時のfallbackはコスト増でなく枠の移動になる。

## 入口と使い分け

- **Codex親の三入口を分ける**: ① native subagent＝repo密結合、② external execution＝codex-sidecar/aiterm、③ consultation＝gpt-connector。Grok/ComposerはAitermの別harness入口であり、Codex→Codexの入口判断とは別契約。
- Aitermの`codex_agent`/`grok_agent`/`claude_agent`はmodelとeffortを毎回明示する。live catalog不在・effort非対応は明示エラーにし、別modelへfallbackしない。
- **委譲の安全・回収・受入契約は委譲契約が正本**。Aitermの運用型はaiterm-dispatchを正とする。external writerはinstalled→registered→verified→execution-verifiedの最終段だけに置く。
- codex-sidecarはmodel/effortを毎回明示するか`.codex-sidecar.yml` defaultsへ置く。現行schemaはlow〜xhighでmaxを渡せない。
- **役割と配置関係の機械可読な対応**は`lib/orchestrate/placement-policy.mjs` v1が固定する。自動ConsultationはAnthropic/OpenAIだけだが、これは現行配線のclosed enumであり、xAIの能力評価ではない。

## effortの規範

effortは単調に品質を上げない。まず役割に合うpresetへ置き、同じ代表taskで隣接levelを比べる。失敗後に変えるのはmodel tierかeffortの片方だけにする。

| model | 出発点 | 上げ下げの規律 |
|---|---|---|
| Opus 5 | **medium**（工程限定の実装・review）、**high**（長期agent・複雑設計） | xhigh/maxは長時間の知識仕事で測定差が出た時だけ。権限境界が緩い工程へ高effortで置かない |
| Fable 5 | high | 契約criticalのスポット。常用親と同義になる使い方はしない |
| Sonnet 5 | medium | finderの字面回収だけlow。高effortは代表taskで差が出た時 |
| Haiku 4.5 | effortなし | 存在しない`haiku×low`を指定しない |
| Sol/Terra | medium | high/xhighは測定可能な品質差がある時。maxは最難関quality-first。ultraはCodex harnessのmax＋自動fan-outであり明示要求時だけ |
| Luna | **分解済み・仕様固定・focused test付きはmedium**（2026-08-19実測: medium=max同格・14/14） | 分解が甘い仕事はLunaのeffortを上げて救わず別モデルを選ぶ（旧「maxのみ」実測の教訓を適用範囲限定で継承） |
| Grok 4.6 | low=X/字面回収、medium=統合調査・監査finder、high=統括・反証・長時間agent | xhighは思考loopと遅延の外部報告がある。代表taskでhighを上回った時だけ使う |

## Grok 4.6をどう読むか

xAI公式値ではoffice/agentic系で最前線級、DeepSWE・TerminalBenchでは比較対象を下回る。Xには統括・review・長時間実装の成功例と、security誤判定・部分読み完了誤認・思考loopの失敗例が併存する。dotagents実測（2026-08-19）では監査finderのrecall首位（7/10・FP 0）と反証満点（14/14）で、監査・反証・調査の第一候補として実戦配置する。

## 指定と世代交代時の更新手順

- Claude Code内はfloating alias（`fable`/`opus`/`sonnet`/`haiku`）だけを使う。Agent/Workflowのmodelとeffortは対応する場合に毎回明示し、Haikuへeffortを付けない。
- Codexにfloating aliasがないため、`codex/agents/*.toml`と`.codex-sidecar.yml`は具体slugを持つ公認projection。ClaudeのAgent frontmatterとWorkflow per-call値も、runtimeが要求する実行projectionとして本書と同一commitで更新する。
- 外部CLIはpinせず`agents-update`でlatest追従する。model live catalogは実行直前に見る。
- オーナーの世代交代宣言後、`grep -rn "前提:"`で影響面を列挙し、本書、公認例外、focused fixture、RAGを同時更新する。新規候補は小さな実戦比較を行い、失敗も次の配置判断へ残す。
- 順位の変更は実測（役割配置実験の再走または実戦の成功率・手戻り）を根拠にし、実験記録をRAGへ残してから表を書き換える。
