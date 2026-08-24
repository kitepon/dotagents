# 08_cursor-fragments — Cursor 端末設定の工場断片

`~/.cursor/mcp.json` と `~/.cursor/cli-config.json` は端末固有（コミットしない）。このファイルは工場が所有する断片と、限定適用器の正典である。親の model×effort と permission と login はオーナー領分であり、適用器は触らない。

適用器は [`../bin/apply-cursor-config.sh`](../bin/apply-cursor-config.sh)。`--apply` は端末承認後。backup は `$HOME/Archives/dotagents-cursor-config-*.tar.gz`。

## 1. 工場が書く面

- 工場MCP 6サーバ（stdio）。所有面は `~/.cursor/mcp.json` の `mcpServers`。個人MCP（Gmail等）は同じファイルに残してよい。工場は工場6だけを upsert する。
- User Rules UI と `cli-config.json` は完成形にしない。グローバル憲法の正本ファイルは `~/.cursor/rules/factory.mdc`（Wave 1）。Cursor 3.17.8 Desktop の always-apply 注入は workspace 内の `.cursor/rules` に限るため、工場 `cursor-constitution-hook` が配達する。本文が 10000 字以内なら `additional_context` に同一本文を載せる。超える場合 Desktop は spill して「uuid.txt を Read」に置換するため、hook 側で cap 内の案内（ベル・Cursor native shell・正本パス）を inline し、同一本文は `factory.mdc` の Read で届ける。sessionStart は composer handle 未作成だと落とすので、awaited の beforeSubmitPrompt にも同じ hook を置く。

| name | command | args / env |
|---|---|---|
| `aiterm` | `aiterm-mcp` | — |
| `caveat` | `caveat` | `mcp-server` |
| `lattice` | `lattice-mcp` | — |
| `codex-sidecar` | `codex-sidecar-mcp` | — |
| `gpt_connector` | `gpt-connector-mcp` | — |
| `aishell` | `aishell-mcp` | `AISHELL_CAPABILITY_SET=expanded-v1` |

既存の工場サーバは command / args / 必須env が契約どおりなら触らない。`disabled: true` や command の食い違いは工場契約へ戻す。`gmail` など工場外のサーバは触らない。

command の論理名は上表どおり。適用時に `PATH` 上で解決できた command は絶対パスで書き、その親ディレクトリを `env.PATH` の先頭に置く。この解決は適用した席の PATH だけを見る。席への手作業の展開は、その席の親AIに正規入口を実行させる。Mac で書いた `mcp.json` を他席 HOME へ転送して置かない。Cursor Desktop の GUI PATH と Agent CLI の PATH は別でありうる。未解決なら名前のまま残し、handshake は typed 失敗。既に実行可能な絶対パスがあり basename が論理名と一致し、`env.PATH` が契約どおりなら、適用器の PATH が空でも書き戻さない。

Windows native では同じ契約を Windows の語に写す。`env.PATH` の区切りは `;`。解決できた command は PATHEXT どおり `.cmd` / `.exe` になりうる。npm の global bin と `node.exe` は別ディレクトリなので、よくある配置（`Program Files\\nodejs` 等）に `node.exe` があればその親も `env.PATH` に置く。

## 2. 触らない面

- `~/.cursor/cli-config.json` の `model` / `modelParameters` / permission / login
- 工場6以外の MCP
- `~/.cursor/skills-cursor/`
- 個人hook。所有面は `~/.cursor/hooks.json` と `bin/cursor-*-hook`。apply-cursor-config が工場hookを upsert し、個人hookは残す。

工場hookはCursor envelope（`hook_event_name` / `permission` / `additional_context`）をそのまま読む。Claude 形（`permissionDecision`）へ canonicalize しない。Spotter / Throughline / Caveat の製品hookは工場hookに載せない。Throughline 0.10.3+ は `throughline install` が同じ `~/.cursor/hooks.json` へ絶対 node + `bin/throughline.mjs` を upsert する（工場 `cursor-*-hook` は残す。`apply-cursor-config` は Throughline コマンドを消さない）。Spotter / Caveat の Cursor 製品hookは無い。`cursor-constitution-hook` は `~/.cursor/rules/factory.mdc` を Desktop Agent へ配達する（home mdc を always-apply しないための配達。正本は factory.mdc）。10000 字以内なら同一本文を `additional_context` へ載せる。超過時は cap 内の案内を inline し、同一本文は正本ファイルの Read で届ける（Desktop 3.17.8 の spill は本文を uuid.txt への Read 指示に置換し、末尾の Cursor delta が落ちる）。sessionStart は fire-and-forget で handle 未作成だと落とすため、同一 hook を awaited の beforeSubmitPrompt にも置く（session ごとに1回）。onset INFO の beforeSubmitPrompt 注入は非採用（orchestrate-advisory は sessionStart のまま。Throughline の handoff 注入は製品側が sessionStart の `additional_context` で行う）。Cursor に `exit_plan_mode` が無いため plan-gate も非採用。

## 3. 受入

適用後の新規 Cursor session で工場6の handshake を見る。失敗はtypedのまま残し、登録成功へ丸めない。既存sessionの MCP catalog 見た目は受入に数えない。`hooks.json` は live reload される。憲法配達の受入は user hooks を load 済みの窓で人が文を送った Desktop チャット（Cmd+Shift+L の新規、または reload 済み既存窓。Task/cloud・goal continuation・`cursor --chat` は Desktop hook を踏まない）。`cli-config.json` の model が適用前後で同じであること。Cursor は互換で `~/.claude/skills` も読む。工場所有は `~/.cursor/skills` であり、Claude 面の列挙を切断成功と読まない。
