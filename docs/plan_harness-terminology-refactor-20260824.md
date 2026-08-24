# harness用語統一・OS/ハーネス分離 campaign（2026-08-24）

- **状態**: **完遂（2026-08-24・P6拡張込み）**。
- **P6（オーナー裁定による全量化）**: 「用語のあるrepoだけ」への絞り込みを撤回し、全11製品＋dotagentsをOS依存/ハーネス依存の分離と簡単化の対象として棚卸し→実装した。結果:
  - **gpt-connector 0.4.17**: darwinゲート3重実装を`platform/darwin.ts`の`isDarwin()`へ、`state.ts`内のwin32判定を`isWindows()`へ、OS文字列検証を`safePlatform()`再利用へ集約。135 test green・publish・install・version smoke済み。
  - **codex-sidecar 0.3.11**: POSIX専用ガード5箇所を新設`packages/core/src/platform.ts`の`isWin32()`へ、paths.tsの正規化2箇所をローカルヘルパへ統合。**0.3.10はnpm publish直叩きで`workspace:`依存が未解決のまま公開された導入不能版**（検出→deprecate→pnpm publishの0.3.11で修正）。install→factory-diagnostics ready。
  - **Throughline 0.10.2**: XDGベースdir組み立て3重実装を新設`src/os/app-dirs.mjs`へ、hostリテラル比較6ファイルを`hosts/identity.mjs`定数へ、codex-auto-refresh/codex-sidecarのOS判定を`os/`層へ委譲。761 test green・publish・install・factory smoke済み。
  - **Lattice 0.63.10**: 14ファイルへ複製されていたwin32ガード付きdirectory fsyncを新設`src/fs-dir-sync.mjs`へ一本化（名前付き9＋inline 6）。full test green・publish・install・factory-diagnostics ok。
  - **Caveat 0.17.7→0.17.8**: env対応Windows判定を`platform.ts`の`isWindowsEnv()`へ集約（0.17.7）。公開後smokeで**0.17.6からの既存回帰**（診断のClaude hook canonical判定が`process.execPath`との文字列完全一致を要求し、installerの安定binパスと恒常不一致→macOSでfalse `not_installed`）を検出し、最小再現の回帰testを先行して0.17.8で根治。install後smokeはclaude/codexともready。
  - **Spotter 1.5.14**: Windows絶対パス表記判定を`platform/paths.mjs`の`isWindowsAbsolutePath()`へ集約、`killWorkerTree`と`terminateProcessTree`の意図的差分（絶対にrejectしないbest-effort掃除）を明記。publish・install・smoke済み。
  - **aiterm-mcp 0.28.3**: campaign 32のqueue項目（stop hook 2本とagent-sharedの`uid()`/`runtimeStateBase()`三重実装）を新設最下層`src/state-root.ts`へ一本化。355 test green（release連鎖は本plan末尾の証跡参照）。
  - **peertable 0.6.1**: wake系harness知識は既に`wakeup-delivery.mjs`/`codex-dialog.mjs`へ分離済みと実測確認し、残っていたharness読取パターン4箇所を`memberHarness()`へ統合。publish・install・diagnostics ready。
  - **dotagents**: 現行世代のOS判定・chmodガードを新設`lib/platform.mjs`（`isWin32()`/`chmodIfPosix()`）へ集約（external-events / factory-reporter / factory-toolchain-ledger / orchestrate control-record）。**wire版別凍結ファイル（lib/factory/v2〜v5とそのbin実行体ファミリー）は互換凍結のため意図的に対象外**（bin/factory-scan-v*・factory-reporter-v*の版別複製は凍結実行体であり重複統合しない、の裁定）。
  - **AIShell**: OS分岐なし（macOS arm64専用ゲートのみ）・harness分岐なし（host非依存の単一実装）を実測確認。棚卸しが挙げた「tgz 5件がcommit済み」は実物確認で棄却（追跡ファイルも実体も無し）→変更なし。
  - **ServerManager**: OS分岐はpi5/checks/layer0-self.jsの開発機ガード1ファイルに集約済み、ハーネス実行はCodex単一実装（pi5/codex-ssh.js）で分岐なし。Discord投稿の2実装（pi5/BugHub）は責務層が異なる意図的並存と裁定し統合しない→変更なし。
  - **MarkItDown**: 第三者製品でfork/patch禁止（台帳恒久裁定）のためソース改変は対象外。
- 初回scope（用語置換と初期release）の結果:
  - aiterm-mcp 0.28.2: `src/vendors/`→`src/harnesses/`・内部識別子・現役docsをharnessへ統一。4環境CI green→tag CI green→npm publish→global install→MCP initialize smoke OK。wire互換field（`vendor`/`vendor_session_id`/`vendor_dependencies`/`AITERM.VENDOR_LAUNCHER_FAILED`）は不変。
  - peertable 0.6.0: member素性の正本fieldを`harness`へ（DB列migration・旧`vendor`受理・応答mirror併記・`PEERTABLE_HARNESS`正本・`--vendor` flag互換alias）。npm publish→global install→diagnostics ready。本番room server（main-server）もimage `20260824-7360790`へ入替済み（旧image残置でrollback可・会話ログvolume不変）。
  - Throughline / Spotter / Caveat: docs散文のみ置換（cross-harness等）。製品挙動変更なしのためnpm releaseは対象外。
  - dotagents: 正典散文（codex delta・orchestrate skill・executor-adapters・02_models・製品契約台帳）を置換し生成物を再生成。生成test 6 pass・markdownlint 0 error。lib/factoryのwireキーは不変。
  - 対象外確定: Lattice / aishell / codex-sidecar / gpt-connector / ServerManager / MarkItDown（AI分類のvendor使用なし）。
- **レーン**: 統括（複数repoの書込みを調整）
- **背景**: Cursorは複数AIモデルを載せる実行基盤であり、AIを「ベンダー」で分類する語彙が破綻した。オーナー裁定により、実行基盤の分類語を**harness（ハーネス）**へ全面置換する。実際のCursor対応は本campaignの対象外（aiterm-mcpは0.28.0で先行実装済み）。

## ゴール

1. **G1 用語置換**: AI実行基盤の分類として使われる「vendor」を「harness」へ置換する。対象は現役の正典・README・コード内identifier・コメント。**歴史文書（evidence/・docs/archive/・CHANGELOG・確定済みADR本文）と、公開wire契約の互換fieldは置換しない**（下記「不変契約」）。
2. **G2 分離**: OS依存ファイルとハーネス依存ファイルを最小限の内容で分離する。**レイヤ裁定: OS層を下層、ハーネス層をその上に置く**（harness adapterがOS抽象を利用し、coreはharness interfaceだけに依存する）。aiterm-mcp campaign 32（2026-08-23完遂・core → harnesses → shared → os の一方向依存）を工場標準の実証形とする。
3. **G3 簡単化**: 置換・分離のついでに見つけた明白な重複・死コードの整理（挙動不変のみ）。
4. **G4 完遂**: リファクタした製品ごとに、全ドキュメント更新→commit→push→npm global install→npm release→公開後smokeまで同一waveで閉じる。docs-only変更の製品はcommit/pushまで（npm releaseは製品挙動の変更が無いため対象外、理由付きで報告）。

## 不変契約（置換しないもの）

- aiterm-mcp診断schema `aiterm-mcp.factory-diagnostics.v1` の `vendor_dependencies` キー（dotagents `lib/factory/v2〜v7.mjs` がexact allowlistで検証する現行wire。v2-v5は凍結履歴）。
- aiterm-mcp receiptの互換field `vendor`／`vendor_session_id`（ADR 0038で互換維持を確定済み。正本fieldは `harness`）。
- runtime error code `AITERM.VENDOR_LAUNCHER_FAILED`（fingerprint安定性）。
- peertable room DBの既存列・旧skill資産からの `vendor` 書込み（migration＋読み書き互換で受ける）。
- 第三者パッケージの実パス（`@openai/codex-*/vendor/`）、依存vendoring語（Lattice sensor grammar・aishell等の「vendored dependency」）——AI分類語ではないため対象外。

## 現状調査の結論（2026-08-24実測）

| repo | vendor=AI分類の実態 | 処置 |
|---|---|---|
| aiterm-mcp | src/vendors/ 4 adapter・identifier約160箇所。OS/harness分離は0.27.8で完了、harness APIは0.28.0で導入済み | 内部identifier・dir・現役docsをharnessへ改名、release |
| peertable | member台帳の素性field `vendor`（DB列・API・SSE・env `PEERTABLE_VENDOR`・skill scripts・UI） | 互換付き全面rename（正本`harness`・旧`vendor`受理/併記）、release |
| Throughline | README×2・CLAUDE.md・docs/16 の散文「cross-vendor」等6箇所 | docs置換のみ |
| Spotter | docs/00_overview.md「host-vendor decision points」1箇所 | docs置換のみ |
| Caveat | docs/05_next_session.md「vendor-neutral hook」1箇所 | docs置換のみ |
| dotagents | 正典散文（codex skill/delta・shared/orchestrate/executor-adapters.md等）＋生成物 | 散文置換＋生成物再生成。lib/factoryのwireキーは不変 |
| Lattice / aishell / codex-sidecar / gpt-connector / ServerManager / MarkItDown | AI分類のvendor使用なし（依存vendoring・rag引用のみ） | 対象外 |

- OS/ハーネス分離の現状: aiterm-mcpは完了済み。dotagentsは既に分離済み（claude/・codex/・grok/ のharness別dir＋OS別setup 4入口）。Caveatはinstall面がファイル単位で分離済み（claudeInstall.ts / codexHookInstall.ts / hookShared.ts）。Spotterはdocs/00_overview宣言どおり分離済み。peertableのharness分岐はwakeup-bridge等の小分岐に局在しており、adapter抽出は間接を増やすだけで最小実装原則に反するため**改名に留める**（Cursor対応時に必要ならその時に抽出する）。

## 非目標

- Cursor実対応（peertable・他製品への追加）。aiterm-mcp診断schema v2化（`vendor_dependencies`→`harness_dependencies`のwire改名はhost横断cutoverが必要で、用語統一の利益に対し過大）。歴史文書の書換え。挙動修正・機能追加。

## 工程

- P1 aiterm-mcp: rename（vendors/→harnesses/・identifier・docs）→ full test → release 0.28.2 → install → smoke
- P2 peertable: 互換付きrename → test/smoke → release 0.6.0 → install → smoke
- P3 docs-only 3repo（Throughline / Spotter / Caveat）: 置換 → commit/push
- P4 dotagents: 正典散文置換＋生成物再生成 → shell lint/契約test → commit/push
- P5 知識還流・本計画の完遂化

## 並列化検討の結論（campaign単位で一度）

repo間は独立だが、統括1名の直列実行とする。理由: 置換の罠（wire互換fieldの誤置換）が全repoで同型であり、統括自身が一度学んだ判定を直列で適用する方が委譲Packet作成＋受入コストより安い。Lattice runは新設しない。

## 検証

- aiterm-mcp: `npm test` full（macOS）＋ `npm pack --dry-run` 同梱確認 ＋ 公開後smoke。
- peertable: 既存test＋room server起動smoke＋新旧field互換のfocused test。
- dotagents: `npm test`（factory-scan契約test）＋生成物diff確認。
- 各repo: `rg -i vendor` 残存の全数確認（不変契約の残存だけが許容）。

## maintenance queue（campaign外の持ち越し・理由付き）

- **dotagents main CIのlinux-native lane赤（既存）**: `tests/install/clean-home.sh`内のverify-installがserver profileで`SERVERMANAGER_READY_URL`を要求するが、linux runner環境に未設定（実測: repo内で既定を渡すのはsetup-wsl-factory.shだけ）。加えてmain-serverの`/readyz`は現在503（`not_ready`・database/schemaはpass）。e4d93c1（Windows工場一撃展開wave）以降のposix laneはquoted-hook破壊で本件へ到達しておらず、本campaignの`lib/hook-command.py`修理（POSIX hostでのWindows path basename取り）でwsl2/macos laneはgreen復帰、linuxだけ本件が残る。**所有はWindows工場wave／runner運用（factory-ci runbook）**であり、本campaignのdiffとは独立。対処候補: linux runnerのenvへ`SERVERMANAGER_READY_URL=http://127.0.0.1:39310/readyz`を恒久設定（setup-linux-factory.shへの追補）＋readyz 503の原因（鮮度check）確認。
- **Lattice**: `stableNodePath()`（bridge-executable）と`resolveStableNodePath()`（hooks-cli）が同一問題への非同一実装として並存（棚卸し検出）。統合は挙動差の裁定が要るため未実施。`rc1-v4-campaign.mjs`のproduction経路孤立も確証不足で保留。
- **Spotter**: PATH実行体探索の3実装（platform/paths・install・codex-hook-cmd）は用途差（realpath照合等）があり無裁定統合を見送り。`envForMatrixHost`とhost-agent判定の対応表二重保持も同様。
- **Caveat**: Windows ACL実装（runtimeErrors.ts）のplatform.tsへの移設は同一package内の配置整理であり、判定統合（isWindowsEnv・0.17.7）まで実施、実装本体の移動は見送り。O_NOFOLLOW openの2箇所は検証・読取が実質別物で重複でないと裁定。
