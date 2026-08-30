# Factory reporter — 工場側クライアント運用

更新日: 2026-08-30。ここはdotagentsが所有する収集・送信クライアントの正本である。BugHubのcredential発行、DB migration、feature flag、deploy、readiness、復旧は[ServerManagerの受信契約](https://github.com/kitepon/ServerManager/blob/main/bughub/FACTORY_INTEGRATION.md)が所有する。旧wire導入の全記録は[archive](archive/2026-08_factory-reporter-runbook-v1-v8-history.md)へ退避した。

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

## agents-updateとpost-update gate

`agents-update`は更新結果とreporter結果を別々に記録し、どちらかが失敗すれば非0で終わる。post-update runnerはhost configのendpointからwire majorを解決し、同じmajorのschedule runnerを使う。configまたはrunnerを解決できない時は明示失敗し、別majorへfallbackしない。

各製品の公開diagnosticsが返す`fail`はblocking、`unverified`はadapter testで明示した既知の非blocking tupleだけを許す。未知check、未知reason、別製品の`unverified`はblockingである。通常scanは状態を改変せず、component healthを`pass`へ丸めない。

## 停止・失敗

- client送信停止は`reporting.enabled=false`。既存outboxを保持する。
- credential漏洩はServerManager側で対象credentialをrevokeし、host側fileを置換する。
- scan非0はenqueueしない。reporter非0はstdoutのtyped codeに従い、acceptedでないoutboxを保持する。
- server-side停止・migration・feature flag・credential lifecycle・BugHub復旧はServerManagerの正本に従う。
