# 親hook・skill・agent・モデル選定の接続

[全体入口](../09_feature-map.md) / [hook図](harness-hooks.svg) / [原本](harness-hooks.mmd) / [skill図](skill-routing.svg) / [原本](skill-routing.mmd) / [設定適用と保存](configuration.md) / [モデル選定](model-selection.md)

基準main `9fca2c8`、候補`8eac4f2`からの本文確認。4frontend、共通gate、Cursor憲法hook、4applierのhook変換と配置、現存skill/agent/command/補助YAML、02モデル規範を対象とする。実sessionの発火や現在のharness仕様を検証した結果ではない。外部製品のhook/MCP内部と実OS・trustは未確認。

## 配置と登録

`install.sh`は各面のskill directory、agent/command file、binの入口をsymlinkする。Codex skillはofficialの`~/.agents/skills`かlegacyの`~/.codex/skills`の一方。Cursorの生成AGENTSはHOMEへ配らずfactory.mdcと同一本文overlayを置く。既実ファイルSKIP・退役linkだけの回収は[導入図](installation.md)の契約を保つ。配置成功はharnessが現在のsessionで読み込んだ証明ではない。

| 設定の所有 | 実関数・定義 | 配布/変換と保持 |
| --- | --- | --- |
| Claude | `apply-claude-config.sh:HOOKS/update` | PreToolUseのBashとPowerShellに同gateを登録、各5秒。commandを正規化し、特定退役hookだけ回収、未知の既存hookを保持 |
| Codex | `apply-codex-config.sh:update_hooks` | PreToolUse同期gate、5秒/async=false/statusMessage=null。既gateの最初の位置を保持して重複を除く。位置依存trustを新しく取得する処理ではない |
| Grok | `grok/hooks/factory.json`→`apply-grok-config.sh:propose_factory_hooks/apply_factory_hooks` | PreToolUse matcherはBash/run_terminal_command。sandbox用の実fileへ生成、Windows command変換。欠測面は作らない。config後hook失敗の部分保持は既設定図へ |
| Cursor | `cursor/hooks/factory.json`→`apply-cursor-config.sh:propose_hooks` | beforeShellExecutionにgate、sessionStart/beforeSubmitPrompt/preToolUseに憲法hook。工場所有commandだけ置換し他hookを保持、退役eventも回収 |
| command照合 | `lib/hook-command.py:hook_script/command_matches`と各applier固有parser | POSIX/Windows引用・interpreterを扱う既契約。v5診断のcanonical照合とは別実装・別受理条件。今回汎用化しない |

## 破壊操作gate

`bin/{git,codex-git,cursor-git,grok-git}-destroy-gate-hook.sh`はPython frontendで、実体pathから共通`lib/git-destroy-gate.py`をimportして`main(frontend)`を呼ぶ。拡張子をshell実装の証拠にしない。import例外は無出力で終わる。

| 段階・関数 | 入力と所有 | 拒否/不明/取消 |
| --- | --- | --- |
| `main/cursor_shell_command` | stdin JSON。Claude/Codexはsnake_case tool_name/tool_input、GrokはcamelCase、Cursorはevent固有command/cwdまたはpreToolUse | 未対応frontend/tool/event、空/不正JSON、off設定は無出力。親の入力を別親のenvelopeへ推測変換しない |
| `command_escape/shell_segments/git_tokens` | 親/OSに応じたescape、単純な複合command、RTK/proxy/git/-C/-cを認識 | 引用未完・未知形は検出しない。完全なshell interpreterや全破壊操作の検査ではない |
| `destroy_target/checkout_target/detected_targets` | checkout path、restore worktree、force clean、hard reset、stash drop/clearの対象を抽出 | stagedのみrestoreは対象外。未知形を拒否へ広げない |
| `has_changes` | git status --porcelain、cwdと-C/pathspec、2秒。読取だけでstateを書かない | git失敗/timeout/cwd不在はFalse。状態を観測できないこととcleanを区別して文書へ残すが、現コードの返却は無出力となる |
| `emit_deny` | 差分を確認した最初の対象で終了 | Claude/CodexはhookSpecificOutputのpermissionDecision=deny、Grokはdecision=deny、Cursorはpermission=denyと2message。終了codeだけを拒否契約としない |

gateはstash/patch保存を案内するが、退避・削除・rollback自体を実行しない。通常許可JSONやreceiptを保存しない。hookが中断された時の親側判断、未捕捉のshell形、実harnessのtimeout解釈はここから保証しない。今回の観測をsecurity修理例外へ広げていない。

## Cursor憲法の受渡しとstamp

`bin/cursor-constitution-hook.sh:main`は対象eventを選び、CURSOR_HOMEまたはHOMEのrules/factory.mdcを読む。frontmatterを外し、10000字以内なら本文、超過なら`compact_delivery`で案内・本文冒頭・Cursor deltaをcap内へ組む。stdoutのadditional_contextが返却先であり、モデルが全文を理解/正本をReadした証明ではない。

sessionStartはstampせず、beforeSubmitPrompt/preToolUseはsession/conversation IDをsafe名にした`factory-hook-state/constitution-delivered`のstampを確認する。既stampなら無出力、返却後にmkdir/writeを試みる。書込失敗は握り潰すので次回も配送し得る。stampは読了ACKや内容hashではない。欠測/空本文/不正入力は無出力、他の例外がすべてこのhookで捕捉されるわけではない。強制終了で出力後stamp未保存という部分状態もあり得る。

冒頭commentのDesktop版の説明は既実装の前提記録であり、今回live clientを再確認した事実ではない。sessionごとのworker snapshotや実画面反映は未確認。設定検査passと発火/注入完了を分ける。

## skill・agent・commandの正本と接点

現存面はClaude 3skill、Codex 5skill、Grok/Cursor各4skill。6agent、Claude 2command、Codex 2補助YAMLも確認。skill directory内の独自実行scriptはなく、定義文と補助YAMLから既runbook/公開toolへ渡す。機械inventoryのfile/hashは当席phase9-harness-files.jsonに固定し、実sessionの有効化数とはしない。

| 機能の正本 | 配布面・公開窓口 | 所有と停止点 |
| --- | --- | --- |
| auto-deploy-on-push | Claude skillが詳細、Claude commandが入口、他3面skillは親別の実行ゲート | 既範囲で調査→説明→変更→検証。SSH/鍵/Secrets/workflow/pushの例があるが、読み込んだだけで実行許可にならない。本番・Host境界は依頼が所有 |
| polish-github | Claude commandが詳細、Codex/Grok/Cursor skillはpointer | audit→選択/既GO→変更→公開面確認。正本不在を要約で代替しない。外部変異/公開は現在の依頼・既承認で判断 |
| gpt-connector | 4面skill→docs/06 pointer→製品正本 | 公開MCP routingだけ。Claude/Codex直接、Grok search_tool/use_tool、Cursor動的tool取得/呼出し。製品内部を複製しない |
| 1Password | 4面同一skill→shared/runbooks/1password.md | 現在は全skill loopの配置対象。用途description、公式CLI/MCP、未認証と利用可能の区別。skill配置と本体導入/登録/認証を同一視しない |
| Oracle | Codexだけの互換/rollback skill | 通常second opinionはgpt-connector。旧固定前提・手動rollback以外へ広げない |
| implementer/refuter | Claude/Grok/Cursorの親別agent定義 | 実装者の範囲/挙動不変/統括commit、反証者の読取専用を定義。Grok permission/prompt_mode、Claude runtime model/tool、Cursor native routingの差を保持 |
| Codex補助YAML | auto-deploy/polishのdisplay/default_prompt、polishのimplicit invocation設定 | 表示/呼出しのmetadataであり、認証や外部変更を実行するscriptではない |

1Passwordの任意性について、現在skillが既定配置される接点と「任意」と明記していない本文を現状として残す。setup/本体導入・全OS/第三者環境の監査完了ではない。任意化振舞い修理は全体リファクタ完了後の別差分。既選択の任意連携を外さない。

02_models.mdは役割・順位・諸元の正本で、pick-modelがそこから候補を作る。agent定義の親固有frontmatter、実選定JSON、実際のspawn/モデル適用は別段階である。廃止orchestrateのskill/bin/link回収もinstallに明記され、今回復帰させない。

## caller・fixture・設定・未確認

callerは4harness設定、config applier、install/verify、診断v5、手動CLI、hook/skill fixture。工場所有と製品所有hookを混在させない。source上の全literal候補をphase9-harness-contacts.txt、applier接点をphase9-applier-contacts.txtへ保存した。動的harness dispatch/外部callerの全利用は未確定。

既testの対応は`tests/hooks/{smoke,grok-smoke,cursor-smoke}.sh`、`tests/skills/smoke.sh`、`tests/install/{quoted-hook-command,codex-hook-dead-interpreter}.sh`、`tests/factory-scan/claude-hooks-windows.test.mjs`とapplier/install fixture。今回Grok smokeとskill smoke本文、他smokeの入口/関連部分を確認。全fixture意味確認/再走はしていない。変更は文書だけなので既122試験を反復しない。

既共通gateと薄いfrontend、親固有envelope、独立Cursor stateの所有は辿れるため、このまとまりで新しい共通層や修理を先行しない。必要な追加整理の採否は、残る全体接点を揃えたAstra設計で判断する。

未読は1Password setup詳細/第三者環境を含む3OS setup/scheduler/製品公開setup、GPTwriter/lease/authority、Caveat collector/evidence深部、旧v2/v4全診断、CI/配布の最終接点、全fixtureと実OS。最終Astra全体整合は別工程で残る。
