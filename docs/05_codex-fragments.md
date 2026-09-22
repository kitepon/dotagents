# 05_codex-fragments — Codex 端末設定（`~/.codex/config.toml` 等）の推奨断片カタログ

<!-- 前提: 2026-09-08 Astra移行指針を更新。版を明記したCodex実測は当時の記録。defaults の正は docs/02_models.md。本ファイルの体裁・構成は
     docs/03_settings-fragments.md（Claude Code settings.json の推奨断片カタログ）を踏襲する -->

`~/.codex/config.toml` と `~/.codex/hooks.json` は端末固有（コミットしない）。このファイルは「各端末で貼る断片」と限定適用器の正典である。routing 必須2キー、deprecated hook flag移行、PreToolUseのGit破壊操作ゲートと廃止hookの除去だけは [`../bin/apply-codex-config.sh`](../bin/apply-codex-config.sh) が安全に扱い、それ以外は手で判断する。スキーマの根拠は [公式 Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)・[公式Feature Flags](https://developers.openai.com/codex/config-basic#feature-flags)・[公式 Subagents 文書](https://learn.chatgpt.com/docs/agent-configuration/subagents)と、端末Codexの実効parser。端末バイナリと実セッションrolloutも突合し、未再現の主張には確度を明記する。

## 1. 親既定モデル×エフォート（オーナー領分・情報提供のみ）

**AI はピンを打ち替えない**。以下は事実の提示のみで、適用可否・タイミングはオーナー判断。

- 現在値の点検は各端末で `grep -E '^model|^model_reasoning_effort' ~/.codex/config.toml`（端末の現状値は共有文書に書かない＝端末メモリ側へ）。
- **ultra の事実**: ultra = 最大推論（max 相当）＋ proactive な自動マルチエージェント委譲 ON。使用量急増の公式警告（CLI 0.144.0 以降・並列スレッド数閾値。閾値の具体値はローカル裏取り不能＝確度: 中、前セッション由来）。
- **Codex CLI 0.147.0 の実効カタログ（`codex debug models`・2026-08-11 実測）**: `gpt-5.6-sol` の `default_reasoning_level` は **low**、`gpt-5.6-terra` と `gpt-5.6-luna` は **medium**。Sol/Terra は low〜ultra、Luna は low〜max を列挙する。
- **OpenAI公式のAstra移行指針**: `none`／`minimal`を使っていた場合は`low`から比較し、それ以外は現在の実効effortを維持する。Astraは`none`非対応。親の設定はオーナー領分のまま、移行を理由に一律`medium`へ変更しない。APIとCodexの対応段階は区別し、Codexでは実効catalogを確認する（[Astra移行手順](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart)、[取得時の根拠](../rag/models/gpt-6-astra.md)）。
- 推奨値の提示（適用はオーナー判断）: 親に一律のpresetは置かない。用途別の子配置は[順位表](02_models.md)を使う。proactive 自動委譲を意図せず踏みたくない場合は ultra を避ける。

## 2. 再ピン問題

TUI/アプリの `/model` 選択（モデルピッカー）は `config.toml` へ**永続書き込み**される仕様＝断片を一度適用しても、次に `/model` を触れば上書きされる。

- **点検**: `grep -E '^model|^model_reasoning_effort' ~/.codex/config.toml`
- **戻し手順**:
  1. バックアップ: `cp ~/.codex/config.toml ~/.codex/config.toml.bak-$(date +%Y%m%d)`
  2. 該当2行（`model = "..."` / `model_reasoning_effort = "..."`）を編集
  3. 妥当性確認: `codex exec 'echo ok'` が正常終了すること

## 3. ネイティブサブエージェントのモデル指定

[公式 Subagents 文書](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)どおり、
`~/.codex/agents/*.toml` は personal custom agent として自動探索される。
dotagentsは固定roleを配布しない。モデルとeffortは[順位表](02_models.md)から任務に応じて選び、
`spawn_agent`の`model`と`reasoning_effort`へ直接指定する。役割・作業範囲は依頼文に書く。

ただし GPT-5.6 Sol/Terra が選ぶ MultiAgent V2 には、role 定義の探索とは別の入口バグがある。
Codex 0.144.1 の実装では `hide_spawn_agent_metadata` の既定値が `true` で、単なる表示抑制ではなく
`spawn_agent` schema から `agent_type / model / reasoning_effort / service_tier` の4入力を削除する。
その状態の `task_name` は `/root/...` のタスクパス名を作るだけで、同名 custom agent を選ばない＝子は`agent_role = null`で親のmodel×effortを黙って継承する（実被弾の記録はrag/codex参照）。

全端末で以下を必須適用する。`tool_namespace = "agents"` は、拡張した schema を既定の
`collaboration` namespace に置いた時に backend の reserved-schema 検証で 400 になる組み合わせを避ける。

```toml
[features.multi_agent_v2]
hide_spawn_agent_metadata = false
tool_namespace = "agents"
```

注意:

- 既存セッションの tool schema は変わらない。適用後は**必ず新規セッション**で確認する。
- `features list` が `multi_agent_v2 = false` を表示しても、Sol/Terra のモデルカタログ指定が V2 を選ぶため、上記断片は必要。
- `fork_turns` の V2 既定は `all`。model／reasoning_effortを指定する時は`fork_turns="none"`を明示する。
- `task_name`はタスク名であり、モデルや役割の選択には使わない。
- 任務はspawn時に直接渡す。固定roleとの一致検査や事前routing smokeは要求しない。
- 実効sandboxは親のpermission profileを継承する。読み取り専用などの作業範囲は依頼文で明示する。

グローバル `[agents]` の `max_threads` / `max_depth` は公開設定で、公式既定はそれぞれ `6` / `1`。
通常は既定で足りるため明示しないが、必要なら user config または信頼済みproject configで設定できる。
ただしDesktop／実行サービスがより低いconcurrency slotsをセッションへ割り当てた場合、設定を上げても
そのホスト側上限は越えない。変更後は新規セッションで実効spawn数を確認する。
委譲モード（proactive / explicit-request-only 相当）の独立キーもなく、実効 mode は model/effort 側から
決まる。`agents.max_threads` と `features.multi_agent_v2.max_concurrent_threads_per_session` を混同しない。

根拠: [OpenAI公式 Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、
実測・訂正記録は [`rag/codex/subagent-thread-limits.md`](../rag/codex/subagent-thread-limits.md)。

実装根拠: [`MultiAgentV2Config` の hidden 既定](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/core/src/config/mod.rs)、[`spawn_agent` schema から4入力を除く処理](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)、[role 適用後に親 permission profile を再適用する処理](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/core/src/tools/handlers/multi_agents_common.rs)。上流既報は [#31814](https://github.com/openai/codex/issues/31814)（hidden routing）・[#20077](https://github.com/openai/codex/issues/20077)（full-history 既定）。

## 3b. gpt-connector MCP（ChatGPT接続・工場コア全端末必須）

ChatGPTの第二意見をCodex親へ接続する工場entryは、server ID `gpt_connector`、command `gpt-connector-mcp`である。MCP登録は限定applierの対象外で、対象hostの製品公開入口`gpt-connector setup`へ委譲する。工場境界は[接続pointer](06_gpt-connector.md)、製品の利用・診断・復旧は[gpt-connectorの正本](https://github.com/kitepon/gpt-connector#readme)に従う。

## 4. `project_doc_fallback_filenames = ["CLAUDE.md"]`（任意・副作用明記）

CLAUDE.md しか無いリポ（このリポ含む）に指示を届かせるための設定。`project_doc_fallback_filenames` と `project_doc_max_bytes` は config.toml のキーとして実在確認済み（実装文字列に両キー名が連続して実在）。

副作用3点:

1. **Codex は `@import` を展開しない**（生テキスト注入）。CLAUDE.md 側で `@AGENTS.md` のような import 構文を書いていても、Codex はそれを解決せずそのまま読む。
2. **グローバル `~/.codex/` には効かない**。グローバル指示の候補は `AGENTS.override.md` → `AGENTS.md` の順で最初に見つかった非空1ファイル固定（実装文字列で `AGENTS.override.md` の直後に `AGENTS.md` が続く並びを確認・`core/src/agents_md.rs` 由来）。`project_doc_fallback_filenames` はプロジェクト側の doc 探索にのみ効く。
3. **連結全体で `project_doc_max_bytes` を分け合う**。実装に `project doc exceeds remaining budget; truncating`（`remaining_bytes` フィールドあり）という切り詰めメッセージが実在＝複数ファイルを跨いだ合算予算方式であることを確認。デフォルト値の具体的なバイト数（前セッション由来の情報では 65536）は今回の再検証では裏取りできず（strings 探索で拾えたのは無関係な SQLite 定数）＝**確度: 低、要再確認**。

## 5. `AGENTS.override.md` の無言シャドー（地雷警告）

`AGENTS.override.md`（非空）が存在すると、上記2の候補順により `AGENTS.md` は**無言でシャドー**される（エラーにならない）。dotagents の `verify-install.sh` はこれを名指しで検出する設計（`docs/archive/plan_gpt56-rewiring.md` 完了記録）。

## 6. プロファイル例（任意）

`--profile <name>` は 0.134+ で別ファイル方式に変更済み。実装文字列に「`profile` is a legacy config selector and can no longer be written; use `--profile <name>` with `<name>.config.toml` instead」「Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config」を確認——単一 `config.toml` 内の `profile = "..."` / `[profiles.xxx]` はもう書き込めないレガシー扱いで、`~/.codex/<name>.config.toml` を作りベース設定の上にレイヤーする方式が現行仕様。

```bash
# 例: 実装物量用プロファイル
cp ~/.codex/config.toml ~/.codex/work.config.toml
# work.config.toml 側で model/model_reasoning_effort だけ上書き
codex --profile work
```

用途別切替＝オーナーの手動運用を楽にする道具（AI は作成を強制しない）。

## 7. 限定 config applier

通常の正規入口は `apply-codex-config` である。既定は dry-run で、実端末には一切書かない。

```bash
./bin/apply-codex-config.sh --dry-run
```

差分は次の **9項目だけ**。model / effort / permissions / OAuth / trust / MCP / 既存他ツールの hook は対象外で、触れない。

| 対象 | 許可する変更 |
|---|---|
| `config.toml` | `[features.multi_agent_v2]` の `hide_spawn_agent_metadata = false` と `tool_namespace = "agents"`。旧`[features].codex_hooks`があれば現行`hooks`へ移行し、両方あれば現行値を保持して旧キーだけ除去 |
| `hooks.json` | PreToolUseの`codex-git-destroy-gate-hook`を1件のcanonical entryに正規化し、廃止したdotagents hook（callout・orchestrate advisory・Lattice工程表案内）の登録を取り除く |

`--apply` は端末設定を書き換えるので、dry-run の差分を確認し、対象端末への適用承認を得てからだけ実行する。

```bash
./bin/apply-codex-config.sh --apply
./bin/verify-install.sh --profile official
```

安全契約:

- 既存・提案後の TOML は Codex CLI 自身の parser で検証する。不正なら fail-loud で書き込まない。
- lifecycle hookの現行flagは`[features].hooks`。`codex_hooks`はdeprecated警告を出すため限定applierが除去し、hook機能を無効化するfallbackには使わない。
- `config.toml` / `hooks.json` が symlink なら所有境界を壊さないため fail-loud にする。
- inline comment と他 section / 他 hook は保持する。dotagents 自身のGit破壊操作ゲートだけを、絶対パス・`type: command`・`timeout: 5`・`async: false`・`statusMessage: null` の1件に畳む。
- 変更がある時だけ `~/Archives/dotagents-codex-config-*.tar.gz` に backup を作る。directory は `0700`、archive と member は `0600`。`CODEX_HOME` が HOME 外でも archive 内は安全な相対名にする。
- 2ファイルは temp へ先に prepare / fsync してから置換し、途中失敗なら既に置換した側も original へ rollback する。rollback 自体が失敗した場合は明示エラーで止まる。
- `CODEX_HOME` は test や別 home 用に指定できる。実端末の通常値は `$HOME/.codex`。

同じ状態へ2回適用しても変更も backup も増えない。hook trust の対話Codex CLI `/hooks`承認、OAuth login、MCP の登録はこの script の責務外である。Codex App／IDEへ`/hooks`を送ってもtrust入口にはならない（[ADR 0104](adr/0104-cf0216-hook-trust-surface-correction.md)）。

## 8. 旧 `~/.codex/AGENTS.md` の退避・置換手順

1. **実ファイルか symlink か確認**: `ls -la ~/.codex/AGENTS.md`（symlink なら dotagents の `codex/AGENTS.md` を指しているはずで対応不要）。
2. 実ファイルなら中身を読み、**価値ある共通行は**`shared/constitution.md`、Codexの配置・配線に関する行は`docs/02_models.md`／本書へPRする（この判断はオーナー確認を要する＝勝手に統合しない）。deltaは空（見出しのみ）が既定で、本当にhost固有の規範だけ`codex/AGENTS.delta.md`へ。`codex/AGENTS.md`は生成物なので直接編集しない。
3. tar 退避してから削除: `tar czf ~/.codex/AGENTS.md.bak-$(date +%Y%m%d).tar.gz -C ~/.codex AGENTS.md && rm ~/.codex/AGENTS.md`
4. `./install.sh --profile official` を再実行し、symlink が張られることを確認: `readlink ~/.codex/AGENTS.md` が dotagents の `codex/AGENTS.md` を指すこと。

## 9. hooks.json のdotagents hook

dotagentsがCodexへ配るhookはGit破壊操作ゲートだけとする。配線は section 7 の `apply-codex-config` だけを使う。command は、展開済み絶対pathのscriptを明示interpreterで起動する（POSIXは`/usr/bin/env python3 $HOME/.local/bin/<hook>`）。`~/.codex/hooks.json` は共有 append ファイルであり、hook trust は applier が変更しない。適用後に対話Codex CLIの`/hooks`でtrustを承認する。

### Git破壊操作ゲート（PreToolUse）

`codex-git-destroy-gate-hook`をPreToolUseへ1件だけ追加する。shell系toolの`command`から`checkout -- <pathspec>`／`checkout .`、worktreeを戻す`restore`、`clean -f`系、`reset --hard`、`stash drop`／`clear`だけを保守的に検知する。対象pathspec（不明時はworktree全体）に未commit差分がある時だけ`P12_UNCOMMITTED_DESTROY`でdenyする。branch切替checkout、`restore --staged`だけ、clean・非git・status失敗はallowする。退避には`stash push`またはdiffのpatch保存を使う。`DOTAGENTS_GIT_DESTROY_GATE=off`で無効化できる。同一 script の死んだ interpreter（存在しない Python313 等）は同一 entry として畳み、PreToolUse を毎回 code 1 にしない。

### Spotter Codex hook（工場コア・Spotter所有）

対象projectで `spotter install -y` を実行する。生成entry、発火条件、診断、導入後確認は[Spotter README「Install」](https://github.com/kitepon/Spotter#install)を正とする。dotagentsの `apply-codex-config` はSpotter所有entryを保持し、再実装・削除・trust変更をしない。

## 10. MCP の親別 matrix と登録 / 疎通

MCP は親に応じて入口を分ける。Codex親はnative枠だけを工場全体の上限にせず、外部実行レーンで入れ子CodexとGrok/Composerを併用する。

| 親 | core | 任意 / 認証依存 | 禁止 / 非採用 |
|---|---|---|---|
| Claude Code | `codex-sidecar`、`aiterm`、`gpt_connector`、`caveat`、`lattice`、`aishell`（Apple Silicon / macOS 15+） | OpenAI Docs等の認証依存追加面 | 非対応hostのAIShell登録 |
| Codex | native subagents、`codex-sidecar`、`aiterm`（Codex / Grok / Composer）、`gpt_connector`、`caveat`、`lattice`、`aishell`（Apple Silicon / macOS 15+） | OpenAI Docs等の認証依存追加面 | 非対応hostのAIShell登録 |

利用可能性はinstalled（CLI存在）→registered（親へconnector登録）→verified（read-only疎通）→execution-verified（実タスク完遂と回収）で区別する。外部writerに使うのはexecution-verifiedだけ。timeoutは状態不明として同じtask IDのsession/jobを回収し、稼働中の重複起動をしない。

登録前は read-only に現在値を確認する。

```bash
codex mcp list --json
codex mcp get caveat --json
```

未登録の STDIO server を追加する操作は端末 config を書き換えるため H を要する。承認後だけ、必要なものを1件ずつ登録して直後に `list` / `get` で確認する。

```bash
codex mcp add caveat -- caveat mcp-server
codex mcp add lattice -- lattice-mcp
codex mcp add aiterm -- aiterm-mcp
codex mcp add codex-sidecar -- codex-sidecar-mcp
codex mcp add gpt_connector -- gpt-connector-mcp
codex mcp add aishell --env AISHELL_CAPABILITY_SET=expanded-v1 -- aishell-mcp
```

STDIO の environment は closed-mode として扱う。親 shell の値が必要だと推測して継承に頼らず、`mcp_servers.<id>.env` / `env_vars` に必要最小限を明示する。secret をコマンド行・repo・会話ログに書かない。OAuth は `codex mcp login <name>` を対話 H の下で行い、未認証の任意 MCP は理由付き WARN とする。

疎通は書込みを伴わない最小操作で確認する。`caveat_search`、OpenAI Docs検索、`aiterm`のsession listはread-only。コード構造面は`lattice-mcp`だけを使い、indexが無ければtyped guidanceに従う。独立Codegraphをfallback起動しない。AIShellは対話登録と工場疎通で入口を分ける——対話hostは`AISHELL_CAPABILITY_SET=expanded-v1`の高密度面へ登録し、工場疎通は`AISHELL_TOOL_PROFILE=factory`でだけ見える`factory_diagnostics`でschema `aishell.native_factory_diagnostics.v1`、product version、privacy 4項目falseを確認する。pathを返す`runtime_status`を工場疎通の代用にしない。gpt-connectorの`sessions`はread-onlyだが、Chat送信は依頼に必要な時だけ行う。Oracleは互換・rollback時だけ参照する。
