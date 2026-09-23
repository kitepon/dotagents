# Knowledge return

所有: dotagents所有・全project向けL2正典。

## rag/の型

- 外部仕様・文献の一次ソースは`rag/<topic>/raw/`へverbatimで置き、要約・リンク・自前の実測を足したコンパイル記事は一次ソースと別ファイルにする。
- 各ファイルの冒頭に出典・取得日・確度を書き、`rag/INDEX.md`へ内容を特定できる1行を足す。`rag/`が無いprojectでは作る。
- 良い回答・監査ダイジェスト・図解も、再利用価値があれば`rag/`か`docs/`へ戻す。
- 月次でrag/のリンク切れ・INDEX欠落・確度未記載と、端末メモリを同じ枠で点検する。

## 道具の選び方

- 知識の器はMarkdownとgitだけにする。Obsidianは`.obsidian/`を端末固有としてgitignoreし、読む窓としてだけ使う。NotebookLMは人間用の一方通行の窓に限り、主脳にしない。
- ネイティブ機能で上位互換できるプラグインは新規導入しない。
