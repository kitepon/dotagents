# Codex固有差分

## shell入口

- **shell操作は、全hostで既定として aiterm-mcp の永続PTY（`mcp__aiterm__pty_*`）を使う**（全host共通）。永続PTYは cwd・環境変数・ssh セッション等の状態を保てる（長時間・対話的・連続操作に強い）。明らかに軽い単発の読み取りに限りhost標準の単発shellツール可。新しいセッションで無意識に標準入口へ流れない。PTY既定はhostの承認・sandboxの迂回ではない＝承認を要する操作の目的・影響・戻し方説明は入口によらず省略しない。

## Codex子の入口とaitermの境界

- **Codex親がCodex子を呼ぶ時はnative sub-agentを既定にする。** 同じ子へのfollow-upで対話と
  task相関を保ち、repoに密結合した実装・調査・反証をaitermの`codex_agent`へ流さない。
- aitermを永続shellとして使うことと、aitermからCodex子を起動することを混同しない。前者はshell操作の
  既定のまま、後者はnativeで満たせない隔離・durable external session・独立capacityの具体的利益が
  準備・回収コストを上回る時だけ例外的に選ぶ。単にaitermがCodexを起動できることや、慣性で
  external laneへ流れることは選定理由にしない。
- Grok／Composer等の別harnessをaitermで使う判断と、Codex→Codexの入口判断は別契約である。
