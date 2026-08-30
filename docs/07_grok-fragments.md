# 07_grok-fragments — Grok 端末設定の工場断片

`~/.grok/config.toml` は端末固有（コミットしない）。このファイルは工場が所有する断片と、限定適用器の正典である。親の model×effort と permission と login はオーナー領分であり、適用器は触らない。

適用器は [`../bin/apply-grok-config.sh`](../bin/apply-grok-config.sh)。`--apply` は端末承認後。backup は `$HOME/Archives/dotagents-grok-config-*.tar.gz`。

## 1. 工場が書く面

- `[compat.claude] agents = false`（Wave 1。`~/.claude/CLAUDE.md` を吸わない）
- `[compat.claude] hooks = false`（Wave 4。Claude `settings.json` の hook は `disabled` になり発火しない。`grok inspect` には vendor=claude の行が残ることがある）
- 工場MCP 6サーバ（stdio）。同名が `~/.claude.json` にあっても **toml 側が勝つ**（2026-08-16 隔離HOME実測）。個人MCP（Gmail等）は Claude json に残してよい。`compat.claude.mcps` は切らない。

| name | command | args / env |
|---|---|---|
| `aiterm` | `aiterm-mcp` | — |
| `caveat` | `caveat` | `mcp-server` |
| `lattice` | `lattice-mcp` | — |
| `codex-sidecar` | `codex-sidecar-mcp` | — |
| `gpt_connector` | `gpt-connector-mcp` | — |
| `aishell` | `aishell-mcp` | `AISHELL_CAPABILITY_SET=expanded-v1` |

既存の工場セクションは command / args / 必須env / `enabled` が契約どおりなら触らない。`enabled = false` や command の食い違いは工場契約へ戻す。`[mcp_servers.<name>.env]` のような工場サーバのサブ表は inline `env` へ畳み、本体と二重に残さない。`[mcp_servers.x-article]` など工場外のセクションは触らない。

command の論理名は上表どおり。適用時に `PATH` 上で解決できた command は絶対パスで書き、その親ディレクトリを `env.PATH` の先頭に置く。この解決は適用した席の PATH だけを見る。席への手作業の展開は、その席の親AIに正規入口を実行させる。Mac で書いた `config.toml` を他席 HOME へ転送して置かない。Grok Build Desktop の GUI PATH（`/usr/bin:/bin:/usr/sbin:/sbin`）では brew の名前解決も `#!/usr/bin/env node` もできない。未解決なら名前のまま残し、handshake は typed 失敗。既に実行可能な絶対パスがあり basename が論理名と一致し、`env.PATH` が契約どおりなら、適用器の PATH が空でも書き戻さない。

Windows native では同じ契約を Windows の語に写す。`env.PATH` の区切りは `;`。解決できた command は PATHEXT どおり `.cmd` / `.exe` になりうる。npm の global bin と `node.exe` は別ディレクトリなので、よくある配置（`Program Files\\nodejs` 等）に `node.exe` があればその親も `env.PATH` に置く（`.cmd` shim が `node` を呼ぶため。macOS で command 親に node が同居するのと同型）。この判定は適用時 PATH に依存しない。TOML の `\` はエスケープする。Windows の GUI PATH 基底は上記 node 親（あれば）と `WINDIR\\System32` / `WINDIR` / Wbem / PowerShell だけとし、不足は実測のあとだけ足す。

## 2. 触らない面

- `[models]` と `default_reasoning_effort`
- `[ui] permission_mode` ほか permission
- `[privacy]` と login
- 工場6以外の MCP
- `compat.claude.skills` / `mcps`（skillsはWave 2で切らない裁定済み。工場MCPの所有のために mcps は切らない）
- 個人hook。所有面は `~/.grok/hooks/factory.json` と `~/.local/bin/grok-*-hook` だけ

工場hookはGrok camelCaseをそのまま読む。Claude 形へ canonicalize しない。製品hookは工場hookに載せない。Throughline の導入・hook出力・再適用は [Throughline README「In 30 seconds」](https://github.com/kitepon/Throughline#in-30-seconds) が正である。

Windows native の工場hook command は shebang ファイルを直接実行しない。`apply-grok-config` が `~/.grok/hooks/factory.json` を symlink から実ファイルへ置き、解決できた `python.exe` / `sh.exe` を絶対パスで前置する。拡張子なしの hook を Windows が「次のアプリで開きますか？」で開くのを防ぐ。POSIX は repo の shebang command のまま。

Grokの `UserPromptSubmit` / `SessionStart` / `PostToolUse` は stdout を制御に使わない。観察系工場hookは exit 0 と空または非block JSONだけを返し、Stop で `decision=block` や exit 2 を出さない。

## 3. 受入

適用後の `grok inspect --json` で工場6の `source.type` が `configToml` であること。handshakeは `grok mcp doctor --json` で見る。失敗はtypedのまま残し、登録成功へ丸めない。
