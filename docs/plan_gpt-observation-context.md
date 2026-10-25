# GPT任意観測内訳の工場保全・投影

担当ドロシー。2026-10-25。中央通常release・製品source受入・一回native呼出しのopt-in合意と正規report受入までの計画。中央はFr docs/gpt-observation-context-20261026.md、primitive取得・写像は製品のfactory-observation-context.mdを正本とする。台帳bootstrap/fd4とは別工程である。

## 原因と変更範囲

既factory projectorはcheck.safe_contextを捨て、contract9のGPT allowlistは空である。元診断の一回観測を同reportへ保存するため、任意7keyを検査・保全する共通moduleと、既projectGptConnectorFactoryの明示source optionを追加した。HTTP/user/bridgeの取得や分類は製品が所有し、工場では再計算しない。

`projectGptConnectorFactory(native, exitOk, observedAt, {includeObservationContext:true})`は既check変換後に完全なgroupだけを対応checkへ渡す。元status/reason/overall/版・auth_requiredのskippedとfailure fingerprint生成を維持する。省略/空objectは旧投影と同一。非2xx/unobservedでuserがuninspectedでない場合、bridge=false/uninspectedで後続3keyがuninspectedでない場合、部分group/余分key/enum外/非scalarは固定errorで拒否する。入力値やgetterの例外文はechoしない。

source-onlyのvalidateGptObservationReportV9は既validateReportV9を再利用する。追加groupを完全に検査した後、検査用copyからそのextensionだけを除いて元のshape/privacy/statusを検査する。report本体のgroupや元情報を削除・上書きしない。他製品のallowlistは変更しない。

projectSameReportGptObservationは同reportのcheckにある完全で一致するgroupだけを、元report_id/host_id/observed_at/installed_versionとともに返す。不一致や欠測では表示を保留する。runtime_errorのgroupは元記録に保ち、過去履歴を現在のcheckと混成しない。内訳を新故障・本人ログイン必須・自動resolveの根拠にしない。

## 有効化と通常経路

通常scannerは新source optionを渡さない。既native CLI factory-diagnostics --jsonへ引数を足さず、追加probeや二回目の観測をしない。既定projectorと現contract9は非空groupを拒否する。通常reporterは新candidate validatorをimportしないため、全経路成立前に非空groupを送る経路は増やしていない。

中央実装/必要検証/通常release、製品の独立source採否、その一回native呼出しへopt-inを渡す方法と責務を合わせた後で、scanner・通常validatorの接続を次差分にする。非空groupをoutboxへ保存して将来再送させる方式は使わない。既auth_required/skippedと元runtime登録・解決規則は維持する。

## 確認と未成立

新7groupだけをfake/native JSONと固定reportで確認した。省略/空group旧互換、同report不変とauth skipped、default/現contract9の送信前拒否、部分/矛盾/noecho、check混成保留、他製品privacy維持、runtime履歴非混成が成功した。旧5分類・既4host/公開/導入成功群は再走していない。実probe/HTTP/CDP/実送信/host操作/秘密は0。

| OS | Claude Code | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| Linux | 共通parser source対象、実経路未確認 | 同左 | 同左 | 同左 |
| macOS | 共通parser source対象、実経路未確認 | 同左 | 同左 | 同左 |
| Windows | 共通parser source対象、実経路未確認 | 同左 | 同左 | 同左 |

この表はreport parserの適用範囲を示し、ハーネスの実認証や利用可能性を保証しない。今回は隔離Linux上のpure結果だけである。工場source通常統合・中央通常release・製品opt-in・実一回reportの正規受入は未成立として次工程へ残す。
