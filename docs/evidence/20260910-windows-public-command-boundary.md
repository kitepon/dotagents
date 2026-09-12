# Windowsの標準呼び出しと公開診断の境界

2026-09-10のWindows実端末導入で、工場自身の呼出し・公開結果の読取りに二つの不備を確認し、2026-09-12に修正の検証を再開した。本記録は4端末の統合完了を表さない。

- unaiの公開診断はPowerShell 7から成功する一方、工場はPowerShellの絶対パスを、裸のcommandだけを認める独自resolverへ渡して`EINVAL`にしていた。
- Caveatの公開診断はCursorを含む既知のschema v1を返す一方、工場は旧shapeだけを認め、製品のoverallとmigrationを独自に再判定していた。

Windowsの公開入口解決はPowerShell 7の`Get-Command`へ委譲し、実行ファイルはNodeの標準`spawn`、scriptはPowerShellの標準呼出し演算子で実行する。npm shim本文の解析、製品内部entrypointの探索、AppContainerのパス補正を削除する。command不在は標準の`CommandNotFoundException`から識別し、製品自身の終了code 127と混同しない。

Caveatは公開schemaの既知の新旧shapeと型を検証し、公開overall・version・schema・migrationを報告へ転記する。現役wireの診断要求と導入検証には公開optionの`--require-connector cursor`を加える。hookやmigrationの成否を工場で計算し直さない。未知のfield・statusは引き続き拒否する。

公開契約の根拠はCaveat担当の回答と、[公開版の診断説明](https://github.com/kitepon/Caveat/blob/v0.19.1/README.ja.md#L192-L199)、[connectorの説明](https://github.com/kitepon/Caveat/blob/v0.19.1/docs/03_dual_agent_support.md#L185-L193)。製品repo・状態・配置は変更していない。

Windowsの独立した一時環境で、標準exe・ps1・cmd、引数のliteral保持、stdin・cwd・環境変数、終了code、command不在を確認した。同名commandの複数配置では`Get-Command`が配列を返すことを最小再現し、標準optionの`-TotalCount 1`でPATH順の一件を得るよう修正した。同名cmdを二つ置く回帰ケースを含め、Windowsの小試験3件が成功した。Macの関連試験は32件成功した。

関連試験の初回は一時コピーへGit履歴を含め忘れ、revision取得で失敗した。またCaveatとGrokのCLI不在を試す隔離PATHがPowerShellなどの実行基盤まで除外していた。試験環境へ元checkoutの履歴を取得し、隔離PATHには標準PowerShellとSystem32だけを残した。gitの代役もNodeを要求しないcmdのechoへ簡素化し、両方の個別試験がWindowsで成功した。製品コードへ試験環境の不足を補う変更は加えていない。

別ベンダーのGrok反証は、Windows呼出しの公開境界を受理した。Caveatについては`v2`と旧scanだけでは現行reportへ届かないという指摘を採用し、`v8 → v7 → v6 → v5`の実行経路で共有decoderを使用するよう修正した。`verify-install`にも同じ公開引数を渡す。現行`v8`の試験で正常、Cursor不備、overallと終了codeの不一致を確認し、Mac・Windowsとも成功した。導入検証の関連試験`tests/install/clean-home.sh`も成功した。

候補の工場呼出しから、Windowsに導入済みのunaiとCaveatの公開診断を取得できた。unaiはschema v2・overall ready、CaveatはCursorを必須にしたoverall ready・schema 3・migration currentを転記できた。この確認はunaiの更新停止が解消したことを意味しない。

2026-09-12の最終確認は、Windowsの関連32試験がすべて成功し、`make ci`も全gateが成功した。途中のCIで旧引数だけを認めるfactory-core fixtureと契約台帳の本文digest登録漏れが見つかり、それぞれ個別検証を終えてから最終CIを再実行した。契約台帳の変更はCursor必須の公開引数だけで、文書の境界検査は維持している。

実端末導入全体は未完了。Windowsの初回結果は更新・報告とも失敗であり、BugHubの配送ackは合格を意味しない。unaiの公式installerは既存checkoutの行末差分で更新を拒否しており、差分の破棄・補正はしていない。AIShellの既存Keychain利用は担当製品の修理待ち。MacのSSHはlocalhostへの2回の接続が拒否され、残る端末の工場導入とfresh reportは未実施。
