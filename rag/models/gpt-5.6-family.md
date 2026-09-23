<!--
source: https://developers.openai.com/api/docs/models/gpt-5.6-sol ／
        https://developers.openai.com/api/docs/models/gpt-5.6-terra ／
        https://developers.openai.com/api/docs/models/gpt-5.6-luna ／
        https://developers.openai.com/api/docs/guides/latest-model ／
        https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/ ／
        openai/codex リポ models.json・latest-model.md（一次・2026-07-10 取得、前セッション調査）／
        upgrading-to-gpt-5p6-sol.md（一次・effort 公式指針）／
        core/src/client.rs（Ultra→Max マッピング）・session/multi_agents.rs（Ultra→Proactive）／
        本セッションでの再検証: ~/.codex/models_cache.json（端末実測・fetched_at 2026-07-10T15:37:32Z）・
        codex-darwin-arm64 バイナリの strings 実読（agent_roles.rs 由来のバリデーションメッセージ・
        AgentRoleToml 構造）
audit_by: ベル配下 implementer（作業委譲・2026-07-11）
fetched: 2026-07-10（前セッション一次取得）／2026-07-11（実装再検証）／2026-08-11（Codex 0.147.0 実測）／2026-08-14（公式Web再取得）
confidence: 高（GA・価格は公式Web、effort 段階は端末実測）〜中（ultra の内部委譲メカニズムは
  前セッション由来で今回未再実行）。claim ごとに below 明記。
-->

# GPT-5.6 ファミリー（Sol / Terra / Luna）

## ティア体系

番号（`5.6`）は世代、`Sol`/`Terra`/`Luna` は世代をまたぐ能力ティア。

| slug | 位置づけ | 価格（per Mtok, in/out） |
|---|---|---|
| `gpt-5.6-sol` | 旗艦（frontier agentic coding model） | $5 / $30 |
| `gpt-5.6-terra` | 中位（balanced・everyday work 向け） | **$2 / $12** |
| `gpt-5.6-luna` | 軽量（fast and affordable） | **$0.20 / $1.20** |

2026-08-14にOpenAIの各model pageを直接再取得し、Sol $5/$30、Terra $2/$12、Luna $0.20/$1.20を確認した。検索indexには旧価格（Terra $2.5/$15、Luna $1/$6）のsnippetが残るため、検索結果の要約ではなく開いた現行model pageを正とする。

`gpt-5.6` は `gpt-5.6-sol` へ route される（2026-08-11 の OpenAI 公式 model page と model guidance で確認）。

GA: 2026-07-09。現行API model pageは3tierとも1,050,000 context、128,000 max output、knowledge cutoff 2026-02-16を掲示する。Codex CLIの実効contextは製品側catalogを別途確認する。

## Effort（reasoning level）

APIとCodex CLIの語彙を分ける。

| 面 | 既定 effort | 対応 effort 段階 |
|---|---|---|
| OpenAI API（3tier共通） | **medium** | none / low / medium / high / xhigh / max |
| Codex CLI 0.147.0 `gpt-5.6-sol` | **low**（当時のlive catalog実測） | low / medium / high / xhigh / max / ultra |
| Codex CLI 0.147.0 `gpt-5.6-terra` | **medium** | low / medium / high / xhigh / max / ultra |
| Codex CLI 0.147.0 `gpt-5.6-luna` | **medium** | low / medium / high / xhigh / max（ultraなし） |

API公式はmediumを均衡点とする一方、Codex製品catalogは別の既定や`ultra`を持ちうる。子の実行は継承に依存せずmodel/effortを明示する。

公式指針（一次: OpenAI Model guidance）:

- `medium` を均衡点、`low` を latency 重視の起点にする。
- `high` / `xhigh` は追加 reasoning が測定可能な品質差を出す時に使う。
- `max` は最難関の品質優先 workload 向けで、`xhigh` と代表タスク上の品質・latency・cost を比較する。
- `gpt-5.6-luna` はcost-sensitive / high-volume workload向け。

**dotagents実測（一般化禁止）**: オーナーの実taskではLuna medium以下の成果がほぼ監査を通らず、再監査・手戻りの総費用が増えた。この観測から、dotagentsでLunaを使う場合はmaxだけとし、maxが過剰な軽作業はLunaのeffortを下げず別modelへ置く。これはOpenAI公式の個別推奨でも客観的な全task性能でもなく、ローカル実測に基づく運用判断である。

## ultra の正体

`ultra`はAPIの`reasoning.effort`ではなくCodex harness側のmodeである。**ultra = max推論＋proactiveマルチエージェント自動委譲ON**（一次: `core/src/client.rs`のUltra→Max、`session/multi_agents.rs`のUltra→Proactive。前セッション調査・今回未再実行、確度中）。

- `~/.codex/models_cache.json` の `gpt-5.6-sol`/`gpt-5.6-terra` の effort 説明文でも "Maximum reasoning with automatic task delegation" と ultra を明記（本セッション実測で裏付け）。
- 高並列時の使用量急増につき公式警告あり（CLI v0.144.0 で導入。閾値「8スレッド」は前セッション由来で本セッション裏取り不能＝**確度: 低〜中**）。
- ultra は CLI 0.144.0+ 必須（この端末は 0.144.1・本セッション実測で確認）。

## ネイティブサブエージェント（`~/.codex/agents/<name>.toml` / `.codex/agents/`）

**本セッションで codex-darwin-arm64 バイナリ（0.144.1）に `strings -a` を当てて実装文字列から直接裏取り**（一次: `agent_roles.rs` 由来のバリデーションメッセージ群）:

- 実際のエラー文言列（`PATH`/`ROLE` は可変部分のプレースホルダー）: 「agent role file at PATH must contain a TOML table」→「agent role file at PATH must define a non-empty `name`」→「agent role ROLE must define a description」→「agent role file at PATH must define `developer_instructions`」→「PATH.developer_instructions cannot be blank」。
- つまり **`name`・`description`・`developer_instructions` の3つが必須**（`name` と `developer_instructions` は非空必須、`description` は非空チェック文言は確認できず存在必須のみ確度中）。欠落・綴りミスは「Ignoring malformed agent role definition:」という warning ログのみで無言無効化（実装文字列に完全一致するログ文言を確認）。
- キー: `name` / `description` / `model` / `model_reasoning_effort` / `sandbox_mode` / `developer_instructions`。加えて構造体 `AgentRoleToml` には `config_file` と `nickname_candidates` という追加フィールドが実在（`nickname_candidates` は「ASCII 文字・数字・空白・ハイフン・アンダースコアのみ」「重複禁止」という制約バリデーション文言あり。任意フィールドと推定・本カタログの3ファイルでは未使用）。
- `sandbox_mode` の有効値は実装文字列で `read-only` / `workspace-write` / `danger-full-access` の3種を確認。
- 公式 Subagents 文書は `~/.codex/agents/*.toml` の自動探索を明記する。個別 `[agents.<name>]` 登録はこのリポの3 role には不要。
- **MultiAgent V2 の入口事故（2026-07-11 実測）**: 0.144.1 の `MultiAgentV2Config` は `hide_spawn_agent_metadata = true` が既定で、`spawn_agent` schema から `agent_type / model / reasoning_effort / service_tier` を削除する。`task_name` はタスクパス生成専用で role 解決しない。3子で `agent_role = null`、親 Sol×xhigh 継承を確認。必須対処は `[features.multi_agent_v2] hide_spawn_agent_metadata=false`＋`tool_namespace="agents"`、新規セッション、`agent_type=<role>` 明示。
- V2 の `fork_turns` 既定は `all` → full-history fork。role/model/effort override と併用すると `reject_full_fork_spawn_overrides` が拒否するため、custom role は `fork_turns="none"` が必須。
- **sandbox の親継承（0.144.1 source＋0.147.0 rollout 実測、確度: 高）**: `apply_role_to_config` の後に親 turn の permission profile が再適用される。2026-08-14には同じrefuterがmacOSで`danger-full-access`、WSL2で`workspace-write`を継承した。role別の強制境界としては使えないため、工場role TOMLから`sandbox_mode`を外し、refuter / sorterの書込み禁止は行動契約へ置く。
- 現行 spawn 応答は実効 role/model/effort/sandbox を返さない。Control配下の書込みWorkerだけは`verify-codex-agent-routing`でrolloutの`session_meta` / `turn_context` / developer messageを照合し、role/model/effort/developer instructionsの不一致なら本作業を渡さない。sandboxは親継承の観測値として表示する。通常のnative audit / refuter / sorterは事前smokeを要求しない。
- `[agents]` の委譲モードキーは config.toml 側に不在（effort から自動導出。詳細は [[../../docs/05_codex-fragments.md]] §3）。`max_threads`=6・`max_depth`=1 が公式既定値で、どちらも公開設定。旧版の「`multi_agent_v2` 有効時に `agents.max_threads` を明示すると起動エラー」という説は再現未実施のまま現行公式仕様と矛盾したため撤回した。Desktop／サービスがより低い実効上限を課す場合はある（[[../codex/subagent-thread-limits.md]]、2026-07-13訂正）。

## Codex CLI 呼び出し

- `-m` / `--profile <name>`（`~/.codex/<name>.config.toml` を base config の上にレイヤー。本セッションで実装文字列「Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config」を確認。単一 config.toml 内の legacy `profile = "..."` / `[profiles.xxx]` はもう書き込めない仕様変更済み）
- `-c model_reasoning_effort=...`
- TUI `/model`（**config.toml へ永続書き込み＝再ピン仕様**。前セッションの実測に基づく）
- グローバル指示は `AGENTS.override.md` → `AGENTS.md` の最初の非空1ファイル・積層不可（一次: `core/src/agents_md.rs`。本セッションで実装文字列中に両ファイル名がこの順で連続するのを確認）

## sidecar 連携

codex-sidecar は端末 config の `model`/`model_provider`/`model_reasoning_effort` 行だけを隔離 home に継承する（一次: `codex-sidecar-core/dist/app-server-client.js` の `minimalCodexConfig`。本セッションで `codex-sidecar-core/dist/config.js` を実読し `.codex-sidecar.yml` の必須キー `project`（非空文字列）を新規発見——前セッションの仕様認識には無かった）。`.codex-sidecar.yml` が無いと `CONFIG_NOT_FOUND`。`defaults.model_reasoning_effort` は `low`/`medium`/`high`/`xhigh` のみ受理（`ultra`/`max` はスキーマ外＝本セッションで `codex-sidecar-core/dist/config.js` の `MODEL_REASONING_EFFORTS` 定数から確認）。

## 選定上の注意

- 2026-08-14のAPI定価はSol $5/$30、Terra $2/$12、Luna $0.20/$1.20。検索snippetの旧価格をcurrent priceとして使わない。
- 272K tokens を超える入力は request 全体が input 2倍・output 1.5倍になる。長大 context ではモデル単価だけで見積もらない。
- provider 公表 benchmark は harness・token budget・比較価格が揃わないため、dotagents の配置表では横断順位を採用しない。代表的な repo task の成功率、総 token、所要時間、手戻りで判断する。
- Artificial Analysis v4.1.1 では Luna×max=52、Terra×max=57、Sol×max=61。合成指数は広い思考力そのものではないが、Luna×max を局所実装候補として試す根拠にはなる。詳細は [[benchmark-snapshot-20260811.md]]。

## 関連

- [[../../shared/runbooks/02_models.md]] — 役割→ティア×effort 決定表（この記事の要点を反映済み）
- [[../../docs/05_codex-fragments.md]] — Codex 端末設定断片（V2 role routing・実効値ゲート・再ピン問題・AGENTS.override.md シャドー）
- [[../../docs/archive/plan_gpt56-rewiring.md]] — 本記事の元になった設計・実装完了記録
