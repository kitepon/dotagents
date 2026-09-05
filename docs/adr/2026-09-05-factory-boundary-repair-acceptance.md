# 工場の責任境界修理の受入裁定

日付: 2026-09-05。状態: 決定。裁定者: dotagents統括親。

オーナーの修理指示に対する[実行証拠](../evidence/2026-09-05-factory-boundary-repair.md)と以下の検証を受け、確認済みの修理範囲を受け入れる。工場規範への製品依存の混入、CIの検査選択と既存の検査停止、計画の誤報、Lattice公開応答の読取境界を修理した。

## 検証

| 対象 | 保持する結果 |
|---|---|
| dotagents実装 | `437ebada1166a19ddcdf4b4907bb45ca787b0dd7`をorigin/mainへpush済み |
| Mac全体検査 | `make --jobs=4 ci`成功。ログSHA-256: `8b408c45c764e2518db87134d3dc9f4872f061093c143750e5c571ee6299f749` |
| GitHub CI | [run 33931811306](https://github.com/kitepon/dotagents/actions/runs/33931811306)。同じ実装commitでclassify、Linux full、gateすべてsuccess |
| Mac実機 | `verify-install --profile official`成功。ログSHA-256: `d89e333a71f7f1fa07fcc766d22a77d118400ac749031b6d3b5979fd9b2a2bd3` |
| BellTeam | ローカル`97041f9`、本番`03e4dd5`。全155試験と最終補正の関連8試験成功。本番のhealthz、設定保存先、既存MCP登録を確認 |

生ログは各repoのgit管理外`.git/factory-boundary-*.log`に保持した。公開可能な観測結果は実行証拠と本裁定に固定した。

## 境界と還流

- BellTeamの内部修理と本番反映は製品repoに保持した。工場の共通規範は生成正本へ復元し、製品専用の前提を含めない。
- 一般化した所有境界を`AGENTS.md`へ、Lattice公開契約の消費範囲を`docs/factory-product-contracts.md`へ、CIの選択規則を`docs/04_ci.md`へ反映した。
- 読取専用の独立確認から出た指摘は実装と回帰試験に反映した。異なるproviderによる監査ではなく、実Botを起動する受入試験も行っていない。本番反映後の公開診断と設定読取で確認した。
- 本裁定は確認済みの修理範囲を閉じる。全製品の内部に欠陥が無いという宣言はしない。今回導入していないLattice工程や既存runには変更を加えていない。

Control `factory-boundary-repair-20260905`は、本裁定と実行証拠を受入根拠としてfinalize・archiveする。
