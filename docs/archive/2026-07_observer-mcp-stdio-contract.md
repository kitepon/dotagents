# Observer MCP stdio契約の公式根拠

- 出典: MCP公式仕様 2025-11-25（[[raw/transports-2025-11-25]]、[[raw/lifecycle-2025-11-25]]、[[raw/tools-2025-11-25]]）
- 取得日: 2026-07-15
- 確度: 高（MCP公式一次仕様）

## Observerへの適用

1. stdioはUTF-8のJSON-RPC 2.0を改行区切りで交換し、message内に生改行を含めない。stdoutにはMCP message以外を書かず、診断はstderrへ限定する。
2. `initialize`を最初のinteractionとし、2025-11-25を応答versionに使う。応答後の`notifications/initialized`までは通常tool requestを受け付けない。
3. server capabilityは固定tool集合だけなので`tools: { listChanged: false }`とし、tasks、sampling、roots、resources、promptsを宣言しない。
4. toolは`tools/list`でexact input/output schemaを公開する。結果は`structuredContent`と同じJSONをtext contentにも返す。
5. tool実行上の入力・Throughline hard failureは`isError: true`のtool resultへboundedな固定codeだけを返す。未知tool、壊れたJSON-RPC、lifecycle違反はprotocol errorとする。
6. 2025-11-25のtask-augmented executionはexperimentalであり、Observerの一時間waitには採用しない。waitは通常の単一`tools/call`を保持し、process cancelを既存Throughline clientへ伝播する。
7. annotationsはhostにとってhintにすぎない。`wait`／`read`はprojectとThroughlineに対してread-onlyだが、将来のMailbox publishは別tool・別権限として分離する。

## 実装で固定する最小surface

- `observer_read`: completed-turn pageを取得する。
- `observer_wait`: completed cursorの変化を最大3600秒待つ。
- 初期版ではpublish、target登録、watch start/stopをMCPへ公開しない。起動停止は明示指示を受けた親hostが所有する。

MCP wireを手書きする場合も、newline framing、最大message byte、exact JSON-RPC object、単一response、shutdown時のpending cancelをcharacterization testで固定する。SDK導入はwire互換とruntime dependencyを比較して別途判断する。
