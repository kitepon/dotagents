# 工場の製品統合契約台帳

更新日: 2026-08-30。ここは各製品を**制御する台帳ではなく、公開面を工場へ接続する台帳**である。製品集合・現役wire・endpointは[生成された現行状態](factory-current-state.md)、host期待は[host matrix](factory-host-product-matrix.md)が正。製品内部の手順を含んでいた旧版は[archive](archive/2026-08_factory-product-contracts-pre-autonomy.md)へ凍結した。

## 共通境界

- 製品数・区分・現役wire・本番endpointは[工場の現行状態](factory-current-state.md)が正。本台帳は製品ID、version入口、公開diagnosticsとschema ID、adapter projection、privacy、host/wire互換、製品文書へのpointerだけを所有する。
- 各製品は、自身の導入・設定・状態・schema・migration・診断の意味・復旧・更新・release判断を自身のrepoで所有する。dotagentsはそれを複製せず、公開入口だけを消費する。
- dotagentsが所有するのは、製品ID、version probe、公開diagnostics入口とschema ID、adapter projection、privacy、host/wire互換、横断受入だけである。
- adapterはread-only公開入口だけを使う。内部DB・設定・hook・processを推測して補わず、`unsupported`／`unverified`／`skipped`をpassへ丸めない。
- factory連携を外しても製品本体の導入・利用・診断・復旧・更新・release判断が失われないことを製品側の受入条件とする。
- 製品CIのworkflowと合否は各製品repoが所有する。dotagentsは共通runnerとhost横断接続を提供し、製品からdotagentsのworkflowを参照させない。
- reportへsecret、credential、prompt、session/file本文、生log、絶対pathを出さない。
- 製品の修理とreleaseは製品repoの正典に従う。dotagentsは公開後probeとhost/wire横断受入だけを判定する。
- 自作コア製品の修理・機能追加は、製品repoが所有するrelease gateと手順でpublish・利用面への導入・公開後smokeまで閉じる。dotagentsはその手順を複製せず、製品側gate通過後の公開probeとhost/wire横断受入だけを担当する。publish対象を既定ブランチの祖先に限る共通規則は維持する。
- 工場の再現欠陥の重大度分類とmaintenance waveは[orchestrate契約](../shared/orchestrate/contract.md)が正である。第三者製品・基盤toolchain本体の欠陥はdotagentsの修理範囲外、dotagents所有adapter・設定生成・互換projectionの欠陥は範囲内とする。自作製品の修理は製品repo、工場統合の修理はdotagentsへ分ける。

## 自作コア製品

| ID / repo | version・公開diagnostics | 工場projection | 製品側の正本 |
|---|---|---|---|
| `caveat` / `kitepon/Caveat` | `caveat --version`; `caveat factory-diagnostics --json` (`caveat.native_factory_diagnostics.v1`); runtime error snapshot / ack | native overall、version、公開runtime error。CLI不在は`missing`、内部DB/hook推測は禁止 | [Caveat docs](https://github.com/kitepon/Caveat/tree/main/docs) |
| `throughline` / `kitepon/Throughline` | `throughline --version`; `throughline factory-diagnostics --json` (`throughline.native_factory_diagnostics.v1`); runtime error snapshot / ack | native overall、version、公開runtime error。session本文・DB直接読解は禁止 | [Throughline docs](https://github.com/kitepon/Throughline/tree/main/docs) |
| `spotter` / `kitepon/Spotter` | `spotter --version`; `spotter diagnostics factory` (schema `1.0`); 公開runtime error snapshot/ack | 対象外projectは`not_applicable`、対象で診断不能は`unverified`。tool DB直接読解は禁止 | [Spotter docs](https://github.com/kitepon/Spotter/tree/main/docs) |
| `lattice` / `kitepon/Lattice` | `lattice --version`; `lattice status --json` (`lattice.project_status.v1`); `lattice factory-diagnostics --json` (`lattice.native_factory_diagnostics.v1`); runtime-errors | typed project status、native overall、sensor/readiness、公開runtime error。消費中の`todo_status_result`とruntime schemaはdotagents consumerがexact validationする | [Lattice product contract](https://github.com/kitepon/Lattice/blob/main/docs/00_product-contract.md) |
| `gpt-connector` / `kitepon/gpt-connector` | `gpt-connector --version`; `gpt-connector factory-diagnostics --json` (`gpt-connector.factory-diagnostics.v1`); runtime error公開面 | version、MCP contract readiness、製品が返すoverall/check状態をそのまま投影する。Darwin以外のlive面は`unsupported`でありreadyへ丸めない。会話・job内部を読まない | [gpt-connector README](https://github.com/kitepon/gpt-connector#readme) |
| `aiterm-mcp` / `kitepon/aiterm-mcp` | MCP `diagnostics` (`aiterm-mcp.factory-diagnostics.v1`); runtime error snapshot/ack | stdio initialize後のread-only診断。PTY/agent起動をhealth checkにしない | [aiterm-mcp docs](https://github.com/kitepon/aiterm-mcp/tree/main/docs) |
| `codex-sidecar` / `kitepon/codex-sidecar` | `codex-sidecar factory-diagnostics --project <cwd>` (`factoryReadiness.schemaVersion="1"`); runtime error公開面 | package整合済みversion、native overall、read-only readiness。実agentを起動しない | [codex-sidecar usage](https://github.com/kitepon/codex-sidecar/blob/main/docs/USAGE.md) |
| `servermanager` / `kitepon/ServerManager` | loopback `/readyz`、deploy revision manifest、公開external-event connector | server hostだけreadiness/revision/freshnessを外部probe。DBやPi5 stateを直接読まない | [ServerManager docs](https://github.com/kitepon/ServerManager/tree/main/docs) |
| `aishell` / `kitepon/aishell` | MCP `factory_diagnostics` (`aishell.native_factory_diagnostics.v1`) と initialize version | Apple Silicon macOSだけ。factory profileのprivacy済みprojectionを消費し、通常tool profileへ混ぜない | [AIShell diagnostics](https://github.com/kitepon/aishell/blob/main/docs/factory-diagnostics.md) |
| `peertable` / `kitepon/peertable` | `peertable-client diagnostics --json` (`peertable.native_factory_diagnostics.v1`) | native overall/version。room URL・token・DB・message本文を読まない | [Peertable docs](https://github.com/kitepon/peertable/tree/main/docs) |
| `unai` / `kitepon/unai` | `unai --version`; `unai factory-diagnostics --json` (`unai.native_factory_diagnostics.v1`) | native overall/version/manifest整合。校正本文・voice・履歴を読まない | [unai README](https://github.com/kitepon/unai#readme) |

## 第三者・基盤toolchain

### `markitdown`

第三者のblack-box adapterで、`markitdown --version`と一時local fixtureだけを使う。対応範囲はstable `>=0.1.0 <0.2.0`。第三者本体をpatchせず、URL/JS renderingやrc=0だけでpassにしない。

### 基盤toolchain

- `claude-code`、`codex-cli`、`grok-build`は基盤toolchainでありコア製品ではない。公式installer／package manager／self-updateだけを使い、内部状態や認証を変更しない。
- Grok Desktop / AFKのCommunity overlayは製品IDを増やさない。工場との接続と両repoを跨ぐ順序だけを[overlay契約](factory-grok-build-community-overlay.md)が所有し、build・deploy・release・state・recoveryは各overlay repoが所有する。
- OracleとObserverは現役製品集合へ戻さない。履歴とrollback可否は[生成された現行状態](factory-current-state.md)およびarchiveから読む。

### `observer`

2026-08-16に工場コアから撤去済みで、wire v6/v7を含む現役・rollback製品キーへ`products.observer`を出さない。adapter、更新、一撃展開、欠落issue化を復活させない。

## 変更時の受入

製品追加・削除・公開schema変更では、製品repoの公開契約を先に更新し、次にdeployment contract、host matrix、adapter、wire契約、生成状態、4 hostの横断受入を更新する。製品内部の手順やrelease可否をこの台帳へ書き戻さない。
