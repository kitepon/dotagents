# 1Password

公式CLIの`op`をMac・Linux・Windows nativeで共通に使う。必要な認証情報は`op run`で実行するプログラムへ渡し、値を会話・ログ・コマンド引数へ表示しない。認証情報を使う目的と対象は現在の依頼から判断する。

Environmentsの作成・一覧・変数名の確認には、登録済みの公式`onepassword` MCPを使える。MCPは秘密の値を返さず、一般のログイン項目の管理はCLIが担当する。MCPが未登録・非対応・失敗ならその状態を明示する。

新しい端末への接続設定は、POSIXでは工場の`setup-1password --profile mac|linux|server`、Windows nativeではPowerShell 7でrepoの`bin/setup-1password.ps1`を使う。本人不在時は`--configure-only`で導入と登録だけ行い、認証待ちを明示する。通常入口は認証と一覧取得まで確認し、未認証なら成功にしない。端末の本人認証は1Passwordアプリ、画面のないサーバーの認証は1PasswordのService Accountが所有する。パスワードやSecret Keyを会話へ入力してもらわない。

画面のないLinuxサーバーでは、login shellへ1Passwordのtokenを渡さない。共有保管庫`開発工場`を読むのはBellTeamだけで、サーバーは下の無人実行の端末用読取専用Service Accountだけを使う。

無人実行（cron・ScheduledTask・自動起動）は1Passwordを任意で使える。端末ごとの読取専用Service Account（その端末専用の保管庫だけ）のtokenを、各端末で`setup-1password --profile <profile> --store-unattended-token`（Windowsは`bin/setup-1password.ps1`）へ隠し入力かstdinで渡すと、Mac Keychain・Linux systemd-creds（`~/.config/dotagents/credentials/1password/unattended.cred`）・Windows DPAPI（`%LOCALAPPDATA%\dotagents\credentials\1password\unattended.dpapi`）へ保存する。保存前に`op whoami`でService Accountと確かめ、保存後に読み戻す。利用側はenv fileへ`NAME=op://<保管庫ID>/<項目ID>/<field>`を書き、`dotagents-op-run --env-file <file> -- <command> [args...]`で起動する（Windowsは`node <dotagents>\bin\dotagents-op-run.mjs ...`）。参照だけを読み、平文の値はそのまま渡す。読めない時は子を起動せずexit 2で名前付きのエラーを出し、子はService Account tokenを受け取らない。token漏洩時はその端末のtokenを再発行し、その端末で同じ保存を再実行する。

MCPの登録名は全harnessで`onepassword`を使う。GrokのMCP識別子は数字開始を受理しないため、製品名の`1Password`を登録IDにしない。

既存の`.env`やSSH鍵の移行は、移行を含む依頼の時だけ行う。Watchtowerの`.env`インポートは元ファイルを削除し、マウント時は読取に1Passwordが関わるため、利用プログラムと自動起動への影響を確認してから移す。

- [CLIと認証の公式手順](https://www.1password.dev/cli/get-started)
- [プログラムへ秘密を渡す公式手順](https://www.1password.dev/cli/secrets-scripts)
- [公式MCP](https://www.1password.dev/environments/mcp-server)
- [Service Accountの権限と制約](https://www.1password.dev/service-accounts/get-started)
