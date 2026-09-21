# wire v9 横断統合契約

v8の固定製品集合へ`jev-ultrafast`、`agent-desktop`をこの順序で追加する。集合は`lib/factory/v9.mjs`、受信shapeは[ServerManagerのschema](https://github.com/kitepon/ServerManager/blob/main/bughub/schemas/factory-report-v9.schema.json)が正。

schema_versionは`9.0`、report_modeは`full`、endpointは`/api/factory/v9/reports`。v8の集合・endpoint・outboxを維持し、新旧payloadの変換や補完はしない。受信有効化と保存・配備はServerManager、clientの導入・予約・送信はdotagentsが所有する。

両第三者製品は公式versionを報告し、jev-ultrafastだけにsource revisionを付ける。agent-desktopのnpmバイナリとJev用checkoutは別の配布物として扱う。GUI未実行は`unverified`、agent-desktopの非Macは`not_applicable`と`unsupported`を使う。prompt・画面・入力・キー・設定・生logを含めずsafe_contextは空集合とする。host期待は[host matrix](factory-host-product-matrix.md)、製品責務は[統合台帳](factory-product-contracts.md)が正。
