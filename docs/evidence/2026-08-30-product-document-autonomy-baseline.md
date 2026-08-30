# 製品文書自律化 — baselineと監査結果

取得日: 2026-08-30。全repoは作業前に既定branchとremoteを照合し、下記HEADから開始した。監査席はread-onlyで、移動可否を本文の状態、git履歴、現行正本、repo内参照、Lattice/Controlの固定参照から判定した。

| repo | baseline HEAD |
|---|---|
| dotagents | `4c94af95715d`（campaign初期化後） |
| Caveat | `4f87ca78d28d` |
| Throughline | `4bf84f548eeb` |
| Spotter | `19774736d5ba` |
| Lattice | `6dd5b8122088` |
| gpt-connector | `c8ba18440c8e` |
| aiterm-mcp | `b4b38d3599f4` |
| codex-sidecar | `74af0c6fade8` |
| aishell | `cbe9d512709a` |
| ServerManager | `7b9808bf6995` |
| peertable | `846b8bb1ec43` |
| unai | `7e27f4ba8207` |

## 確定した境界

- dotagentsに残す: 製品集合、host/wire、公開version/diagnostics入口、schema ID、adapter projection、privacy、横断受入。
- 製品repoへ戻す: install、configuration、state、schema、migration、diagnostic semantics、recovery、update、release。
- 完了plan/handoff/release記録はarchiveへ物理移動する。固定pathをControl/Lattice/evidenceが束縛する場合だけ同じpathをhistory/evidenceとして残す。
- 同義文書はcurrent正本を一つ決め、計画・経緯をarchiveへ落とす。ADR/evidenceは意味が似ていても別Decision/証拠なので統合しない。
- 10製品のCIがdotagents reusable workflowの可変`@main`を必須参照していた。これは製品側の合否を外部変更で動かす制御喪失として、検証済みcommitへの固定対象とした。unaiはproduct-local CIで独立済み。

## 監査で確認した主な誤案内

- dotagentsのCursor文書が、実装済みCaveat/Spotter製品hookを「無い」と案内していた。
- dotagentsの現役設定断片にretired Observerのrepo/hookが残っていた。
- Latticeが製品目標をhost絶対path、live工程をdotagents側storeへ置いていた。
- aiterm-mcpが存在しない`pty_kill_all`を復旧入口として案内していた。
- 複数製品でowner URL、version、schema、release状態、完了planのcurrent分類がdriftしていた。

上記は推測でなく、各repoの実装・manifest・workflow・文書参照との突合結果である。
