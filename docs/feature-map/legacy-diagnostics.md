# 旧wire v2/v4の個別診断

[全体入口](../09_feature-map.md)→[診断詳細](diagnostics.md)、[旧scan描画](diagnostics-legacy.svg) / [原本](diagnostics-legacy.mmd)。base `9fca2c8`、候補`5c5890d`。`lib/factory/v2.mjs`本文と`v4.mjs`との全差分を照合した。旧wireの互換契約を現行v5-v9へ黙って共通化しない。

## 実関数と受渡し

| v2/v4の同名private関数 | 所有する検査・投影 | 失敗・保持 |
| --- | --- | --- |
| `throughlineDiagnostic` | exact keys、database v8/v9の既移行tuple、Codex hook events集約、readiness/証拠/connector、canonical reasonを検査 | 旧0.8.0のlabel v8/schema9受理を保持。status集約とexit不整合は拒否。副作用の無い投影で、製品のhookを修理/有効化しない |
| `spotterDiagnostic` | marker/context/catalog/hook/runtime storeの形・固定7check順序、inactive/不正marker例外とoverall整合 | 任意check追加/重複、自由なreason、秘匿対象のpath/tokenを拒否。inactiveはnot_applicable、fail/not_readyを一括unverifiedへ隠さない |
| `aitermDiagnostic` | read-only PTY件数、stdio MCP、runtime store collection、vendor optional依存、overall整合 | vendorの不在を必須化せず、ready/unverifiedと未適用の数を検査。実vendor/PTY接続を追加しない |
| `sidecarDiagnostic` | failure shapeと既schema1/workflow/preset/3package同版/明示model-policy/auditor dry-runの全整合 | failed shapeを保持し、版不整合をinstalled成功にしない。retired sidecarを現行必須へ戻さない |
| `native/nativeResult/unavailable/componentChecks/failure` | run→JSON→製品parser→公開projection。missingはspawn ENOENT、他schema/exit失敗はunverified。not_applicableはskipped | 旧failureはhigh、fingerprintはproduct+check+reason。現行v5のCaveat部品warn/製品+check固定指紋と異なる。parserの理由は既callerへ戻す |
| `projectGptConnectorFactory/projectGptRuntime/gpt` | 固定9check、state/job/migrationとoverall/exitを照合。collection時だけsnapshot256件、cursor/公開error/解消/重複/privacyを検査 | snapshot失敗はruntime_errors unverified、ACK:null。disabledはempty/zero/未適用を要求。next>acknowledgedの時だけACK候補。製品内部のlive許可へ広げない |
| `claudeIntegration/codexIntegration/canonicalHookEntry/canonicalCodexHookCommand` | HOME settings/TOML/同期PreToolUseとhook command/timeout/重複を照合。Codex features listを検査 | 不正はincompatible/high。旧ClaudeはBash定義、現行の追加親契約と同一にしない。検査passは実session発火の証明ではない |
| `npmCli/grokUpdate/grok` | installed版/registry latest、既SemVer比較・降格拒否、Grok stable updateの公開形 | 取得不能はunverified、Grok spawnはnot_applicable/skipped。導入更新はせず、registry失敗を新しい版や既台帳で補わない |
| `markitdown` | --version後に専有temp textの変換を行い公開結果だけ投影 | finallyでtemp回収。親強制終了後の回収や全scan rollbackは保証しない |
| `applyToolchainLedger` | 共通readerで読んだ台帳を既3CLI last_updateへ投影 | operation/gate失敗は旧high failure、drift/pending/欠測はunverified。現行のwarn差を保持。保存台帳自体は変更しない |

## wire間の差と呼出し順

v2は固定12 IDで旧Codegraphをnot_applicableにし、実行・再導入しない。Caveatは共通`parseCaveatDiagnostic`を使い、commandに`--require-connector cursor`を渡す。

v4はCodegraph欄をLatticeへ置換し、`scan.mjs:latticeProduct`へ接続。Caveatは同file内のexact旧database/sync/Claude・Codex connector/hook構造を要求し、自身のaggregateでoverall整合を検査する。required schema3/固定keysの旧受理差を現行parserへ機械的置換しない。Caveat commandはfactory-diagnostics --jsonだけ。Lattice runtime collection/ACKもv4だけ追加する。

両`scanV*WithAcknowledgements`はplatform/arch検査→順次公開診断→任意collection→台帳/3CLI→固定repo revision→report UUID/時刻→同ID ACK bundleを返す。server profileだけServerManager診断と、collection時のexternal event mergeを行う。v2 ACKはGPT/ServerManager、v4はLatticeを追加。collectionEnabled既定false。report-only `scanV2/scanV4`も返却だけを落とすwrapperであり、collection trueで呼べば採取を省略する意味ではない。

旧scan/CLI→ACK metadata→旧reporterの受付後ACKという接続は[配送詳細](delivery-functions.md)を参照する。通常現行v5-v9の空ACKとは別契約。command throw/不正platform/取得不能revisionはcaller失敗で、新完成reportなし。途中診断の実行・temp作成は全transactionで戻さず、既queue/過去reportを成功で消さない。

## caller・test・fixture・config・export

公開exportは各`V*_PRODUCT_IDS/scanV*/scanV*WithAcknowledgements/projectGptConnectorFactory`。直接callerは旧scan CLI、v2/v4 reporter/fixture、v5のV4集合等。依存窓口はcommand、Caveat parser（v2だけ）、scanのServerManager/Lattice、runtime-errors、共通台帳reader、toolchain-contract。env/HOME/hooks/PATH・platformと旧collection configは既契約のまま。新export/config/CLIを加えない。

全literal接点は当席phase12-contacts.txt、v2-v4差分はphase12-v2-v4.diffへ固定。既fixtureは`tests/factory-scan/v2.test.mjs`のnative shape/製品別不変条件/Throughline・aiterm/collection snapshot/ACK、`gpt-connector-runtime-errors.test.mjs`、`spotter-diagnostics.test.mjs`、`tests/lattice-cutover/wire-v4.test.mjs`、toolchain-ledger系へ接続する。今回は接点/case索引と既調査であり、旧診断fixture全件の本文・実行完了とはしない。

重複private parser/投影は[第3設計](../adr/20261103-feature-map-responsibility-phase3.md)で維持を採用した。exact受理・exit・重大度/指紋・Caveat parser・collectionの差を機械的に統合しない。CIのsource接続は[CI配布](ci-distribution.md)、残るfixture/実OSと全体判断は[全体レビュー](final-review.md)を参照する。
