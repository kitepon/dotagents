# 製品文書の所有・重複・寿命監査

## 監査結論

全製品で、README/AGENTS/計画書/工場台帳へ同じ仕様・release状態が重複していた。統合先は次の順で固定した。

1. 利用者の導入・利用・更新は製品README。
2. 状態・schema・診断・復旧は製品のcurrent contract/runbook。
3. release判断は製品AGENTS/RELEASEと機械gate。
4. 不変Decisionは製品ADR、完了工程は製品archive、証拠はevidence。
5. dotagentsは公開入口のpointer/projectionとhost/wire横断契約だけ。

## repo別の処置

| repo | archive / merge | 所有境界修正 |
|---|---|---|
| dotagents | 完了plan 5本をarchive。固定pathのmaster/stub/elastic証拠はhistory化。製品台帳・gpt運用・reporter履歴をcurrent統合面から分離 | 統合台帳を公開入口・projection・privacyへ縮約 |
| Caveat | announcement、完了Codex/private-tier/BugHub工程をarchiveし、dual-support・storage・diagnosticsへ統合 | sealed publish、Cursor、状態、復旧、更新、releaseをCaveat側へ収束 |
| Throughline | 完了plan/diagnostics/runtime-error/Grok工程をarchiveし、README/current contracts/ADRへ統合 | schema v9、診断、復旧、更新、releaseを製品側へ収束 |
| Spotter | revoked plan、完了diagnostics/runtime-error planをarchive。dashboard/evaluationはcurrent contractと運用へ分離 | status履歴をCHANGELOGへ、製品hook/state/recoveryを製品側へ収束 |
| Lattice | 完了Gantt/bridge/ToDo構造plan群をarchive。現役planだけ索引 | host絶対Patent正本とdotagents live-store正本を廃止し、repo内PLAN/product contract/.latticeへ回収 |
| gpt-connector | 完了3planをarchiveしdocs indexを新設 | browser/session/diagnostics/recovery/update/releaseを製品repoへ回収 |
| aiterm-mcp | 完了plan/監査/release工程をarchiveし、必要な固定pathだけhistory stub | PTY lifecycle、診断、復旧、releaseを製品repoへ回収。不存在tool案内を修理 |
| codex-sidecar | 完了3planをarchiveし二重docs indexを統合 | global host絶対path依存を除き、state/diagnostics/recovery/update/releaseを製品repoへ回収 |
| AIShell | 完了spikeと版別release noteをarchive collectionへ移しindex化 | profile/state/migration/update/releaseを製品repoへ回収 |
| ServerManager | 完了plan 6本をarchiveしcomponent入口へ統合 | BugHub credential/DB/deploy/recoveryをServerManager側、client transportだけdotagents側へ分離 |
| Peertable | terminalなcampaign 22本をarchiveしcurrent索引を新設 | 隣接dotagents model表の暗黙優先を廃止。同梱provenance artifactを既定、外部は明示opt-in |
| unai | archive対象なし。小規模なためREADME/AGENTSへ統合 | release/rollback/Windows uninstall/競合復旧を製品repoで完結 |

## 移動禁止

- Control/Lattice/evidenceがexact pathとdigestを束縛するADR、証拠、migration ledgerは移動・改名・意味統合しない。
- dotagentsの`plan_factory-master.md`、elastic decision/evidence、旧入口stubはroot pathを保って`history`へ分類する。
- 状態がpending/in-progressのplan、または恒久契約をまだ抽出していないplanは今回archiveしない。

## 反対仮説

公開command/schema ID、adapter exact mapping、privacy、host期待、wire固定集合、server-first横断順序まで製品repoへ分散すると、工場の互換判定が成立しない。このためそれらはdotagentsへ残す。一方、製品内部のdiagnostic意味論、state、migration、hook、update、releaseまでdotagentsへ残すと、単独clone時に制御を失う。この二つを同じ「契約」と呼ばず、integrationとproduct controlへ分離した。
