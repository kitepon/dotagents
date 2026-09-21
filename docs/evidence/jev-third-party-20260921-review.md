# Jev第三者製品追加の責任境界レビュー

取得日: 2026-09-21。対象はdotagentsの公式導入・更新・公開probeと、ServerManagerの受信契約。Grokによるread-only反証を行い、親が実ファイルを照合して裁定した。

## 指摘と裁定

| 指摘 | 裁定と最終状態 |
|---|---|
| agent-desktopのcheckout維持は必要か | 上流Skillの公開入口が`node scripts/jev/run.mjs`なので維持する。npm版とcheckoutの版は別物であり、npm版の報告へGit revisionを付ける処理は削除した。 |
| Skill導入は上流の標準か | 上流READMEが案内するskills.sh配布面を`npx skills add`で導入する。製品内部ファイルの直接編集は行わない。 |
| 工場の導入判定が追加診断を重ねていないか | Python版の固定、サンプルの`--help`、導入時のCLI版確認は削除。公式installerの終了結果で導入成否を決め、公開versionは定期報告だけで読む。 |
| 既存wireを破壊しないか | 実configが指すmajorを維持する。新規・config欠落時の既定だけを新majorへ更新し、受信サーバーも旧majorを保持する。 |
| ブラウザ製品のhost契約が文書化されているか | 全対応profileのrequired製品として、所有する構造化契約とServerManagerの統合文書へ反映した。 |

## 独立反証の最終回答

2026-09-21T08:03:33.770Z、Grokの最終回答:

> この裁定への具体的反証は残らない。指摘箇所は裁定どおりになっている。

回答は、browserだけの`source_revision`、上流Skillのスクリプト入口、公式Skill配布、追加導入検査の撤去、実configへの追従、browserのhost契約を確認している。親はこの回答を採用した。

実行記録: launch `60cdf07e4618a38b4316ae1ff876c29f`、最終delivery `68f6eed1-4ed9-49f7-a115-7dde61a9f1a5`。実装用Workerは使っていない。
