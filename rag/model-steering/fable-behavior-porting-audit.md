<!--
source: connect24h の X 記事「賢さは買う・型は移植できる」 https://x.com/connect24h/status/2073364135111508418
audit_by: ベル（統括直轄・refuter 敵対検証つき）
fetched: 2026-07-05
confidence: 高（一次資料＝Anthropic 公式 doc を verbatim 取得し file:line で裏取り。raw/ に保管）
-->

# 監査: Fable 5 の「行動の型」を全モデルへ横展開できるか（connect24h 記事の検分）

## 問い
connect24h の記事は「Fable 5 の賢さは買うしかないが、**行動の型**は Claude Code の output style で下位モデルへ移植できる」と主張。この中核ロジックが公式で裏付けられ、かつ dotagents 環境（統括＝Fable 5、憲法＝claude/CLAUDE.md）で使えるか。オーナーの狙い＝親が Fable 5 とは限らない前提で、賢い振る舞いをどのモデルでも／worker でも引き出す（能動的なモデル使い分け。格下げ・希望しない拒否フォールバックは非重視）。

## 結論（一行）
**記事の中核提案「型を output style で移植」は、うちには採用しない。** 公式が「過剰に prescriptive な旧世代指示は Fable 5 で品質を下げる」（[[raw/prompting-fable-5]] L174）と明言し、「行動規約は output style でなく CLAUDE.md に置け」（[[raw/output-styles]] L13）とカテゴリを名指すため、型を output style で"足す"のは**逆行**。Fable への正解は「足す」でなく、憲法の過剰な steering 列挙を**選択的にスリム化**すること。真の収穫は (a) うちの会話規範が Fable の型と既に整合している確証、(b) 記事の事実誤りの確定、(c) 憲法スリム化という次の宿題。

## 採否台帳（refuter 敵対検証を通過した最終評決）

| # | 記事のロジック | 公式裏取り | refuter 評決 | 採否 |
|---|---|---|---|---|
| 1 | output style は既定指示末尾＝CLAUDE.md より型が「粘る」 | output-styles L98/L100/L113 は**構造のみ**。「粘る/よく効く」は非記載 | **殺せた**（粘りは憶測。証拠の付け違い） | **棄却** |
| 3 | subagent に output style が非伝播＝罠として記録 | 明示の一文なし。L115「subagent は独自 system prompt」からの推論 | **殺せた**（推論の断定化は危険＋委譲契約で既に無効化済み） | **棄却** |
| 2 | effort 換算「Fable high ≈ Opus 4.8 xhigh」でペア設定 | migration L688「effort は各モデルで recalibrated」＝等価でない | **殺せた**（等式は誤り／02_models 注入は越境） | **棄却** |
| 4 | 行動の型を output style として持つ（本丸） | prompting-fable-5 L174・L53／output-styles L9・L13 | **殺せた（最強）**（二重の公式根拠で逆行） | **棄却** |
| 4b | 好む/嫌う書き方を対で指定（肯定＋否定） | prompting-fable-5 L58 が実践（"not…arrow chains"） | 生存（弱） | **弱採用**（rag メモ級・聖典改訂に非該当） |
| — | 「Opus 4.8 は 200K のまま」 | migration L680「Opus 4.8 は 1M が既定・beta header 不要」 | 生存（記事が誤り） | **記事の誤りを確定** |

## 各判定の根拠（file:line）

### 判定1・4 — チャネル分離と「型を output style で持つ」（本丸・棄却）
- output style は「how Claude responds, **not what Claude knows**／role, tone, and output format」（[[raw/output-styles]] L9）。**行動規約（進捗の裏取り・境界・スコープ）は tone/format でなく conventions ＝公式は「CLAUDE.md に置け」と名指す**（L13）。→ 型を output style に載せるのはカテゴリ違いの器。
- 「旧世代向けの過剰に prescriptive な skill/prompt は Fable 5 で品質を下げる。デフォルト性能が良ければ古い指示の削除を検討せよ」（[[raw/prompting-fable-5]] L174）。「Fable は指示追従が強く brief instruction で steer できる（各挙動の列挙不要）」（L53）。→ うちの CLAUDE.md（104行・大量条項）は L174 が名指す対象そのもの。型を"足す"のは逆行。
- 記事の「粘る」根拠は無い。output style に持続機構はあるが（L101 reminders／L108・L112 every response）、それは「位置ゆえに粘る」という記事の説明とは別物で、採用を正当化しない。

### 判定2 — subagent 非伝播（棄却）
- 公式に明示の一文なし。L115「Agents run a subagent with its own system prompt」からの推論を断定化するのは危険。
- うちは worker への指示を output style に頼っていない＝委譲契約8点セット（[[../../claude/skills/orchestrate/references/delegation-contract]]）＋ implementer 焼き込み（claude/agents/implementer.md L9-21）で明示的に渡す設計。この穴は既に構造無効化済み＝新規 caveat の実益ほぼ無し。

### 判定3 — effort（棄却＋宿題1件）
- 「Fable high = Opus xhigh」等式は誤り。effort レベルは各モデルで token 配分が recalibrated（[[raw/migration-guide]] L688）。公式が言うのは「Fable の低 effort でも前世代 xhigh を超えることが多い」という能力比較（L43/L638）。
- 換算表を docs/02_models.md に作るのは、同 doc の「役割→モデル解決のみ・定量スペックを持たない」設計（02_models.md L1/L5・PLAN 原則9）に反する越境。
- **生きた宿題**: うちの settings.json は `effortLevel:"xhigh"`。migration L651 は「Opus 4.8 で xhigh だったワークロードも Fable では high から再評価せよ」。ただし L638「xhigh は capability-sensitive に温存」。うちの統括役（監査確定・契約クリティカル・不可逆操作）は capability-sensitive の典型＝**xhigh 据え置きが妥当**。結論：再評価は済み、現状維持が正当。high への一律切替は公式が支持していない。

### 判定5 — 「Opus 4.8 は 200K」は記事の誤り（確定）
- [[raw/migration-guide]] L680「Opus 4.8 は 1M context がデフォルト、beta header 不要、long-context premium なし」。裏付け L313/L658/L706。この環境の統括も Opus 4.8 **1M 版**で稼働＝記事の 200K 主張と真っ向矛盾。

### 判定6 — 衝突1（即行動 vs まず会話）は見かけ倒し（生存・条件付き）
- L38「act when you have enough info」＝変更要求ありの場面での決断効率／overplanning 抑制。L80「ユーザーが問題を述べている／質問している／考えを口にしている時は assessment が deliverable。findings を報告して止まれ。頼まれるまで fix するな」＝変更要求なしの場面。**別トリガで作動＝非衝突**。
- **L80 はうちの応対規範「まず会話」（CLAUDE.md L14-18）を否定でなく補強する**。＝うちの会話規範は Fable 5 の設計思想と整合。
- ただし境界「変更要求 vs 議論」は判断依存で、両故障モードが公式記載（L77 unrequested actions／L105-110 early stopping）。型化するなら境界基準（L64/L80）と文脈スコープ（対話 vs autonomous pipeline）を明示同梱すること。

## 記事の信頼性メモ
- 出発点の CL4R1T4S（elder-plinius）Fable 5 リークは、**Anthropic が真正性を公式否定**（一部は Fable 5 の出力ですらない・コア safety classifier は維持）＝ excellentprompts 記事 L32-34。connect24h が「結論、不要だった」と公式 doc へ切り替えたのは**結果的に正しい判断**。成果物の主素材（公式 prompting-fable-5）は汚染されていない。
- 事実主張のうち pricing（$10/$50 per M）・safety classifier（cyber/bio/reasoning_extraction）・Opus へのフォールバック案内は公式で正しい（[[raw/introducing-fable-5-mythos-5]] L16/L25/L41）。context だけ誤り。

## うちに刺さった発見（記事が触れていない・調査の真の収穫）
1. **うちの憲法は既に Fable の型と広く整合**: 会話規範（L80）・進捗の裏取り（prompting-fable-5 L72＝自己保身の禁止）・スコープ規律（L48）・思考を response に再現しない（L175＝出力衛生）・memory 作法（L96＝端末メモリ規約）。＝「移植」でなく「既に持っている」が正しい姿勢。
2. **憲法の選択的スリム化＝実施済み（2026-07-05・コミット 33b52e8..1f2e660）**: L174 を踏まえ着手。反証役11体の敵対検証で**純粋削除（`compress_safe`）はゼロ・全条項 load-bearing** と判明——特に本環境が xhigh 稼働ゆえ出力衛生・作業範囲は Fable 既定（高 effort での冗長化・scope creep）への **push-back** だった（統括の初期「既定なぞり」ラベルは5件が覆された）。よって作業の性格は「消す」でなく **floor（削除不可の核）を残して例示・重複・散文を締める** に着地＝宿題の「意味を保って短く」に合致。圧縮6件（人格の錨＋出力衛生・大規模変更・まず会話・五原則1/2/4）、**keep** ＝原則3/5・調査L30（Karpathy アンカー）・**git/rsync/stash 系の実被弾ハザード記憶（CLAUDE.md L84-96）**・委譲契約・人格核・L101（公式 L175 整合）。
3. **effort 据え置きの正当化を確保**: xhigh 維持は capability-sensitive ゆえ妥当（L638）と公式で裏付け。

## 関連
- [AI協業をコード化する（履歴）](../../docs/archive/research/orchestration/ai-collaboration-as-code.md) — 委譲構造（worker への指示は agent 焼き込みで渡す＝判定2の裏付け）
- docs/02_models.md — 役割→モデル解決の唯一の参照点（effort 換算の越境を退けた根拠）
- 一次資料 verbatim: raw/prompting-fable-5.md, raw/output-styles.md, raw/migration-guide.md, raw/introducing-fable-5-mythos-5.md, raw/release-notes-system-prompts.md, raw/excellentprompts-fable-5-notes.md
