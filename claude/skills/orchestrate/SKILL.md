---
name: orchestrate
description: 多エージェント/多モデル統括の標準型。統括レーン＝①計画に中断が組込済み②受入が多段連鎖③複数repoの書込調整④裁定証跡が必要、のいずれかが着手時に確定している戦役に着手する前に必ず読む。技法（fan-out・反証・Critic）は通常レーンでも参照可、Control儀式は統括レーンだけ。トリガー例：「戦役」「campaign」「オーケストレーション」「ultracode」
---

<!-- 前提: 2026-08-11の統括契約。統括が最上位級でない場合の運用は本書「ガードレール常時ON」節に収録済み。役割→モデルの対応は dotagents/docs/02_models.md が正（バージョン固定禁止＝PLAN 原則9） -->

# Orchestrate — 統括の標準型

まず[共通契約](references/shared-orchestrate/contract.md)と[委譲契約](references/shared-orchestrate/delegation-contract.md)を全文読む。使う時・使わない時、同期、原因特定、focused検証、通し試験の最終確認、反証、Packet/Report、レーン分離、独立完結、知識還流、F/A/H、Control lifecycle、フェーズ、統括ゲートは共有文書が正本である。この本文は Claude 固有の appendix として読む。

## Claude appendix（既存の運用詳細）

以下はClaudeのWorkflow / Agent / codex-sidecar / aitermを使う場合の固有入口と配置強化策である。共通原則の二重管理はせず、製品中立の判断は上の共通契約に従う。**aitermで子エージェントレーンを張る前に[aiterm-dispatch.md](references/shared-orchestrate/aiterm-dispatch.md)（完了受信・レーン構成・親専任の運用型）を読む。**

Claude appendixは、Claude固有入口から得たstatusをControlへ投影するだけである。Claude内部の共通dispatch API、Executor state複製、新規operational admissionを前提にしない。既存manifestの定義・所有は変更しない。

## Claude 固有の運用

- 同期確認には `sync-sweep` を使う。端末横断リポの照合、dirty、stash、迷いブランチ、NO_REMOTE を明示してから着手する。
- Claude の委譲は[共有の委譲契約](references/shared-orchestrate/delegation-contract.md)と[Workflow 雛形](references/workflow-templates.md)を参照する。

## 知能の配置

| 層 | 担当 | 実行手段 |
|---|---|---|
| L0 統括 | 裁定・契約クリティカル（認可/tx/公開API互換/依存方向/本番操作）・履歴修復・コミット・最終責任 | 本人 |
| L1 監査・検証 | 発見→重複統合→**指摘ごとの反証**→網羅性Critic（盲点→第2ラウンド） | Workflow（`references/workflow-templates.md`） |
| L2 設計 | 2〜4視点の並列設計（実行順序/配置/取捨 等）→**割れは統括が根拠で裁定**（多数決禁止） | Agent (Plan) |
| L3 実装 | 統括レーンで委譲利益が明確な仕様固定物量 | codex-sidecar の `codex_work` または Agent/Workflow |
| L4 外部CLI | 完全固定仕様の機械的一括・第三者視点レビュー | 非対話＝codex-sidecar の `codex_review`/`codex_work`/`codex_generate` 等／対話＝aiterm の `codex_agent`・`grok_agent`・`composer_agent` |

役割に対するmodel×effortの解決と順位は[docs/02_models.md](references/shared-orchestrate/02_models.md)だけを正とする。このskillはClaude固有の実行入口だけを定め、配置値を複製しない。
**並列dispatchの既定はLattice**: 独立に見えるTODOが2つ以上あれば並列化を一度検討し（無意識の直列流れ禁止）、**同一repoへ書込みするworkerを2つ以上同時に走らせるなら**`lattice plan compile`→`run start`経由を既定にする（別repo並列・read-only並列は対象外）。交差判定を親の自前判断でやらない。直列化規則の正本は[合成契約](references/shared-orchestrate/composition.md)「同一repo writerの直列化」、委譲側の帰結は[委譲契約](references/shared-orchestrate/delegation-contract.md)「並列化の検討とLattice既定」。
**継承の罠（最上位張り付き防止）**: Agent/Workflow の model 省略は親モデル継承＝親が最上位だと全子が最上位に張り付く。全役割で `model` と `effort` を順位表どおり毎回明示する——親と同値の指定は可、省略は不可（正本は[委譲契約](references/shared-orchestrate/delegation-contract.md)最低安全契約）。

## 協業ループ（Claude⇄外部AI・aiterm PTY で回す）

「設計→レビュー→再設計」を外部AI（Codex/Grok）と往復させる型。基盤は aiterm 永続PTY（`mcp__aiterm__pty_*`）＝tmux ペインの read/type/keys で、smux 等の外部ツールは不要。

- **片方向レビュー**: codex-sidecar の `codex_review`（非対話）で Codex にレビューさせる → **統括が指摘を敵対的裁定**（生き残りだけ採用）→ 統括が修正・コミット。Phase検証のクロスprovider既定（02_models.md）の実行形でもある。
- **往復**: 修正後に再度 `codex_review` で確認。**1往復ごとに統括が裁定**する（全自動対話にしない＝品質 > 自動化）。第三者視点（別モデル・別レート枠）と敵対的検証を同時に得る。対話で詰めたい時は aiterm の `codex_agent`/`grok_agent`/`composer_agent`。

## 標準エージェント（~/.claude/agents に定義済み）

- **implementer**: 委譲契約を焼き込んだ標準実装者。契約の共通部を毎回書かなくてよい。
- **refuter**（読み取り専用）: 敵対的検証者。指摘/計画/主張を実ファイルを読んで殺しにかかる。

## ガードレール常時ON（統括が最上位級でない場合に備える）

セッション主モデルが最上位ティア未満の時にも品質を保つ追加ガードレール。統括は自分の知能レベルを確証できない（実行中の実モデルは AI から見えず、格下げの検知・reset はオーナーへ委ねる）ので、下記は「格下時だけ」でなく、**契約クリティカル・監査確定・不可逆操作では常時ON**にする（品質を統括モデルの当たり外れに依存させない）:

- **検証2票制は契約クリティカルだけ**: 認可・tx・公開API互換・依存方向・本番操作級の指摘・判断に限り独立2票（existence＝事実か／value＝直す価値があるか）。その他は統括自身の確認で採用/棄却する。
- **裁定は棄却側へ倒す**: 確信が持てない指摘・提案は棄却する（もっともらしいだけの大改造を通さない。迷ったら殺す）。
- **契約クリティカルは自己実装前に refuter を1回通す**: 認可・tx・公開API互換・依存方向・本番操作は、着手前に「この設計は安全か」を refuter に殺させてから。統括と同じ当たり外れを二度引かない配置は、02_models.mdの反証・相談順位から明示して呼ぶ。
- **エスカレーション裁量**: 委譲物に納得しなければ、02_models.mdの順位に従って上位候補へ引き上げてよい。安さは品質の人質ではない。
- **配置は統括レーンの4関節で宣言**: F/A/Hと同時に（ティア, effort, 入口）を1行宣言する。通常レーンは分類・配置宣言を要しない。02_models.mdの既定から上振れする方を要正当化し、配置に迷ったら安い方・採用に迷ったら棄却する。

## Claude 固有の参照

- 委譲プロンプトの雛形: [共有の委譲契約](references/shared-orchestrate/delegation-contract.md)
- Workflow スクリプト雛形（敵対的監査・一括整理）: `references/workflow-templates.md`
- 役割→現行モデルの対応: `dotagents/docs/02_models.md`（バージョン固定禁止・エスカレーション裁量）
