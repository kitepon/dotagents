# Windowsの公開呼出し修正と報告受入

2026-09-12、工場のWindows呼出しとCaveat decoderの修正を`959005b119cbb6109692256ed8772dfdc3b581a7`でmainへ反映した。[修理と個別試験](20260910-windows-public-command-boundary.md)に続く、公開後の確認記録である。4端末の統合完了は表さない。

## 公開CIでの試験修正

[初回の公開CI](https://github.com/kitepon/dotagents/actions/runs/34685748684)はMac・Linuxが成功し、Windowsの標準起動試験1件が失敗した。子processのcwdは`C:\WINDOWS\TEMP`、期待値は`C:\Windows\Temp`で、同じディレクトリを文字列の大文字小文字だけで不一致としていた。引数、stdin、環境変数はすべて一致した。

試験は実測cwdも`realpath`で解決して比較するよう修正した。渡すcwdを大文字表記にして、表記が異なる場合を明示的に確認する。Windows実機の関連小試験3件はすべて成功した。製品コードの変更やパス補正は加えていない。

## Windowsの正式な報告処理

Aitermの永続PTYからWindowsへSSH接続し、既存の工場checkoutを`git pull --ff-only origin main`で更新した。対象commitがorigin/mainの祖先であることと、工場checkoutに未commit差分がないことを確認した。

通常の公開入口を一回実行した。

```powershell
node bin/factory-reporter-v8-schedule-runner.mjs --config "$env:LOCALAPPDATA/dotagents/factory-reporter/config.json"
```

reportの生成、enqueue、flushがすべて成功し、終了codeは0だった。配送結果は`sent=1`、`retained=0`、`dead_lettered=0`、`deferred=0`、`ack_failed=0`。reportは`59bcb9db-5071-4490-a0aa-4d2f6952eaa7`、観測日時は`2026-09-12T09:27:15.707Z`、hostは`windows-workstation`、工場revisionは`959005b`である。

| 対象 | 最新reportの結果 |
|---|---|
| Caveat | 公開診断pass、導入版0.19.1、状態schema 3、migration current、compatible |
| unai | 公開診断の7項目がpass。Claude・Codex・Grok・Cursorへの配置を含む。導入版0.4.0、compatible |
| 更新履歴 | Claude・Codex・Grokのlast_updateはunverified / post_gate_failedを保持 |

BugHubの公開WebUIでも、WindowsのCaveatとunaiに同じ導入版・compatible・最新観測が表示された。ローカルJSONだけで受入にしていない。

今回の通常報告は更新処理を実行せず、更新完了用の`delivery-receipt.json`も書き換えない。同ファイルは`--finalize-update`だけが作るため、前回更新batchのreportを指す状態を正しく保持している。今回の配送はflushの結果と公開WebUIで確認した。

## 残る条件

unaiの公式installerが更新を拒否したcheckoutには、引き続き11ファイルの差分がある。`git --no-pager diff --ignore-space-at-eol --stat`は空であり、行末差分であることを再確認した。差分の破棄・補正や製品コードの変更はしていない。公開診断が合格でも、公式更新の成功とは判定しない。

AIShellは製品担当が既存Keychain利用とartifact読取りを修理しており、公開・導入・公開後smokeの完了を待つ。MacのSSH接続条件の確認、残る端末の工場導入、全4端末のfresh reportと横断受入は未完了。工程は[計画の現在地](../plan_product-owned-setup-20260909.md#現在地)を引き継ぐ。
