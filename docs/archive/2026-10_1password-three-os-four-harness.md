# 1Passwordの3OS・4ハーネス展開

## 承認された範囲

Mac・native Linux・Windows nativeのClaude・Codex・Grok・Cursorで公式1Passwordを利用可能にする。main-serverもLinuxのサーバー端末として対象に含む。既存のAPIキー・`.env`・SSH鍵の移行は含めない。

## 完了時点の確認

- 公式CLIをMac・main-server・rabbit・Windowsへ導入済み。rabbitとWindowsの公式アプリも導入し、開いた。
- Mac・rabbit・Windowsの4ハーネスへ公式MCPを登録済み。各端末の既存設定はtarバックアップ後に変更した。
- 公開プロトコルの起動とtool一覧はMac/rabbitで8tool、Windowsで6toolを確認。Windowsにはローカル`.env`操作がない。
- Mac・rabbit・WindowsはCLI認証、MCP認証、空の環境一覧取得が成功した。Windowsは本人のdesktop sessionから共通Python本体を実行して確認した。SSH sessionは本人のdesktopと異なり、アプリの接続確認の代用にはならない。
- main-serverは専用保管庫のService Accountによる公式CLI認証に成功した。tokenの正本は1Password、サーバーの永続値はsystemd-credsのユーザー暗号化資格情報だけで、既存login shellの環境読込から公式環境変数へ渡す。新しいlogin sessionの認証も確認した。
- Grokの数字開始のMCP登録ID拒否を公開診断で確認し、全harnessの登録名を`onepassword`へ移行した。Mac/rabbitではGrok公開診断・Cursor公開tool一覧・Claude接続確認も成功した。
- セットアップは未認証を`ready: false`・終了値3として返す。秘密を使うCLIの失敗出力も非表示にする。関連12テスト、文書検査、全CIで確認した。

## 利用開始

既に起動しているAIやshellへの初期環境は遡って反映されない。MCPは各ハーネスの再読込後、サーバーのCLI認証は新しいlogin sessionで利用する。必要な鍵の登録・移行は別の依頼の時だけ行う。

工場入口と親共通の使い方は[1Password runbook](../../shared/runbooks/1password.md)、製品仕様と観測は[調査記録](../../rag/tools/1password-codex-mcp-20261004.md)を参照する。
