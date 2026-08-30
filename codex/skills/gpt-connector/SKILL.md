---
name: gpt-connector
description: ChatGPTのsecond opinionをgpt-connector MCP経由で依頼された時に使う。
---

# gpt-connector

正規接続はMCP `gpt_connector`、commandは`gpt-connector-mcp`。工場への接続は[dotagentsのpointer](../../../docs/06_gpt-connector.md)、製品の使い方は[gpt-connectorの正本](https://github.com/kitepon/gpt-connector#readme)に従う。このskillはCodex親から公開MCPを選ぶ入口だけを持ち、製品の操作契約を複製しない。
