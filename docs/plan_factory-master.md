# 開発工場 統合マスター計画

**状態:** Active  
**工程正本:** Lattice `factory-master`

この文書は開発工場campaignの目的と現役導線だけを示す。Task、依存、状態、完了証拠は
Lattice storeが唯一の正本であり、Markdown checkboxや旧queueへ二重化しない。

## 現在の工場

- 開発工場: dotagents
- 自作コア10製品: Caveat／Throughline／Spotter／Lattice／gpt-connector／aiterm-mcp／
  codex-sidecar／AIShell／ServerManager／peertable。Observerは2026-08-16に工場コアから撤去
- 第三者管理製品: MarkItDown（公開CLIだけをblack-box管理）
- 基盤toolchain: Claude Code CLI／Codex CLI／Grok Build
- 現役factory wire: **v7・固定14製品（observerキーなし。全4現役host cutover済み・2026-08-10）**。v6はhost別rollback先として維持
  （[wire v7設計](wire-v7-design.md)・[reporter runbook §4b](factory-reporter-runbook.md)が正）
- 独立Codegraph: retired／not_applicable。Lattice sensorが正式後継

所有境界と恒久規則は[AGENTS.md](../AGENTS.md)、趣旨は[PLAN.md](../PLAN.md)、有限契約は
[factory-product-contracts.md](factory-product-contracts.md)、host別受入は
[factory-host-product-matrix.md](factory-host-product-matrix.md)を正とする。

## 完了campaign

- [Lattice編入](archive/plan_lattice-factory-integration.md)
- [AIShell編入](archive/plan_aishell-factory-integration.md)
- [Observerコア編入](archive/plan_observer-core-integration.md)
- [Codex全対応](archive/plan_codex-full-support.md)
- [BugHub工場統合](archive/plan_bughub-factory-integration.md)
- [工場全文書同期](archive/plan_factory-documentation-sync.md)
- [peertable編入](archive/2026-08_peertable-onboarding.md)（設計・実装）と
  [wire v7実行](archive/2026-08_peertable-wire-v7-execution.md)（publish・enroll・cutover・正典更新）。
  cutoverは2026-08-10に全4現役hostで完遂（実送信・gate success・matrix 7.0を各host実測）
- [工場全製品の展開閉包](handoff_factory-deployment-closure-20260811.md)。12管理製品の初回導入・継続更新・
  post-update gateを閉じ、Mac／WSL2／Windows nativeのhost別一撃展開と定期更新を2026-08-15までに完遂

## 現在のwave

Tier 2機械境界wave（`fm-0687`〜`fm-0690`・2026-08-02起票・lane `canon-layer-redesign`）が進行中。
各ToDoの平文設計メモは[source-ledger](archive/lattice-source-ledger/canon-tier2-gates-20260802.md)にある
（`lattice todo note`経路が下記欠陥で塞がっている間の一時迂回）。

## 並行campaign

- [Grok 親host 全対応](plan_grok-parent-host.md)（2026-08-16開始。工程正本は当該Markdown。Lattice未適用）。
  Wave 0〜5着地。4席の新規session受入は2026-08-16に閉じた。Phase監査済み。2026-08-16裁定: Observerをコアから撤去、Spotterはコア維持かつ正式Grok host化、ThroughlineのGrok対応は必須。Wave 6はThroughlineとSpotter。Observer撤去は独立wave。
- [Cursor harness 工場適用](plan_cursor-parent-host.md)（2026-08-24開始。工程正本は当該Markdown。Lattice未適用）。
  [harness用語統一](plan_harness-terminology-refactor-20260824.md)完遂の上に乗る。OS層と既存3harness dirは壊さない。Aiterm `cursor-cli`は消費のみ。Wave 1〜6着地。Mac新規session受入は 2026-08-24 に閉じた（`d4c055fa`）。Wave 6 製品adapter（Caveat 0.18.0 / Lattice 0.64.0 / Spotter 1.6.1）はこのMacで実測。

## maintenance queue

- **`test-observer-package`が diagnostics schema / version 不一致で落ちる**（2026-08-16記録・所有repo=Observer／dotagents試験・非クリティカル）:
  Grok親Wave 5閉じで観測。`make ci`の必須targetではない。Grok戦役のcommitは当該testに触れていない。最小再現は`make test-observer-package`。
- **Lattice `todo note`がスタブrevisionでfail closed**（2026-08-02記録・所有repo=Lattice・非クリティカル）:
  `factory-master`履歴中の`rev-c7e2409e…`（2026-07-20移行中断の残骸・`plan.json`欠落）でnote投影が
  `NOTE_PROJECTION_INVALID`になる。最小再現・迂回はcaveat
  `lattice-todo-note-revision-plan-json-note-projection-invalid`が正。2026-08-02に Lattice 0.40.1（`3d6b882`）で修理・publish済み＝**解消**。
- **`factory-reporter-scheduler install --apply`がrunner binの解決可能性を検証せずsuccessを返す**
  （2026-08-10記録・所有repo=dotagents）: 実被弾はpeertable wire v7 canary cutover・room [91]。
  **2026-08-10修理済み**——`--apply`はrunner不在／実行権限なしを`runner_unresolved`のtyped errorで
  登録前に拒否する（dry-runは従来どおり検証なし）。負側testで欠陥版がfailすることを確認済み。
  最小再現はcaveat `dotagents-factory-reporter-scheduler-install-apply-runner-bin-success-fail-open`が正＝**解消**。
- **`agents-update`のpost-update gate既定がwire v6 runner固定**（2026-08-10記録・所有repo=dotagents）:
  wire v7へcutover済みのhostでconfigのendpoint（v7）とrunner（v6）のmajorが食い違い、cutover後最初の
  定期実行からgateが落ちる構造だった。**2026-08-10修理済み**——runnerはhostの実configの
  `reporting.endpoint`が指すmajorから解決し（env明示が最優先）、endpointが読めない時はv6へ倒す
  （未cutover hostの挙動不変）。このMacでv7解決・config不在fallbackとも実測済み＝**解消**。

工程表示は次で生成する。

```bash
lattice todo status --json
lattice todo gantt --scope live
lattice todo gantt status
```

旧queue、wire v2〜v5の移行過程、完了済みH gate、障害訂正の詳細はgit履歴・archive・ADR・
Lattice storeに保持し、本書へ再掲しない。
