# 工場の現行状態

<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Source: lib/factory/deployment-contract.mjs -->
<!-- Regenerate: node bin/render-current-docs.mjs --write -->

このページは、変更で動く工場の現行値だけを機械可読な配備契約から生成する。恒久的な責務と禁止事項は[製品契約台帳](factory-product-contracts.md)、host差は[host matrix](factory-host-product-matrix.md)、wire各版の固定契約は`wire-vN-design.md`を読む。

| 項目 | 現在値 |
|---|---|
| 現役管理対象 | 13製品 |
| 自作コア | 10製品 |
| 第三者管理 | 3製品 |
| 現役wire | v9（schema `9.0`、17製品） |
| 本番BugHub endpoint | `/api/factory/v9/reports` |
| host別rollback先 | wire v8 |
| self-hosted runner | 3席（6 instance） |
| full CI環境 | 3環境 |

## 製品集合

- 自作コア: `caveat`、`throughline`、`spotter`、`lattice`、`gpt-connector`、`aiterm-mcp`、`aishell`、`servermanager`、`peertable`、`unai`
- 第三者管理: `markitdown`、`jev-ultrafast`、`agent-desktop`
- 現役wire: `caveat`、`throughline`、`spotter`、`lattice`、`markitdown`、`gpt-connector`、`aiterm-mcp`、`codex-sidecar`、`servermanager`、`claude-code`、`codex-cli`、`grok-build`、`aishell`、`peertable`、`unai`、`jev-ultrafast`、`agent-desktop`

## CI runner

| runner | host label | 利用面 | instance（CPU集合） |
|---|---|---|---|
| `factory-macos-m5-u` | `macos-native` | full CI | `factory-macos-m5-u`（全CPU） |
| `factory-linux-rabbit-u` | `linux-workstation` | full CI | `factory-linux-rabbit-u`（8-15）、`factory-linux-rabbit-u2`（16-23） |
| `factory-windows-fox-u` | `windows-native` | full CI | `factory-windows-fox-u`（8-15）、`factory-windows-fox-u2`（16-23）、`factory-windows-fox-u3`（24-31） |

instanceは同じhost labelと同じ専用利用者で動く独立runnerで、CPU集合は互いに重ならない。配置と適用手順は[runner capacity](feature-map/runner-capacity.md)。

full CIは`full CI`の3席だけで同じ試験を行う。main-serverは運用workflow専用とし、通常CIを実行しない。WSL2 runnerと`wsl2` labelは現役集合へ含めない。

## 更新方法

製品の追加・削除・区分変更、wire更新、runner変更では、`lib/factory/deployment-contract.mjs`を先に更新し、`node bin/render-current-docs.mjs --write`でこのページを再生成する。ほかの現行案内は数、wire番号、runner名を手入力せず、このページを参照する。
