# Factory reporter — 工場側クライアント運用

更新日: 2026-10-07。ここはdotagentsが所有する収集・送信クライアントの正本である。BugHubのcredential発行、DB migration、feature flag、deploy、readiness、復旧は[ServerManagerの受信契約](https://github.com/kitepon/ServerManager/blob/main/bughub/FACTORY_INTEGRATION.md)が所有する。旧wire導入の全記録は[archive](archive/2026-08_factory-reporter-runbook-v1-v8-history.md)へ退避した。

## 境界

- config未配置または`reporting.enabled=false`ではenqueueとnetwork送信を行わない。
- token、実config、outbox、report本文をgitやチャットへ載せない。reportへprompt、session/file本文、生log、絶対pathを入れない。
- host identityは`host.id / host.profile`で固定し、credentialのserver-side bindingと一致させる。
- 製品状態は各製品の公開diagnosticsからread-onlyで取得する。内部DB・schema・hook・processを直接読まない。
- 現役wireとendpointは[生成された現行状態](factory-current-state.md)だけから読む。別majorへpayloadを変換しない。

## 設定とcredential

雛形は[`examples/factory-reporter/`](../examples/factory-reporter/)にある。各hostのconfigとcredentialは所有者だけが読めるrepo外pathへ置く。credentialの発行・rotation・revokeはServerManagerの正規管理入口で行い、dotagentsへserver-side commandを複製しない。

```json
{
  "reporting": {
    "enabled": false,
    "endpoint": "<factory-current-stateのendpoint>",
    "credential_file": "<host固有の所有者限定path>"
  }
}
```

配置後は内容を表示せず、fileが空でないこととpermissionだけを確認する。hostごとにcredentialを分け、rabbitとWindows nativeのtokenを共用しない。rabbitの初回導入は`setup-linux-workstation-factory.sh`がcredential発行・転送・config作成まで一撃内で行うため、平文tokenを手で表示・転記しない。

## 正規実行順序

現役majorを`v<N>`として、次の一方向だけを使う。

```text
factory-scan-v<N> --config <config> --output <report> --ack-output <acks>
factory-reporter-v<N> preview --config <config> --report <report>
factory-reporter-v<N> enqueue --config <config> --report <report> --ack-metadata <acks>
factory-reporter-v<N> flush --config <config>
```

`preview`は常にnetworkゼロ。`enqueue`と`flush`は明示ON時だけ送信し、accepted後だけoutboxと公開ACKを進める。個別製品の不在・非対応はreport全体を偽成功へせず、その製品を`missing`／`unsupported`／`unverified`のまま残す。

## 現役wire、互換、rollback

本番BugHubの入口は[工場の現行状態](factory-current-state.md)だけが正であり、作業前にhost configの`reporting.endpoint`を同ページと照合する。`factory-reporter-scheduler install --dry-run --platform <OS> --wire-major v<N>`で生成物を確認してから`--apply`する。installer/updateはconfigを作らず、送信をONにせず、旧majorのstate/outboxを削除しない。

wire切替はServerManagerが新majorを受理できる状態を先に公開し、hostを1台ずつ切り替え、fresh reportとdelivery receiptを確認する。rollbackは対象hostの退避configと旧major schedulerへ戻すだけとし、新majorのstate/outboxや履歴を消さない。

| client | server入口 | 用途 |
|---|---|---|
| 現役major | 同じmajorのendpoint | 通常運用。majorとendpointは工場の現行状態から読む |
| host別rollback major | 同じrollback majorのendpoint | 最初の切戻し。majorは工場の現行状態から読む |
| 異なるmajor／未知major | 任意の既知endpoint | reject。field削除、再serialize、自動upgrade/downgradeをしない |

現役majorから戻す時は退避configを戻し、[工場の現行状態](factory-current-state.md)が示すhost別rollback majorのschedulerを登録する。さらに古い保存済みmajorへ戻す時は、対象wireの設計文書と退避configを明示してdry-run後に登録し、majorごとのstateとoutboxを共有・削除・変換しない。再cutoverもhostを1台ずつ行う。

legacy v6互換を検証する時は`factory-reporter-scheduler install --wire-major v6 --dry-run --platform <OS>`を使い、payloadは`schema_version="6.0"`のまま保つ。

新majorは、ServerManagerが旧endpointを保ったまま新validatorとendpointを先に配備し、readinessと旧major受理を確認してから有効化する。その後dotagents clientを1 hostずつ切り替える。全host移行、旧outbox drain、rollback drillが終わるまで旧majorをretireしない。

## agents-updateと更新報告

`agents-update`は更新結果とreporter結果を別々に記録し、どちらかが失敗すれば非0で終わる。post-update runnerはhost configのendpointからwire majorを解決し、同じmajorのschedule runnerを使う。configまたはrunnerを解決できない時は明示失敗し、別majorへfallbackしない。

導入の結果は各製品の公式入口が返す。製品が`partial`や`action_required`（利用者の対応待ち）と答えた時は、その値のまま記録し、工場の更新の失敗には数えない。現行runnerの`--post-update`は最終台帳を反映する前のreport準備であり、製品の診断を追加の導入gateにしない。公開された失敗・未対応・未検証は報告へ保持し、工場自身のreport生成・台帳確定・配送の成否と区別する。互換上残る`post_gate_status`はこの工場処理の状態を表す。

## 定期更新の失敗の報告

`agents-update`が失敗で終わった時、どの手順が失敗したかをdotagentsが自分の名前（`dotagents`）でBugHubへ報告する（オーナー裁定K-DNC248・K-N4QYA4、2026-10-03）。それまで更新の結果は端末のlogにしか残らず、失敗が続いても誰にも見えなかった。

- **境界**: 報告するのは「この端末の定期更新で、この手順が失敗した」ことだけ。製品が返したエラーの中身は載せず、製品の不具合を工場が引き取ることもしない。届け先は1つで、製品ごとに振り分けない。修理へ繋ぐのはBugHubを見た人で、dotagentsは製品の担当へ届ける仕組みを持たない。
- **手順の名前**: `setup.<製品>`（公開入口の導入手順）、`package.<npm package>`、`npm`、`markitdown`、`unai`、`typesafe`、`jev`、`spotter-install`、`toolchain-ledger`、`factory-report`。`claude-code`・`codex-cli`・`grok-build`の更新結果は台帳がreportへ運ぶので、ここでは数えない。
- **重大度**: 手順の名前や累計の回数では決めない。前の回に成功していた手順（または初めて）の失敗は`warn`で載せる。この時点で確かめられているのは「この回の更新がその手順で止まった」ことだけで、原因（通信・製品・端末）は未確定、次の回が同じ手順をやり直す。前の回も失敗していた手順は、再試行でも直らなかったものとして`high`へ上げる。直ったあとの失敗は、また`warn`から数える。製品が動くかどうかは、工場のreportが製品の診断として別に運ぶ。重大度を持たない以前の記録は、送っていた`high`のまま扱う。
- **届かなかっただけの回**: reportの準備・送信が、BugHubから応答を受け取れなかった保留だけで終わった回は、`factory-report`の失敗にも成功にも数えず、未解決の記録にも触れない。reportは送信待ちに残り、次の毎時の実行が送り直す。更新のlogには`DEFERRED:`の行が残り、更新の終了値は非0のまま。BugHubが応答して断った保留、隔離、ackの失敗、reportの生成や予約の失敗は、これまでどおり手順の失敗に数える。
- **記録**: `agents-update.sh`が最後に`bin/factory-update-failure-report.mjs record`へ、動いた手順と失敗した手順の名前を渡す。失敗した手順は回数を累計し、次の回で成功した手順は解決済みにする。今回動かなかった手順には触れない。記録や送信ができなくても、更新の結果は変えない。
- **置き場**: 記録は`~/.local/state/dotagents/update-failures.json`、送信の設定は`~/.config/dotagents/update-failure-reporting.json`（Windowsはどちらも`%LOCALAPPDATA%\dotagents\`）。合鍵はBugHubの持ち主が置く`~/.config/bughub/product-credentials/dotagents.json`（Windowsは`%LOCALAPPDATA%\bughub\product-credentials\dotagents.json`）で、dotagentsは読むだけで作らない。
- **送信**: 既定では送らない。端末で`factory-update-failure-report.mjs enable`を実行し、合鍵が本人だけの通常のファイル（0600、リンクでない）である時だけ送る。送る形はBugHubの製品報告の契約（`bughub/PRODUCT_REPORTING.md`）で、`error_code`は`UPDATE_STEP_FAILED`、`component`は手順の名前、版は`0.0.0+<revision>`。受領済みにするのは、200・`accepted`・同じ`report_id`・応答の署名がそろった時だけ。
- **確認と停止**: `factory-update-failure-report.mjs status`が、送信の状態・未解決の手順・最後の結果を返す。`verify`は、記録に触れずに中身が空の報告を1回送り、合鍵・宛先・応答の署名を確かめる（BugHubにissueは出来ない）。届かなかった分は次の更新で送る。待たずに送る時は`flush`。止める時は`disable`。
- **限界**: 更新が動かなかったこと（端末が止まっていた、予定が外れていた）は検出しない。WindowsはACLを確かめず、合鍵が通常のファイルでリンクでないことだけを見る。

## 通信失敗の報告

登録の条件と重大度は[BugHubの通信失敗の契約](https://github.com/kitepon/ServerManager/blob/main/bughub/NETWORK_REPORTING.md)に従う（2026-10-07、オーナー指示）。工場は、通信の診断の記録と、修理が要る登録を分ける。理由コードや回数だけで`fail`や`high`にしない。

- **工場自身の送信**: factory reportの`flush`と、定期更新の失敗報告の送信は、届かない時に送信待ちへ残し、次の実行で送り直す。BugHubは同じ`report_id`・同じ本文を重複として受け、失敗報告は累計を送るので、送り直しで二重に数えない。届かなかった事そのものはBugHubのissueにしない。`flush`は、保留のうちBugHubから応答を受け取れなかった件数を`unreachable`で返す。
- **scanの通信を伴うcheck**: `npm_latest`（registryの最新版）は、読めない時に`unverified`／`registry_unverified`で残す。`fail`にしない。
- **`last_update`（定期更新の台帳）**: 重大度は、失敗した更新のあとにCLIを起動できるかで決める。「起動できる」は、更新の直後（台帳の`after_version`）か今回のscan（`installed_version`）のどちらかで版を読めたことを指す。

| 台帳の理由 | CLIを起動できる | 起動を確かめられない |
|---|---|---|
| `registry_unavailable`・`check_failed`（最新版の確認が失敗。導入に触れていない） | `unverified`（理由はそのまま） | `fail`・`high` |
| `install_failed`・`update_failed`（入替が失敗。原因は台帳に無い） | `fail`・`warn` | `fail`・`high` |
| 上記以外の失敗 | `fail`・`high` | `fail`・`high` |

- **限界**: 入替の失敗の原因（通信・ファイルのlock・権限）は台帳に無く、端末の更新logにだけ残る。grok-buildはscanが`grok update --check --json`でしか版を読まないので、通信が切れている間は起動を確かめられず、`check_failed`が`high`のまま残る。

## 停止・失敗

- client送信停止は`reporting.enabled=false`。既存outboxを保持する。
- credential漏洩はServerManager側で対象credentialをrevokeし、host側fileを置換する。
- scan非0はenqueueしない。reporter非0はstdoutのtyped codeに従い、acceptedでないoutboxを保持する。
- 製品CLIの応答が上限（既定20秒）を超えた時は、そのcheckを`unverified`／`cli_timeout`で残す。出力を読めていないので`fail`にせず、製品側の契約違反（`native_schema_invalid`など）とも区別する。npm CLIの版を読む呼出しが時間切れした時は、PATH上の別の導入へ読み替えない。
- server-side停止・migration・feature flag・credential lifecycle・BugHub復旧はServerManagerの正本に従う。
