# Windowsのnpmファイルロックの残件調査

2026-09-13 JSTの観測記録。原因調査は未完了であり、修理済みとは判定しない。

## 完了報告の訂正

公式更新と予約実行が復旧したことを根拠に、依頼全体を「残作業なし」と報告したのは誤りだった。ロック保持者が未特定である以上、原因調査と必要な修理は残件とする。[工程正本](../plan_product-owned-setup-20260909.md)の現在地を訂正した。既存の受入記録は当時の実績として保持し、全体完了の根拠には使わない。

## 当時のログ

- 失敗した予約実行は`run-b1798154-10d6-4a5d-8426-c872ce5f2f11.log`。開始は01:01:32、PowerShellのPIDは39584。
- 01:01:57に開始したnpmが、`codex-sidecar.ps1`を一時名へrenameする際に`EBUSY`、`errno -4082`で失敗した。元のnpm詳細ログは今回の調査時点では存在せず、予約実行のtranscriptにエラー本文が残っていた。
- [当時のWindows CI](https://github.com/kitepon/dotagents/actions/runs/34703817239)は01:01:46開始、試験工程は01:01:53から01:07:42まで動作していた。PowerShellCoreイベントにもCI checkoutからの`-PlanOnly`実行と、コマンド探索の記録がある。更新とCIの同時実行は確認できるが、これだけで保持者は特定できない。
- PowerShellCore/Operationalは有効。TaskScheduler/Operationalは無効、Sysmonのログは存在せず、該当時間のSecurityイベント4688も取得できなかった。

## 短い再現試験

[Microsoft公式のProcess Monitor](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon)を一時ディレクトリへ取得し、Microsoft署名が有効であることを確認した。ファイル操作とプロセス作成を25秒間記録した。

`tests/factory-scan/v8-caveat.test.mjs`と、公式の`npm install -g codex-sidecar-cli@0.3.13 --logs-max=100`を並行実行した。npmは01:48:05に終了0、試験も1件成功・終了0だった。今回の記録では対象ファイルに対する`SHARING VIOLATION`は0件で、01:48:03.9554025のrenameも成功した。元のEBUSYは再現していない。

対象ファイルに関する147件のイベントから、次を確認した。

- 試験の子PowerShell（PID 43916と40292）が、実環境の`codex-sidecar.ps1`を読んでいた。PID 43916の起動元は試験プロセスで、コマンドは`Get-Command -Name codex-sidecar -CommandType Application,ExternalScript -TotalCount 1`だった。
- `CreateFile`に`Generic Read`と`ShareMode: Read`が記録されている。読み込み中のrenameと競合し得る観測だが、今回その競合による失敗は起きていない。
- 疑似コマンドの解決先だけを調べる単独試験では、`.cmd`だけを置いた場合も、その疑似`.cmd`を返した。疑似`.ps1`を追加した場合は疑似`.ps1`を返した。実製品のスクリプトを読んだことと、実製品を実行したことは同義ではない。
- Defenderの`MsMpEng.exe`とSystemにも対象ファイルへのアクセスがあった。いずれも当時のロック保持者と断定できない。

製品・工場のコードは変更していない。Process Monitor、CSV出力処理、試験プロセスは終了を確認した。

## 証跡と残件

Windowsの一時ディレクトリ`dotagents-npm-lock-e7cdc100f96149398e419b42f6ef24fb`に、元のPML・CSV、対象ファイルの抽出CSV、プロセス作成の抽出CSV、試験出力を保持した。

| 証跡 | SHA-256 |
|---|---|
| `sidecar-file-events.csv` | `5e7b0e7b4b05b19489c85752c4b92b5d5219c591d8606e6729ec038b2822bbc2` |
| `lookup-process-events.csv` | `c3bcacaf7506ddfbb803778592ec01f0de4d6c3111316f1c7c436095ccfd6f62` |
| `focused-test.stdout.log` | `202713c24a0d90b1667de49e7d4550ce249f669766738105ff591e5fea15ae06` |

残件は、EBUSYが再現した時点で、失敗したrenameと、競合するファイルを開いたプロセスを同じ記録から特定すること。その結果に基づいて所有者と必要な修理を決める。今回の再現試験が成功したことを、元の原因が解消した証拠にはしない。
