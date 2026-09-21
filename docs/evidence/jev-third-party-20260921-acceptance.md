# Jev第三者製品の工場配布・受入記録

取得日: 2026-09-21。対象依頼は上流製品の最新版を一撃展開・定期更新・状態報告へ加えること。製品の改造と全端末への即時再展開は含めない。

## 責任境界

| 所有者 | 今回扱った範囲 |
|---|---|
| 上流製品 | 本体、操作ループ、依存、OS対応、製品設定、公開CLI。fork・patch・独自操作wrapperを加えていない。 |
| dotagents | 公式Git・uv・npm・Skill installerの呼出し、対象OS、工場キー配布、公開versionの観測と報告、更新予約。 |
| ServerManager | BugHubの受信schema、保存、公開表示、受信有効化、配備と復旧。変更はServerManager自身へ実装した。 |

独立反証と親裁定は[レビュー記録](jev-third-party-20260921-review.md)に保存した。採用した指摘は修正済みで、残る具体的反証はない。

## 受入結果

| 項目 | 結果と証拠 |
|---|---|
| 既存baseline | 関連23件成功。既存wireを変更せず新majorを追加した。 |
| 公式導入・再実行 | Macで公式導入処理を2回実行し成功。npm latestと上流mainへ一致。Browser Harnessは上流uv lockで導入する。 |
| 導入失敗・OS差・公開probe | focused test成功。失敗の伝播、未対応OSのskip、秘密非出力、GUI非起動を確認。 |
| 一撃展開・定期更新 | Mac/Linuxの隔離展開試験、cronの最小環境・失敗伝播試験が成功。Windowsは静的契約試験を実施し、MacにPowerShellがないため実行2件はskip。 |
| ServerManager | 関連77件、必須`npm test`、release gate成功。mainの`2aad085928675981148404594976a17db8f644e0`を正規`bughub/deploy.sh`で配備した。 |
| 新旧受信経路 | 新旧endpointとも無認証POSTは401。旧wireを維持し、新wireの受信を先に公開した。 |
| 配備・稼働 | 製品標準のdry-run、DB backup、旧image保持、revision照合、activationを通過。配備後`/readyz`はHTTP 200。 |
| Macの報告 | 工場設定と配布面をtar退避し、公式配布入口とschedulerを適用。報告1件を送信し、保留・dead letter・ACK失敗は0。 |
| 公開表示 | 公開matrixの2製品について、送信した観測時刻と導入版の一致を実測。[構造化証拠](jev-third-party-20260921-canary.json)に保存した。 |
| 最終CI | dotagentsの`make ci`成功（exit 0）。実行ID `C2D682A9-C593-4BC9-9B61-E7FB100FFEE3`、2026-09-21T08:11:46Z〜08:18:28Z。 |

最終CIの先行2回では、旧製品集合・旧wireを固定したfixtureの残存を検出した。該当箇所をfocused testで直し、製品コードへ回避分岐は加えていない。最終文書確認で、READMEの第三者製品案内は生成一覧への参照へ揃え、desktopのnpm版とGit revisionを混同しない説明に修正した。

最終CIのstdout SHA-256は`b6a646435b9f9fa017234b0b909855fe55c05fe8b839ac709faed90ad12524d6`、stderrは`f7589b47503c74a9511f335964c7204a0881823015b78b5de184eae4b79046e2`。ServerManager必須試験のstdout SHA-256は`383fb8703e073b6fd4d9fae81fe0452d65411e43caf9ef2590a7b0f29b1b4a65`。

## 確認範囲

今回確認したのは最新版の導入・更新・工場報告である。GUI操作は起動しておらず、報告もGUI互換性を`unverified`、GUI試験を`skipped`としている。agent-desktopのWindows/Linux対応は上流未対応として扱い、工場で補作していない。JevへのGUI判断呼出しも今回の受入では行っていない。

全端末再展開とWindows実機の導入試験は実施していない。別作業のCursor hook・test差分とAIShell状態は保持し、今回のcommit対象から除外する。
