# 1PasswordとCodexの公式MCP連携

取得日: 2026-10-04。確度: 機能と設定方法は公式資料、3OSの起動・公開tool一覧・CLI/MCP認証・環境一覧取得は実測。既存のCodexチャットのtool再読込は未確認。

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

## 3OS・4ハーネス展開の観測

Mac・main-server・rabbit・Windowsへ公式CLIを導入した。rabbitは公式APTのdesktopアプリ、Windowsは公式wingetのMSIXアプリを導入した。Mac/rabbit/WindowsのClaude・Codex・Grok・Cursorへ、同じ公式MCPのstdio入口を各ハーネスの公開登録方法で設定した。

Windowsの公式MCPも初期化・tool一覧取得に成功した。Mac/Linuxは8tool、Windowsは6toolで、Windowsにはローカル`.env`作成と一覧がない。公式Claude/Cursorプラグイン資料のWindows対応記述と、Windows同梱resourceのMCP入口記述には不一致があるため、MCPの起動実測と認証成功を分ける。Windowsの本人認証・空の環境一覧取得も、本人のdesktop sessionから成功した。SSHはdesktopと異なるsessionで、本人のアプリが動く面からの接続を直接代替できない。

main-serverはGUIを持たず、公式MCPのdesktop認証が成立しない。専用保管庫だけに読書きできるService Accountを公式CLIで作成し、tokenの正本を1Passwordへ保存した。永続値はOS標準のユーザー暗号化資格情報だけとし、既存login shellの初期環境へ公式認証変数を渡して、新しいsessionでCLI認証が成功した。Service Accountは個人契約でも使えるが、組込み個人保管庫へはアクセスできず、Environmentsへの権限は読取だけである。

Grokの公開診断は、数字開始のMCP登録名`1password`を理由に全toolをsessionへ取り込まなかった。登録名を4ハーネス共通の`onepassword`に直すと、Mac/rabbitのGrok公開診断が成功した。Cursorの公開tool一覧とClaudeの接続確認も成功した。

- [公式CLI導入](https://www.1password.dev/cli/get-started)
- [Linux公式導入](https://support.1password.com/install-linux/)
- [公式認証方式](https://www.1password.dev/get-started/build-integrations)
- [Service Accountの作成と制約](https://www.1password.dev/service-accounts/get-started)
- [Service Accountの利用枠](https://www.1password.dev/service-accounts/rate-limits)
- [Claude公式プラグインの対応条件](https://www.1password.dev/environments/claude-plugin)
- [Cursor公式プラグインの対応条件](https://www.1password.dev/environments/cursor-plugin)
- [systemdの公式資格情報仕様](https://github.com/systemd/systemd/blob/v259/man/systemd-creds.xml)
