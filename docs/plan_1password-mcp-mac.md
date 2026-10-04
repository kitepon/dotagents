# このMacの1Password公式MCP接続

## 承認された範囲

このMacで公式MCPをCodexへ登録し、本人認証と開発環境の一覧取得を確認する。APIキーの移動や全端末への展開は含めない。

## 現在地

- Codexの公式`mcp add`で`1password`を登録済み。設定変更前のtarバックアップを端末の`/tmp/codex-1password-config-backup-20261004.tar.gz`へ保存した。
- 公式MCPの起動、初期化、8つの公開toolと2つの説明resourceを確認済み。
- 公式MCPに対する本人認証と環境一覧取得は成功。開発環境は0件。初回の認証エラーの内部原因は未特定。
- Jevの画面操作はOSアプリ一覧取得で失敗。本人から提示された画面でMCPクライアントとの統合が有効と確認し、その後に認証が成功した。設定操作のApproval Box申請は取り下げ済み。
- 進行中のチャットの道具一覧には追加したMCPがまだ含まれない。Codexで再読込後の確認だけが残る。

## 再開時

1. Codexで接続を再読込し、必要なら本人が開いた新しいチャットで公式MCPが見えることを確認する。
2. 公式toolとして環境一覧を取得する。1Passwordが認証を求めた場合だけ本人へ操作を依頼する。
3. 結果を[調査記録](../rag/tools/1password-codex-mcp-20261004.md)へ反映し、この計画をarchiveへ移す。

設定と認証の正本は[1Password公式資料](https://www.1password.dev/environments/mcp-server)を参照する。
