# 09_feature-map — 機能・状態・接続の現状図

Dotagents全体の図起点リファクタリングの作業中資料。対象基準はmain `9fca2c8bf002b9b0ac8bd22d13d8076142a02ff5`。図は実コードの確認範囲を示し、製品全体の調査完了を示さない。

規範生成とHOME配置の既存概要図は[READMEの構成](../README.md#構成)を正本のまま使う。本ページはその図から、処理順・状態所有・失敗/取消・実ファイル/関数へ辿る入口を補う。内部の詳細は各機能ページだけを正本にし、全体へ複製しない。

## 現在の全体接続索引

実線は最初のまとまりで本文確認した接続、破線は既契約・実装索引に存在するが全体の詳細本文確認をまだ終えていない接続。図中のノード名はsource上の機能を指す。破線は新しい設計や実運用接続の許可を表さない。

[全体図の描画物](feature-map/overview.svg) / [Mermaid原本](feature-map/overview.mmd)

## 機能詳細・実装対応

| 機能 | 実装の入口 | 詳細と現在の確認範囲 |
| --- | --- | --- |
| 規範生成とリンク配布・verify | `bin/render-global-constitution.mjs`、`install.sh`、`bin/verify-install.sh` | [導入・配布](feature-map/installation.md)。本文確認済み、全失敗/実OS動作を実証済みとはしない |
| 親別config applier | `bin/apply-{claude,codex,grok,cursor}-config.sh`、`lib/hook-command.py` | 導入詳細へ既存責務と書込/rollback境界を索引。各変換関数の全本文確認は未完 |
| host setup | Mac/Linux common/Windows nativeの`bin/setup-*factory*` | install/config/verifyのcaller部分を確認。前提導入・enrollment・SSH/runner等の全本文は未調査 |
| 親別hook・skill・model選定 | 4harness面、`lib/pick-model.mjs`、各bin/hooks | 配布接続のみ。全skill内tools・hook発火・model選択の本文は未調査 |
| source同期/日次更新 | `bin/agents-source-update.mjs`、`bin/agents-update.sh` | 既契約/前回索引から接続。更新/部分失敗/確定/取消の詳細図は未作成 |
| 製品公開setupと任意連携 | `lib/factory/product-setup.mjs`、`typesafe-setup.mjs`、`jev-setup.mjs`、`bin/setup-1password.sh` | 公開入口/製品境界の索引。1Passwordの既定skill配布は現在挙動として保持、修理を混在しない |
| 日次/毎時scheduler | `bin/agents-update-scheduler.mjs`、`bin/factory-reporter-scheduler.mjs`、`lib/factory/windows-scheduler.mjs` | 既契約/索引。OS登録/中断/実行中取消/hidden launcherの詳細本文は未調査 |
| 製品公開診断と投影 | `lib/factory/scan.mjs`、`v9.mjs`、`command.mjs` | 既契約/索引。profile・privacy・timeout/子終了の全分岐は未調査 |
| 毎時runner/台帳確定/receipt | `bin/factory-reporter-v9-schedule-runner.mjs`→v5共通runner、`bin/factory-toolchain-ledger.mjs` | 既契約/索引。contender/state/台帳pending/終端receiptの詳細本文は未調査 |
| outbox/送信/ACK/保持 | v9→`bin/factory-reporter-v5.mjs`、`lib/factory/report-fragments.mjs`、`delivery-receipt.mjs` | 既契約/索引。応答不明/413/ACK失敗/回復・取消の詳細本文は未調査 |
| GPT台帳writer/排他/観測 | `lib/factory/deployment-writer.mjs`、`core-authority-sources.mjs`、`update_context_*` | source受入済みとlive/issuer/store/resource未確定を区別。図のために実接続を始めない。詳細本文は未調査 |
| CI・公開・配布接点 | `Makefile`、`.github/workflows/`、`scripts/dotagents-ci-plan.mjs` | 本まとまりのcaller/test入口を確認。全gate/比較base・公開契約の意味確認は未完 |

全tracked pathの機械索引は漏れを探す入口であり、意味確認の完了数には数えない。動的dispatch・alias・外部repo caller・実OS状態・各親の実session認識は未確定。

進行と完了条件は[今回の工程](plan_feature-map-refactoring-20261103.md)。1Password任意化の挙動変更は全体リファクタの完了後、別差分で扱う。
