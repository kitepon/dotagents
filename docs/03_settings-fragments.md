# 03_settings-fragments —  各端末 settings.json の推奨断片カタログ

<!-- 前提: 2026-07 時点の Claude Code settings 仕様。機微（トークン・認証情報・個人の絶対パス）はこのファイルに書かない＝リポにコミットしない -->

`~/.claude/settings.json` と各リポの `.claude/settings.json` は端末固有・リポ固有（コミットしない。dotagents の gitignore 済み）。このファイルは「各端末で貼る断片」のカタログであり、適用は手動または skill 経由で行う。

## 読み取り系 Bash の permissions.allow（グローバル推奨）

プロンプト削減の基本セット。破壊系（rm・push・install）は**入れない**——都度確認が正:

```json
{
  "permissions": {
    "allow": [
      "Bash(git fetch:*)", "Bash(git status:*)", "Bash(git log:*)",
      "Bash(git diff:*)", "Bash(git branch:*)", "Bash(git stash list:*)",
      "Bash(ls:*)", "Bash(rg:*)", "Bash(grep:*)", "Bash(find:*)",
      "Bash(wc:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(readlink:*)",
      "Bash(du:*)", "Bash(file:*)", "Bash(which:*)", "Bash(bash -n:*)"
    ]
  }
}
```

## リポ別 allowlist の作り方（正規手順）

手書きせず **fewer-permission-prompts skill** を各リポで実行して生成する（実際のトランスクリプトから頻出読み取りコールを抽出して優先順位つきで提案してくれる）。生成物はそのリポの `.claude/settings.json` に入る＝P3 標準の必須要件。

## コア製品repoへのアクセス断片（dotagentsだけ）

dotagentsセッションからコア製品repoへ直接手を届かせるのは、この断片を dotagents の `.claude/settings.local.json` へ貼った端末だけとする。`.claude/` はこのリポの gitignore 対象＝端末ごとに貼る。

対象は[工場の現行状態](factory-current-state.md)で自作コアに分類された製品の正規repoだけとし、MarkItDown（第三者・repoなし）、基盤toolchain、`*-wt-*` / `*-worktrees` の作業ツリーは含めない。`<HOME>` は各端末の home 絶対パスへ置換する:

```json
{
  "permissions": {
    "additionalDirectories": [
      "<HOME>/Developer/Caveat",
      "<HOME>/Developer/Throughline",
      "<HOME>/Developer/Spotter",
      "<HOME>/Developer/Lattice",
      "<HOME>/Developer/gpt-connector",
      "<HOME>/Developer/aiterm-mcp",
      "<HOME>/Developer/codex-sidecar",
      "<HOME>/Developer/aishell",
      "<HOME>/Developer/ServerManager",
      "<HOME>/Developer/peertable",
      "<HOME>/Developer/unai"
    ]
  }
}
```

- 置き場は dotagents の `.claude/settings.local.json` だけとする。project の `.claude/settings.json` へ書いた付与は workspace trust ダイアログを承認した後にだけ効き、グローバル `~/.claude/settings.json` へ書くと全 project がコア11repoへ到達する。
- パスは絶対パスで書く（`~` 展開は公式ドキュメントに明記がない）。実在する repo だけを列挙し、無い行を残さない。
- 反映は次セッションの起動から。当該セッション内だけ足すなら `/add-dir <path>` を使う。
- `additionalDirectories` が与えるのはファイルアクセスだけで、その先の `.claude/` 設定（skills・agents・CLAUDE.md）は読み込まれない。それらが要る時は起動時 `--add-dir` かセッション中 `/add-dir` を使う。

## hooks の方針

- 自動化（「毎回 X したら Y」）は memory や指示ではなく hooks でしか成立しない——必要になったら update-config skill で settings.json に組む。
- **Caveat hookは手挿ししない**: 工場はCaveatの一回setup入口だけを呼ぶ。対応host、生成物、再適用条件は[Caveat README](https://github.com/kitepon/Caveat#readme)を正とする。
- **Spotter hookは手挿ししない**: 対象projectでは `spotter install -y` だけを呼ぶ。生成物・host別hook・連携オプション・再適用条件は[Spotter README「Install」](https://github.com/kitepon/Spotter#install)を正とし、dotagentsのhook断片へSpotter entryを複製しない。
- **Lattice導線hookは手挿ししない**: 一撃展開は `lattice hooks install --host <host>` をhostごとに一度呼ぶ。対応host、platform、生成物、statusの意味は[Lattice integration package「hooks導線」](https://github.com/kitepon/Lattice/blob/main/docs/01_integration-package.md#L116-L121)を正とする。

- **Claude hook の正規入口**: [`../bin/apply-claude-config.sh`](../bin/apply-claude-config.sh) が下記のClaude hook jq断片を `~/.claude/settings.json` へ冪等に追加する。既存entry・model・permissions・他ツールの設定は変更しない。断片は配線内容の正本として残す。
- **計画レーン案内 hook（全端末必須・下記）**: プラン承認直後に「計画文書の作法」を注入する。レーンの発動条件はグローバル正典「作業レーンと統制」に従う（本書へ条件を複製しない）。ペイロードは同期される [`../bin/plan-gate-hook.sh`](../bin/plan-gate-hook.sh)（`./install.sh` で `~/.local/bin/plan-gate-hook` へ symlink）。初期設計は [archive/2026-07_plan-gate-hook.md](archive/2026-07_plan-gate-hook.md)、現行のレーン裁定はグローバルCLAUDE.md／AGENTS.mdを正とする。

### 計画レーン案内 hook の配線断片

前提: `./install.sh` 済み（`~/.local/bin/plan-gate-hook` が存在）。`~/.claude/settings.json` にマージ（既存 `hooks.PostToolUse` があればその配列へ足す）。ライブ反映＝次のプラン承認から発火:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "command", "command": "~/.local/bin/plan-gate-hook", "timeout": 5 }
        ]
      }
    ]
  }
}
```

- matcher は `ExitPlanMode` 完全一致（プラン承認専用イベントは無く PostToolUse で受ける）。
- TodoWrite には貼らない（些末用途が多く毎回発火は alarm fatigue）。通常レーンのTodoWriteから文書作成を要求しない。

### 呼びかけ hook 群の配線断片（配置ゲート・TODO ゲート・着手案内）

前提: `./install.sh` 済み（`~/.local/bin/{delegation-gate-hook,todo-gate-hook,onset-gate-hook}` が存在。`todo-gate-hook` はサブコマンド `session-start` / `stop` を取る）。現行の義務はグローバルCLAUDE.md／AGENTS.md、Hookの実装履歴は [archive版](archive/plan_callout-hooks.md) を参照する。4本とも `~/.claude/settings.json` にマージ（既存配列があればその配列へ足す、無ければ新規作成）。ライブ反映＝配線後の新セッション不要（hot-reload 実測済み）。

#### C1 配置ゲート（PreToolUse・委譲ツール呼び出し時）

セッションで最初の委譲を検出した時だけ、配置・委譲契約の正典を案内する短い INFO を返す。加えて、次の閉集合だけを同期 `permissionDecision="deny"` で拒否する。`gpt_connector` の `consult` は相談であって委譲ではないため対象外（[`../bin/delegation-gate-hook.sh`](../bin/delegation-gate-hook.sh)）。

- `mcp__aiterm__codex_agent` は具体値（`inherit`・空・空白のみ・`${...}`等の変数風は不可）の `model` と `reasoning_effort` が必須。grok/composer は対話TUIに effort 指定を持たないため INFO のまま。
- sidecar write入口（`codex_work` / `codex_work_start` / `codex_generate`）は、callの具体値 `model` と `modelReasoningEffort`、または実効cwdから上向きに解決した `.codex-sidecar.yml` の具体値 `defaults.model` と `defaults.model_reasoning_effort` の組だけを明示等価として許可する。単なるファイル存在・空/継承/変数風defaultsはdeny。read系 sidecar は INFO のまま。
- `Agent` / `Task` は具体のcall `model` が必須。ただし `CLAUDE_PROJECT_DIR/.claude/agents` directory が**存在しない**時だけ、`~/.claude/agents/<subagent_type>.md`（ファイル名直結・非再帰）のfrontmatter具体 `model:` を明示等価として許可する。Claude runtimeの再帰探索・frontmatter name識別・project優先をhookで模倣しない。project agent directoryがあるshadow環境ではruntime解決との差を安全側に倒し、定義ベース判定を捨てて明示modelを要求する。`inherit`、空、変数風の値は固定でないためdeny。Claude Agent入口にはeffort fieldがないため、ここではeffortを要求しない。`Workflow` は script内のper-call明示を正とし、静的検査の誤爆を避けるため INFO のまま。
- aiterm codex と上記sidecar write入口のscopeは、prompt/inputに完全な `[scope:read-only]` または `[scope:write]` を**一つだけ**入れる。欠如と両方混在はdeny。これは dispatch routing 用の宣言強制であり能力壁ではない。実効の能力壁は Codex native sandbox、sidecar `allowed_paths`、将来のaiterm launch schema が担う。
- write宣言では `git rev-parse --git-common-dir` の絶対パス、失敗時は共通 `unidentified-repo` sentinelをキーに期限なしのwriter予約を作る。予約directoryはowner-only 0700を強制し、修復不能なら `P11_STATE_UNAVAILABLE` denyとなる。予約はowner-only `writer-reservations/`下にtemp+renameで完全recordとして公開し、既存の空・破損・中間recordは不透明busyとしてdenyする。同一keyの未解放予約はdeny。予約を消す経路は `delegation-gate-hook --release --common-dir <common-dir>`（sentinelは `unidentified-repo`）だけで、`--common-dir`単独はexit 2、`--list`は破損recordもopaqueとして表示する。TTL、自動解放、自動warning格下げ、Lattice例外、`.lattice/`直接読取はない。予約directoryはC1/X2/C2-C3の7日GC対象外。並列が必要なら Lattice の `plan compile → run start` を使う。

全denyは理由コード（`P10_MODEL_EFFORT_MISSING`、`P9_SCOPE_DECL_MISSING`、`P9_SCOPE_DECL_AMBIGUOUS`、`P11_WRITER_BUSY`、`P11_STATE_UNAVAILABLE`）、最小の正しい呼び方、`shared/orchestrate/delegation-contract.md`参照の3行で返す。親`STATE_DIR`を確保できない場合も入力を解析する。read系・非writerのhook内部障害は denyせず理由付きINFOへ縮退する一方、write宣言dispatchは予約stateを確保できないため `P11_STATE_UNAVAILABLE` でfail-closedにする。Bashは汎用入口で構造化inputがなく委譲か判定できないためINFO維持、sidecar read系は書込まないため直列化対象外でINFO維持する。`lib/orchestrate/execution-path.mjs` はこのPython hookからimportしない（接続契約は fm-0689 の別note対象）。

```bash
S=~/.claude/settings.json
MATCHER='Agent|Task|Workflow|mcp__codex-sidecar__codex_.*|mcp__aiterm__(codex|grok|composer)_agent'
if ! jq -e --arg m "$MATCHER" '.hooks.PreToolUse[]?|select(.matcher==$m)' "$S" >/dev/null; then
  cp "$S" "$S.bak-delegationgate"                  # バックアップ
  tmp=$(mktemp)
  jq --arg m "$MATCHER" '.hooks.PreToolUse += [{"matcher":$m,"hooks":[{"type":"command","command":"~/.local/bin/delegation-gate-hook","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"  # 妥当性を確認してから置換
fi
```

#### Git破壊操作ゲート（PreToolUse・Bash）

`git checkout -- <pathspec>`／`checkout .`、worktreeを戻す`restore`、`clean -f`系、`reset --hard`、`stash drop`／`clear`を検知する。対象pathspec（不明時はworktree全体）に未commit差分がある時だけ`P12_UNCOMMITTED_DESTROY`でdenyし、branch切替checkout、`restore --staged`のみ、clean・非git・status失敗はallowする。退避は`stash push`またはdiffのpatch保存を使う。`DOTAGENTS_GIT_DESTROY_GATE=off`で無効化できる。

```bash
S=~/.claude/settings.json
if ! jq -e '.hooks.PreToolUse[]?.hooks[]?.command | select(.=="~/.local/bin/git-destroy-gate-hook")' "$S" >/dev/null; then
  cp "$S" "$S.bak-git-destroy-gate"
  tmp=$(mktemp)
  jq '.hooks.PreToolUse += [{"matcher":"Bash","hooks":[{"type":"command","command":"~/.local/bin/git-destroy-gate-hook","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

#### C2 TODO 棚卸し（SessionStart・source=startup/clear のみ発火）

docs/ の `plan_*.md`/`queue_*.md` の未消化・archive 未退避をリポ×24h スロットルで棚卸しし、観測事実と正典への参照だけを INFO で返す（[`../bin/todo-gate-hook.sh`](../bin/todo-gate-hook.sh) の `session-start` サブコマンド）。

```bash
S=~/.claude/settings.json
if ! jq -e '.hooks.SessionStart[]?.hooks[]?.command | select(.=="~/.local/bin/todo-gate-hook session-start")' "$S" >/dev/null; then
  cp "$S" "$S.bak-todogate-start"
  tmp=$(mktemp)
  jq '.hooks.SessionStart += [{"hooks":[{"type":"command","command":"~/.local/bin/todo-gate-hook session-start","timeout":10}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

#### Orchestrate advisory（SessionStart・読み取り専用）

active Control、unknown／未回収Run、write conflict、H参照不足、capacity警告だけを、該当時に短い
INFOとして表示する。state変更、H認証、executor/provider/network/cancelは行わず、CLI不在・非git・
timeout・不正snapshot・unsafe cacheでは沈黙する。hookは固定absolute Pythonを`-I`で起動し、親の
`PYTHONPATH`等を解釈しない。既存SessionStart entryを変更せず、次の1件だけ追加する。

```bash
S=~/.claude/settings.json
if ! jq -e --arg home "$HOME" '[.hooks.SessionStart[]?.hooks[]? | select(.type=="command" and .timeout==5 and (.command=="~/.local/bin/orchestrate-advisory-hook" or .command==($home+"/.local/bin/orchestrate-advisory-hook"))] | length == 1' "$S" >/dev/null; then
  cp "$S" "$S.bak-orchestrate-advisory"
  tmp=$(mktemp)
  jq '.hooks.SessionStart += [{"hooks":[{"type":"command","command":"~/.local/bin/orchestrate-advisory-hook","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

`DOTAGENTS_ORCHESTRATE_ADVISORY=off`で無効化できる。成功表示後だけsession×repo単位で一度だけ表示し、
hook自身のcache markerは7日後に掃除する。cache baseと`dotagents/hooks`はowner directoryかつsymlink
でないことを検査し、不適合時は作成・変更せず沈黙する。

#### Lattice工程表案内（SessionStart → UserPromptSubmit・読み取り専用）

`source=startup|clear`のたびに、SessionStartはLattice CLI呼び出しを待たずにbackground workerを起動する。次のUserPromptSubmitは同じsession×repoの中継結果を一度だけ配送し、まだ完了していなければ取得中であることだけを表示する。worker完了後は、正規typed statusに案内すべき残工程がある時だけLattice工程表の安定パスと現在地を短いINFOとして表示する。受理するschema、案内対象、表示文、失敗時の分類は[`lib/lattice-hook.py`](../lib/lattice-hook.py)とfocused hook testを正とし、本書へ版別に複製しない。HTMLやstoreを直接解釈するfallbackと`lattice todo gantt`の自動実行は持たない。既存entryを変更せず、次の2件だけ追加する。

中継はowner-ownedかつsymlinkでない`$XDG_CACHE_HOME`（未設定時は`~/.cache`）配下の`dotagents/hooks/`へ、`SHA-256(session_id).SHA-256(repo-root).lattice-gantt.*`として保存する。`.pending`／`.waiting`／`.result`／`.consumed`は7日後にhook自身が掃除する。

```bash
S=~/.claude/settings.json
if ! jq -e --arg home "$HOME" '[.hooks.SessionStart[]?.hooks[]? | select(.type=="command" and .timeout==6 and (.command=="~/.local/bin/lattice-gantt-hook session-start" or .command==($home+"/.local/bin/lattice-gantt-hook session-start"))] | length == 1' "$S" >/dev/null; then
  cp "$S" "$S.bak-lattice-gantt"
  tmp=$(mktemp)
  jq '.hooks.SessionStart += [{"hooks":[{"type":"command","command":"~/.local/bin/lattice-gantt-hook session-start","timeout":6}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
if ! jq -e --arg home "$HOME" '[.hooks.UserPromptSubmit[]?.hooks[]? | select(.type=="command" and .timeout==5 and (.command=="~/.local/bin/lattice-gantt-hook user-prompt-submit" or .command==($home+"/.local/bin/lattice-gantt-hook user-prompt-submit"))] | length == 1' "$S" >/dev/null; then
  cp "$S" "$S.bak-lattice-gantt"
  tmp=$(mktemp)
  jq '.hooks.UserPromptSubmit += [{"hooks":[{"type":"command","command":"~/.local/bin/lattice-gantt-hook user-prompt-submit","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

配線後の動作と失敗分類は[`lib/lattice-hook.py`](../lib/lattice-hook.py)を正とする。`DOTAGENTS_LATTICE_HOOK=off`で無効化できる。

#### C3 プラン更新忘れ（Stop・rolling baseline で毎ターン判定）

このターンで dirty/コミットの差分があるのに `docs/plan_*.md` が動いていなければ INFO を pending に保存する。Stop 自体には注入せず、次の自然な UserPromptSubmit で C4 が1回だけ配送する（[`../bin/todo-gate-hook.sh`](../bin/todo-gate-hook.sh) の `stop` サブコマンド）。
文面はLattice typed discoveryが `ready`／`active_run` を返すrepoでは記録先の選択肢としてLattice storeとMarkdown planを並べ、それ以外は従来のplan正本文面とする。

```bash
S=~/.claude/settings.json
if ! jq -e '.hooks.Stop[]?.hooks[]?.command | select(.=="~/.local/bin/todo-gate-hook stop")' "$S" >/dev/null; then
  cp "$S" "$S.bak-todogate-stop"
  tmp=$(mktemp)
  jq '.hooks.Stop += [{"hooks":[{"type":"command","command":"~/.local/bin/todo-gate-hook stop","timeout":10}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

#### C4 着手案内（UserPromptSubmit・セッション初回と compact 後）

作業の進め方をグローバル `CLAUDE.md` / `AGENTS.md` と orchestrate skill へ案内する短い INFO。セッション初回だけ返し、compact 後に1回だけ再案内する。C3 の pending があれば同じ経路で配送する（[`../bin/onset-gate-hook.sh`](../bin/onset-gate-hook.sh)）。

```bash
S=~/.claude/settings.json
if ! jq -e '.hooks.UserPromptSubmit[]?.hooks[]?.command | select(.=="~/.local/bin/onset-gate-hook")' "$S" >/dev/null; then
  cp "$S" "$S.bak-onsetgate"
  tmp=$(mktemp)
  jq '.hooks.UserPromptSubmit += [{"hooks":[{"type":"command","command":"~/.local/bin/onset-gate-hook","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

#### env による制御

各 hook は環境変数で無効化できる。`off` 以外の値（未設定を含む）は既定動作になる:

- `DOTAGENTS_PLACEMENT_GATE=off` — C1 の初回委譲 INFO と上記denyをともに無効化。
- `DOTAGENTS_TODO_GATE=off` — C2 の棚卸しと C3 の pending 保存・配送を無効化。旧 `block` 値に特別な昇格動作はない。
- `DOTAGENTS_ONSET_GATE=off` — C4 の初回案内 INFO を無効化。C3 pending の配送は `DOTAGENTS_TODO_GATE` 側で制御する。
- `DOTAGENTS_LATTICE_HOOK=off` — Lattice工程表案内のbackground起動とUserPromptSubmit配送を無効化。
- `DOTAGENTS_GIT_DESTROY_GATE=off` — Git破壊操作ゲートを無効化。

## 適用チェック

- 適用後、`/permissions` 相当の UI か新セッションでプロンプト頻度が下がったことを確認。
- allowlist に書いた覚えのないコマンドが増えていたら要調査（設定の出所を必ず特定する）。
