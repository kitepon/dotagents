# Codex固有差分

## 簡単な判断の委譲

- 自然文の分類・選別・振り分けなど、短い文脈と明確な候補で答えられる判断は、公式`typesafe-ai` skillでJevへ優先的に委譲する。複雑な推論・設計・最終判断はCodexが担い、規則で決まる処理はコードで行う。
- この委譲はComputer Useの有無にかかわらず適用する。関連する判断はまとめて渡し、報告ではJevを実際に使った工程を明記する。skill・認証が未設定の場合とAPI失敗時は、その状態を明示する。

## JevによるComputer Use

- JevによるGUI操作は、ブラウザに上流`jev-ultrafast`、デスクトップに上流`agent-desktop`の`jev-desktop`を使う。導入と呼出しはjev-computer-use runbookと上流の標準入口に従う。通常の操作ループへCodexの逐次判断や独自の工程管理・追加ゲートを重ねない。自作`codex-jev`／`jev-use`は使わない。

## Codex子の入口とaitermの境界

- **親が子の完了を待ってターンを終える委譲は、Aitermの`agent_launch`と自動完了配送を使う。**
  子の完了で親の後続作業を再開し、オーナーによる手動の呼び起こしを前提にしない。
- それ以外のCodex親からCodex子への委譲はnative sub-agentを既定にし、同じ子へのfollow-upで
  対話とtask相関を保つ。
- aitermを永続shellとして使うことと、aitermからCodex子を起動することを混同しない。後者は上記の自動完了配送が必要な場合、またはnativeで満たせない隔離・durable external session・独立capacityの具体的利益が
  準備・回収コストを上回る時だけ例外的に選ぶ。単にaitermがCodexを起動できることや、慣性で
  external laneへ流れることは選定理由にしない。
- Grok／Composer等の別harnessをaitermで使う判断と、Codex→Codexの入口判断は別契約である。
