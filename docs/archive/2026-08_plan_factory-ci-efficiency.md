# Factory CI efficiency

## 目的

- Markdownだけの変更で4環境fullを実行しない。
- 製品変更は対応する全環境で同じfull testを並列実行する。
- checkout・依存導入・試験本体の時間を分け、依存導入が支配的な製品だけ標準キャッシュを使う。

## 実施

1. 共通workflowで変更をMarkdownだけか、それ以外かに分類する。
2. 製品callerで依存導入とfull testのコマンドを分離する。
3. caller変更による実CIのstep時間を確認する。
4. 依存導入が支配的と実測できた製品だけ、package managerの標準キャッシュを追加する。

## 受入

- Markdownだけの変更はLinux 1環境で終わる。
- 製品変更は対象全環境でcheckout・dependency install・product full testが別stepとして成功する。
- 独自キャッシュ層、製品別path-to-test表、OSごとの役割分散を追加しない。

## 実測結果

製品callerの変更を4環境で実行し、各stepの最小〜最大秒を確認した。

| 製品 | checkout | 依存導入 | full test |
| --- | ---: | ---: | ---: |
| Caveat | 1〜5 | 1〜2 | 24〜64 |
| Spotter | 1〜3 | 0〜1 | 7〜42 |
| Lattice | 1〜3 | 1〜5 | 74〜168 |
| gpt-connector | 1〜5 | 0〜6 | 4〜13 |
| aiterm-mcp | 0〜4 | 1〜4 | 66〜114 |
| codex-sidecar | 1〜4 | 1 | 40〜101 |
| Observer | 0〜3 | 0〜1 | 3〜23 |
| ServerManager | 0〜3 | 0〜2 | 87〜130 |
| Peertable | 1〜5 | 0〜3 | 0〜1 |

依存導入が製品全体の所要時間を支配する製品はなかった。数秒を削るためのキャッシュ機構は追加しない。
