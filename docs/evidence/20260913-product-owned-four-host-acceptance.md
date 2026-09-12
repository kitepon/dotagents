# 製品所有の導入入口と4端末の受入

2026-09-13 JST。工程正本は[製品所有の導入入口へ戻す改修](../plan_product-owned-setup-20260909.md)。製品の修理・公開記録と工場の再判定撤去は[コードの受入](20260913-product-result-ownership.md)を参照する。

## 工場の修理

`cf4f0c87cdc53947d1109ed6ef2952bed3ddd0bd`で、製品の公開結果を工場が再集約する処理と導入後の追加検査を除去した。製品の公式入口が返す失敗・部分対応・未対応は公開結果として記録し、工場の成功条件へ作り替えない。

Windowsへの実展開では、dotagents自身に次の不具合を再現し、同repoで修理した。

- `7971d56d16a546c0c2a0d89dd29770f51d0f13ae`: setupが正常な`python`を使う一方、verify-installは別の`python3`リンクを呼んでPermission deniedになっていた。Windowsの標準Python入口を揃えた。実機で`python --version`は成功し、`python3 --version`だけが失敗することを確認した。Pythonや製品の管理状態は手補正していない。
- 同commitで、Unixの実行権限変更へ依存していた工場wrapperの試験を、全OSで成立する欠落試験へ変更した。
- `3bda82a41502c14fe3801a94dc244a0f36776e4b`: 工場hook登録時にPATH上の`bash`を探し、WSLの`C:\Windows\System32\bash.exe`を登録していた。Windows工場setupが使うGit for Windowsの標準入口に揃えた。正規の設定適用コマンドがbackupを作成した後、Windows実機のverify-installが終了コード0で成功した。

## 検証

工場の再判定撤去は、別ベンダー反証が採用0件、ローカル最終CIが終了コード0で成功した。Windows補修の関連`make test-install`はAIShell run `FFC2F052-174D-41AE-A6F3-72BB5E8AB41E`と`0CC9449D-EAFE-4E16-B6E0-5BF79E49DEA3`で成功し、factory-coreとshell/Python構文検査も成功した。

公開CIの初回はWindowsのUnix実行権限fixtureで失敗した。Mac・Linuxは成功。fixtureとPython入口の修正後は[3 OSの公開CI](https://github.com/kitepon/dotagents/actions/runs/34703661723)がすべて成功した。Git Bash登録の修正を含む[最終公開CI](https://github.com/kitepon/dotagents/actions/runs/34703817239)もMac・Linux・Windowsと最終gateがすべて成功した。

## 正規セットアップと配送

MacはAitermから直接操作し、別端末への接続だけにSSHを使った。製品の公式更新は全端末で成功した。

| 端末 | 正規setup | report_id | 配送 |
|---|---|---|---|
| Mac | 終了0、00:48:55 JST | `85d6049d-de4a-4082-913f-d640fcc0dde3` | 今回のbatchと受理receiptが一致 |
| main-server | 終了0、00:48:23 JST | `e0a7bd52-49d0-43c6-9c44-fa8e01f66bfc` | 今回のbatchと受理receiptが一致 |
| rabbit | 終了0、00:48:14 JST | `53aeb6de-8985-45ac-a0cc-8cc852b78112` | 今回のbatchと受理receiptが一致 |
| Windows native | 手動工程成功、予約実行終了0、01:09:13 JST | `0fb05034-3f2b-467b-8efa-9d127805134e` | 今回のbatchと受理receiptが一致 |

Mac・main-server・rabbitのsetupは報告目録15製品と工場の配置を確認した。Windows補修後のrepoは4端末とも`3bda82a`へ揃えた。Macの既存Cursor変更2件とrabbitの読取許可差分は保持した。

Windowsの初回予約実行では、npmが`codex-sidecar.ps1`を置換する際にEBUSYで失敗した。対象ログは`run-b1798154-10d6-4a5d-8426-c872ce5f2f11.log`、失敗batchは`67873463-e97e-4af0-b793-4e0edcb8f0ee`で、製品更新失敗と報告配送成功をそのまま記録した。公式の`npm install -g codex-sidecar-cli`は単独実行で終了0となった。ロック保持プロセスは未特定であり、原因不明の製品変更や工場の再試行分岐は追加していない。

登録済みタスクを01:07:01 JSTに再実行し、01:09:13 JSTに正常終了した。Task SchedulerのLastTaskResultは0、次回は02:00 JST。新規のsetup receipt `567de174-4389-4926-87fb-bcb019d41f12`はscheduled_run=true、delivery_acknowledged=true、verify_install=passed、reported_products=15を示した。配送batchは`5f153a3f-bacb-4760-bdb5-fa52d86d7c6f`。先行する手動工程の報告`912b280d-6fec-4bda-9291-a01a45666bb6`も受理済みである。初回の外側setup呼出しが非0だった履歴と、再実行した登録タスクの成功を区別して受入した。

## 公開画面

[BugHub](http://192.168.1.2:39310/)の工場状態を実際に更新し、4端末すべてでSpotter 1.6.4、Throughline 0.10.17、UNAI 0.6.3、Caveat 0.19.2がinstalled／compatibleとして表示されることを確認した。gpt-connector 0.5.3は全端末で導入済みであり、Macのcompatibleと非Macのlive機能unsupportedを保持している。過去の記録を新しい実測として扱っていない。

Windows予約実行後にも画面を更新し、新しい観測としてSpotter・Throughline・UNAI・Caveat・codex-sidecarの導入とcompatible表示を確認した。製品の修理・公開・公式導入、工場の責務修理、4端末の報告配送、Windowsの予約実行、公開CIを受入完了とする。npmの一度のファイルロック保持者は未特定であり、恒久修理したとは記録しない。
