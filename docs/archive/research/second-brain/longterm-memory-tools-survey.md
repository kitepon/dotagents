# 長期記憶ツール調査（2026-07）— 見送りの裁定と再訪条件

- 取得日: 2026-07-04
- 確度: 中〜高（各ツールの性質は公式・比較記事の一致情報。ベンチ数値は出典間で食い違いあり＝単一値を信用しない）
- 出典: [Context Cloud 比較記事](https://contextcloud.pro/blog/best-mcp-memory-servers-for-teams/)・[mem0 公式](https://docs.mem0.ai/integrations/claude-code)・[claude-mem-lite](https://github.com/sdsrss/claude-mem-lite)・[vectorize.io 比較](https://vectorize.io/articles/claude-code-memory-vs-mem0-vs-hindsight)
- 関連: [[karpathy-obsidian-llm-knowledge-base]] [[notebooklm-second-brain-critique]]

## 適用例（憲章原則7の運用）

窓は流行が去れば替えられるが、器に真実を入れると人質になる。Obsidianは`.obsidian/`を端末固有としてgitignoreし、Markdown＋gitを読む窓としてだけ採用できる。NotebookLMは主脳にはせず、一方通行の人間用窓に限る。プラグインはネイティブ機能で上位互換できるなら新規導入しない。

## 候補の概観（2026-07 時点）

| ツール | 保存先 | 性質 |
|---|---|---|
| mem0 | クラウド or 自前 vector DB | 最大コミュニティ・マルチスコープ記憶・/plugin で導入可 |
| Hindsight | daemon＋DB（自己ホスト可） | 検索精度ベンチ最上位を主張（LongMemEval 94.6%。ただし他ツールのベンチ値は出典間で大きく食い違う） |
| claude-mem / claude-mem-lite | SQLite | Claude Code の hook 連動自動記録。外部サービス不要 |
| Context Cloud | SaaS | チーム向け（共有ワークスペース・RBAC） |

## 裁定: 全て見送り（2026-07-04）

理由は原則7（依存は窓に限定・**真実の保存は素の md＋git**）との構造衝突:

1. 候補は全て**記憶の保存先が DB / クラウド / SQLite のサイロ**。採用した瞬間、知識の真実の源が「git の md」と「ツールの DB」に分裂する——NotebookLM を主脳にしない判定と同型。
2. うちには既に**5層の長期記憶**があり、全部 git 同期の素の md（罠=caveat〔リポ化済み〕・研究=rag/・決定=docs/・作法=CLAUDE.md 正本・進捗=プラン文書〔docs/ 内・TODO 兼務〕）＋端末メモリ（Claude Code ネイティブのファイルベース記憶）＋Throughline（セッションのバトン）。**保存層の欠落は無い**。
3. 候補の付加価値は主に「検索（semantic retrieval）」。それは**保存を移さず検索だけ足す「窓」型**で将来解決できる（コード側は codegraph が既にこの形: 保存=ソース、索引=別物）。

## 再訪条件

- rag/ と caveat が grep / FTS で回らない規模になったら（体感で検索が仕事のボトルネックになったら）、**md を正としてインデックスだけ張る**ローカルツールに限定して再調査する（保存先を持つツールは対象外のまま）。
- 再訪もオーナーのトリガーで（原則6。カレンダー駆動にしない）。
