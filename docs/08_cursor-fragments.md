# 08_cursor-fragments — Cursor 端末設定の工場断片

`~/.cursor/mcp.json` と `~/.cursor/cli-config.json` は端末固有（コミットしない）。このファイルは工場が所有する断片と、限定適用器の正典である。親の model×effort と permission と login はオーナー領分であり、適用器は触らない。

適用器は [`../bin/apply-cursor-config.sh`](../bin/apply-cursor-config.sh)。`--apply` は端末承認後。backup は `$HOME/Archives/dotagents-cursor-config-*.tar.gz`。

## 1. 工場が書く面

- 工場MCP 6サーバ（stdio）。所有面は `~/.cursor/mcp.json` の `mcpServers`。個人MCP（Gmail等）は同じファイルに残してよい。工場は工場6だけを upsert する。
- User Rules UI と `cli-config.json` は完成形にしない。グローバル憲法の mount は `~/.cursor/rules/factory.mdc`（Wave 1）。

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
- 個人hook。所有面は Wave 4 の `~/.cursor/hooks.json` と `~/.cursor/hooks/` だけ

工場hookはCursor envelopeをそのまま読む。Claude 形へ canonicalize しない。Spotter / Throughline / Caveat の製品hookは工場hookに載せない。

## 3. 受入

適用後の新規 Cursor session で工場6の handshake を見る。失敗はtypedのまま残し、登録成功へ丸めない。既存sessionは config 変更を引き継がない。`cli-config.json` の model が適用前後で同じであること。
