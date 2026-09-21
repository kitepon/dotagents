# Codex固有差分

## 簡単な判断の委譲

- 自然文の分類・選別・振り分けなど、短い文脈と明確な候補で答えられる判断は、公式`typesafe-ai` skillでJevへ優先的に委譲する。複雑な推論・設計・最終判断はCodexが担い、規則で決まる処理はコードで行う。
- この委譲はComputer Useの有無にかかわらず適用する。関連する判断はまとめて渡し、報告ではJevを実際に使った工程を明記する。skill・認証が未設定の場合とAPI失敗時は、その状態を明示する。
- 工場配布キーは`~/.config/dotagents/credentials/typesafe/api.env`にある。公式skillからAPIを使う時はNodeの`--env-file`等で読み込み、キー値は出力しない。

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
