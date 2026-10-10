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

## npmの退避フォルダ

npmは入替の前に、古いpackageを隣の`.<名前>-<hash>`へ退避し、成功した後で消す。Windowsでは稼働中のexeを消せないので、agentが動いている間の入替は退避フォルダを残す。次の入替はそこへ上書きできず`EBUSY`で落ち、巻き戻しで退避側の古いexeが元の場所へ戻る（2026-10-07 claude-code、2026-10-08 codex-cli。codexは0.160.1から0.160.0へ戻った）。

`agents-update`は、npmへ渡すpackageごとに、入替の前と後で`bin/factory-npm-retired.mjs clear`を呼ぶ。

- **消せる物は消す**。消せないファイルだけを`<更新logの場所>/retired-executables/<時刻>-<退避フォルダ名>/`へ、同じvolumeのrenameで移す。複製はしない。稼働中のプロセスは止めない。
- **置き場のexe**は、掴んでいたプロセスが終わった後の回で消える。
- **片付けられない時**（別volumeなどでrenameも通らない）は、そのpackageを入替えない。logへ`FAILED: <package> の退避フォルダを片付けられない（入替を見送る）`を残し、台帳は`failed`／`install_failed`、`after_version`は入替前の版のまま。
- **片付けを試せなかった時**（helperの異常終了）は入替を止めず、logへ`WARN: <package> の退避フォルダを確認できない`を残す。
- 退避フォルダがあった回だけ、片付けた名前と移した先を1行のJSONで更新logへ残す。

退避先の名前はnpmの実装（`@npmcli/arborist`の`retire-path.js`）に合わせている。npmが名前の付け方を変えた時は片付けの対象が見つからなくなり、挙動は片付けを入れる前と同じに戻る。

## 定期更新の失敗の報告

`agents-update`が失敗で終わった時、どの手順が失敗したかをdotagentsが自分の名前（`dotagents`）でBugHubへ報告する（オーナー裁定K-DNC248・K-N4QYA4、2026-10-03）。それまで更新の結果は端末のlogにしか残らず、失敗が続いても誰にも見えなかった。

- **境界**: 報告するのは「この端末の定期更新で、この手順が失敗した」ことだけ。製品が返したエラーの中身は載せず、製品の不具合を工場が引き取ることもしない。届け先は1つで、製品ごとに振り分けない。修理へ繋ぐのはBugHubを見た人で、dotagentsは製品の担当へ届ける仕組みを持たない。
- **手順の名前**: `setup.<製品>`（公開入口の導入手順）、`package.<npm package>`、`npm`、`markitdown`、`unai`、`typesafe`、`jev`、`spotter-install`、`toolchain-ledger`、`factory-report`。`claude-code`・`codex-cli`・`grok-build`の更新結果は台帳がreportへ運ぶので、ここでは数えない。
- **重大度**: 手順の名前や回数では決めず、確かめた実害で決める。規則は下の「重大度と根拠」。
- **届かなかっただけの回**: reportの準備・送信が、BugHubから応答を受け取れなかった保留だけで終わった回は、`factory-report`の失敗にも成功にも数えず、未解決の記録にも触れない。reportは送信待ちに残り、次の毎時の実行が送り直す。更新のlogには`DEFERRED:`の行が残り、更新の終了値は非0のまま。BugHubが応答して断った保留、隔離、ackの失敗、reportの生成や予約の失敗は、これまでどおり手順の失敗に数える。
- **記録**: `agents-update.sh`が最後に`bin/factory-update-failure-report.mjs record`へ、動いた手順と失敗した手順の名前を渡す。失敗した手順は回数を累計し、次の回で成功した手順は解決済みにする。今回動かなかった手順には触れない。記録や送信ができなくても、更新の結果は変えない。
- **置き場**: 記録は`~/.local/state/dotagents/update-failures.json`、送信の設定は`~/.config/dotagents/update-failure-reporting.json`（Windowsはどちらも`%LOCALAPPDATA%\dotagents\`）。合鍵はBugHubの持ち主が置く`~/.config/bughub/product-credentials/dotagents.json`（Windowsは`%LOCALAPPDATA%\bughub\product-credentials\dotagents.json`）で、dotagentsは読むだけで作らない。
- **送信**: 既定では送らない。端末で`factory-update-failure-report.mjs enable`を実行し、合鍵が本人だけの通常のファイル（0600、リンクでない）である時だけ送る。送る形はBugHubの製品報告の契約（`bughub/PRODUCT_REPORTING.md`）で、`error_code`は`UPDATE_STEP_FAILED`、`component`は手順の名前、版は`0.0.0+<revision>`。受領済みにするのは、200・`accepted`・同じ`report_id`・応答の署名がそろった時だけ。
- **確認と停止**: `factory-update-failure-report.mjs status`が、送信の状態・未解決の手順・最後の結果を返す。`verify`は、記録に触れずに中身が空の報告を1回送り、合鍵・宛先・応答の署名を確かめる（BugHubにissueは出来ない）。届かなかった分は次の更新で送る。待たずに送る時は`flush`。止める時は`disable`。
- **限界**: 更新が動かなかったこと（端末が止まっていた、予定が外れていた）は検出しない。WindowsはACLを確かめず、合鍵が通常のファイルでリンクでないことだけを見る。

### 重大度と根拠

手順の失敗で確かなのは「この回の更新がその手順で止まった」ことだけで、原因（通信・製品・端末）は未確定なので、`warn`で載せる。失敗が続いた事だけでは上げない。根拠は、この回の工場のreportで、その手順が導入・設定する製品を起動できたか（版を読めたか）だけから読み、次の3つに分ける。

| この回の根拠 | 1回目の失敗 | 前の回も失敗している時 |
|---|---|---|
| 起動できない（製品が`missing`） | `warn`（次の回が再試行する） | `high` |
| 起動できる（対象の製品すべてが`installed`） | `warn` | `warn`へ評価し直す |
| 観測なし（reportを読めない・6時間より古い・製品の状態が未確認・止まる製品を持たない手順） | `warn` | 前の評価を保持する |

- `high`の時に止まっている機能は製品の起動、影響はこの端末のその製品、復帰はその手順が通るか人の手による導入。
- 起動できる製品のcheckが`fail`でも、版照会・期待値検査・診断の失敗だけで全体の利用不能とは扱わない。どのcheckが`fail`かは根拠（`製品ID:check_id`）に残し、何が止まりどう復帰するかは、製品のcheckが製品の名前と製品の重大度で運ぶ。
- 観測なしの回は、確かめた`high`も、評価していない以前の`high`（重大度を持たない記録）も下げない。`warn`は実害を確かめていない事を表し、無害の証明ではない。
- 重大度と根拠（製品、failしたcheck、観測時刻）は端末の記録に残り、`factory-update-failure-report.mjs status`の`open_records`で読める。BugHubへ送る形には足していない。
- 工場自身の手順（`npm`・`toolchain-ledger`・`factory-report`）と、製品を持たない手順（`typesafe`・library）は止まる製品を持たない。npmが無い端末の影響は、`claude-code`・`codex-cli`の`last_update`（`npm_unavailable`）が運ぶ。
- 手順と製品の対応は`lib/factory/update-failure-report.mjs`の`STEP_PRODUCTS`が持つ。手順や製品を足す時は、ここへ対応を足す。

## 製品診断の細目と登録条件

製品の診断が部品ごとに`status`と`reason_code`を返す時、工場は全体の合否1個へ丸めず、部品ごとのcheckで運ぶ（2026-10-10、オーナー裁定 K-3WADM6）。今の対象はCaveatだけで、ほかの製品へ広げる時は、製品の担当の同意とオーナーの裁定を先に取る。

- **呼び出し**: `caveat factory-diagnostics --json --require-connector cursor --require-connector grok`。macOS・Linux・Windowsで同じ引数を渡し、Claude Code・Codex・Cursor・Grokの4つを製品の合否へ入れる。overallと終了値は製品へ委ね、工場は集約し直さない。
- **部品（15個）**: `database`、`sync`、`claude_mcp`、`claude_hook_{user_prompt_submit,post_tool_use,post_tool_use_failure,stop}`、`codex_hook_{user_prompt_submit,post_tool_use,stop}`、`cursor_hook_{before_submit_prompt,post_tool_use,post_tool_use_failure,stop}`、`grok_mcp`。一覧は`lib/factory/caveat-diagnostics.mjs`の`CAVEAT_COMPONENTS`が持つ。
  CaveatのGrok対応はMCP登録だけで、専用のhookは製品に無い。CodexとCursorのMCP診断もv1に無い。無い部品を`pass`にも不足にもしない。出力に無い部品（古い版）はcheckを作らない。
- **合否**: 製品の`status`を写す。`ready`は`pass`、`not_ready`は`fail`、`unverified`は`unverified`。
- **重大度**: 製品が答えた回の`not_ready`は`warn`。実害を確かめていない事を表し、無害の証明ではない。理由の名前・回数・時刻から`high`や原因の責任を推論しない。v1は影響・重大度・復帰を宣言しないので、工場は無い欄を仮定しない。
  実害（検索できない、入力が消えるなど）は製品自身のruntime記録が製品の重大度で運ぶ。その記録が空でも、実害なしとは扱わない。
- **identity**: fingerprintは「製品＋check_id」から作り、理由・版・重大度・時刻を入れない。同じ部品で理由が変わっても（`behind`から`remote_mismatch`など）同じissueのままで、理由は`reason_code`と生のreportの履歴に残る。
- **秘密**: `reason_code`は`^[a-z][a-z0-9_]{0,63}$`に合い、path・token・鍵の形を含まない物だけ運ぶ。外れた部品は`unverified`／`detail_schema_invalid`にし、外れた値や診断の生の出力をreportにも報告文にも写さない。path・設定の中身・remoteのURLは読まない。
- **旧check `native_diagnostics`**: 製品のoverallが`ready`の回だけ`pass`を出す。BugHubは、同じcheck_idの`pass`でしかissueを閉じない（checkが消えた・`unverified`になっただけでは閉じない）ので、以前のissueはこの`pass`で閉じる。
  overallが`not_ready`で部品の`fail`がある回は出さない。部品の`fail`が1つも無い回（工場が知らない部品が増えた時など）は、`native_diagnostics`を`fail`／`warn`／`native_not_ready_unattributed`で残す。以前の`native_not_ready`とは別のfingerprintになり、以前の記録へ新しい重大度は載らない。
  overallが`unverified`で、未確認の部品が1つも無い回は`native_diagnostics`を`unverified`／`native_unverified`で残す。出力がschemaから外れた回は、以前と同じ`native_diagnostics`／`unverified`。
- **復帰の読み方**: 後のreportで同じcheckが`pass`になった事は、その部品の診断の状態が戻った事を表す。検索・書込み・ログイン・実際のMCP接続が動く事の確認とは分けて扱う。`grok_mcp`の`pass`が示すのは、登録が有効で正規の実行先を指す事まで。明示的な無効化（`disabled`）は自動で解除せず、そのまま運ぶ。
- **変えていない物**: ほかの製品の診断（Throughline・Aiterm・Spotter・gpt-connector・Lattice・unai）の重大度と、harnessの安全hook・設定検査（`required_hooks`・`config_parser`・`native_routing`）、`last_update`。旧wire（v2と初代）のCaveatの読み方も変えていない。

## 通信失敗の報告

登録の条件と重大度は[BugHubの通信失敗の契約](https://github.com/kitepon/ServerManager/blob/main/bughub/NETWORK_REPORTING.md)に従う（2026-10-07、オーナー指示）。工場は、通信の診断の記録と、修理が要る登録を分ける。理由コードや回数だけで`fail`や`high`にしない。

- **工場自身の送信**: factory reportの`flush`と、定期更新の失敗報告の送信は、届かない時に送信待ちへ残し、次の実行で送り直す。BugHubは同じ`report_id`・同じ本文を重複として受け、失敗報告は累計を送るので、送り直しで二重に数えない。届かなかった事そのものはBugHubのissueにしない。`flush`は、保留のうちBugHubから応答を受け取れなかった件数を`unreachable`で返す。
- **scanの通信を伴うcheck**: `npm_latest`（registryの最新版）は、読めない時に`unverified`／`registry_unverified`で残す。`fail`にしない。
- **`last_update`（定期更新の台帳）**: 重大度は、失敗した更新のあとにCLIを起動できるかで決める。「起動できる」は、更新の直後（台帳の`after_version`）か今回のscan（`installed_version`）のどちらかで版を読めたことを指す。

| 台帳の理由 | CLIを起動できる | 起動を確かめられない |
|---|---|---|
| `registry_unavailable`・`check_failed`（最新版の確認が失敗。導入に触れていない） | `unverified`（理由はそのまま） | `fail`・`high` |
| 上記以外の失敗（入替、版の照合、期待値の検査。原因は台帳に無い） | `fail`・`warn` | `fail`・`high` |

- **限界**: 入替の失敗の原因（通信・ファイルのlock・権限）は台帳に無く、端末の更新logにだけ残る。grok-buildはscanが`grok update --check --json`でしか版を読まないので、確認や更新が失敗した回は`agents-update`が`grok --version`で起動を確かめ、読めた版を台帳の`after_version`へ残す。

## 停止・失敗

- client送信停止は`reporting.enabled=false`。既存outboxを保持する。
- credential漏洩はServerManager側で対象credentialをrevokeし、host側fileを置換する。
- scan非0はenqueueしない。reporter非0はstdoutのtyped codeに従い、acceptedでないoutboxを保持する。
- 製品CLIの応答が上限（既定20秒）を超えた時は、そのcheckを`unverified`／`cli_timeout`で残す。出力を読めていないので`fail`にせず、製品側の契約違反（`native_schema_invalid`など）とも区別する。npm CLIの版を読む呼出しが時間切れした時は、PATH上の別の導入へ読み替えない。
- server-side停止・migration・feature flag・credential lifecycle・BugHub復旧はServerManagerの正本に従う。
