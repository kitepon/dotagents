# wire v8 横断統合契約

**状態:** Active
**決定:** [ADR 0131](adr/0131-unai-core-integration-lane-admission.md)

本書はdotagentsが所有するclient・server間の横断契約だけを定める。ServerManagerの受信実装、
有効化、配備、保存、rollbackはServerManagerが所有し、unaiのnative diagnosticsはunaiが所有する。
完了した編入工程は[履歴](archive/wire-v8-unai-cutover-2026-08-30.md)へ分離している。

## 固定15製品

`products`は次の順序・集合に固定する。

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

clientとserverは15キーの完全一致を検証し、欠落、余剰、別名を拒否する。`observer`は含めない。

## transportとversion

- `schema_version`: `8.0`
- endpoint: `POST /api/factory/v8/reports`
- report mode: `full`
- server payload shape: [ServerManagerのv8 JSON Schema](https://github.com/kitepon/ServerManager/blob/main/bughub/schemas/factory-report-v8.schema.json)
- server意味論と運用: [ServerManager Factory integration](https://github.com/kitepon/ServerManager/blob/main/bughub/FACTORY_INTEGRATION.md)

request pathのmajorでschemaとhost expectationを評価する。v8 payloadを旧majorへ変換せず、旧majorの
payloadをv8へ補完しない。v7 endpoint、schema、state、outboxはrollback互換面として分離して維持する。

## 製品診断の投影

unaiの診断command、JSON shape、check、成功・失敗の意味は
[unaiの製品README](https://github.com/kitepon/unai/blob/main/README.md)が所有する。dotagents adapterは
公開された製品契約だけを検証してfactory reportへ投影し、独自のcheckや終了条件を定義しない。
診断本文、voice規範、対象path、secretはreportへ載せず、unaiの`safe_context`は空集合とする。

## host expectationと文章面

unaiはMac、main-server、rabbit native Linux、FOX Windows nativeの4 hostで`required`、欠落severityは`high`とする。
製品面は各hostへ公式installerで配り、利用面は`shared/constitution.md`の同じ一行を全host生成物へ配る。
host deltaへ別表現を置かず、unai規範本文をdotagentsへ複製しない。

## 所有境界

- client設定、outbox、scheduler、host切替: [factory reporter runbook](factory-reporter-runbook.md)
- server schema、受信、flag、保存、配備、rollback: ServerManagerのFactory integrationとrelease正本
- unai diagnosticsと文章規範: unaiのREADME、skill、manifest
- 横断製品集合、host expectation、client/server互換、工場受入: dotagents
- 完了済みrolloutの証拠: [unai-005](evidence/unai-core-integration/unai-005.md)

dotagentsは各製品の正本を参照して横断受入を行うが、製品の内部操作や判断を複製・制御しない。

## 非目標

- unaiの校正規範やvoiceの変更
- wire v2〜v7の製品集合変更
- v7 schemaへのunai後付け
- 文章本文、prompt、利用履歴の集約
- 製品repoの移動、改名、内部操作の中央化
