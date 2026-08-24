# Cursor harness 工場適用

**状態:** Active（Wave 6 実測完了。新規session受入はH）
**開始:** 2026-08-24
**工程正本:** 本ファイル（Lattice未適用。オーナーが指示した時だけ移管する）
**親導線:** [開発工場 統合マスター計画](plan_factory-master.md)
**前提campaign:** [harness用語統一・OS/ハーネス分離](plan_harness-terminology-refactor-20260824.md)（2026-08-24完遂。本作業はその構造の上に乗る）
**レーン:** 統括（受入が多段、後続波は製品repo、所有面の切替に証跡が要る）
**終着:** CursorをClaude / Codex / Grokと同格の工場harnessにする。Claude面への寄生を完成形にしない。Aitermの`cursor-cli` workerレーンを親面の完成と読まない。

語彙を混ぜない。

| 語 | 指すもの | 指さないもの |
|---|---|---|
| **harness（工場の「親」）** | Claude / Codex / Grok / Cursor。憲法・配布・工場MCP・工場hookの所有者 | 席、model、toolchain ID、Composer |
| **席（OS）** | Mac / Windows native / WSL2 / Linux。工場4席は全部本線 | harness。憲法generatorの4harnessと席を「4 host」と書かない |
| **toolchain** | Claude Code CLI / Codex CLI / Grok Build。導入・更新・version管理の対象 | harness面そのもの。Cursor Agent CLIを第4 toolchain IDにするかは本計画の外 |
| **Composer** | Grok CLI上のmodel preset（`harness:"grok-cli"`） | Cursor harness。aitermの独立入口にしない |
| **model** | harnessが選ぶ推論モデル | 実行基盤。Cursor上のGPT/Claude/Grokは`cursor`のまま |

全対応はファイル数の左右対称ではなく**能力対称**である。製品固有機能は無理に移植せず、`対応 / 製品固有 / 非採用（理由）` のいずれかを明記できればその面は閉じる。

## 0. 目的

dotagentsを開いたCursor親が、Claude面を吸わずに工場原則・主要workflow・委譲品質・端末再現性を自前の面から得る。Aiterm 0.28+の`agent_launch({ harness: "cursor-cli" })`は子レーンの足場であり、本計画の完了条件ではない。

## 1. 完了条件

Cursor harnessについて次がすべて言える。

1. グローバル憲法は`shared/constitution.md`＋`cursor/AGENTS.delta.md`から生成した`cursor/AGENTS.md`だけを読む。`~/.claude/CLAUDE.md`をUser Rulesとして吸わない。
2. 工場skill / 工場agent / 工場runbookはCursor所有面（実測した`~/.cursor/...`）へsymlinkされ、`verify-install`がそれを見る。
3. 工場MCP（caveat / lattice / aiterm / aishell / gpt_connector / codex-sidecar）はCursor所有のMCP設定が持つ。handshake失敗を成功扱いしない。
4. 工場hookはCursor所有面が持ち、Claude `settings.json`からの流入を正規契約にしない。Cursor envelopeをClaude形へ変換しない。
5. [factory-host-product-matrix.md](factory-host-product-matrix.md)にCursor harness列がある。各セルは実測どおり`required` / `optional` / `unsupported` / `not_applicable`だけを使う。
6. 工場の4席は全部本線。Cursor親を置く席では、新規sessionが憲法・工場MCP・工場skillを自前面から読む。WSL2の席でWindows nativeを代替しない。製品または上流が正規入口を持たない面だけを`unsupported`にする。

Wave 1〜5がdotagentsで閉じる範囲。Wave 6は製品repoであり、本計画の完了条件に含めず導線だけ置く。

## 2. 現状（着手時点の事実）

- 工場のharness dirは`claude/` / `codex/` / `grok/`。`cursor/`はない。constitution generatorのHOSTSは3つ。`install.sh`はCursor面を張らない。
- このMacの`~/.cursor`に`mcp.json`・`hooks.json`・`skills/`・工場憲法のsymlinkはない。`skills-cursor/`はCursor内蔵で工場の所有対象外。
- この会話はCursor Desktop上でprojectの`AGENTS.md`を読んでいる。会話が成立することと工場グローバル面が届いていることは別である。
- Aiterm 0.28.0で`cursor-cli` harnessが公開済み。通常`~/.cursor`を共有し、独自homeを作らない（製品ADR 0038）。工場はこれを消費する。Aitermの`src/harnesses/`とOS層（`tmux-runtime` / `agent-resolver`）を工場側で再編しない。
- [harness用語統一campaign](plan_harness-terminology-refactor-20260824.md)がOS層を下、harness層を上とする一方向依存を工場標準にした。Cursor実対応はその非目標だった。wire互換field（`vendor_dependencies`等）は置換しない。

## 3. 裁定

1. **OSとharnessの分離を壊さない。** レイヤは[用語統一campaign](plan_harness-terminology-refactor-20260824.md)のまま: OS層が下、harness層がその上。harness adapterはOS抽象を使い、coreはharness interfaceだけに依存する。Cursorを足すときに新しい第3軸（「Desktop vs CLI」「IDE vs agent」をOSに混ぜる等）を作らない。
2. **既存3harnessの配置を組み替えない。** `claude/` / `codex/` / `grok/`、OS別setup 4入口、`lib/platform.mjs`、各製品の`os/`・`platform/`・`src/harnesses/`・`hosts/`を、Cursor追加のついでに再分割・改名・横断ifの畳込みをしない。Cursor固有は`cursor/`（dotagents）および各製品の既存harness置き場へ足す。
3. **製品は既存の足し方だけを使う。** Throughlineは`hosts/identity.mjs`＋`hosts/<host>.mjs`。Caveatは`claudeInstall.ts` / `codexHookInstall.ts`に並列するinstallファイルと`installShared.ts`。Spotterは`src/host/adapters.mjs`（OSは`src/platform/`のまま）。Latticeは`hooks --host`。peertableは用語統一campaignどおり、Cursorが必要になるまでadapter抽出せず局所分岐のまま。Aitermのcursor adapterは触らず消費する。
4. **終着はnative面。** Claude面を読むことをCursor親の正規契約にしない。projectの`AGENTS.md`はリポ正典として残す。
5. **一波一所有面。** 憲法、skill、MCP、hookを同じcommitで全部切らない。
6. **共通憲法は判断だけ。** Cursor固有のツール入口（native shell、MCP名、hook envelope）は`cursor/AGENTS.delta.md`へ置く。Claude/Codex/Grokの現行挙動は黙って変えない。
7. **個人MCPは移さない。** 工場6だけをCursor所有面へ足す。Gmail等は元の場所に残す。
8. **製品host化は工場harness面と混ぜない。** Throughline / Spotter / Caveat / LatticeのCursor adapterはWave 6。MCPで足りる製品はWave 3で閉じ、matrixは実測どおり書く。
9. **Plugins / marketplaceは非採用。** `~/.cursor/skills-cursor/`は触らない。
10. **親のmodel×effortは触らない。** `cli-config.json`のmodel、login、permissionを適用器が書き換えない。
11. **工場の4席は全部本線。** Cursor Desktopが無い席でも、Cursor Agent CLIと`~/.cursor`所有面が立つならその席は本線。上流が入口を持たない面だけ`unsupported`。
12. **工程正本は本Markdown。** Lattice planはオーナー指示があるまで作らない。
13. **Cursor Agent CLIを第4 toolchain IDにしない。** 公式installerと`agent update`はAiterm ADR 0038が正。工場のmanaged製品集合とwire v7キーは増やさない。
14. **公開wireの互換fieldを改名しない。** `vendor_dependencies`のv2化はこの戦役の対象外。

### 面ごとの所有

| 面 | Cursor所有 | 置き場の型 | やらないこと |
|---|---|---|---|
| 憲法 | `cursor/AGENTS.delta.md` → 生成`cursor/AGENTS.md` → Cursor nativeのグローバル規則面（Wave 1で実測して固定） | harness | User Rules UIへの手貼りを完成形にすること。`skills-cursor/`へ置くこと |
| Skills | `cursor/skills/` → `~/.cursor/skills` | harness | 内蔵skillの上書き |
| MCP | 工場分だけCursor MCP設定（候補は`~/.cursor/mcp.json`。Wave 3で実測） | harness。command絶対パス化など席差はOS setupが呼ぶ適用器 | 個人MCPの強制移管。Macで書いたjsonを他席HOMEへ転送 |
| Config | `apply-cursor-config`（dry-run / backup / `--apply`） | harness断片＋OS入口からの呼び出し | model・login・permissionの自動変更 |
| Hooks | `~/.cursor/hooks.json` と `~/.cursor/hooks/`（公式user hook面） | harness。Windowsのinterpreter前置はGrok同様OS適用器 | Claude hookの丸コピー、payloadのClaude形canonicalize |
| Subagents | Cursor nativeのagent面を実測してから | harness | bundled explore/planの置換 |
| Sessions | Throughline Cursor capture（製品repo） | 製品harness adapter | Wave 1〜5でcaptureを成功扱いすること |
| 製品connector | host matrixのCursor列 | 製品harness層 | Wave 5で全セルをrequiredにすること |
| OS配線 | 既存`setup-*-factory` 4入口が`install.sh` / `apply-cursor-config`を呼ぶだけ | OS | setupスクリプトへCursor envelope解釈や製品host enumを書くこと |

## 4. Wave

各waveは独立commit、focused gate、個別revertが可能な単位。

### Wave 0 — 正本（本commit）

- 本計画を`docs/`へ置く。
- [00_overview.md](00_overview.md)と[plan_factory-master.md](plan_factory-master.md)から導線を張る。
- 製品コード・install・configは触らない。

### Wave 1 — 憲法と配布の骨格

**F:** 4harness化（Claude / Codex / Grok / Cursor）。共通憲法の「3親」文言を4へ。Cursor固有ツール入口はdeltaへ。OS層と既存3harness dirは不変。
**A:** generator、`cursor/`、`install.sh`、`verify-install`、constitution test、layout/READMEの最小追記。グローバル規則の実マウント点はCursor native面を実測してから1つに固定する。
**H:** このMacで`install.sh`再実行のあと、新規Cursor sessionで憲法がCursor所有面だけから乗ること。

受入:

- `node bin/render-global-constitution.mjs --check`が4harnessで通る。
- `make test-constitution`が`cursor/`を含む。
- 隔離HOMEのinstallがCursor規則面とrunbookを本リポ向きsymlinkにする。
- 新規Cursor sessionのuser rulesにClaude delta固有条文が無い。人格（ベル）と共通原則は残る。
- Claude/Codex/Grok親の生成物と挙動は不変。
- `lib/platform.mjs`とOS別setup 4入口の責務分割が、Cursor追加で逆転しない。

### Wave 2 — skill / agent

**A:** `cursor/skills`（orchestrate / auto-deploy-on-push / polish-github / gpt-connector。入口はCursor appendix、契約は`shared/orchestrate`）、必要なら`cursor/agents`。
**F:** `~/.cursor/skills-cursor`を工場scan対象にしない。同名shadowは実測してから切る。

### Wave 3 — 工場MCP

**A:** `docs/08_cursor-fragments.md`と`apply-cursor-config`。工場6をCursor MCP設定へ冪等追加。
**H:** `--apply`。適用後に新規sessionでhandshakeを見る。
**F:** 失敗を登録成功へ丸めない。`cli-config.json`のmodelを触らない。

### Wave 4 — 工場hook

**A:** Cursor公式user hook面にdotagents所有hookだけを置く。読むのはCursor envelope。
**F:** 製品hook（Throughline / Spotter / Caveat）は工場hookに載せない。Claude/Codex/Grok経路は不変。

### Wave 5 — harnessとして閉じる

**F:** host matrixにCursor列を追加し、Wave 1〜4の実測を書く。
**A:** READMEランブック、4つのOS setup入口からの任意Cursor配線、`verify-install`のCursor面。
**H:** 置く席の新規Cursor session受入。Wave 6は別H。

### Wave 6 — 製品repo（本計画の外側、導線のみ）

着手は別Hだった。親面が無い状態で製品を正式host化しない。OS分岐は各製品の既存OS層、harness分岐は既存harness置き場へ足す。coreへCursorの`if`を散らさない。2026-08-24に実測して閉じた。

| 製品 | 既存の足し方 | 今の状態 |
|---|---|---|
| aiterm-mcp | `src/harnesses/cursor.ts`（OSはresolver/runtime） | 0.28+で完了。本戦役は消費するだけ |
| Throughline | `hosts/identity.mjs`＋`hosts/<host>.mjs`。OSは`src/os/` | 0.10.3公開。Cursor first-class host。npm / tag / このMacのglobal install済み。capture/handoffは新規session |
| Caveat | `claudeInstall.ts` / `codexHookInstall.ts`＋`installShared.ts` / `hookShared.ts` | 製品hook unsupported（Cursor install pathなし。Grok precedent）。MCPはWave 3 |
| Spotter | `src/host/adapters.mjs`。OSは`src/platform/` | unsupported（Cursor tool-dbなし。Grokと同様に正式hostを足さない） |
| Lattice | `lattice hooks --host` | `claude\|codex`のみ。Grok hostを増やさない裁定と同じく `--host cursor` は増やさない。工場ganttはdotagents所有 |
| peertable | 局所分岐のまま。必要になってから抽出 | 円卓は skill の HTTP API。工場MCPに room は持たない（Grokと同じ） |
| その他MCP製品 | 工場MCP登録で足りる | Wave 3 |
| ServerManager / MarkItDown | connector not_applicable またはCLIのみ | 列へ`not_applicable` |

## 5. 非目標

- 用語統一campaignの再オープン、`vendor_dependencies`のwire改名。
- 既存`claude/` `codex/` `grok/`の再分割。
- Cursor Agent CLIをmanaged toolchain IDにすること。
- ComposerをCursor harnessへ移すこと。
- gpt-connectorの多provider化。
- Cursor marketplace / pluginを工場の配布面にすること。
- 共通canonicalizerでCursor payloadをClaude形にすること。
- 製品が入口を持たない面を工場の非対応席へ読み替えること。
- Aiterm / Throughline / Caveat / Spotter / LatticeのOS層とharness層を「わかりやすく」再編すること。

## 6. 既知の罠

- `install.sh`は実ファイルをSKIPする。Cursor規則面が実ファイルだと正本化が静かに不成立。
- `~/.cursor/skills-cursor/`はCursor内蔵。工場skillをここに置かない。
- 既存Cursor sessionはconfig/hook変更を引き継がない。受入は新規sessionだけ。
- `apply-*-config --apply`は端末承認後。backupなしでMCP/hook設定を触らない。
- 席への手作業の展開は、その席のdotagentsで親AIを起動して正規入口を走らせる。Macで解決した絶対パスを転送して置かない。
- Cursor DesktopのGUI PATHとAgent CLIのPATHは別でありうる。Grok DesktopのGUI PATH欠落と同じクラス。適用器は席のPATHで解決し、未解決は名前のまま残してhandshakeをtyped失敗にする。
- Aitermは曖昧な`agent`名を解決しない。工場も`cursor-agent`だけを見る。

## 7. 検証

Wave内は変更に直結するfocusedだけ。関連gateはwave完了時に1回。`make ci`はWave 5の最終確認と、複数waveをまとめて閉じる時だけ。

| Wave | focused | 関連 | 人の目 |
|---|---|---|---|
| 1 | `make test-constitution`、install隔離HOMEのCursor規則面 | `make lint-constitution`、`make lint-md` | 新規Cursor sessionでClaude deltaが乗っていない |
| 2 | installのCursor skills、skill smoke | `make lint-skills` | skill列挙。`skills-cursor`を工場所有に数えない |
| 3 | apply-cursor-configのdry-run/backup/冪等test | `make test-install` | 新規sessionの工場MCP handshake |
| 4 | Cursor envelopeの負系fixture、既存3harness hook smoke不変 | `make lint-hooks` | 新規sessionでClaude hookが正規契約になっていない |
| 5 | verify-install Cursor面、setupの未導入通過 | `make ci` 1回 | 置く席の新規session |

Phase完了時の重い監査はWave 5のあと1回。検証者は親と異なるprovider。Wave 1〜4の完了候補は統括自身のdiff確認で閉じる。

## 8. F / A / H

- **F:** 4harness憲法、OS/harness分離の維持、共通→delta、host matrix Cursor列、工場4席は全部本線、工場MCPの失敗を丸めないこと。製品Cursor hostはWave 6。
- **A:** generator拡張、`cursor/`エントリ、install/verify、apply-cursor-config、Cursor appendix、hook adapter。
- **H:** 実HOMEの`install.sh` / `apply-cursor-config --apply` は済。Wave 6の製品repoは Throughline 0.10.3 まで完了。Macの工場MCPは apply 後の Desktop 別project で tool 列挙、空workspaceの `agent mcp list` で工場6が `ready`。Throughline は `cursor:` session を DB に書いた。残Hは新規 Desktop Agent チャットで憲法が `factory.mdc` から乗ることと、工場skillが `~/.cursor/skills` から列挙されること（Claude skill の併記は Cursor 互換読込であり切断しない）。

Wave 1〜5はdocs正本とdotagents実装で進める。Control RecordはGrok戦役と同じく作らない。事後に`init`しない。

## 9. 現在地

Wave 6 実測完了（2026-08-24）。Throughline 0.10.3 を公開し、このMacへ registry 由来で global install、`throughline install` が `~/.cursor/hooks.json` へ sessionStart / beforeSubmitPrompt / stop を upsert（工場 `cursor-*-hook` は残存）。公開commit `88982ca`、証跡commit `4bf84f5`、GitHub CI green（`88982ca` 5 checks / `4bf84f5` 2 checks）、npm shasum `e1afa30d616ce18a3013ad564c85edc894d9039b`、tag `v0.10.3`。Caveat製品hook・Spotter・Lattice `--host cursor` は理由付き unsupported。aiterm-mcp は消費のみ。peertable は HTTP API（room MCP なし）。host matrix Cursor親列と製品契約台帳を実測どおり更新。Control Recordは作らない。dotagents `ada08b1` のあと `make ci` green。

Mac live（2026-08-24）。`install.sh` のsymlinkは `~/.cursor/rules/factory.mdc` / skills 4 / agents 2 / runbooks。`apply-cursor-config` backup `20260824T032343Z` と `T033103Z`。apply 後の別project（`x-article-mcp`、metadata 12:28）で工場MCP 6が tool 列挙。空workspaceの `agent mcp list` は工場6すべて `ready`（caveat `list-tools` 6本）。このdotagents窓の `mcps/` は apply 前（11:46）の plugin だけ＝既存sessionは数えない。Throughline DB に `cursor:7face712-ef58-40d7-b71e-b71091dfee5c`。Cursor 3.17.8 は user skill として `~/.cursor/skills` に加え互換で `~/.claude/skills` も読む。CLI `agent` は未loginのため新規CLI sessionで憲法注入を測れず。残Hは新規 Desktop Agent チャットの `factory.mdc` と `~/.cursor/skills/orchestrate`。
