# unai-004 release・4 host正規導入

日付: 2026-08-29

## 公開

- unai `v0.2.0`を公開し、Bash／PowerShell 7の公式installerとnative diagnosticsを配布した。
- SpotterのWindows MCP調査が終了しない既存欠陥を、製品repoで原因から修理した。
  `claude-spotter@1.6.2`、GitHub Release `v1.6.2`、npm shasum
  `f72e8a31dbef220e43493f959bb649ddc0846043`を公開した。
- AitermのWindows runtime error診断・記録が正常処理を2秒で打ち切る既存欠陥を、
  製品repoで原因から修理した。`aiterm-mcp@0.29.6`、
  [GitHub Release v0.29.6](https://github.com/kitepon/aiterm-mcp/releases/tag/v0.29.6)、
  npm shasum `52dcf1992e372a70fe7ab71d0fde384761891a11`を公開した。
  公式Registry登録とMCPB配布も完了した。

## 4 host展開

| host | report ID | 結果 |
|---|---|---|
| Mac | `7ab7b8ef-2eea-456e-bd23-35b149f40c8b` | wire 8.0、15製品、unai 0.2.0 ready、delivery受理 |
| main-server | `a43c4b47-9857-4162-85ee-7087cb283642` | wire 8.0、15製品、unai 0.2.0 ready、delivery受理 |
| FOX WSL2 | `185351e0-a67f-4986-a37d-3e8319c0a017` | wire 8.0、15製品、unai 0.2.0 ready、delivery受理 |
| FOX Windows native | `9fa48ddc-c683-48ee-b3e9-5684b6a5ad99` | wire 8.0、15製品、unai 0.2.0 ready、delivery受理 |

Windows正規入口の初回実行IDは`d97c594a-1522-4edc-b649-e346ac3a5bf8`、
同入口が実際に起動した定期タスクの実行IDは`8d60d417-e135-4d41-b189-8b45799e4090`。
全hostで`manifest_consistency`、`node_runtime`、`skill_bundle`がpassした。
最終同期後のBugHub readinessは6項目すべてpassし、source revisionは
`7b9808bf69955f5b5ba618f86e44d022c8a7730f`で一致した。

## 検証

- unai 3 OS CI: <https://github.com/kitepon/unai/actions/runs/33243938166>
- Spotter 4 host CI: <https://github.com/kitepon/Spotter/actions/runs/33248886286>
- Aiterm 4 host CI: <https://github.com/kitepon/aiterm-mcp/actions/runs/33253607719>
- Aiterm tag publish CI: <https://github.com/kitepon/aiterm-mcp/actions/runs/33253940886>
- Aiterm公式Registry CI: <https://github.com/kitepon/aiterm-mcp/actions/runs/33255510363>
- dotagents 4 host full CI: <https://github.com/kitepon/dotagents/actions/runs/33253778655>

## スキップ

- unai repoの移動・改名: オーナーの別承認が必要であり、今回の工場編入には不要。
- unai校正規範の拡張: 既存規範を全文章仕事へ適用する依頼であり、規範自体の変更ではない。
