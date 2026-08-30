# Grok 親host 全対応

**状態:** Active（Wave 5 H受入済み。次はPhase監査）
**開始:** 2026-08-16
**工程正本:** 本ファイル（Lattice未適用。オーナーが指示した時だけ移管する）
**親導線:** [開発工場 統合マスター計画](plan_factory-master.md)
**レーン:** 統括（受入が多段、後続波は製品repo、compat切断に証跡が要る）
**終着:** B。Grok BuildをClaude Code / Codexと同格の工場親にする。Claude面への寄生を完成形にしない。

語彙を混ぜない。**親**はClaude / Codex / Grok。**席**はMac / Windows native / WSL2 / Linuxの4つで、全部本線。憲法generatorの3親と工場席を「3 host」と書かない。

Codex全対応の型を踏襲する。全対応はファイル数の左右対称ではなく**能力対称**である。製品固有機能は無理に移植せず、`対応 / 製品固有 / 非採用（理由）` のいずれかを明記できればその面は閉じる。

## 0. 目的

dotagentsを開いたGrok親が、Claude面を吸わずに工場原則・主要workflow・委譲品質・端末再現性を自前の面から得る。Grok Buildは基盤toolchainのままだが、親hostとしては憲法・配布・工場MCP・工場hook・親別connectorの所有者になる。

2026-08-14の`grok-factory-application`（GF01〜GF07）は到達性と害止めの証拠であり、正式親host化の受入ではない。`partial` / `unsupported` / `not_applicable`をgreenへ丸めない。

## 1. 完了条件

Grok親について次がすべて言える。

1. グローバル憲法は`shared/constitution.md`＋`grok/AGENTS.delta.md`から生成した`grok/AGENTS.md`だけを読む。`~/.claude/CLAUDE.md`（Claude delta付き）をuser ruleとして吸わない。
2. 工場skill / 工場agent / 工場runbookは`~/.grok/`へsymlinkされ、`verify-install`がそれを見る。
3. 工場MCP（caveat / lattice / aiterm / aishell / gpt_connector / codex-sidecar）は`~/.grok/config.toml`が所有する。handshake失敗を成功扱いしない。
4. 工場hookは`~/.grok/hooks`が所有し、Claude `settings.json`からの流入を切る。Grok envelope（camelCase）をClaude形へ変換しない。
5. [factory-host-product-matrix.md](factory-host-product-matrix.md)にGrok親列がある。各セルは実測どおり`required` / `optional` / `unsupported` / `not_applicable`だけを使う。
6. 工場の4席（Mac / Windows native / WSL2 / Linux）は全部本線。Grok親を置く席では、新規sessionが憲法・工場MCP・工場skillを自前面から読む。WSL2の席でWindows nativeを代替しない。製品または上流が正規入口を持たない面だけを`unsupported`にする。

Wave 1〜5がdotagentsで閉じる範囲。MacとFOX WSL2とFOX Windows nativeとLinux / main-serverのsession受入は着地済み。残Hは本計画の外側のWave 6。Wave 6は製品repoであり、本計画の完了条件に含めず導線だけ置く。

## 2. 現状（着手時点の事実）

- Grokは既定でClaude互換スキャナを全部ONにする。projectの`AGENTS.md` / `CLAUDE.md`、`~/.claude/CLAUDE.md`、`~/.claude/skills`、`~/.claude/settings.json` hook、`~/.claude.json` MCPを吸う。
- dotagentsに`grok/`ツリーはない。`install.sh`はClaude/Codexだけ。constitution generatorのhostは2つ。`~/.grok/skills`と`~/.grok/hooks`は空。`~/.grok/config.toml`の工場MCPはほぼ無い。
- 2026-08-14裁定: Spotter / Throughlineは正式Grok host化を棄却し、Claude hookへ流入したGrok envelopeを副作用前のunsupported no-opにした。Observerは同provider family専用でGrok面を持たない。
- 2026-08-16のGrok親sessionでもaiterm / lattice / aishell / gpt_connector / codex-sidecarはhandshake失敗だった。会話が成立することと工場が届いていることは別である。

## 3. 裁定

1. **終着はnative面。** Claude面を読むことをGrok親の正規契約にしない。compatは移行中の一時状態だけとし、所有面が立ったセルから切る。
2. **一波一所有面。** 憲法、skill、MCP、hookを同じcommitで全部切らない。切るのは、その面のGrok所有が`install`とfocused gateで証明された後だけ。
3. **共通憲法は判断だけ。** host固有のツール入口（aiterm PTYのMCP名、Claude Workflow/Agent matcher、Grok native terminal）は各deltaへ移す。Claude/Codexの現行挙動はdeltaへ移すだけであり、黙って変えない。
4. **個人MCPは移さない。** Gmail等はオーナーのClaude jsonに残してよい。`compat.claude.mcps`を工場MCPの所有のために全部は切らない。工場サーバはGrok tomlが正本で、同名がClaude jsonからも上がるならGrok側で工場名をdisableし二重起動しない。
5. **製品host化は親host化と分けないで混ぜない。** ThroughlineとSpotterのGrok対応はWave 6の製品repo作業である。ObserverのGrok familyは開かない。8/14のSpotter正式Grok host棄却は2026-08-16に撤回する。
6. **Pluginsは非採用。** 個人git＋symlink配布とmarketplaceを二重化しない。
7. **親のmodel×effortは触らない。** `apply-grok-config`は工場MCP、compatセル、工場hook entryだけを扱い、`[models]`とpermissionとloginを書き換えない。
8. **工場の4席は全部本線。** Mac / Windows native / WSL2 / Linux（main-server）を工場親の対象から外さない。製品対応は順次実測で上げる。製品または上流が正規入口を持たない面（AIShellの非macOS、Observerの非macOS、ServerManager runtimeの非main-serverなど）だけを`unsupported` / `not_applicable`にする。Grok BuildのWindows nativeは上流にPowerShell `install.ps1`があるので、導入matrixの`unsupported`を維持しない。WSL2の席でWindows nativeを代替しない。
9. **工程正本は本Markdown。** Lattice planはオーナー指示があるまで作らない。
10. **2026-08-16 製品判定。** Observerを工場コアから撤去する（製品repoの廃棄・改名はこの裁定の範囲外。工場管理対象からの除外）。Spotterはコアを維持し、正式Grok host化する。ThroughlineのGrok対応は必ず行う。Observer撤去はREADME「工場コア製品の変更管理」の削除手順に従う独立waveとし、Throughline／SpotterのGrok実装と混ぜない。

### 面ごとの所有

| 面 | Grok所有 | Claude面から切る時期 | やらないこと |
|---|---|---|---|
| 憲法 | `grok/AGENTS.delta.md` → 生成`grok/AGENTS.md` → `~/.grok/rules/AGENTS.md` | Wave 1。`compat.claude.agents=false` | リポの`AGENTS.md`/`CLAUDE.md`を隠すこと |
| Skills | `grok/skills/` → `~/.grok/skills` | Wave 2。`compat.claude.skills=false` | Codex `~/.agents/skills`の削除。同名はdiscovery優先を実測して影を防ぐ |
| Commands | 対応skillの明示invocation。必要なら`~/.grok/commands` | Wave 2 | Claude slashの模造 |
| MCP | 工場分だけ`~/.grok/config.toml` | Wave 3。工場名の二重起動だけ止める | 個人MCPの強制移管、`compat.claude.mcps`の全切断 |
| Config | `apply-grok-config`（dry-run / backup / `--apply`） | Wave 3 | model・login・permissionの自動変更 |
| Hooks | `~/.grok/hooks`。envelopeはGrok camelCaseのまま読む | Wave 4。`compat.claude.hooks=false` | Claude hookの丸コピー、payloadのClaude形canonicalize |
| Subagents | `grok/agents/` → `~/.grok/agents` | Wave 2 | bundled explore/planの置換 |
| Sessions | Throughline Grok capture（製品repo） | Wave 6 | Wave 1〜5でcaptureを成功扱いすること |
| Plugins | 非採用 | — | marketplaceを工場配布にすること |
| 製品connector | host matrixのGrok親列 | Wave 5で列を公開し、実測どおり書く | Spotter/ObserverをWave 5でrequiredに上げること |

## 4. Wave

各waveは独立commit、focused gate、個別revertが可能な単位。次のwaveのcompat切断は前のwaveの受入後だけ。

### Wave 0 — 正本（本commit）

- 本計画を`docs/`へ置く。
- [00_overview.md](00_overview.md)と[plan_factory-master.md](plan_factory-master.md)から導線を張る。
- 製品コード・install・configは触らない。

### Wave 1 — 憲法と配布の骨格

**F:** 3親化（Claude / Codex / Grok）。共通憲法の親固有ツール入口をdeltaへ移す。`compat.claude.agents`切断。
**A:** generator、`grok/`、`install.sh`、`verify-install`、constitution test、layout/READMEの最小追記。
**H:** このMacで`install.sh`再実行のあと、新規Grok sessionで憲法が`~/.grok/rules/AGENTS.md`だけから乗ること。

受入:

- `node bin/render-global-constitution.mjs --check`が3親（Claude / Codex / Grok）で通る。
- `make test-constitution`が`grok/`を含む。
- 隔離HOMEのinstallが`~/.grok/rules/AGENTS.md`と`~/.grok/runbooks`を本リポ向きsymlinkにする。
- 新規Grok sessionのuser rulesにClaude delta固有条文が無い。人格（ベル）と共通原則は残る。
- Claude/Codex親の生成物と挙動は、deltaへ移した条文を含めて不変。

### Wave 2 — skill / command / agent

**A:** `grok/skills`（orchestrate / auto-deploy-on-push / polish-github / gpt-connector。入口はGrok appendix、契約は`shared/orchestrate`）、`grok/agents`（implementer / refuter）。
**F:** `~/.agents/skills`との同名shadowを実測する。`~/.grok/skills`が同名に勝てば`compat.claude.skills`は切らない（peertable等のClaude専用skillを落とさない）。勝てない時だけ切断またはignoreを取る。

受入:

- Grokが工場skillを`~/.grok/skills`から列挙する。
- 同名のCodex skillがGrok appendixを影で消さない。消すならGrok側のdiscovery優先を変えるか、Codex面をGrokのscan対象から外す。推測で切らない。
- bundled skill（imagine等）は残す。工場skillで上書きしない。

### Wave 3 — 工場MCP

**A:** `docs/07_grok-fragments.md`と`apply-grok-config`。工場6サーバをstdioで`~/.grok/config.toml`へ冪等追加。
**H:** `--apply`。適用後に`grok mcp doctor`（または同等）で工場サーバの起動を見る。
**F:** 工場名がClaude jsonと二重ならGrok側でcompat由来をdisableする。個人サーバは残す。

受入:

- caveat / lattice / aiterm / aishell / gpt_connector / codex-sidecarがGrok toml由来で列挙される。
- このMacの新規sessionで工場MCPのhandshakeが`supported`か、失敗理由がtypedで残る。失敗を登録成功へ丸めない。
- `[models]`とpermissionとloginがapply前後で変わらない。

### Wave 4 — 工場hook

**A:** `~/.grok/hooks`にdotagents所有hookだけを置く。読むのはGrok camelCase。対象はgit-destroy-gate、delegation-gate、todo-gate、onset-gate、lattice-gantt、plan-gate、orchestrate-advisory。
**F:** `compat.claude.hooks=false`。Claude/Codex経路は不変。Spotter / Throughline / Caveatの製品hookはGrokで起動しない（8/14のno-opを維持）。

受入:

- Claude `settings.json`のhookがGrok sessionに現れない。
- 工場hookがGrok envelopeで副作用前に落ちない（GF01のSpotter exit 2 / Stop 8回継続を再発させない）。
- PreToolUse拒否とStop continuationの負系fixtureをdotagents側に置く。製品repoのGrok host enumは増やさない。

### Wave 5 — 親として閉じる

**F:** host matrixにGrok親列を追加し、Wave 1〜4の実測を書く。
**A:** READMEランブック、`setup-macos-factory` / `setup-wsl-factory` / `setup-windows-native-factory`の任意Grok配線、`verify-install`のGrok面。
**H:** MacとFOX WSL2とFOX Windows nativeとLinux / main-serverの新規Grok session受入は着地済み。Wave 6は別H。

受入:

- Grok親列の各セルに、requiredにする根拠の実測がある。根拠が無いセルは`unsupported`または`not_applicable`のまま残す。工場の席自体を対象外にしてセルを固定しない。
- 一撃展開はGrok未loginでも止まらない（toolchain optionalのまま）。login済みならWave 3の工場MCPを適用する。Windows nativeも同じ。

### Wave 6 — 製品repo（本計画の外側、導線のみ）

着手は別H。dotagents Wave 5の完了を製品着手の前提にしないが、親面が無い状態で製品を正式host化しない。

| 製品 | 内容 | 今の状態 |
|---|---|---|
| Throughline | Grok turnのcapture / restore / handoff | Mac capture・`handoff-context`・Grok `/tl`→`grok-continue`は閉じた（2026-08-17、源`01a00ff1`→後継`c01a2689`、Dotagents棚、初手待機）。ライブ窓へのstdout注入はhost非対応のまま。後継起動はmacOS Terminalのみ。npm 0.10.0。他席のhook captureは未了 |
| Observer | 工場コアから撤去 | 2026-08-16裁定。Grok familyは開かない。撤去は独立wave |
| Spotter | 正式Grok host | コア維持。8/14棄却を撤回。Wave 6で正式host化する |

## 5. 非目標

- Composerをlive catalog不在のまま使う、またはGrokへfallbackする。
- gpt-connectorの多provider化。
- Grok marketplace / pluginを工場の配布面にする。
- 共通canonicalizerでGrok payloadをClaude形にする。
- 製品が入口を持たない面（AIShell / Observerの非macOSなど）を工場の非対応席へ読み替えること。
- 8/14のGF07 12製品matrixを、本計画の完了前に書き換えない。

## 6. 既知の罠

- Grok Stopのexit 2は最大8回継続する。Claude hookを切る前に工場hookへ丸コピーするとGF01が再発する。
- `install.sh`は実ファイルをSKIPする。`~/.grok/rules/AGENTS.md`が実ファイルだと正本化が静かに不成立。
- Codex公式skill面`$HOME/.agents/skills`はGrokが`.agents`として別スキャンする。`compat.codex`はinertでもここは生きる。
- `apply-*-config --apply`は端末承認後。backupなしで`config.toml`を触らない。
- 既存Grok sessionはconfig/hook変更を引き継がない。受入は新規sessionだけ。
- Windows nativeの`apply-grok-config`は shebang 直起動を避けるため`~/.grok/hooks/factory.json`を実ファイル化する。`install.sh`は実ファイルをSKIPするので、正本`grok/hooks/factory.json`を直したあとはWindows面へ再applyする。symlinkのままに戻さない。
- 席への手作業の展開は、その席のdotagentsで親AIを起動して正規入口を走らせ、失敗はその席で直す。SSHは席へ入る経路。スクリプト単独の無人実行とsetupのexit 0を親受入にしない。Macで解決した絶対パス・`config.toml`・hookを転送して置かない。

## 7. 検証

Wave内は変更に直結するfocusedだけ。関連gateはwave完了時に1回。`make ci`はWave 5の最終確認と、複数waveをまとめて閉じる時だけ。

| Wave | focused | 関連 | 人の目 |
|---|---|---|---|
| 1 | `make test-constitution`、install隔離HOMEのGrok rules | `make lint-constitution`、`make lint-md` | 新規Grok sessionでClaude deltaが乗っていない |
| 2 | installのGrok skills/agents、skill smoke | `make lint-skills` | `/skills`相当の列挙 |
| 3 | apply-grok-configのdry-run/backup/冪等test | `make test-install` | `grok mcp doctor` |
| 4 | Grok envelopeの負系fixture、Claude/Codex hook smoke不変 | `make lint-hooks` | 新規sessionでClaude hookが無い |
| 5 | verify-install Grok面、setupの未login通過 | `make ci` 1回 | 4席の新規session |

Phase完了時の重い監査はWave 5のあと1回。検証者は親と異なるprovider（ClaudeまたはCodex）。Wave 1〜4の完了候補は統括自身のdiff確認で閉じる。

## 8. F / A / H

- **F:** 3親憲法（Claude / Codex / Grok）、共通→deltaの条文移動、compat切断、host matrix Grok親列、工場4席は全部本線、工場MCPの失敗を丸めないこと。Spotter正式Grok hostはWave 6。
- **A:** generator拡張、`grok/`エントリ、install/verify、apply-grok-config、Grok appendix、hook adapter。
- **H:** 実HOMEの`install.sh` / `apply-grok-config --apply` / 4席の新規session確認は2026-08-16に閉じた。残HはWave 6の製品repo着手と、未login席でのGrok login。

Wave 1〜5はdocs正本だけで進めた。Control Recordは作っていない。事後に`init`しない。

## 9. 現在地

オーナーH受入（2026-08-16）。Wave 5の4席人の目は閉じた。Phase監査（Claude opus×high、session `grok-wave5-phase-audit`）は条件付き。指摘1（`apply-grok-config`が`[mcp_servers.*.env]`を残してinline envを足しTOMLを壊す）は契約criticalで閉じ条件。指摘2（`test-observer-package`未記録）はmaintenance queueへ。指摘3（Control省略）は本戦役のまま事後initしない。指摘4（Windows hook非発火の直接証拠）は開示済みで今の必須作業にしない。このMacでWave 5閉じの`make ci`を回した。lint・constitution・hooks・`test-install`（setup-macos / wsl / linux 含む）はpass。Linux第4入口に合わせてcanon-migrationの受け側文言を追従し、隔離HOMEの`verify`がdarwinへ`wsl`を上書きしていたのを外した。`test-observer-package`はObserver diagnostics schemaで落ちた（Grok親Wave 5の範囲外）。Mac `01a0091e`、FOX WSL2 `01a00964`、Windows native 適用`01a0097e` / 受入`01a00999` / hook修正後`01a009d3`、Linux / main-server `01a00a9c`。工場の4席は全部本線。旧裁定8（Windows native対象外）は2026-08-16に破棄。製品未対応面は`unsupported`のまま残してよい。次はPhase監査（親と異なるprovider）。Wave 6は別H。

Wave 5 Mac受入を通し直し（2026-08-16 前session）。DesktopのGUI PATH（`/usr/bin:/bin:/usr/sbin:/sbin`）では工場MCPの名前解決と `env node` ができないのが、そのsessionの`connection failed`の原因。`apply-grok-config`は解決できたcommandを絶対パスで書き、親dirを`env.PATH`先頭に置く。実HOME再apply済み（`[models]` grok-4.6 / xhigh 不変。Stripeコメント保持）。GUI PATHの`grok mcp doctor`で工場6はhandshake OK。そのDesktop session自体のtool列挙は起動時handshakeのまま失敗（config変更を引き継がない）。inspect: 有効globalは`~/.grok/rules/AGENTS.md`、工場skill 4、工場hook enabled 9、Claude settings hook 22件disabled。`verify-install`のGrok面は通る。全体はMarkItDown / uv tool不在でFAIL（Grok範囲外）。`PATH=/opt/homebrew/bin:$PATH make ci`はpass（python 3.14）。FOX新規sessionは未実施。Windows nativeは当時の計画では対象外（2026-08-16裁定で破棄）。Wave 6は別H。

Wave 5 Mac新規session受入（2026-08-16 session `01a0091e`、このDesktop窓。前sessionの人の目は数えない）。起動時`mcp_init_completed`は total 14 / succeeded 7 / failed 6 / auth_required 1。工場6（caveat / lattice / aiterm / aishell / gpt_connector / codex-sidecar）は`~/.grok/config.toml`の絶対パスで`mcp_server_connected`、このsessionからtool call完了。失敗はtypedのまま残した: chrome-devtools `spawn_failed`（`npx`不在）、playwright / sprite-forge / relay-local / ipmcp-local / x-article `handshake_failed`、stripe `auth_required`。失敗を登録成功へ丸めていない。homebrew入りPATHの`grok mcp doctor`は工場6 healthyだが、同じ実行が chrome-devtools / playwright も healthy にしたので doctor成功をこのsession成功に読み替えない。user rulesのglobal有効は`~/.grok/rules/AGENTS.md`だけ（`~/.claude/Claude.md`はinspect disabled。projectの`Agents.md` / `Claude.md`はリポ正典として残る）。Claude delta固有のaiterm-mcp永続PTY既定は無い。人格（ベル）とGrok native shell既定は残る。工場skill 4は`~/.grok/skills`から列挙、bundled（imagine等）は残る。`compat.claude.skills` / `mcps`は切っていない。工場hook enabled 9は`~/.grok/hooks`、Claude settings/project hook 22件はvendor=claude disabled。このsessionの`events.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。FOX新規sessionは未実施。Windows nativeは当時の計画では対象外（2026-08-16裁定で破棄）。Wave 6は別H。

Wave 5 FOX WSL2新規session受入（2026-08-16 session `01a00964`、このFOX窓。前の人の目は数えない）。起動時`mcp_init_completed`は total 13 / succeeded 9 / failed 3 / auth_required 1。工場5（caveat / lattice / aiterm / gpt_connector / codex-sidecar）は`~/.grok/config.toml`のbare commandで`mcp_server_connected`、このsessionからtool call完了。aishellは`mcp_server_failed` `spawn_failed`（`aishell-mcp` No such file or directory。WSLはmatrixどおりunsupported）。`mcp_init_completed.failed_servers`はaishellを載せず ai-news / sprite-forge / vercel だけを書いたが、aishellを登録成功へ丸めていない。その他のtyped失敗: ai-news / sprite-forge `handshake_failed`、vercel `auth_required`。追加applyはしていない（不足はaishell不在だけ。bare名はFOXのPATHで5本解決）。`grok mcp doctor --json`は工場5 handshake OK・aishell `command not found`。doctor成功をこのsession成功に読み替えない。user rulesのglobal有効は`~/.grok/rules/AGENTS.md`だけ（`~/.claude/CLAUDE.md`はinspect vendor=claude disabled。projectの`AGENTS.md` / `CLAUDE.md`はリポ正典として残る）。Claude delta固有のaiterm-mcp永続PTY既定は無い。人格（ベル）とGrok native shell既定は残る。工場skill 4は`~/.grok/skills`から列挙、bundled（imagine等）は残る。`compat.claude.skills` / `mcps`は切っていない。工場hook enabled 9は`~/.grok/hooks`、Claude settings/project hook 30件はvendor=claude disabled。vercel plugin hook 1件はenabledのまま（settings.json由来ではない）。このsessionの`events.jsonl` / `sandbox-events.jsonl` / `logs/unified.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。Windows nativeは当時の計画では対象外（2026-08-16裁定で破棄）。Wave 6は別H。

Wave 5 FOX Windows native配線とlogin済みapply（2026-08-16 session `01a0097e`、このFOX Windows native窓。WSL2 HOMEは触っていない。前の人の目は数えない）。作業前のlocal mainは`1c064d57`で origin/main `0f16fa2` より20 commit遅れ、dirtyなし。fast-forwardしてから触った。`%USERPROFILE%\.grok\auth.json`は1728 bytes。`XAI_API_KEY`は未設定。適用前の`config.toml`に工場MCPも`[compat.claude]`も`[models]`も無かった。`install.sh --profile official`が`%USERPROFILE%\.grok\{rules,runbooks,skills,agents,hooks}`を本リポ向きsymlinkにした。login済みなので`apply-grok-config --apply`した（backup `~/Archives/dotagents-grok-config-20260816T074937Z.tar.gz`）。`[ui] permission_mode = always-approve`は不変。`[models]`は作っていない。2回目applyは変更なし。工場5 commandは`*.CMD`絶対パス、aishellは未解決のまま`aishell-mcp`。`env.PATH`は`;`区切りで npm bin / `Program Files\nodejs` / Windows GUI 基底。追加applyはしていない。

このsessionの起動時`mcp_init_completed`は適用前の値であり、受入に数えない。total 8 / succeeded 4 / failed 3 / auth_required 0。connectedはaiterm / lattice / gpt_connector / oracle。typed失敗はcodegraph `spawn_failed`、mothermcp `handshake_failed`、caveat `timeout` 65s、codex-sidecar `timeout` 65s。`failed_servers`はmothermcp / caveat / codex-sidecar。aishellはこのsessionの起動面に無い（登録成功へ丸めていない）。起動時targetはbare名またはClaude/cursor由来の`node.exe`経路で、`config.toml`ではなかった。適用後のreinitは起きていない。

適用後の`grok inspect --json`（discovery。この会話の起動時user rulesではない）: global有効は`%USERPROFILE%\.grok\rules\AGENTS.md`だけ。`%USERPROFILE%\.claude\Claude.md`はvendor=claude disabled。projectの`Agents.md` / `Claude.md`はリポ正典として残る。工場skill 4は`%USERPROFILE%\.grok\skills`、bundled（imagine等）は残る。`~/.agents/skills`のoracle / run-observer-parent-watchは残る（`compat.claude.skills`は切っていない）。工場hook 9は`%USERPROFILE%\.grok\hooks`。Claude-path hook 25件はinspect行にvendor=disabledが無い。`externalCompat`の`claude.agents` / `claude.hooks`はenabled=false source=config。工場6の`source.type`は`configToml`。`grok mcp doctor --json`は工場5 handshake OK、aishell `command not found`。doctor成功をこのsession成功に読み替えない。人格（ベル）とGrok native shell既定は`grok/AGENTS.md`に残る。Claude delta固有のaiterm-mcp永続PTY既定は`grok/AGENTS.md`に無い。このsessionの`events.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。全面`setup-windows-native-factory.ps1`（UAC・MarkItDown・15製品smoke）は回していない。Wave 6は別H。適用後の新規session受入は session `01a00999` で閉じた。

Wave 5 FOX Windows native新規session受入（2026-08-16 session `01a00999`、このFOX Windows native窓。WSL2 HOMEは触っていない。前の人の目は数えない）。作業前のlocal mainは origin/main `7b9fc507` と一致、dirtyなし。`USERPROFILE=C:\Users\kite_`、`OS=Windows_NT`、`WSL_DISTRO_NAME`なし。このsessionの`grok_home`は`C:\Users\kite_\.grok`。起動時`mcp_init_completed`は total 9 / succeeded 6 / failed 1 / auth_required 0。工場5（caveat / lattice / aiterm / gpt_connector / codex-sidecar）は`%USERPROFILE%\.grok\config.toml`の`*.CMD`絶対パスで`mcp_server_connected`、このsessionからtool call完了。aishellは`mcp_server_failed` `spawn_failed`（`aishell-mcp` program not found。Windowsはmatrixどおりunsupported）。`mcp_init_completed.failed_servers`はaishellを載せず mothermcp だけを書いたが、aishellを登録成功へ丸めていない。その他のtyped失敗: codegraph `spawn_failed`（cursor `.mcp.json`由来、`codegraph` program not found）、mothermcp `handshake_failed`（cursor由来）。追加applyはしていない。`grok mcp doctor --json`は工場5 handshake OK・aishell `command not found`。doctor成功をこのsession成功に読み替えない。user rulesのglobal有効は`%USERPROFILE%\.grok\rules\AGENTS.md`だけ（`%USERPROFILE%\.claude\Claude.md`はinspect vendor=claude disabled。projectの`Agents.md` / `Claude.md`はリポ正典として残る）。このsessionの`prompt_context.agents_md_files`も同じ3件。Claude delta固有のaiterm-mcp永続PTY既定は無い。人格（ベル）とGrok native shell既定は残る。工場skill 4は`%USERPROFILE%\.grok\skills`から列挙、bundled（imagine等）は残る。`compat.claude.skills` / `mcps`は切っていない。工場hook enabled 9は`%USERPROFILE%\.grok\hooks`、Claude-path hook 25件はinspect行にvendor=disabledが無い。`externalCompat`の`claude.agents` / `claude.hooks`はenabled=false source=config。工場6の`source.type`は`configToml`。このsessionの`events.jsonl` / `logs/unified.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。Wave 6は別H。残HはLinux / main-server。

Wave 5 FOX Windows native hook修正後新規session受入（2026-08-16 session `01a009d3`、このFOX Windows native窓。WSL2 HOMEは触っていない。前session `01a00999` の人の目は数えない。`01a00999` は hook修正 `9cca5e5f` 適用より前から生きていた）。作業前のlocal mainは origin/main `9cca5e5f` と一致、dirtyなし。`USERPROFILE=C:\Users\kite_`、`OS=Windows_NT`、`WSL_DISTRO_NAME`なし。このsessionの`grok_home`は`C:\Users\kite_\.grok`。`%USERPROFILE%\.grok\hooks\factory.json`はsymlinkではなく実ファイル（3001 bytes、2026-08-16 17:58:55）。工場hook 9のcommandは全部 `python.exe` または `"C:\Program Files\Git\bin\sh.exe"` 付き。Claude settings.json の工場所有hook（lattice-gantt-hook / todo-gate-hook / onset-gate-hook / git-destroy-gate-hook / delegation-gate-hook / orchestrate-advisory-hook / plan-gate-hook）も同じ形。POSIX正本 `grok/hooks/factory.json` は `${HOME}/.local/bin/grok-*` のまま。System32\bash.exe は使っていない。起動時`mcp_init_completed`は total 9 / succeeded 6 / failed 1 / auth_required 0。工場5（caveat / lattice / aiterm / gpt_connector / codex-sidecar）は`%USERPROFILE%\.grok\config.toml`の`*.CMD`絶対パスで`mcp_server_connected`、このsessionからtool call完了（`caveat_search`を含む）。aishellは`mcp_server_failed` `spawn_failed`（`aishell-mcp` program not found。Windowsはmatrixどおりunsupported）。`mcp_init_completed.failed_servers`はaishellを載せず mothermcp だけを書いたが、aishellを登録成功へ丸めていない。その他のtyped失敗: codegraph `spawn_failed`（cursor `.mcp.json`由来、`codegraph` program not found）、mothermcp `handshake_failed`（cursor由来）。追加applyはしていない。`grok mcp doctor --json`は工場5 handshake OK・aishell `command not found`。doctor成功をこのsession成功に読み替えない。user rulesのglobal有効は`%USERPROFILE%\.grok\rules\AGENTS.md`だけ（`%USERPROFILE%\.claude\Claude.md`はinspect vendor=claude disabled。projectの`Agents.md` / `Claude.md`はリポ正典として残る）。このsessionの`prompt_context.agents_md_files`も同じ3件。Sourcesは`shared/constitution.md` + `grok/AGENTS.delta.md`。Claude delta固有のaiterm-mcp永続PTY既定は無い。人格（ベル）とGrok native shell既定は残る。工場skill 4は`%USERPROFILE%\.grok\skills`から列挙、bundled（imagine等）は残る。`compat.claude.skills` / `mcps`は切っていない。`compat.claude.agents` / `hooks`はconfig.tomlでfalse。工場hook enabled 9は`%USERPROFILE%\.grok\hooks`、Claude-path hook 25件はinspect行にvendor=disabledが無い。`externalCompat`の`claude.agents` / `claude.hooks`はenabled=false source=config。工場6の`source.type`は`configToml`。このsessionの`events.jsonl` / `logs/unified.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。工場hookの実行記録も同じ2ファイルには無い（Grok 1.0.4のこのログ面はhook実行を書いていない）。オーナー実測: この新規sessionで「次のアプリで開きますか？」は出ていない。工場hookとClaude工場所有hookのcommandはinterpreter付きなので、`01a00999`で見えた shebang 直接起動の形ではない。throughlineはinspectにbare commandで残る（工場所有でない。PATH上に`throughline.cmd`がある）。発火記録は無い。丸めていない。Wave 6は別H。残HはLinux / main-server。

Wave 5 Linux / main-server新規session受入（2026-08-16 session `01a00a9c`、このLinux / main-server窓。FOX / WSL2 HOMEは触っていない。前session `01a00a75` の人の目は数えない。`01a00a75` は工場配線前で、起動時工場は4本だけだった）。作業前のlocal mainは origin/main `f2ce9de` と一致、dirtyなし。`uname`は`Linux ubuntu 7.0.0-29-generic`、`HOME=/home/kite`、`WSL_DISTRO_NAME`なし、`/proc/sys/fs/binfmt_misc/WSLInterop`なし。`command -v grok`は`/home/kite/.grok/bin/grok`。このsessionの`grok_home`は`/home/kite/.grok`。`~/.grok/auth.json`は1728 bytes。工場面はsession開始前から配線済み（`~/.grok/{rules,skills,hooks,agents}`のsymlinkと`runbooks`、`hooks/factory.json`→本リポ。時刻は21:29）。`install.sh --profile official`と`apply-grok-config --apply`は回していない。dry-runは各工場サーバへinline `env = { ... }`を足す表記差だけで、既存の`[mcp_servers.*.env]`と同じPATHであり機能不足ではない。全面`setup-linux-factory.sh`は回していない。起動時`mcp_config_resolved`は工場6（aishell / aiterm / caveat / codex-sidecar / gpt_connector / lattice）だけ。起動時`mcp_init_completed`は total 6 / succeeded 5 / failed 0 / auth_required 0。工場5（caveat / lattice / aiterm / gpt_connector / codex-sidecar）は`~/.grok/config.toml`の絶対パスで`mcp_server_connected`、このsessionからtool call完了（`caveat_search`を含む）。aishellは`mcp_server_failed` `spawn_failed`（`aishell-mcp` No such file or directory。Linuxはmatrixどおりunsupported。`command -v aishell-mcp`も不在）。`mcp_init_completed.failed`は0でaishellをfailed countに載せていないが、aishellを登録成功へ丸めていない。起動時eventsに工場以外のtyped失敗は無い。追加applyはしていない。`grok mcp doctor --json`は工場5 handshake OK・aishell `command not found`。doctor成功をこのsession成功に読み替えない。user rulesのglobal有効は`~/.grok/rules/AGENTS.md`だけ（`~/.claude/CLAUDE.md`はinspect vendor=claude disabled。projectの`AGENTS.md` / `CLAUDE.md`はリポ正典として残る）。このsessionの`prompt_context.agents_md_files`も同じ3件。Sourcesは`shared/constitution.md` + `grok/AGENTS.delta.md`。Claude delta固有のaiterm-mcp永続PTY既定は無い。人格（ベル）とGrok native shell既定は残る。工場skill 4は`~/.grok/skills`から列挙、bundled（imagine等）は残る。`~/.agents/skills`のoracle / run-observer-parent-watchは残る（`compat.claude.skills`は切っていない）。`compat.claude.skills` / `mcps`は切っていない。`compat.claude.agents` / `hooks`はconfig.tomlでfalse。工場hook enabled 9は`~/.grok/hooks`、POSIXの`${HOME}/.local/bin/grok-*`（shebangのまま。Windows interpreter前置なし）。Claude-path hook 22件はvendor=claude disabled。`externalCompat`の`claude.agents` / `claude.hooks`はenabled=false source=config。工場6の`source.type`は`configToml`。このsessionの`events.jsonl` / `logs/unified.jsonl`にthroughline / Spotter / Caveat製品hook / `lattice hooks emit --host claude`の実行記録は無い。throughlineはinspectのClaude-path hookとしてdisabledのまま残る。丸めていない。factory-host-product-matrixは書き換えていない。Wave 6は別H。

Wave 6 Throughline Grok hook capture 人の目（2026-08-17 session `01a00b2f-ef4a-76e1-9f20-ce7e8d0b0ca0`、このDesktop窓。前sessionの見た目は数えない）。Throughline origin/mainは`8ca1e5c`、dotagents origin/mainは`cdd8f5a`。`~/.grok/hooks/throughline.json`は存在し factory.json は未改変。このsessionの`updates.jsonl`に`global/throughline:session_start`と`user_prompt_submit`の発火があり、両方`exit code 127: sh: throughline: command not found`。`events.jsonl`にthroughline痕跡は無い。`~/.throughline/throughline.db`の`grok:`行は0件、このsession idのsessions/bodiesも無い。Grok側`chat_history.jsonl`にuser/assistantは存在するがThroughline L2ではない。Claude/Codexの既存sessionとsettingsは触っていない。npm未公開・restore/handoff実機・Spotter着手はしていない。成功条件（この新規sessionの`grok:`行とL2）は未達。次はinstallがCodex同様に絶対パスを書くことと、直したあとの新規session再受入。

Wave 6 Throughline Grok hook capture 人の目（2026-08-17 session `01a00b38-87ea-7670-8f7d-a9fe937263c5`、このDesktop窓。前sessionの見た目は数えない）。Throughline origin/mainは`a964e0a`。`global/throughline`のsession_start / user_prompt_submit / stopはsuccess。最新stopの`backfill.log`は`chat_history.jsonl`で`groups:4` `inserted_turns:4`。DBに`grok:01a00b38-87ea-7670-8f7d-a9fe937263c5`行とL2 user/assistant 4往復（8行）がある。成功条件は達した。Claude/Codexは触っていない。npm未公開。restore/handoff実機と他席、Spotterは未了。

Wave 6 Throughline Grok restore 実機（2026-08-17 session `01a00b38`、このDesktop窓）。`throughline handoff-context --session grok:01a00b38-87ea-7670-8f7d-a9fe937263c5 --json` は status ready、context 8730字でこの会話の L2 を含む。実装追加なし。`/tl` バトンは未書き。auto path は `grok:` を前任から除外する。hook handoff（`/tl`→新規 session 注入）と他席、Spotter は未了。

Wave 6 Throughline Grok `/tl` 判定修正（2026-08-17 session `01a00b38`）。live `/tl` は hook success だが baton 未書き。Grok は `<user_query>/tl</user_query>` で包む。判定を直した。再 `/tl` と `/new` 後の注入は未測。

Wave 6 Throughline Grok handoff注入をchat_historyへ（2026-08-17）。`01a00ce5-0169`はbaton消費とstdout 8600字まで成功したがGrokはUserPromptSubmit stdoutを無視。注入を`chat_history.jsonl`の最新`<user_query>`直前へ`synthetic_reason=throughline_handoff`行として書く。Claude stdoutは維持。live再測は未了。

Wave 6 Throughline Grok注入のsynthetic_reason修正（2026-08-17 session `01a00cf9`）。baton消費とchat_history行は成功したが、独自`throughline_handoff`理由をGrokがモデル文脈から外した。`system_reminder`へ直した。live再測は未了。

Wave 6 Throughline Grok live注入はhost非対応（2026-08-17 session `01a00cfe`）。baton消費・merge・chat_history L5のsystem_reminderは成功。updates.jsonlとprompt_contextと初回assistantに注入文は無い。Grokのライブ文脈はchat_historyを再読しない。UserPromptSubmitでモデルへ記憶を足す公式面は無い。

Wave 6 Throughline Grok `/tl` 後継起動 実機（2026-08-17）。ライブ注入の代わりに `throughline grok-continue --session grok:<id>` が源の `project_path` で Terminal 席を立てる。確認席 `01a00ff1`（Dotagents、`handoff-context` ready）の `/tl` が `c01a2689` を同じ棚に立て、初手末尾は待機、モデルは待って止まった。毒化源 `01a00b38`（`merged_into`、L2 0 件）では spawn しない。aiterm / `--rules` は使わない。Desktop Inactive は成功条件にしない。製品契約は Throughline ADR 0021 と `docs/plan_grok-successor-launch.md`。
