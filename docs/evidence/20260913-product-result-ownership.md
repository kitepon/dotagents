# 製品の公開結果を工場が再判定しない修理

2026-09-13 JST。工程正本は[製品所有の導入入口へ戻す改修](../plan_product-owned-setup-20260909.md)。既存の所有境界を実装へ戻す作業であり、新しい規範の追加ではない。

## 原因と修理先

製品の実際の不具合は各製品repoで修理した。工場が正常な公開結果を独自の形式・内部状態検査で拒否していた不具合はdotagentsで修理した。

| 製品 | 公開済みの修理 | 公開記録 |
|---|---|---|
| UNAI | Windows installerのGit改行設定 | [v0.6.3](https://github.com/kitepon/unai/releases/tag/v0.6.3) |
| Throughline | npm 12のview・pack JSON形式 | [v0.10.17](https://github.com/kitepon/Throughline/releases/tag/v0.10.17) |
| gpt-connector | Windowsの公式tar呼出し | [v0.5.3](https://github.com/kitepon/gpt-connector/releases/tag/v0.5.3) |
| Caveat | Codex hooks設定の有効判定 | [v0.19.2](https://github.com/kitepon/Caveat/releases/tag/v0.19.2) |
| Spotter | MCP設定の読取り、npm 12、Windows権限設定、評価DBの同時初期化 | [v1.6.4](https://github.com/kitepon/Spotter/releases/tag/v1.6.4) |

上記の公式更新はMac・Windows native・main-server・rabbitで成功済み。直後の工場報告はSpotterの正常なschema 1.1を旧readerが拒否し、製品更新成功を追加gateの失敗へ変えていた。

## dotagentsの変更

- `verify-install`から製品CLI、MCP登録、製品hook、製品診断の再検査を除去した。工場所有のファイル・hook・互換入口・退役製品の配置確認を維持した。
- Mac・Linux・Windowsのsetupと現行schedule runnerは、製品結果を導入gateへ再利用しない。工場報告のhost・wire・製品ID集合と、今回の配送receiptを確認する。
- Spotterの`compatibility_status`、各製品のoverallをそのまま記録する。内部checkの再集約、未使用のschema世代・vendor一覧・DB内部値・privacy宣言の検査を除去した。記録する値の型・公開終了コード・出力の秘密非混入は工場の報告処理で確認する。
- PeertableとUNAIのcheck名を固定せず、公開されたcheckを記録する。製品が示した失敗・未対応・未検証を成功へ書き換えない。
- gpt-connectorとLatticeのsetupは製品自身が返す`partial`を記録する。内部のOS・host別状態から独自の成功条件を作らない。
- 製品installerの失敗と工場の報告生成・配送失敗は、従来どおり更新ログに別々に記録し、処理の非0終了を保持する。

## 個別検証

製品overallと詳細checkが一致しないfixtureでも、工場がoverallを上書きせず、記録対象の失敗checkを保持することを確認した。未使用fieldにpathが含まれても転送しない。公開結果と終了コードの不整合、読取対象の未知状態、CLI不在は識別して報告する。

Mac・Linux server・Linux workstationの隔離setup試験、Windowsの報告目録試験、製品CLIを追加呼出ししない工場配置試験、現行v8の更新報告試験が成功した。旧Caveat試験に残っていた「未使用field追加で拒否」の期待を、共有readerの責務に合わせて更新し、失敗した2件だけを再実行して成功した。

Macの隔離試験では、同じ秒のバックアップ作成が衝突するdotagents自身の欠陥も再現した。macOSの`mktemp`は`XXXXXX.tar.gz`をランダム化せず、そのままの名前で作成していた。テンプレート末尾を`XXXXXX`に直し、時刻を固定した3回のsetupが成功した。運用上の待機や再試行は追加していない。

## 別ベンダー反証

Grokの読取り専用反証を2026-09-12 15:26:31 UTCに回収した。対象は未commit差分と現役v8から到達するreaderで、採用すべき実欠陥は0件。公開結果の型・終了コード契約と、不要な内部再集約を区別して確認した。工場所有のBugHub外部probeの自己検証、退役wire専用readerは今回の製品診断再集約とは区別した。

## コードの受入

旧clean-home試験が製品のOS・CLI・hookを工場で再検査させていたため、その試験と製品用fixtureを撤去した。工場自身の配置・設定・hookの試験は維持し、`make test-install`が成功した。

最終`make -k ci`は2026-09-12 15:40:05 UTC開始のAIShell run `DC1BF944-48DE-4CBC-8220-84EAFA9DC7DE`で全gateを実行し、終了コード0で成功した。`-k`は失敗時も残るgateを実行する指定で、失敗の無視やskipは行わない。

修正版dotagentsの4端末への展開と公開WebUIでの配送結果は、公開後の受入記録へ残す。この記録はコードの受入時点で確定する。
