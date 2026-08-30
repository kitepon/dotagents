# 規範ゼロベース監査 — 提案と裁定台帳（r2・凍結）

- Status: **凍結（2026-08-02オーナー裁定）**——スリム化を第一級目標に含めると解の形が根本から
  変わるため、項目別パッチ方式を中止し、層モデル（L0常時/L1起動時/L2オンデマンド）の再設計へ
  移行。矛盾の発見自体（P1〜P8等）は有効な入力として再設計へ引き継ぐ。
- 引き継ぐ確定裁定: P1採用（push既定の条件付き一本化・force系のみ明示指示）／P2採用
  （F/A/Hは統括レーン限定）。表現形は新構造に従う。
- 旧Status: 裁定待ち（項目別・オーナー）
- Date: 2026-08-02
- 経緯: 当初の棚卸し案（重複数え上げ型）は受け皿ミスでオーナーが棄却→ゼロベース再監査。
  r1への反証1巡（独立refuter・corpus自力再読）が**GO不可**を返し、棄却3件・補正11件を反映した
  本r2が提示版。r1の欠陥はrefuterの指摘どおり本文へ記録済み。
- 入力: ①白紙監査（先行仮説なし・12指摘）②行動履歴監査（memory17/罠DB343/docs417/実diff→18パターン）
  ③消費者マップ（読者面と機械gate結合の実測）④統括の当日逸脱目録⑤提案への反証1巡。
- 評価軸: 「**意図どおりAIが動くこと**」。美的重複は誤動作を生む場合だけ問題とする。

## 結論サマリ

規範は「何をすべきか」の明文化にほぼ成功（18失敗パターン中、防止済5・部分12・未対応1）。残る弱点:

1. **実行が分岐する条文**（Tier 1・8件）——同じ依頼から正反対の行動が導ける。
2. **破った瞬間に止める機械境界の不在**（Tier 2・4工事）——規則追加でなくgate実装で塞ぐ。

オーナー最頻矯正パターン（実測）: ①実物より広い完了報告 ②委譲境界が文章のみ ③自由の制約化。

r1反証での棄却3件（P13受け皿ミス再発・P15根拠誤読・P19規則堆積）は末尾の負の台帳に残す。

---

## Tier 1 — 実行が分岐する条文の解消（文書修正wave 1件）

### P1. push規則の正面矛盾 【裁定: 採用（2026-08-02）】

- 矛盾実在: 憲法26行（完遂にpush含む）／75行（pushは明示指示時のみ）／PLAN原則2（必ずpush）。
- 補正済み提案: 75行を「force系・履歴改変・共有ブランチ巻き戻しは明示指示時のみ」へ限定した上で、
  **通常pushの既定は「project正典または恒久裁定でpush既定が確認できるrepo」に限る**
  （無条件既定化は誤push防御を弱める——反証指摘の採用）。generation testのexact検査文言の
  追従を同waveに含める。

### P2. F/A/Hラベルの適用範囲 【裁定: 採用（2026-08-02）】

- PLAN原則5へ「ラベル運用は統括レーンの裁定用」の1句（番号・骨子不変）。

### P3. 子モデル「省略=継承」表記の自己衝突 【裁定: 　】

- 対象はClaude側SKILL.md 28/47行**とworkflow-templates.md 11行**（反証が追加発見）。
  「親と同値のaliasを明示」へ統一。

### P4. dotagents TODO正本の二重表記 【裁定: 　】

- AGENTS.md掟3**とREADME.md 5行**（反証が追加発見）を「プラン＝目的・判断・受入条件と
  Lattice工程への導線」へ。

### P5. 統括plan要件の粒度 【裁定: 　】

- 憲法44行とcontract.md 14行の**両面**を「campaign単位のplan正本＋重装備は4関節」で整合
  （片面追補では矛盾が残る——反証指摘の採用）。

### P6. publish H承認の埋没分離 【裁定: 　】

- AGENTS.md 26行段落を恒久権限とH承認の別bulletへ（内容不変）。

### P7. 知識還流のscope限定 【裁定: 　】

- 還流の書込みは「書込みを含む依頼・進行中campaign・明示の知識還流Phase」だけ、他は還流提案まで。

### P8. model/effort規則とCodex native role 【裁定: 　】

- 委譲契約10行へ「検証済みroleによる**model・effort両方の**固定は明示と等価」（effort欠落を
  補正——反証指摘の採用）。

## Tier 2 — 機械境界の工事（各々独立起票。規則は増やさない）

### P9. 委譲の能力分離 【裁定: 起票済み（2026-08-02・fm-0687〜fm-0690・Lattice factory-master）】

【追記2026-08-02: 完了——dotagents宣言token＋aiterm 0.21.0の実効壁。fm-0687 done】

- 対象を**未強制面に限定**: Claude側Agent/Bash委譲とaiterm系（Codex refuter/sorterは既に
  read-only sandbox・Controlはrole書込拒否済み——反証の前提補正）。committer新設はしない
  （子commit禁止契約と衝突）。

### P10. model/effort省略のdispatch拒否 【裁定: 起票済み（2026-08-02・fm-0687〜fm-0690・Lattice factory-master）】

【追記2026-08-02: 完了（fm-0688/fm-0690 done）】

- Claude C1のdeny化に加え、**Codex X2面・sidecar既定値の扱い**を起票時の設計論点に含める
  （C1単独ではCodex面に届かない——反証の補正）。

### P11. writer直列化の強制点 【裁定: 起票済み（2026-08-02・fm-0687〜fm-0690・Lattice factory-master）】

【追記2026-08-02: 親側C1・Codex側X2で完了（fm-0689 done）。Lattice側強制点は棄却——競合処置は製品の実行時面が所有（オーナー裁定・0.41.1でrevert）】

- 実態: `lib/orchestrate/execution-path.mjs`（pure判定・production importerなし）。
  「単一入口へ接続」ではなく**dispatch ownerごと（親の手順・Lattice run経路）の強制点設計**として起票。

### P12. 祖先検証gateの残repo展開 【裁定: 起票済み（2026-08-02・fm-0687〜fm-0690・Lattice factory-master）】

【追記2026-08-02: 完了（fm-0688/fm-0690 done）】

- 前提更新（反証の実測）: 実装済み=AIShell・Lattice・gpt-connector・Observer。
  未実装の候補=aiterm-mcp（buildのみ確認）・Throughline・Caveat・Spotter・codex-sidecar等を
  再棚卸しして展開（既存恒久裁定の実装完遂）。

## Tier 3 — 文書衛生（生き残り3件）

### P14. モデル名の02_models集約（範囲補正版） 【裁定: 採用・実装済み（2026-08-02）】

- skillから**世代の解決例・コスト説明**だけを02_modelsへ寄せ、実行に必要なfloating alias
  （`sonnet`等の呼出形）はskillに残す（全置換は実行形を壊す——反証指摘の採用）。

### P16. AGENTS.md工場欠陥段落のポインタ化 【裁定: 　】

- 共通部分はcontract.md「Phase maintenance」へ、dotagents固有（第三者完全範囲外・adapter例外・
  H carry-over）だけ残す。反証も維持判定。

### P17. 委譲契約のADR経緯の圧縮 【裁定: 　】

- 経緯散文を「（ADR 0113で不変Decision確定・旧L7留保は失効）」の括弧1つへ（再燃防止マーカー保持）。
  反証も維持判定。

### P18. 外部到達性の断定規則（範囲限定版） 【裁定: 採用・実装済み（2026-08-02）】

- 「**外部サービスの可用性・到達性の断定**は、単一経路・単一試行を根拠にせず、再試行または
  独立経路の確認だけを根拠にする」（無限定の「単一試行=unknown」はfail loudと衝突——反証指摘の採用）。

## Tier 4 — 触らない（負の裁定台帳）

- 正本＋delta＋生成物の機構・parity gate／通常レーン強既定＋4条件OR／timeout=unknown回収契約／
  F/A/H定義の二層／git鉄則群（**ただし75行はP1の対象**——反証が台帳矛盾を指摘したため明記）。
- 旧B（還流規約の二重フル記載）: 取り下げ。他projectからの自己充足に必要な意図的階層化。
- **P13（Lattice工程条文の憲法縮約）: 棄却**。受け皿ミスの再発だった——Lattice docs/01は
  「索引・編入条件だけ」と自称し（1-5行実読確認）、全projectの工程統治規則を所有できない。
  憲法10行は現状維持。Lattice側に統治正典面が新設された場合だけ再考。
- **P15（Control lifecycle縮約）: 棄却**。根拠誤読だった（control-record.md:992はpacket回収
  規則でありlifecycle正本ではない・実読確認）。contractの5段は唯一の短い実行順として維持。
  統括儀式の実行コスト問題（当日実測）は文書縮約でなくTier 2の工事とCLI UXが正しい出口。
- **P19（完了宣言の対報告規則）: 棄却**。五原則5＋報告節85-86行＋contract 56行から導出可能な
  重複であり堆積になる。当日の逸脱は規則不足でなく遵守不足——規則追加では解決しない。

## 進め方（GO後）

1. Tier 1 wave（P1-P8）: 対象= 憲法・PLAN・AGENTS/README・SKILL/workflow-templates・委譲契約・
   contract。generator再生成＋generation test/skill smoke/parity/lintの**exact検査文言追従**を
   同一waveに含める。編集はCodex委譲・commit前にrefuter 1巡・親受入。
2. Tier 3 wave（P14/P16/P17/P18）: 同上。
3. Tier 2（P9-P12）: 各々独立起票（実装工事・このplanは起票の裁定だけ）。
