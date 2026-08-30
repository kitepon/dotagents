# 06_gpt-connector — 工場への接続

dotagentsはgpt-connectorの製品動作を制御せず、各hostへのMCP登録と工場adapterだけを所有する。

## 工場契約

- MCP server ID: `gpt_connector`
- command: `gpt-connector-mcp`
- version probe: `gpt-connector --version`
- 適用器は上の1 entryだけを冪等に登録し、個人MCP・model・login・permissionを変更しない。
- 工場受入はMCP一覧と製品のread-only diagnosticsだけを使う。

## 製品側の正本

利用、診断の意味、状態、復旧、更新、CI、releaseは[gpt-connector repo](https://github.com/kitepon/gpt-connector#readme)に従う。旧製品運用の複製は[archive](archive/2026-08_06_gpt-connector-product-control-history.md)へ凍結した。
