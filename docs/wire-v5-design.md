# wire v5 設計正本 — AIShellの固定集合編入

> **現在状態:** 現役とrollback先は[工場の現行状態](factory-current-state.md)を参照する。
> v5は現役入口ではなく、過去majorのrollback契約としてendpoint・schema・state/outboxを維持する。

**状態:** Historical／rollback維持（[AIShell編入計画](plan_aishell-factory-integration.md) Phase A5-P0の設計成果物）
**工程正本:** Lattice plan `aishell-factory-integration`
**対象:** dotagents reporter、ServerManager / BugHub ingest、4 active host

本書はwire v5の**契約**を所有する。工程状態・完了証拠はLattice storeが、
実装手順は各repoのコードと[reporter runbook](factory-reporter-runbook.md)が持つ。

## 1. なぜ新しいwire majorが要るのか

AIShellをBugHubの観測面へ載せる方法は、着手時点では2つあると考えていた。

- **A案**: 新しいwire majorを切り、固定集合へ`aishell`を加える
- **B案**: majorを切らず、server側のexpectation matrixだけで`aishell`をmac=requiredへ昇格させる

**B案はschemaが塞いでいる**。2026-07-25の実測:

| 面 | 実測 |
|---|---|
| BugHub v2 schema | 14キー定義／12必須。`lattice`・`aishell`をoptional keyとして受理する |
| BugHub v4 schema | 12キー定義、`additionalProperties: false`。`aishell`のスロットが**無い** |
| dotagents client | `lib/factory/contract.mjs`の`exactKeys(report.products, V4_PRODUCT_IDS)`が13個目のキーを拒否する |

つまり設計時点の現役wire v4では、`aishell`を送ろうとしても**client / server両端で拒否される**。
「optionalだから報告が無いだけ」ではなく、構造的に席が無い。

A3で入れたserver-first optional登録はv2 schemaにだけ存在し、v4 cutoverの時点で
観測面から消えていた。**編入中製品のoptional key登録はwire majorを越えて継承されない**——
これが本waveで最も高くついた発見であり、[還流対象の罠](evidence/wire-v5/)である。

したがって**凍結を守る限りA案しかない**。ただし「唯一」は政策込みの結論である——
v4 schemaへoptional keyを後から足す改訂（B′案）は物理的には可能で、それを封じているのは
schemaではなく§7の凍結方針である。物理的不可能と政策的棄却を混同しない。

- **純B案**（凍結を守りexpectation matrixだけ触る）: schemaとclient validatorが物理的に塞ぐ。**不可能**。
- **B′案**（凍結を破りv4 schemaを改訂）: 物理的には可能。既に受理済みのv4 reportと受入証拠の
  意味を後から変えることになるため**政策的に棄却**する。
- **A案**（新major）: 採用。

## 2. 固定13製品集合

```
caveat, throughline, spotter, lattice, markitdown, gpt-connector,
aiterm-mcp, codex-sidecar, servermanager, claude-code, codex-cli, grok-build,
aishell
```

v4の固定12製品を**順序も含めてそのまま保持**し、`aishell`を1つ加えた集合とする。
`report_mode="full"`、`schema_version="5.0"`、endpoint `POST /api/factory/v5/reports`。

### 不変条件

- **v5はv4の意味を差し替えない**。v4 endpoint、v4 schema、v4の受入証拠は一切変更しない。
  v5は追加であって改訂ではない。
- v2 / v4のproduct set、schema、凍結済み受入証拠を後付けで書き換えない。
- 製品IDの綴りは既存のまま使う（`gpt-connector`、`aiterm-mcp`、`codex-sidecar`、
  `claude-code`、`codex-cli`、`grok-build`）。v5で改名しない。
- `aishell`のsafe_context allowlistは空から始める。必要keyは契約testと同時に個別追加する。

### v3番号の扱い

`v3`はObserver編入（固定13製品）のために予約された番号だが、**client / serverどちらにも
実装が存在しない**（2026-07-25実測: `lib/factory/`・`bin/`・`bughub/`のいずれにもv3は0件）。
v4がv3を飛び越えて着地している。

v5はこの空き番号を再利用**しない**。Observerが将来編入される時は、その時点の現役majorの
次番号を取る。v3はObserver予約の未実装番号として温存し、v5でObserverを扱わない。

## 3. expectation matrix

server側の期待値は[正本matrix](factory-host-product-matrix.md)と一致させる。v5の`aishell`行は
正本が既に定義している——mac=`required`（Apple Silicon / macOS 15+）、server / wsl /
windows-native=`unsupported`（macOS native API不在）。

| product | mac | server | wsl | windows-native |
|---|---|---|---|---|
| caveat / throughline / spotter / lattice / markitdown / gpt-connector / aiterm-mcp / codex-sidecar | required | required | required | required |
| servermanager | not_applicable | required | not_applicable | not_applicable |
| claude-code | required | required | required | **unsupported** |
| codex-cli | required | required | required | required |
| grok-build | **optional** | **optional** | **optional** | **unsupported** |
| **aishell** | **required** | **unsupported** | **unsupported** | **unsupported** |

### 意味論

- 期待値が`required`**でない**時はexpectation issueを作らない（既存実装どおり)。
- 期待値が`required`の時、`installed`ならresolve、`unverified`ならwarn、それ以外はhigh。
- **`required` + `not_applicable`をissueにしないのは、v5で新たに要求する挙動変更である**。
  現行実装は`installed`でしかresolveせず、`not_applicable`は**high issueになる**
  （`bughub/src/db.js`の`applyFactoryIssues`）。AIShellはApple Silicon専用なので、
  Intel Macが将来hostに加わればmac profileのまま`not_applicable`を報告する。
  profileの粒度がarchを区別しない以上、製品が構造的な非対応を宣言したらそれを信じる。
  **これは既存の意味論ではなく実装変更を伴う要求である**ことを明記する。
  client側も`not_applicable`をこのprofileで出せることを合わせて確認する。
- severityは各報告元の製品契約が決めた値を素通しする。BugHubは再判定しない。

### v5分岐はfall-throughへ委ねない

`factoryExpectation()`は現在`v2`分岐だけを持ち、それ以外は全て`required`へ落ちる。
v5分岐は上表を明示的に書き、fall-throughに頼らない。

## 4. expectation実装と正本の乖離（wv5-0030の裁定）

> **本節は2026-07-25の独立反証（Grok 4.5、cross-provider）で事実認定が覆り、全面改訂した。**
> 初版は「`factoryExpectation()`にv4分岐が無いので全製品がrequiredへfall-throughし、
> grok-buildがmain-serverで偽warnを出している」と書いたが、**誤りだった**。
> 反証の指摘を実コードで再確認した結果を以下に置く。初版の記述は撤回する。

### 実際の評価経路

`bughub/src/factory-ingest.js`の`ingestFactoryReportV4`は`save: db.saveFactoryReportV2`を使い、
`saveFactoryReportV2`は`applyFactoryIssues(hostId, report, receivedAt, 'v2')`を呼ぶ。
つまり**wire v4のreportは`version='v2'`として期待値評価される**。fall-throughしていない。

その結果、v2分岐の規則がv4にもそのまま効いている:

- `grok-build` → mac/server/wsl=`optional`、windows-native=`unsupported`（**正本どおり。乖離なし**）
- `claude-code` windows-native → `unsupported`（**正本どおり。乖離なし**）

初版が挙げた乖離2件は**どちらも存在しない**。main-serverのgrok-build `unverified`は
`optional`として解決されており、偽warnは発生していない。live matrixでも確認した。

### 本当の乖離（実測で確定）

| product | 正本 | 実効値 | 状態 |
|---|---|---|---|
| `lattice` | 4 profile全て`required` | `optional` | **live影響あり** |
| `codex-cli` windows-native | `required` | `unsupported` | 潜在 |

`factoryExpectation()`のv2分岐は`['lattice','aishell']`を無条件に`optional`へ落とす。
コード上のコメントは「Latticeはv4でenroll済み」と書いているが、**v4のreportがv2として
評価される以上、latticeは永久に`optional`のまま**であり、意図が実装されていない。

**live影響**: BugHub matrixで`fox-wsl`の`lattice`は`missing`だが、期待値が`optional`
のためexpectation issueが1件も上がっていない。**wire v4で必須コア製品へ昇格させたはずの
Latticeの欠落が、4 hostのうち1台で黙って見逃されている**。

`codex-cli` windows-nativeは、v2分岐が`claude-code`と同列に`unsupported`へ落とすが、
正本matrixは`required`である。現在windows-workstationは`installed`なので潜在に留まる。

### 裁定

**v5分岐を明示的に書き、あわせて`lattice`のrequired化と`codex-cli` windows-nativeの
required化を同一波で修理する。**

- **理由1**: `lattice`の欠落見逃しは、期待値matrixが存在する目的そのものを損なっている。
  必須製品が1台で欠けていて誰も気づかない状態を、次のwaveへ持ち越さない。
- **理由2**: 修理対象は`factoryExpectation()`という同一関数であり、v5分岐を書く時に必ず触る。
- **理由3**: v5でaishellをrequiredへ昇格させる際、`['lattice','aishell']`の無条件optional分岐を
  そのまま残すとaishellも同じ罠に落ちる。**同じ欠陥をv5で再生産しない**ために、
  ここで分岐の設計自体を直す必要がある。

**凍結との関係**: product setもschemaも変更しない。変えるのはserver側expectation matrixだけで、
`FACTORY_INTEGRATION.md`が「server期待matrixはdotagents正本と一致させる」と定めている以上、
現状は**contract違反であって仕様ではない**。ただし`lattice`をrequiredへ上げると、
`fox-wsl`で**新たにhigh issueが1件立つ**。これは隠れていた事実の可視化であり、
cutover受入の判定を汚さないよう、P1完了時点で「新規に立つissueは`fox-wsl`/`lattice`の1件だけ」
であることを実測で確認してから進める。

## 5. v4 → v5 compatibility契約

- **v4 endpointは受理を継続する**。v5 cutover中も、退役裁定（P6）を通すまでv4を止めない。
  `FACTORY_V4_INGEST_ENABLED`と`FACTORY_V5_INGEST_ENABLED`は独立flagとし、片方の停止が
  他方に波及しない。
- **issue identityは`host + product + fingerprint`で共有する**。wire majorをまたいでも
  同一障害を二重issue・二重通知にしない。これはv1→v2→v4で確立済みの規則を継承する。
- **late reportによる巻戻しを拒否する**。観測時刻で判定し、遅れて届いた旧majorのreportが
  新しいcurrentを上書きしない。
- **storageはv2/v4と同じ面を共有する**。v4は既に`factory_v2_reports` /
  `factory_v2_observations` / `factory_v2_current`へ保存しており（`ingestFactoryReportV4`が
  `saveFactoryReportV2`を使う）、major別に分離していない。**v5もこの共有面へ載せ、
  履歴を連続させる**。初版は「major別に分離する」と書いたが、それは実態でも先例でもない。
  分離するのはv1とv2以降の境界だけである。
- **credentialとendpoint schemaは増やさない**。既存のhost-scoped credentialに乗る。
  製品専用のcredentialやschema majorを作らない。

## 6. rollbackとhost別退避

- **host単位でv4へ戻せる**。global booleanでの一括切替はしない。`factory-reporter-scheduler`の
  `--wire-major v4`で当該hostだけ戻し、他hostのv5運用に影響させない。
- **戻す間もoutboxを保持する**。未送信reportを破棄しない。
- **v5 flagを無効化すればv4運用が無傷である**こと。server側で`FACTORY_V5_INGEST_ENABLED=false`
  へ戻した時、v4の受理・matrix・issueが変化しないことをrollback条件とする。
- **BugHub履歴は削除しない**。v5で観測した`aishell`の履歴は、v4へ戻しても保持する。
- Lattice cutover（wire v4）と同じく、各hostの設定backupをowner-only stateへ保存してから切替える。

## 7. 非目標と既知の罠

### 非目標

- Observerをv5で扱わない。v3はObserver予約の未実装番号として温存する。
- 凍結済みwire v2 / v4のproduct set、schema、受入証拠を後付け変更しない。
- macOS arm64専用というAIShellの製品境界を、未実装hostで動くかのように見せない。
- 製品専用のcredential、endpoint、schema majorを増やさない。
- 全hostの一括切替をしない。

### 既知の罠

1. **編入中製品のoptional key登録はwire majorを越えて継承されない**。v2で`aishell`を
   optional keyとして登録しても、v4 schemaがそれを持たなければcutoverの瞬間に観測面から消える。
   次に「編入中製品」を作る時は、**登録したmajorと、requiredへ昇格するmajorの間に別のmajorを
   挟まない**か、挟むなら当該majorにもoptional keyを引き継ぐ。
2. **AIShellのpath・許可root・process引数・native診断本文をreportへ送らない**。
   `safe_context` allowlistは空から始める。
3. **暗黙fallbackを追加しない**。非対応hostでは構造的な`not_applicable`を返し、
   shell / AppleScript / JXAへ逃がさない。
4. **`factoryExpectation()`のfall-throughに頼らない**。新majorを足す時は分岐を明示的に書く。
   書かないとv4と同じ乖離を再生産する。
