# 工場 host × product 期待matrix

正本: dotagents

このmatrixは、工場が各hostと親AIへ要求する接続状態だけを定める。製品の導入・設定・状態・schema・migration・診断の意味・復旧・更新・CI・releaseは各製品repoが所有する。過去の導入Wave、端末ごとのsession、導入済みversion、製品内部のcommandは[凍結した旧版](archive/2026-08_factory-host-product-matrix-pre-autonomy.md)に置き、ここへ戻さない。

## 判定語彙

- `required`: そのhostまたは親で必須。欠落は`high`。
- `optional`: 利用できるが成立条件ではない。欠落は`info`。
- `forbidden`: 依存方向または工場契約により有効化禁止。検出時は`high`。
- `unsupported`: 製品またはplatformに正規入口がない。欠落にせず理由付き`info`。
- `not_applicable`: hostまたは親の役割に該当しない。issueを作らない。

## 製品導入

製品集合と区分は[生成された現行状態](factory-current-state.md)が正である。製品のpresenceとconnector面を分け、hostの構造要因で成立しない面だけを`unsupported`にする。

| product | Mac | main-server | FOX WSL2 | FOX Windows native | 欠落severity |
|---|---|---|---|---|---|
| Caveat | required | required | required | required | high |
| Throughline | required | required | required | required | high |
| Spotter | required | required | required | required | high |
| MarkItDown | required | required | required | required | high |
| gpt-connector | required（live面supported） | required（live面unsupported） | required（live面unsupported） | required（live面unsupported） | high（presence。live面はMacのみ） |
| aiterm-mcp | required | required | required | required | high |
| codex-sidecar | required | required | required | required | high |
| Lattice | required | required | required | required | high |
| AIShell | required（対応Mac） | unsupported | unsupported | unsupported | high（対応Macのみ） |
| ServerManager | not_applicable | required | not_applicable | not_applicable | high（main-serverのみ） |
| peertable | required（client） | required（server） | required（client） | required（client） | high |
| unai | required | required | required | required | high |
| Claude Code CLI | required | required | required | unsupported | high |
| Codex CLI | required | required | required | required | high |
| Grok Build | optional | optional | optional | optional | info |

## 親別connector

外部実行connectorの段階とwriter制限は[モデル配置](02_models.md)が正である。この表は有効化の期待だけを持ち、製品の操作手順を持たない。

| product | Claude親 | Codex親 | Grok親 | Cursor親 |
|---|---|---|---|---|
| Caveat | MCP＋hooks required | native hooks required（MCPはnot_applicable） | MCP required、製品hook unsupported | MCP＋製品hook required |
| Throughline | hook/skill/CLI required | hook/skill/CLI required | hook/CLI required | hook/CLI required |
| Spotter | 対象projectだけrequired | 対象projectだけrequired | unsupported | 対象projectだけrequired |
| MarkItDown | CLI required | CLI required | not_applicable | not_applicable |
| gpt-connector | MCP contract required。live面は対応Macだけsupported、非Darwinは`unsupported` | 同左 | 同左 | 同左 |
| aiterm-mcp | MCP required | MCP required | MCP required | MCP required |
| codex-sidecar | MCP required | MCP required | MCP required | MCP required |
| Lattice | MCP required | MCP required | MCP required | MCP required |
| AIShell | MCP required（対応Mac） | MCP required（対応Mac） | MCP required（対応Mac） | MCP required（対応Mac） |
| ServerManager | not_applicable | not_applicable | not_applicable | not_applicable |
| peertable | team編成時だけMCP `room` required | 同左 | 親MCPはnot_applicable | 親MCPはnot_applicable |
| unai | skill required | skill required | skill required | skill required |

独立CodegraphとObserverは現役製品またはconnectorとして扱わない。Latticeが公開する`codegraph_*`互換名はLatticeのABIであり、独立製品の登録を意味しない。Spotterは明示対象projectだけ、peertableはteam編成中のprojectだけをrequired対象にする。

## 診断と更新

端末ごとの到達性、PATH、導入version、session、更新結果はこのmatrixへ書かない。host展開は[セットアップランブック](../README.md#他端末セットアップランブック)、工場clientの収集と送信は[factory reporter](factory-reporter-runbook.md)、製品diagnosticsの意味は[製品統合台帳](factory-product-contracts.md)から各製品文書へ辿る。ServerManager/BugHubは観測を集約するが、dotagentsまたは製品に代わって方針を決めない。
