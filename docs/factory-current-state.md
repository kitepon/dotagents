# 工場の現行状態

<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Source: lib/factory/deployment-contract.mjs -->
<!-- Regenerate: node bin/render-current-docs.mjs --write -->

このページは、変更で動く工場の現行値だけを機械可読な配備契約から生成する。恒久的な責務と禁止事項は[製品契約台帳](factory-product-contracts.md)、host差は[host matrix](factory-host-product-matrix.md)、wire各版の固定契約は`wire-vN-design.md`を読む。

| 項目 | 現在値 |
|---|---|
| 現役管理対象 | 12製品 |
| 自作コア | 11製品 |
| 第三者管理 | 1製品 |
| 現役wire | v8（schema `8.0`、15製品） |
| 本番BugHub endpoint | `/api/factory/v8/reports` |
| host別rollback先 | wire v7 |
| self-hosted runner | 4席 |
| full CI環境 | 3環境 |

## 製品集合

- 自作コア: `caveat`、`throughline`、`spotter`、`lattice`、`gpt-connector`、`aiterm-mcp`、`codex-sidecar`、`aishell`、`servermanager`、`peertable`、`unai`
- 第三者管理: `markitdown`
- 現役wire: `caveat`、`throughline`、`spotter`、`lattice`、`markitdown`、`gpt-connector`、`aiterm-mcp`、`codex-sidecar`、`servermanager`、`claude-code`、`codex-cli`、`grok-build`、`aishell`、`peertable`、`unai`

## CI runner

| runner | host label | 利用面 |
|---|---|---|
| `factory-macos-m5` | `macos-native` | full CI |
| `factory-linux-main` | `linux-server` | 運用workflow |
| `factory-linux-rabbit` | `linux-workstation` | full CI |
| `factory-windows-fox` | `windows-native` | full CI |

full CIは`full CI`の3席だけで同じ試験を行う。main-serverは運用workflow専用とし、通常CIを実行しない。WSL2 runnerと`wsl2` labelは現役集合へ含めない。

## 更新方法

製品の追加・削除・区分変更、wire更新、runner変更では、`lib/factory/deployment-contract.mjs`を先に更新し、`node bin/render-current-docs.mjs --write`でこのページを再生成する。ほかの現行案内は数、wire番号、runner名を手入力せず、このページを参照する。
