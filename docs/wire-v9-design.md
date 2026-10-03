# wire v9 横断統合契約

v8の固定製品集合へ`jev-ultrafast`、`agent-desktop`をこの順序で追加する。集合は`lib/factory/v9.mjs`、受信shapeは[ServerManagerのschema](https://github.com/kitepon/ServerManager/blob/main/bughub/schemas/factory-report-v9.schema.json)が正。

schema_versionは`9.0`、report_modeは`full`、endpointは`/api/factory/v9/reports`。v8の集合・endpoint・outboxを維持し、新旧payloadの変換や補完はしない。受信有効化と保存・配備はServerManager、clientの導入・予約・送信はdotagentsが所有する。

両第三者製品は公式versionを報告し、jev-ultrafastだけにsource revisionを付ける。agent-desktopのnpmバイナリとJev用checkoutは別の配布物として扱う。GUI未実行は`unverified`、agent-desktopの非Macは`not_applicable`と`unsupported`を使う。prompt・画面・入力・キー・設定・生logを含めずsafe_contextは空集合とする。host期待は[host matrix](factory-host-product-matrix.md)、製品責務は[統合台帳](factory-product-contracts.md)が正。

## safe_contextの許可key

製品別の許可keyは空から始め、必要なkeyを契約testと同時に足す。現在許可するのは`lattice`のruntime errorの3 keyだけで、集合は`lib/factory/contract.mjs`の`SAFE_CONTEXT_KEYS`が正。BugHubの受理側も同じ集合を許可する。

- `command_kind`（落ちたCLIの面。`run.list`、`other`など）、`error_kind`（例外の種類）、`cause_code`（Nodeのエラーコード、無ければ`none`）。語彙はLatticeが所有し、工場は形と長さだけを`lib/factory/runtime-errors.mjs`で検査する。利用者の引数値・message本文・path・stackは載せない。
- 付ける記録は3 keyを必ずそろえる。そのfingerprintは`sha256(product \0 component \0 error_code \0 message_template \0 command_kind \0 error_kind \0 cause_code)`で、持たない記録は従来の4要素の式のまま照合する。両方の形が1つのsnapshotに並んでよい。
