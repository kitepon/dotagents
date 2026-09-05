# 工場の責任境界修理（2026-09-05）

所有: dotagents。複数repoの修理と横断受入を記録し、完了後は固定証拠として保持する。

## 目的と裁定

オーナーは2026-09-05、工場監査の確認済み指摘の修理を承認した。製品の経験は一般化して工場へ還流させるが、工場の規範を特定製品の稼働に依存させない。
BellTeamの実装・runtimeはBellTeam、工場の配布・CI選択・案内はdotagentsが所有する。Latticeの公開応答の意味はLatticeの正本へ従う。

## 範囲と受入

| 対象 | 挙動修正 | 受入 |
|---|---|---|
| BellTeamの実行ホーム | ホストのHOMEを暗黙に書込先へ使わず、製品の専用homeへ設定生成・子プロセスを揃える | 隔離homeの試験、ホスト正本へ向くsymlinkの非変更、全関連試験、本番公開後の診断 |
| 工場規範 | 未コミットの混入差分を退避し、共通正本とhost差分から復元する | 生成一致、実際の配布先一致 |
| CI | 共通変更が混ざっても該当hostの試験を維持し、文書登録漏れを解消する | 混在変更の回帰試験、文書gate、push後のCI |
| 起動案内 | checkboxの無い互換案内を完了計画と誤認しない共通判定 | Claude/Codexの同条件試験、実リポジトリの9件の誤報消失 |
| Lattice接続 | session-contextの公開契約どおり、表示に使う項目だけを読む | 新しいtodo応答・未知項目・既知項目不正の試験、実CLI応答の受入 |

## 実行と境界

書込みは親が直列に担当する。BellTeam境界とLattice契約の読取調査は独立した子へ分担し、設計の抜けを反証する。writer委譲は使わない。複数repoの書込み調整と最終受入はFとして親が持つ。
新しいLattice工程管理は導入せず、既存runを再dispatch・変更しない。Controlは今回の受入とPhase記録に限定する。
自作コアの追加、第三者改造、既存の別作業の変更、全製品の内部監査は対象に含めない。

## ベースラインと既知の罠

- dotagentsはorigin/mainと一致する`3de6b23`。混入は`claude/CLAUDE.md`と`codex/AGENTS.md`の未コミット差分。先にBellTeamのgit管理外runtime/backupsへ退避した。
- 共通憲法一致検査は混入2件で失敗。文書検査は`rag/models/sprite-forge-roundtable-placement-20260904.md`の未登録で失敗。CI分類の既存9試験は成功し、混在変更の最小再現は該当hostの脱落を示す。
- BellTeamのharness-configとowner MCPの既存6試験は成功。並行していたBot環境整備は`ecddddf`へcommitされたため、その変更を維持して修理する。BellTeamはgit remoteを持たず、製品の正規deploy入口がサーバ側の独立履歴へ反映する。
- symlinkへのwriteFileはリンク先の正本を変更する。設定生成とCLI起動のhomeが分かれる修理も不十分である。
- session-context.v1は公開契約で既知項目だけ読むことを許す。内包todoの全schemaを工場で固定すると製品の拡張で案内が壊れる。

## 検証と現在地

原因を固定するfocused testを先行し、関連gateを通した後に各repoの最終通し試験を一度行う。本番反映は目的・影響・戻し方を説明して製品の正規入口から行う。確認結果と親の最終判断は本記録へ追記する。

## 実装・独立確認

- BellTeamのwriter、更新通知、owner MCP、Bot環境復元、Aiterm、Throughlineを製品の専用homeへ揃えた。親と同じ値でも起動先へホーム関連変数を渡す。Claudeの設定先overrideは継承から除去し、既存のuser MCP設定を維持する。
- 独立読取2名から、Claude設定先の優先変数、tmuxへの同値変数の配達漏れ、Latticeの未初期化応答・513件の正常応答・不正な校正状態の扱いを指摘された。いずれも修正し、回帰試験で確認した。Claude設定先の明示はuser設定ファイルも移すため、追加読取でその案を撤回しHOME既定へ揃えた。
- 独立確認はnativeの別contextで実施した。異なるproviderによる確認ではない。writerは親だけで、製品を跨ぐ状態や手順の複製を追加していない。
- 工場の規範はrendererで正本から復元した。MacのClaude/Grok/Cursorに残っていたBellTeam専用規範3ファイルと、4面のBellTeam MCP登録を内容確認後に退避・除去した。他のMCP登録や親モデル設定は維持した。退避先はBellTeamのgit管理外`runtime/backups/factory-boundary-20260905T084211/`。
- CIは共通変更とhost固有変更の和集合を使う。未登録文書を登録し、4面のorchestrate参照文書を正本から再生成した。モデル表の注記に固定されていた試験を候補順位の検査にし、導入試験に欠けていた既存boundary hookをfixtureへ補った。
- Claude/CodexのMarkdown棚卸しは共通関数へ寄せ、checkboxの無い案内を完了計画として数えない。Latticeの内包TODO版や未使用項目は工場で固定せず、表示項目だけを読む。

## 検証結果

| 検証 | 結果 |
|---|---|
| BellTeam全試験 | `npm test`: 155件成功。追加のClaude設定先補正後は関連8件を再実行し成功 |
| BellTeam symlink再現 | 旧挙動のホスト正本上書きを再現。修理後は正本を維持して専用homeへ生成 |
| BellTeam本番反映 | ローカル`97041f9`、サーバ`03e4dd5`。正規deploy入口で反映しhealthz成功、8 Botの台帳を維持。再開メッセージは送っていない |
| BellTeam本番設定 | `/home/bell`、Claude設定overrideなし、既存user MCP登録あり、製品専用規範あり。tmuxにもClaude設定overrideなし |
| Lattice公開応答 | 7回帰試験成功。実CLIのsession-contextが`active_run`・active 1件で読取成功 |
| 計画棚卸し | 両frontendの6条件成功。実リポジトリでは未完了・完了候補とも0、互換案内9件の誤報消失 |
| CI選択 | 共通＋Mac／Windows／両hostの回帰を含む10件成功 |
| 工場文書・規範 | 生成一致、文書登録、skill参照生成の検査成功 |
| 実機導入検査 | `verify-install --profile official`成功。Caveatの旧`codex_hooks`残存は既存の工場applierで除去し、製品の公開診断がreadyになった |

本記録は修理の実行証拠である。push後のCI結果と最終受入は別の裁定文書へ固定する。ControlのPhaseには、この保持済み証拠と裁定のdigestを結び付ける。
