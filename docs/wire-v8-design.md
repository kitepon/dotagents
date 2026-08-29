# wire v8 設計正本 — unaiの固定集合編入

**状態:** Active
**工程正本:** Lattice plan `unai-core-integration`
**対象:** dotagents reporter、ServerManager / BugHub ingest、4 active host
**決定:** [ADR 0131](adr/0131-unai-core-integration-lane-admission.md)

本書はwire v8の公開契約を所有する。wire v2〜v7は履歴として凍結し、v7はhost別rollback先として維持する。

## 1. major更新の理由

wire v7は`additionalProperties: false`とexact-key検証を持つ固定14製品契約である。unaiを同じversionへ後付けすると同一schemaの意味が変わるため、新しいwire v8で編入する。

## 2. 固定15製品

`products`のキーは次の順序・集合に固定する。

1. `caveat`
2. `throughline`
3. `spotter`
4. `lattice`
5. `markitdown`
6. `gpt-connector`
7. `aiterm-mcp`
8. `codex-sidecar`
9. `servermanager`
10. `claude-code`
11. `codex-cli`
12. `grok-build`
13. `aishell`
14. `peertable`
15. `unai`

clientとserverは15キーの完全一致を検証し、欠落・余剰・別名を拒否する。`observer`は含めない。

## 3. transportとversion

- schema: `factory.report.v8`
- `schema_version`: `8.0`
- endpoint: `POST /api/factory/v8/reports`
- report mode: `full`
- feature flag: `FACTORY_V8_INGEST_ENABLED`
- identity、late-report ordering、current/history、issue transitionはv7までの契約を継承する
- v7 endpoint、schema、state、outboxはrollback用に変更せず維持する

request pathのmajorでschemaとhost expectationを評価する。v8を旧majorの分岐へfall-throughさせず、payloadを暗黙変換しない。

## 4. unai projection

正規入口は`unai factory-diagnostics --json`、schemaは`unai.native_factory_diagnostics.v1`である。`lib/factory/v8.mjs`は次だけをexact検証する。

- `product.name === "unai"`、`product.version`がsemver
- `checks`が`manifest_consistency`・`node_runtime`・`skill_bundle`のexact allowlist
- 各checkが`pass`または`fail`
- `overall`が`ready`または`not_ready`
- `ready`は全check passかつexit 0、`not_ready`はfailを含み非0

schema不正は`unverified`、CLI不在は`missing`へfail closedする。校正対象本文、voice profile、絶対path、secretはreportへ載せない。`safe_context`は空集合のままとする。

## 5. host expectationと文章面

unaiはMac、main-server、FOX WSL2、FOX Windows nativeの全4 hostで`required`、欠落severityは`high`とする。製品導入と文章面への適用は次の二つに分ける。

- 製品面: 公式installerでskillとCLIを配り、native diagnosticsをfactory reportへ射影する
- 利用面: `shared/constitution.md`の「文章・返答の文体はunai skillの規範に従う。」を全host生成物へ同文で配る

host deltaへ別表現を置かず、unai規範本文もdotagentsへ複製しない。

## 6. server-first cutover

1. ServerManagerへv8 schema、endpoint、固定15製品、host expectationを追加し、v7を保持したまま配備する。
2. `FACTORY_V8_INGEST_ENABLED=true`を有効化し、v8 endpointが認証境界まで到達し、v7 endpointが不変であることを確認する。
3. dotagentsのv8 clientと新binを各hostへ配る。scheduler登録前に`install.sh`を再実行し、bin symlinkを解決する。
4. hostごとにconfigを退避し、endpointとschedulerをv8へ切り替える。一括切替しない。
5. 各hostのfresh full reportがBugHub current viewへ`contract_version 8.0`、固定15製品で反映され、unaiがinstalled/compatibleになることを確認する。

## 7. rollback

host単位で退避configを戻し、schedulerを`--wire-major v7`へ再登録する。v8 state/outboxは削除せず、v8 payloadをv7へ変換しない。全hostがv7へ戻った後なら、serverの`FACTORY_V8_INGEST_ENABLED=false`でv8受付だけを停止できる。v7 endpointと履歴、unaiの公開releaseは保持する。

## 8. 非目標

- unaiの校正規範やvoice profileの変更
- 既存wire v2〜v7の製品集合変更
- v7 schemaへのunai後付け
- 文章本文・プロンプト・利用履歴の集約
- repoの移動・改名

## 9. 受入条件

1. client、server、schema、deployment contractが同じ固定15製品を検証する。
2. native diagnosticsのready、not_ready、schema不正、CLI不在を正しく射影する。
3. 全host生成物へ共通の一行が1回だけ入り、host deltaへ重複しない。
4. v7のschema、endpoint、履歴、issue transitionが非回帰である。
5. 全4 hostのfresh v8 deliveryとBugHub matrixでunai installed/compatibleを実測する。

## 工程正本

task、依存、ready frontier、完了証拠はLattice plan `unai-core-integration`だけを正本とする。この文書へtask checkboxを複製しない。
