# 製品所有の導入入口へ戻す改修

## 目的と承認

2026-09-09、オーナーは監査で確定した問題の全実装と、変更製品の文書更新、commit、push、release、npm導入、実機確認までを承認した。工場が製品の不足を補う実装を除き、単体でも成立する正規入口を製品へ戻す。npm以外の製品は、その製品の公式配備入口で届ける。

複数repoの書込み調整と公開後受入が連鎖するため統括レーンとする。工程正本は本書。Lattice工程管理は選択していない。通知修理はServerManagerの既存計画を継続する。

## 受入条件

- 製品は必要な設定、hook、MCP登録、移行、OS差を所有し、正規入口の一回の呼出しで結果を返す。
- 初回、再実行、更新、既存設定からの移行、所有外設定の保持、対応外OSの明示を製品側で検証する。
- dotagentsは対象の選択、公式入口の呼出し、自身の配置、予約、公開probeの確認を所有する。
- 変更製品の全ドキュメントを点検し、変更に影響する案内を同期する。既定ブランチへ着地後にreleaseし、npm製品は公開packageの導入とsmokeを行う。
- 現行機能、既存の日次・週次通知と更新頻度、親モデル設定を維持する。未実行・未対応・失敗を完了へ丸めない。

## 実装と受入の一覧

| 対象 | 修理内容 | 完了条件 | 状態 |
|---|---|---|---|
| Linux前提導入 | Docker配布の強制置換を除去。不足packageだけ導入。Node公式導入経路の成立条件を実測 | 既存Dockerを保持するfocused test、対象host確認 | 着手 |
| runner | 既存runnerへの不要な再設定と403後の誤った継続を整理 | 変更が必要な場合だけ設定し、権限不足を元の原因として表示 | focused検証済み |
| Caveat | 製品の一括入口へ統一し、工場の内部scaffold復旧を削除 | 公開packageで既存復旧機能を照合し、初期化・再実行を検証 | 4 AI登録を実装、隔離設定で初回・再実行・MCP検索を確認、公開前検証中 |
| Throughline | 未導入時の更新順序を修理 | 初回導入と既存更新がそれぞれ製品入口で完了 | Linuxの初回・再実行・失敗のfocused試験済み |
| unai | 工場の固定pathと詳細診断の重複を整理 | 公式installerの公開結果だけで判定 | 未着手 |
| Aiterm | 製品所有の準備・MCP登録入口 | 対応OSと各AIで単体導入を検証 | 公開・npm導入・4 AI実設定・公開MCP実行確認済み、修正後3 OS CI成功 |
| gpt-connector | 製品所有の一括setup入口 | 非Macの読取り機能を保ち、live機能のOS制約を明示 | 未着手 |
| codex-sidecar | 製品所有の登録入口と機能別OS境界を整理 | 既存3 package更新契約を維持し、単体登録を検証 | 未着手 |
| AIShell | 製品所有のMac導入・登録入口 | 対応hostだけ登録し、非対応hostへ工場が登録しない | 未着手 |
| Lattice | 製品MCP登録入口とWindows hookの扱いを整理 | 製品未対応を可視化。工場Gantt hookとの別責務を維持 | 未着手 |
| Peertable | skill導入入口、Aiterm内部namespace・multiplexer依存を公開APIへ整理 | 製品所有setup、OS別runtime focused test | 未着手 |
| 工場共通 | 製品MCPの直接編集・OS別補完を除去 | 製品公開版の導入成功後に切替、4 AIの既存機能を確認 | 未着手 |
| 更新と待機 | 初回・定期更新の順序、重複した全件診断、全setup再試行を整理。工程・経過時間・待機理由を表示 | 処理回数と所要時間を計測し、頻度を変えず受入 | 未着手 |
| ServerManager/BugHub | 新着だけの通知、配送状態の永続化、退役hostと履歴版表示を修理 | 所有repoの既存計画、配備入口、公開後smokeで受入 | 中断作業を継続 |

Spotterは既存project単位の入口を保持する。製品側の不足が確認されていないため、無関係なglobal自動有効化は追加しない。

## 順序と責務

2026-09-09の追加指示により、各製品フォルダで起動したAIが、その製品の修理・公開・単体検証を担当する。
dotagentsのAIは最後に製品の正規入口を使う工場改修と横断受入を行う。各製品担当は別製品repoを変更せず、
依存の不足をその所有製品へ返す。実装と隔離試験は並行できるが、同一端末の共有設定への本番導入は順番に行う。
引継ぎ文は[製品ごとの改修依頼文](evidence/20260909-product-repair-prompts.md)を使う。

各製品を先に修理・公開・導入し、その公開入口に工場を切り替える。責務境界を動かす設計は別ベンダーの反証を公開前に受ける。最後に工場の関連gateと対象hostの通し確認を行う。契約ごとのfocused testが通る前に通し試験を動作確認へ使わない。

## 既知の罠と戻し方

- 作業開始前からあった`codex/rules/default.rules`の読取許可は、追加指示により別commitへ保存済み。
- ServerManagerの通知修理は既存の作業ブランチへcommit・push済み。差分を引き継ぎ、他のcheckoutで作り直さない。
- Linuxの以前の実行でDocker CEがUbuntu配布へ置換された。稼働状態と依存を確認してから復旧を判断し、無観測で入れ替えない。
- 製品ごとの対応OS差を統一仕様で隠さない。非Macのgpt-connectorを一括削除しない。
- 公開対象commitはoriginの既定ブランチの祖先だけとする。変更は製品単位で戻せるcommitへ分割し、本番は所有repoのbackup・rollbackを使う。
- 秘密や認証操作をworkerへ渡さない。ログインや物理端末操作が必要になった場合だけ、必要条件をオーナーへ伝える。

## 現在地

LinuxのDocker保持とrunner再設定条件はfocused testで検証済み。Docker修理は別ベンダーの反証で受入可。
Aitermの一括入口とWindowsのGrok記録先を修正し、公開・npm導入・4 AIの実設定と公開MCP実行を確認した。
Windows CIで見つかったパス期待値のテスト不備も修正し、3 OS CIは成功した。
Caveatは工場が代行していたMCP登録を製品へ移し、4 AIの隔離設定で初回・再実行・MCP検索を確認した。

## 中断と再開

2026-09-09、オーナーの「落ち着いたところでストップしよう」により中断した。全体のゴールは未完了。

- Aitermは公開・このWindows席への導入・公開MCPの動作確認・修正後CIまで完了した。
- Caveatは作業ブランチ`codex/product-owned-setup`へ保存する。ビルド、型検査、公開前smoke、全workspaceテストが成功した。
  4 AIの隔離設定で初回・再実行とMCP検索を確認済み。最後に合わせた`uninstall`の
  `CLAUDE_CONFIG_DIR`対応は、次回の最初にfocused確認とCLI再buildを行う。
  別ベンダーの境界反証は回答前に中断し、外部セッションを閉じた。受入可とは判定していない。
  再開時は境界反証、全current文書の最終照合、mainへの統合、CI、公開、npm導入、公開後smokeの順に続ける。
- dotagentsのThroughline初回導入修理はcommit・pushして保存する。3ケースのfocused試験済みで、関連cron試験は未実行。
  Caveat公開後にLinuxの内部scaffold復旧を削除し、工場から製品MCP登録を段階的に外す。
- gpt-connectorの追加調査は中断した。非Macのread-only MCPと既存4 AI配線を維持する条件は確定済み。
- それ以外の未着手項目とServerManager/BugHubの既存作業は、上の一覧と既存計画を引き継ぐ。

中断時の差分退避先は、この席の一時ディレクトリ内の`dotagents-installer-checkpoint-20260909`。
追加指示により、未commit差分は既存のCodex読取許可を含めてcommit・pushして保存する。
ServerManager/BugHubは既存の作業ブランチ`fix/bughub-new-only-20260909`へ保存する。
製品公開や次の製品への着手を再開指示なしで進めない。
