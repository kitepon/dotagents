---
name: gpt-connector
description: ChatGPTのsecond opinion、gpt-connector MCPの診断・利用・timeout後のsession回収を頼まれた時に使う。
---

# gpt-connector

通常のChatGPT connectorは MCP `gpt_connector` と command `gpt-connector-mcp` を使う。正本は [docs/06_gpt-connector.md](../../../docs/06_gpt-connector.md)。

- 専用Chromeとproduct-owned stateを使い、Oracleや通常Chrome profileを流用しない。
- callerが既知のmodel slugとmodel/effortを明示する。未知値を補完しない。
- timeout後は `sessions` でjobを回収する。Oracle/API/prompt再送への暗黙fallbackは禁止。
- MCP登録、login、送信、添付は外部状態を変えるため、必要な依頼と承認範囲でだけ行う。
- Cursor親では`GetDynamicTools`でschemaを取ってから`CallDynamicTool`する。connector不在を別経路で覆わない。

Oracleはv1互換・rollback専用であり、新規の通常入口ではない。
