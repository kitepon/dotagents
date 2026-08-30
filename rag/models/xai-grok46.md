<!--
source: https://docs.x.ai/developers/grok-4-6
        https://docs.x.ai/developers/release-notes
        https://x.ai/news/grok-4-6
        https://bms.kyokasuigetsu.xyz/benchmarks/controlled-security-campaign-v1
        https://x.com/ArtificialAnlys/status/2087564654965125375
        https://x.com/kunchenguid/status/2087942296721559607
        https://x.com/BrennanMcQuerry/status/2087616060510052673
        https://x.com/jpschroeder/status/2087639976900997240
        https://x.com/BryanJBryce/status/2087715384778723782
        https://x.com/BarryTheAuthor/status/2087791255438942245
        https://x.com/p0lybender/status/2087995892682924191
        https://x.com/praneybehl/status/2088033994319487155
        https://x.com/morganlinton/status/2087900420685639989
        https://x.com/joshvlc/status/2087912988665577547
        ~/.grok/models_cache.json（2026-08-14端末実測）
        Aiterm clean sessions grok46-clean-x-evidence-20260814 / grok46-clean-routing-audit-20260814
fetched: 2026-08-14
confidence: 高（価格・context・effort・live catalog・clean起動は一次資料または実測）／
  中（独立benchmarkの当該harness内比較）／低〜中（Xの単発利用報告。方向性の仮説だけに使う）
-->

# xAI Grok 4.6 — 能力・effort・工場配置

## 一次事実

- `grok-4.6`は500K context、knowledge cutoff 2026-02-01。
- reasoning effortは`low` / `medium` / `high`（既定）/ `xhigh`。
- 200K tokens以下のAPI定価は入力$2、cached input $0.50、出力$6 per Mtok。200K超は$4/$1/$12。
- xAIはGrok 4.6をGrok Buildの既定modelと位置づける。
- このMacの`~/.grok/models_cache.json`には2026-08-14時点で`grok-4.6`と`grok-4.5`があり、Composer modelは無かった。Composer入口はGrokへfallbackせず明示エラーになった。

## vendor benchmarkの読み方

xAI公表値では、Grok 4.6はAA Index 61、GDPVal-AA 1753、CursorBench 69.9、DeepSWE 65.9、FrontierCode 61.3、APEX Agents 57.5、TerminalBench 26、AA Briefcase 1577。比較対象のSolは順に61 / 1728 / 67.2 / 73 / 60.6 / 56.7 / 34.6 / 1502、Fableは62 / 1741 / 70.5 / 70 / 63.6 / 59.2 / 34.1 / 1574だった。

この集合は、Grok 4.6がoffice/agentic判断、broad coding、professional taskで最前線級に入る一方、deep SWEとterminal操作では比較対象を下回ることを示す。vendor自身のharnessなので絶対順位にはせず、**統括・反証・実装の実戦候補へ入れる根拠**として使う。

Artificial AnalysisのBriefcase再掲も1577で、Opus 5には及ばないがSolと同等以上のbalanced agentic workを示した。これは独立観測だが、単一合成scoreから全roleを決めない。

## 監査・反証

Controlled Security Campaign v1のsmart-contract監査では、Solがrecall 40.31 / precision 50.49 / F1 44.83、Grokが36.43 / 45.63 / 40.52。Grokは総合F1で下回った一方、novel-valid findingsは51でSolの49を上回り、所要時間は10.41分対4.39分だった。主評価のconfidence intervalは0を跨ぎ、p=0.1484である。採点は公式EVMbenchでなくCodexで再構成した非公式層なので、このharness内の観測として扱う。

同ページの費用はGrokがprovider申告の$14.31、SolがAPI換算の$26.08で、like-for-likeではない。費用優位の根拠には使わない。

したがって、Grokを「監査不向き」と一律除外する根拠はない。独立providerが別の有効発見を出す価値がある。ただしこの実験でも単独優位ではないため、契約criticalな最終受入は別providerで閉じる。

Xには、Opus 5とClaude UltraReviewが見落としたstate-machine bugをGrok 4.6が発見した報告がある一方、security reviewで危険な誤判定を重ねた報告、既知CVEをSol mediumより多く見逃した報告もある。成功例と失敗例の両方を配置仮説に残す。

## 統括と実装

- 1日を通したオーケストレーター運用で、過剰実装を止め、必要時に上位modelへescalateし、良い判断をしたという報告がある。ただし週次quotaを1日で消費した。
- scoped code reviewで有効な状態遷移bugを見つけた報告、長時間実装を完遂した報告がある。
- 一方、repoを部分的にしか読まず完成風の回答へ進んだ報告、約500M tokensの思考loopに入った長時間実装報告がある。

結論は「補欠」でも「無条件の新既定」でもない。`high`で統括・反証・repo横断agentの代表実務へ投入し、成功率、停止判断、手戻り、quotaを既存親候補と比べる。親pin自体はオーナー領分である。

## effort

- `low`: X投稿、日時、原文、literal factsの回収。
- `medium`: 複数投稿と一次資料の統合、scope固定の実装、通常finder。
- `high`: オーケストレーション、敵対監査、repo横断・長時間agent。現在の実戦出発点。
- `xhigh`: 常用しない。単発benchmarkでmediumが他effortより良かった例と、xhighの思考loop報告がある。代表taskでhighを上回った時だけ採用する。

effortの品質は単調増加と仮定しない。modelとeffortを同時に変えず、同じtask・harnessで隣接levelを比較する。

## local clean再評価

Spotter/Throughline hook修理後、Aitermから新規Grok 4.6 sessionをhighとxhighで起動した。いずれも旧hook errorを出さず完了し、Grok 4.5前提の古い配置、Composer catalog不在、xhigh対応、文書内の矛盾を正しく抽出した。これは**配線汚染が解消した事実と当該2taskの結果**であり、全taskの品質保証ではない。

この再評価により、旧文書の「難関形式推論は不向き」「ハルシ増・形式推論弱」というGrok 4.5由来の一律除外を撤回した。

## Composer

2026-08-14時点のlive catalogにComposer modelは無い。Composer 3の準備中という見立てはあるが、公式slug、公開日、effort、価格は未確認。adapter、test、入口は残し、catalogへ現れるまで`unsupported`として明示する。Grok modelによる代用はしない。

## 関連

- [[../../docs/02_models.md]] — 役割→model×effortの運用正本
- [旧世代snapshot](../../docs/archive/research/models/xai-grok45-composer25.md)
- [[claude-5-family.md]] — Claude 5のeffortとscope creep観測
