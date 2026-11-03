# 外部イベント保存と公開readiness

[全体入口](../09_feature-map.md) / [診断](diagnostics.md) / [配送](delivery.md)。base `9fca2c8`、候補`f05b395`のsource本文を確認。[描画](external-events.svg) / [原本](external-events.mmd)。実probe・実台帳・外部接続は行っていない。

## 保存とACKの所有

`bin/factory-external-event.mjs`はopen/resolve/snapshot/status/ackだけを受け、`lib/factory/external-events.mjs`の公開窓口へ渡す。引数の順序/個数を固定し、ACKだけNumberへ変換、例外はstderrとexit2へ返す。library exportsはCHECKS/REASONS/fingerprint/mutate/snapshot/ack/status。公開CLIのstatus/snapshotもprivate directoryとlockを確保するため、ファイルシステムへの副作用を持つ。

| 実関数 | 入出力と所有する状態 | 失敗・保持・後始末 |
| --- | --- | --- |
| `root/statePaths/read/validateState` | FACTORY_REPORTER_STATE_DIR優先、既定はOS別factory-reporter。external-events.json、schema/sequence/ACK境界/固定check-reason/指紋/正規UTC/時刻順/件数を検査 | directory/fileのsymlink拒否、1MiB上限、欠測だけemptyState。壊れた原本を空へ置換しない。POSIX directory0700/file0600、Windowsの専用owner ACL設定はこのmoduleにはない |
| `withLock` | external-events.lockをwxで作りpidを保存。全公開操作を同lock内で処理 | live/EPERMは待機し3秒でstate_locked、ESRCHだけ回収。壊れたlockはstate_invalid。通常finallyで自分のhandle/lockを回収。process強制終了やPID再利用への全面的保証はない |
| `mutate` | check+reasonのSHA256。新open/新時刻再観測/resolveを次sequenceへappend。再観測はfirst_seen維持/count加算、同一・古いopenと既resolvedの再resolveは同sequence | 未open/逆行resolveを拒否。未ACKの256件を超える追加はstate_fullで旧file保持。ACK済み先頭だけをpruneする |
| `selectable/snapshot` | ACK後から、同じfingerprintが二度出る直前までの連続prefix。high_watermark/acknowledged_through/nextを返す | 後続の別fingerprintまで飛び越えない。読取成功と配送受理は別 |
| `ack/status` | ackは現在選択可能なcursor以内、maxで単調更新してsave。statusはhigh/pendingだけ | ACKは原本全削除ではない。古いACKは後発sequenceを消さない。cursor飛越/安全整数以外を拒否 |
| `save` | 検査→UUID temp/wx/0600→rename→chmod。renameはWindowsのEPERM/EBUSY/EACCESだけ最大5試行 | 恒久rename失敗は旧file保持、tempはfinallyで回収。rename後chmod/cleanup失敗は置換後に例外となり得る。file/parent fsyncや取消専用APIは持たない |

旧`runtime-errors.mjs:PRODUCTS.servermanager/parseServerManagerExternal`はsnapshotを厳密に検査し、openをruntime_errors、resolvedをresolutionsへ写し、同prefix cursorのACK候補を作る。旧`scan.mjs:scanResult/mergeServerManagerExternal`とv2/v4はcollection経路で使う。reporterは受理後だけ製品ACKへ進む。ACK前の受付/POST/JSON応答やstatus表示を同じ完了にしない。

## 現行の外部公開probe

`bin/bughub-external-probe.mjs:endpoint/main/boundedBody/expectedRevision/project`は固定HTTP loopback `127.0.0.1`の`/readyz`だけへGET。credential/query/hash/redirectを拒否し、5秒/64KiB/fatal UTF8の境界を持つ。deploy revision fileは明示envまたはHOME配下の既定pathから最大66bytesを読み、40〜64桁hexと任意の末尾LFを照合する。revision原本を作成・更新しない。

製品所有`bughub.readiness.v1`のHTTP200/503とready/not_ready、固定6check/理由集合/source_revisionの整合を検査する。返却には版・revision・checkのid/status/reasonだけを残し、元時刻/件数等を運ばない。到達不能はunverified/unreachable、不正body/不整合はunverified/contract_invalid。readyはexit0、not_ready/unverifiedは1、引数/endpoint等の外側例外は2。

`scan.mjs:serverManagerNative/projectServerManagerProbe`は子commandを7秒上限で呼ぶ。診断のschema/exit/固定値を再検査し、失敗をcheckへ投影する。旧projectorが作るreadiness_recovered候補は、現行`v5.mjs:scanV5WithAcknowledgements`がruntime_errors/resolutionsを空へ置換して除外する。v6-v9はこの通常経路を継承し、ServerManagerの外部event台帳も製品のruntime snapshotも読まず、通常ACKは空。製品自身の障害報告と工場のreadiness checkを二重配送しない現契約を維持する。

## 呼出し・配布・fixture

install.shのbin globが二CLIを拡張子なしリンクで配布し、clean-home.shがリンク/実行入口を確認する。明示open/resolveへの通常source内callerはliteral検索で確認できず、外部の運用caller全体は未確定。旧runtime parser/ACK、scan-v2/v4、各reporterと現行v5-v9の接続候補は当席phase14-contacts.txtに固定する。

本文確認した`tests/factory-scan/external-events.test.mjs`はprefix/再観測/古いACK/不正state/lock/容量/Windows renameと旧原本保持、`bughub-external-probe.test.mjs`はローカル偽HTTP/revision/不正endpoint/非公開値の除外、`product-owned-runtime-errors.test.mjs`は現行のevent非取得/通常空ACKを扱う。`runtime-errors.test.mjs`、v2/runtime-error-ack/report-fragments等の関連caseは接点索引で区別し、全fixture本文確認/今回実行の主張はしない。これらは既Makefileのscan/reporter/wire gate、clean-homeはtest-installへ接続する。

実OS/強制終了/電断/全writer排他、外部caller、中央受理や画面反映は今回未検証。旧台帳の自動復帰・削除・現行への再編入は行わない。
