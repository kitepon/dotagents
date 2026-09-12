# npm 12の単一版取得はJSON配列になる

- 出典: [npm公式文書](https://docs.npmjs.com/cli/v12/commands/npm-view/)、[一次ソース抜粋](raw/npm-view-json-20260912.md)、Macでの公開CLI実測
- 取得日: 2026-09-12
- 確度: 公式仕様とnpm 12.0.2の実測で確認

`npm view <package> version --json`はnpm 12で単一版も配列として返す。以前のJSON文字列だけを受理する処理では、正常なregistry応答を形式エラーと判定してしまう。

実測ではClaude Code、Codex CLI、Throughlineのいずれも要素数1の文字列配列だった。工場の更新前確認と公開報告は共通の`parseNpmLatestJson`を使うため、ここで旧文字列形式と単一要素配列の両方を扱う。配列から複数版のどれかを選ぶ処理は設けず、空配列・複数版・入れ子・非文字列・不正なSemVerを拒否する。

この形式エラーだけを根拠にregistry障害や認証不足と判断しない。製品自身の自己更新が同じ症状を返す場合も、呼出元から出力を補正せず、その製品の正規入口を調べる。
