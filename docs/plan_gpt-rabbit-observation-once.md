# Rabbit一台の任意報告内訳・一回gate

担当はドロシー。中央受理/表示はFr、製品package供給と退路原本は紅蓮が所有する。現在は申請前の準備sourceであり、host操作・Owner申請・実report・POSTは実行していない。工場のDEFAULT entryは閉じたまま。

## 対象と絶対窓

対象はhost_id=rabbit、product_id=dotagents-rabbit、owner=bellteam/bot-62c62f61だけ。inventory UUIDは中央の必須fieldではなく、未記載だけでは進行を止めない。kite/uid1000、checkout `/home/kite/Developer/dotagents`、state pathはhistorical expected valuesである。本人許可後・変更直前に実principal/path/source/revision/設定identityを読み戻し、不一致・競合・不明なら変更前に停止する。Linux nativeのimageはcontainer imageではなくnative/no-containerとして確認する。

製品は0.16.5/main88b3541f402cf71d8300eb6916d0e4d74ec59662、公開tarball SHA256 f8049d24ba21dbea60dbcf8551d56c373c7df307b4af8ece0cd6af7e04e6e355。台帳d1の実npm artifactへ代用しない。

すべて2026-10-25 UTC。package作業は19:45開始、導入完了上限20:05、失敗時の退路完了上限20:10。同hostの成功供給receiptを20:15より前に確定できた場合だけ、通常毎時17分の20:17報告を一回使う。capture/sendの窓は20:15–20:25。窓超過・供給不明・競合時は閉を保ち、自動再予約・追加probe・二回目diagnostics・再送をしない。report UUID 5efde8ae-4cff-4041-bc5f-9f77bf0c3216は予約値であり、生成済みreportではない。

## 許可と一回消費

旧Caveat K-7FDPGM/K-24JWXQ、Fox package-only、4host inventoryから許可を拡張しない。両担当の固定source/CI/package退路をscope照合した後に、Rabbit一台の本人申請を一件だけ用意する。新しい許可はfactoryの固定mainへの正規source-only反映、実行前readback、紅蓮のpackage導入一回/同範囲の退路一回、既自然report一回のopt-in保全とPOST attempt最大一回を明示する。fresh供給receiptは申請前の前提ではなく、許可内の実行後に取得する。

`rabbit-observation-scope.json`が候補対象/窓/上限/私有pathの正本。permitはsource selector用の所有者供給事実であり、承認・供給・信用の独立証明器ではない。準備templateをapprovedとして保存しない。実回答とreadback/供給原本を照合した担当者だけがowner-only rootへapproved-permit.jsonを作る。現時点ではそのfileもrootも存在させていない。

通常v9 schedulerの通常collectionだけがscannerへ専用引数を渡す。post-update/finalize-updateと旧majorは対象外。引数単独、env/config、report内容では開かない。Linux/uid/対象/窓、同scope SHA、本人decision ref、現host readback、同factory revision、製品成功receiptと四つの採用事実が揃うと、外部native呼出しより前にcapture.claim.jsonを排他的作成・fsyncする。欠測は元argvの通常一回へ戻る。claim部分保存も二回目を許さない。既native一回のargvだけにbooleanを足し、同一結果を既projectorへ渡す。

元report host/時刻/版/check/status/reason/overall/auth_required→skippedは保持する。report_idだけを事前予約UUIDに結び、正文JSON+LFを一回生成する。保存前/reader/enqueue/decode/send前は同validatorで原文一致を確認する。元本文はcaptured-report.jsonへ非置換保存する。

POSTより前にsend.claim.jsonを排他的作成・fsyncする。redirectはerrorとし、redirect先への二回目POSTを許さない。失敗・timeout・応答不明・ack失敗はraw本文とoutbox envelopeをheld-outbox.jsonへ保持し、自動retry queueから外す。通常の別report/host/旧majorのretry契約は維持する。受理済み表示はFrの同ID/bodySHA確認が別に必要で、HTTP判定だけで中央表示完了にしない。

## 私有保存先と退路

rootは `/home/kite/.local/state/dotagents/factory-reporter-v9/gpt-observation-once-20261025T2017Z`。既principal所有、directory0700/file0600、symlink拒否。packageは子 `package-supply/stage`、`package-supply/before`、`package-supply/receipts`を使う。紅蓮のpackage退避は元package全tree/依存と二CLI入口をreadbackし、失敗時同範囲を一回復元する。旧0.16.3を今回の復帰先と推定しない。工場gateの退路はpermitを無効にしてDEFAULT閉へ戻す。claim/raw/既log/outboxを消して再試行しない。Node、信用、auth、MCP-hook、製品設定、他writerを変更しない。

## 検証と残条件

新8groupは専有temp/privateFSとsynthetic report/permitだけ。既production postOne関数の新分岐をfake fetchで実行し、ネットワーク失敗後の保持と二回目fetch0、redirect:errorを確認した。旧成功群の任意再走・実host/probe/HTTP/credentialは0。通常PR CIは別の必須gateとして全5job/3OSを確認する。

| OS | Claude Code | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| Linux | Rabbit限定候補、実host未実行 | 同左 | 同左 | 同左 |
| macOS | 今回gate対象外 | 同左 | 同左 | 同左 |
| Windows | 今回gate対象外 | 同左 | 同左 | 同左 |

未成立は最終source通常CI/統合、双方scope照合、本人回答、許可内readback/供給receipt、一回reportと中央同ID受理/表示。receipt=[]、実非空report0、実正文SHA=nullを維持する。
