# 1PasswordとCodexの公式MCP連携

取得日: 2026-10-04。確度: 機能と設定方法は公式資料、Macの起動・公開tool一覧・認証・環境一覧取得は実測。Codexの新しいチャットでのtool読込は未確認。

## 出典

- [公式MCP手順](https://www.1password.dev/environments/mcp-server)
- [公式CLI手順](https://www.1password.dev/cli/get-started)
- [公式Codex連携の説明](https://1password.com/blog/1password-trusted-access-layer-for-openai-codex)
- インストール済み公式MCPが返した`getting-started`と`environments-guide`の公開resource。

## 機能の違い

公式MCPは1Password Environmentsの作成・一覧・名前変更、環境変数名の一覧と追加、ローカル`.env`のマウントを提供する。保存した秘密の値はMCPの読取結果へ返さない。一般のログイン項目の検索・登録は公式CLIの役割である。

公式MCPの設定と認証は1Passwordアプリが所有する。Codexへの登録は公式のMCP設定入口で行う。手順や必要条件の正本は上記公式資料を参照する。

## Macでの観測

- アプリ同梱の公式実行ファイルからMCPの初期化とtool一覧取得に成功した。PATH上にコマンドがない場合の同梱実行ファイルの指定は、公式MCPの公開resourceに記載されている。
- `authenticate`は「1Password desktop app is not running」というエラーを返した。アプリのプロセスが存在する状態でも同じエラーを観測したため、プロセスの存在だけではMCPの認証受付を確認できない。
- Jevによる設定画面操作はagent-desktopのOSアプリ一覧取得が失敗して停止した。1Passwordの設定変更は未実施。
- 本人が提示した設定画面でMCPクライアントとの統合が有効であることを確認。その後、公式MCPの`authenticate`と`list_environments`が成功した。環境一覧は空だった。初回エラーの内部原因は未特定。
- Codexの公式`mcp add`で登録を確認した。実測は登録した同じ公式実行ファイルに対するMCPプロトコルで行った。進行中のチャットの道具一覧には追加されたMCPがまだ含まれず、Codexの新規チャットでの読込は未確認。

アカウントID、環境名、認証情報はこの記録へ保存していない。
