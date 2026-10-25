# Caveatが所有する診断入口の選択

`read-host.cjs`と`diagnostic-descriptor.mjs`はCaveat担当ノアから受領した正本の無変更コピー。工場は設定parser、managed deploymentの検証規則や多数決による選択を追加しない。製品変更時はノアが正本を更新し、工場担当ドロシーが固定bytesを取り込んでconsumerを検証する。

2026-10-25の製品受渡し原本:

- collector SHA256: `7f26036d1397c8b9ddec36650779635bb9e866d1b5b2cd505b9c452c49f91521`
- selector SHA256: `f1eeac96e071e72f36b76bdcc815f0723ecb7df1562cc2a3edb631b400826a1a`
- owner-correction-v2 manifest SHA256: `2fac6cfb8a8be2898813a757a78969ea73d0c9e239a0fad60e57d50a4381d5c4`

manifestは旧受付停止案を撤回した製品文書とselectorを固定する。collectorは初版から不変。collectorはfilesystem inventoryと識別済みNodeの`--version`だけを読み、設定や信用を書かない。副作用のない既知公開managed readerをhash確認後に読む。collector出力は私有の採取原本であり、wireへ丸ごと送らない。

このsource候補の工場consumerは[../caveat-entry.mjs](../caveat-entry.mjs)。`createCaveatDiagnosticPort()`を作り、`scanV9WithAcknowledgements({..., caveatDiagnosticPort: port})`へ注入する。v9 scanとschedule-runnerは明示的な`--caveat-managed-entry`指定で同portへ接続する。既存の呼出しは変更していない。通常reporterへの採用・4host反映は別の受入工程であり、このコピーを置いたことだけで有効にはしない。

通常のscheduler登録入口も`factory-reporter-scheduler install --wire-major v9 --config <file> --caveat-managed-entry --dry-run`で3OSの定義案を作る。flag省略時の定義は不変。実反映は通常の`--apply`と既存host手順を使い、cron/launchd/Task XMLを手作業で編集しない。この候補では実反映を実行していない。

consumerは毎回fresh collector→製品selectorを実行前後に呼び、command/args、entry/pointer/manifest、4設定のfingerprint、deployment revision、実JSON版を照合する。選択不能時に旧PATHへfallbackしない。実行後に結付けが成立しなくても、取得した診断resultと元fail/重大度を保持し、`diagnostic_entry_binding`を別checkへ載せる。wire9の受付・登録条件は変えない。

`port.evidence()`は前後のdescriptorと元stdoutのSHA256を返す私有APIであり、reportのsource commitや永続receiptではない。明示flag付きscanは`<output>.caveat-binding.json`へreport IDと生成時の正確なreport bytes SHA256を付けて保存する。補助原本の保存失敗はstderrと`binding_evidence_status: failed`へ明示し、生成済みreportの通常配送を止めない。

`scan_report_sha256`は診断時のreport原本に対応する。その後のtoolchain finalizeによる同IDの別本文へ読み替えない。crash durabilityや永続receiptは保証しない。通常scheduler定義へのflag反映と実3OSの権限・採取・診断確認は未成立。これらの不在を製品のreadyへ読み替えない。
