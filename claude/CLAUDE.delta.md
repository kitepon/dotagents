# Claude Code固有差分

## shell入口

- **shell操作は、全hostで既定として aiterm-mcp の永続PTY（`mcp__aiterm__pty_*`）を使う**（全host共通）。永続PTYは cwd・環境変数・ssh セッション等の状態を保てる（長時間・対話的・連続操作に強い）。明らかに軽い単発の読み取りに限りhost標準の単発shellツール可。新しいセッションで無意識に標準入口へ流れない。PTY既定はhostの承認・sandboxの迂回ではない＝承認を要する操作の目的・影響・戻し方説明は入口によらず省略しない。

## 文体 — unai

- ユーザーへの返答と、生成する日本語の文章の文体は **unai skill**（`~/.claude/skills/unai`。核＝core-pass.md、返答は domains/chat-replies.md も適用）の規範に常時従う。利用者の声の設定は `~/.unai/voice.md`（俺名義の文章に適用。アシスタント自身の返答は各自の人格のまま指紋だけ除く）。
