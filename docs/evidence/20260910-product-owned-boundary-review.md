# 工場公開入口の責務境界レビュー

2026-09-10。Grok 4.6 highを読取り専用で実行し、未commit差分と製品の公開契約を照合した。公開応答の完了を回収済み。親は下記の範囲で受入と判断する。実端末展開・最終CI・fresh reportの合格を含まない。

## 結果

初回と定期の入口、公開結果の合否、4 AI、Spotter、AIShell非対応host、Lattice製品hookと工場Gantt、unaiの固定path、report再投影、Windows境界の9観点を確認した。18件の疑いを検討し、採用すべき契約欠陥は0件だった。

| 検討した疑い | 棄却の根拠 |
|---|---|
| 定期にも製品setupが必要／Throughline・unaiが共通表にない | 定期も公開setupを呼ぶ。Throughlineは既存self-update、unaiは公式installerを使う |
| report再確定で全件scanが残る | 工場更新は今回のreport IDを渡す。IDなしの旧APIだけが従来scanを維持 |
| Windows unaiの固定path依存 | 公開commandを解決する。実PATHは実端末受入で確認する |
| Latticeの無効化やAitermの未対応終了を失敗とする | 公開された部分対応以外を完了へ丸めない契約と一致 |
| 非対応MacへのAIShell package導入／旧登録の残存 | 今回の対応条件は登録を制限する。製品登録の削除を工場が直接代行しない |
| Peertableのhost未検出／Latticeの未導入AI設定生成 | 工場が4 AI設定を配置した後に公開入口を呼ぶ |
| gpt-connector標準出力へのpackage導入ログ混入 | package導入後にsetupを呼ぶ現行順序では再導入しない |
| Windows予約でverifyが残る／Spotterの作業ディレクトリ | 工場設定の再適用を除き、既存受入とproject選択を維持する |
| AIShellの旧verify範囲／Linux試験の引数確認不足／未使用関数／計画表 | 実装された公開入口の契約欠陥の証拠にならない。未使用関数と計画記録は親が整理 |
| Latticeが工場Gantt hookを削除する | 製品は自前commandだけを置換し、工場commandを保持する |

親の照合でも、定期更新ではpackage更新と公開setupを実行し、`--setup`はSpotterの初回project選択だけを追加する。レビュー中に残っていたCursor内部登録検査は削除済みで、工場hook検査を維持した。READMEの旧Lattice個別hook手順も公開setupへ統一した。

製品が返す生出力、Windowsの実command解決、公開後の4端末受入は実行前であり、引き続き未検証として保持する。
