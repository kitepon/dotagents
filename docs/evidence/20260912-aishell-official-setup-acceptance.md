# AIShellの公式導入受入

2026-09-12、製品担当「AIShellのMac導入を一入口化」から、このMacでの公開後実測を回収した。以前のKeychain認証拒否は、オーナーが別途依頼した認証機能の廃止後に再確認した。

## 製品担当の実測

- Aitermで公式`npm install -g @quolu/aishell@latest && aishell-setup`を実行し、導入版0.7.3、exit 0、`status: ready`を確認した。
- Claude、Codex、Grok、Cursorの4種すべてが`registration: unchanged`、`ready: true`、`hostVerified: true`、version 0.7.3、toolCount 11であり、`workspace_snapshot`が成功した。
- 公開`aishell-mcp`のfactory profileはprotocol 2025-11-25、公開catalogは`factory_diagnostics`のみ。診断は`ready: true`、`issues: []`、`operationReadiness: ready`、製品版0.7.3で、exit 0を確認した。
- 旧`--check-keychain`は実行せず、認証待ちはない。製品担当はdotagents配下を編集していない。

## 工場での扱い

製品の公式導入入口を受入済みとする。既存AIセッションに残る旧MCPを新版へ切り替える時は、製品の再接続または新規セッションという公開契約に従う。この記録はAIShell単体の受入であり、4端末の工場統合完了は意味しない。
