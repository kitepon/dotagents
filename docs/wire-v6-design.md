# wire v6 設計正本 — Observerの固定集合編入

> **現在状態:** 現役とrollback先は[工場の現行状態](factory-current-state.md)を参照する。
> **v6は現役入口ではない過去major**として維持する（endpoint・schema・各hostのv6 state/outboxは削除しない）。v6 scan/validatorの必須集合はv5と同じ13製品で、
> `observer`キーは出さない。Observer編入後の固定14製品が全hostで現役だったのは2026-07-26〜2026-08-10。
> 以下のv5記述はv6へ移行する設計時点のpredecessor契約として保持する。

**状態:** Historical／二段目rollback維持（[Observerコア編入記録](archive/plan_observer-core-integration.md)の設計成果物）
**工程正本:** Lattice plan `observer-core-integration`  
**対象:** dotagents reporter、ServerManager / BugHub ingest、4 active host  
**決定:** [ADR 0124](adr/0124-wire-v6-observer-enrollment.md)

本書はwire v6の契約を所有する。工程状態・完了証拠はLattice storeが、
実装手順は各repoのコードとreporter runbookが持つ。

## 1. 新しいwire majorが必要な理由

設計時点の現役wire v5は固定13製品を完全報告する契約であり、`additionalProperties: false`と
exact-key検証により未知の製品キーを拒否する。Observerをv5へ暗黙追加することは、
同じversion文字列のschemaを事後変更する契約破壊になる。

wire v3にはObserver用の予約設計があったが、実装・cutover・運用には使われなかった。
歴史上の未使用versionを後から有効化すると、既存証拠と「v3を受理した」という意味が
食い違う。したがってObserverは新しいwire v6へ編入し、v3は履歴として凍結する。

## 2. 現行必須集合は13製品

現行v6 scan/validatorの必須キーはv5と同じ13製品である。編入時の14番目`observer`は後続裁定で削除し、余剰キーとして拒否する。

編入時点の履歴集合は次のとおり（現行契約ではない）。

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
14. `observer`

clientとserverはこの14キーの完全一致を検証する。欠落、余剰、別名、重複を拒否し、
製品集合をoptional keyやserver側だけのexpectationで拡張しない。

## 3. transportとversion

- schema: `factory.report.v6`
- `schema_version`: `6.0`
- endpoint: `POST /api/factory/v6/reports`
- report: 各hostの固定14製品を毎回完全報告する
- identity、late-report ordering、current/history保存はv5までの契約を継承する
- v5 endpointとschemaはrollback期間中、変更せず並存させる

serverはrequest pathから決まる実際のwire versionでschemaとexpectationを評価する。
共有save pathを通る場合も、v6をv2またはv5の既定分岐へfall-throughさせない。

## 4. Observerの診断projection

### 4.1 正規入口

reporterは製品所有の正規入口 `observer diagnostics` を実行し、
schema `observer.product_diagnostics.v1`だけを解釈する。
`observer-mcp --diagnostics`はMCP配線の互換確認に使えるが、製品状態の第二正本にはしない。

projectionは少なくとも次を機械的に照合する。

- product IDはwire key `observer`
- 公開package identityと報告versionが導入済みartifactに一致する
- 診断schemaが期待versionに一致する
- readinessが製品所有の安全な状態語彙で表現される
- unsupported hostは失敗へ偽装せず、構造化された`unsupported`を返す

Observerの内部DB、watch session、mailbox、prompt、thread、監視対象pathを
dotagentsやServerManagerが直接読んではならない。

### 4.2 privacy

Observerの`safe_context` allowlistは初期状態で空集合とする。次を送信しない。

- filesystem path、repository path、socket path
- prompt、応答、transcript、mailbox内容
- session / thread / watch ID
- raw diagnostics、内部state、DB row
- token、credential、環境変数値

製品所有の公開契約としてsanitized snapshotまたはack vocabularyが追加されるまでは、
Observer runtime errorの詳細をBugHubへprojectionしない。代わりに公開診断の
status、reason code、versionだけでfingerprintを作る。

## 5. host expectation

| profile | Observer expectation | 理由 |
|---|---|---|
| macOS arm64 | `required` | Observer v1の正式support host |
| Linux server | `unsupported` | v1のsupport外 |
| WSL | `unsupported` | v1のsupport外 |
| Windows native | `unsupported` | v1のsupport外 |

`unsupported`は製品欠陥ではない。macOS arm64で未導入、診断失敗、version不一致、
schema不一致が起きた場合だけObserverのcompatibility issueを生成する。

## 6. BugHub issue契約

- issue identityは既存どおり`host + product + fingerprint`
- severityは報告元の製品診断またはadapter契約が決め、BugHubは上書きしない
- `resolve` / `reopen`と`/ai`の既存契約を維持する
- late reportはcurrent viewを巻き戻さない
- v5とv6で同じ根因を観測した時は、wire versionだけで別issueを増殖させない
- Observer内部状態をServerManagerが直接修復・変更しない

## 7. server-first migration

1. ServerManagerへv6 schema、固定14製品、expectation、fixture、endpointを追加する。
2. `FACTORY_V6_INGEST_ENABLED=false`を既定にし、v5 ingestを変更しない。
3. v6のschema、unknown-key拒否、late-report、issue identity、v5 regressionを検証する。
4. server側だけv6 ingestを有効化し、client未送信状態がv5運用へ影響しないことを確認する。
5. dotagentsへv6 reporter、Observer adapter、fixture、host matrixを追加する。
6. macOS arm64のcanary hostからv5/v6 dual-runを始める。
7. Linux server、WSL、Windows nativeでObserverが構造化`unsupported`になることを確認する。
8. 全active hostのv6 current view、history、issue transition、privacyを照合してcutoverする。

feature flagはv5と独立させる。単一のglobal switchでv5を同時停止しない。

## 8. rollback

rollbackはhost単位でv6 reporterを止め、backup済み設定からv5 reporterへ戻す。
server側は`FACTORY_V6_INGEST_ENABLED=false`でv6受付を停止できる。

rollback時も次を維持する。

- v5 endpointと固定13製品契約
- v5/v6のreport historyとoutbox
- BugHub issue history
- Observerの公開releaseと導入済みartifact

historyを削除せず、v6 reportをv5形式へ書き換えない。Observerが導入済みでも、
v5 reporterはObserverを報告しない。v5のretireは全hostの安定運用と監査完了後の
別裁定であり、本waveのcutoverと同時には行わない。

## 9. 非目標

- Observerの監視機能追加、UI追加、platform support拡大
- wire v3の復活または履歴改変
- v5 schemaへのObserver後付け
- Observer内部DBの集約
- credential、prompt、session情報の送信
- ServerManagerによるObserver状態の直接変更
- 全host一括の不可逆cutover

## 10. 受入条件

1. client / server / fixture / runbookが固定14製品の同一集合を使う。
2. v6は欠落・未知・余剰product keyを両端で拒否する。
3. macOS arm64でObserverの公開診断からversion・schema・readinessを検証できる。
4. Linux server、WSL、Windows nativeでObserverが`unsupported`になる。
5. Observerのpath、prompt、session、内部stateがreportとBugHubへ流れない。
6. v6のactual version pathでexpectationが評価され、旧versionへfall-throughしない。
7. v5 endpoint、schema、固定13製品、issue transitionのregressionがgreenである。
8. server-first、dual-run、host別cutover、host別rollbackを実証できる。
9. late reportがcurrent viewを巻き戻さず、historyが保持される。
10. v5へ戻した後もObserver releaseとBugHub履歴が破壊されない。

## 工程正本

task、依存、ready frontier、完了証拠はLattice plan `observer-core-integration`だけを正本とする。
この文書へtask checkboxを複製しない。ControlはPhase gate、F/H裁定、受入証拠、
外部実行の検証可能性を所有する。
