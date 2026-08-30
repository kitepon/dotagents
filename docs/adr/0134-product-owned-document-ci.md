# ADR 0134: 製品所有の文書CI

- 状態: Accepted
- 日付: 2026-08-30
- 決定者: オーナー／dotagents
- 先行裁定: ADR 0133

## 背景

ADR 0133は製品文書の所有者を各製品repoへ戻した。実装時の横断監査で、製品CIだけがdotagentsの外部workflowを実行正本にすると、製品を単独cloneした時に文書の受入条件が失われることが分かった。また、複数製品で正規表現によるMarkdownリンク検査、文書だけの変更で依存を導入しないCI、後続pushによる必須試験の取消が独立に発生した。

## 決定

1. 製品CIのcaller、再利用workflow、依存導入、文書検査、full command、release gateは製品repoが所有する。製品workflowからdotagentsのworkflowを実行正本として参照しない。
2. dotagentsはrunner、host label、横断接続、公開後の工場受入だけを所有する。製品CIの内部commandや合否を中央へ複製しない。
3. Markdownだけの変更でも、製品repo自身がclean checkoutで現役索引、archive/stub、ローカルリンクを検査する。文書を配布物へ同梱する製品は、同梱する全Markdownと参照先の閉包も検査する。
4. MarkdownとHTMLの参照抽出はCommonMark/GFMの構文木とHTML parserを使う。reference link、nested image、code、`href`、`src`、`srcset`を正規表現へ推測させない。
5. 既定branchの必須full CIは、後続の文書変更で取り消さない。置換されたpull requestの試験だけを取消対象にできる。

## 帰結

各製品はdotagentsを外しても、自身の文書と配布物を自身のCIで受け入れられる。dotagentsは製品の試験内容を制御せず、工場で必要な実行環境と横断結果だけを統括する。
