# 06_gpt-connector — 工場への接続

dotagentsはgpt-connectorの製品動作を制御せず、公開setupの呼出しと工場adapterだけを所有する。

## 工場契約

- MCP server ID: `gpt_connector`
- command: `gpt-connector-mcp`
- version probe: `gpt-connector --version`
- MCP登録・移行・OS差は製品の`gpt-connector setup`へ委譲する。工場適用器は登録を書かない。
- 非Macでは公開結果の`partial`を保持し、対応する読取り機能を確認する。live機能を成功へ丸めない。
- 工場受入はMCP一覧と製品のread-only diagnosticsだけを使う。

## 製品側の正本

利用、診断の意味、状態、復旧、更新、CI、releaseは[gpt-connector repo](https://github.com/kitepon/gpt-connector#readme)に従う。旧製品運用の複製は[archive](archive/2026-08_06_gpt-connector-product-control-history.md)へ凍結した。
