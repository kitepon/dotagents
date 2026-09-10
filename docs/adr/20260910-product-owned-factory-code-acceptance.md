# 製品公開入口への工場コード切替の受入

2026-09-10。親の裁定: 工場コードの切替を受け入れ、mainへ保存・pushする。工場全体の統合完了は宣言しない。

## 根拠

製品の公開契約と担当の公開記録を照合し、工場によるMCP直接登録、Caveatの内部scaffold復旧・同期順序代行、unaiの固定pathとinstaller後の重複診断を除去した。初回・定期更新を製品公開入口へ渡し、Windows予約の工場設定再適用とreport再確定時の全件scanを除いた。4 AI、非Macのgpt-connector読取り、工場Gantt hook、Spotterのproject選択、既存の日次・週次頻度を保持する。

Grok/Cursor適用、unai、Mac/Linux入口、Throughline、cron、wire v8、予約配送、公開setup判定、report確定の関連focused試験が成功した。別ベンダーの読取り専用反証は9観点・18件の疑いを検討し、採用指摘0件で完了した。最終`make ci`は旧Lattice個別手順を要求する文書テストの不一致を修正し、当該focused成功後の再実行で終了code 0となった。

LinuxのNodeはmain-server上の隔離ディレクトリで公式nvm経路の成立を実測し、独自tarball配置を公式入口へ切り替えた。試験用ディレクトリを削除し、既存Nodeと稼働Dockerは変更していない。

## 受入の限界と続行条件

Aitermは公開済み修正版への既存MCP再接続待ち。AIShellの修正版は公開認証が失敗し、未公開。製品候補の成功を公開後成功として扱わない。

現役4端末への工場公式入口実行、公開probe、fresh reportとBugHub受入は未実施であり、工程のintegration以降は未完了のまま保持する。製品担当が公開と必要な接続を完了した後、AitermのSSHセッションから順次実行する。製品repoの修理や内部補完を工場へ戻さない。
