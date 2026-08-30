# 製品文書自律化 — 訂正とfresh clone受入証拠

取得日: 2026-08-30。

## 判定

製品固有の制御を各製品repoへ戻し、古い文書のarchive移設、同義文書の統合、再発防止CI、今回修正した製品のfresh clone受入まで完了した。工場全体の配布完了とは判定しない。FOX runner、AFK Pilotの本番gateとdeploy、Desktopの恒久checkoutとreleaseが未完了だからである。

本書は[先行証拠](2026-08-30-product-document-autonomy-available-host-acceptance.md)の判定を訂正する。先行証拠はdigest `65c76befc688e9f789ac44dd44b1bc92e95790afcda93211587188874472b099`のまま保存し、観測当時の履歴として改変しない。

## 先行証拠から訂正する事項

1. 「現在稼働しているhostでの受入は完了」は撤回する。Desktopの恒久checkoutは未作成で、既存checkoutは独自commit 12件を持つため、移動・置換していない。
2. AFK Pilotの「gate成功」は`npm run gate:ci`の成功に限定する。実Clerk/Supabaseを使う`e2e:browser`と実Desktopを使う`e2e:lifecycle`を含む`npm run gate`は完了していない。
3. 製品自律化は先行証拠の時点では不十分だった。Caveatの初回同期、Throughlineの更新後migration、ObserverのCI、Community overlayのrelease判定に工場側の製品内部制御が残っていたため、追加修正した。
4. unai v0.2.1の記載は現状ではない。v0.3.0を公開し、公式installerのtag指定導入まで確認した。
5. releaseとdeployを「無関係」とした記載は撤回する。変更した配布面では完遂条件の一部だが、外部gate未完了のため実行していない。

## 所有境界の最終形

- 各製品repoはinstall、configuration、state、schema、migration、diagnostic semantics、recovery、update、CI、releaseを所有する。
- dotagentsは製品集合、host/wire、公開入口の識別、schema ID、adapter projection、privacy、横断受入を所有する。製品内部のcommand列や合否を複製しない。
- 工場から製品更新を行う場合も、製品の一回入口を一度だけ呼び、内部結果をopaqueに扱う。Community overlayはDesktopとAFK Pilotの`scripts/update-overlay.sh`、Throughlineは`throughline self-update`、Caveatは`caveat init --sync --yes`が正規入口である。
- Dotagentsは各製品を統括するが、製品の状態・migration・release判断を制御しない。

この境界はdotagents commit `657f345`とADR 0135〜0137へ固定した。独立監査では、Desktop／AFKの入口が各1回だけ呼ばれること、Throughlineのmigration解釈がdotagentsに残らないこと、archive移設後の現役参照が残らないことを確認し、追加欠陥なしと判定した。

## 文書整理と重複統合

dotagentsの全文書面は、本書を含めてgenerated 6、current 81、contract 1、history 264、evidence 168の計520件である。current面は開始時の156件から81件へ減った。

dotagentsのarchive台帳は101 pathを固定し、そのうち76 pathをlegacy本文として分類する。旧pathを現在も固定参照する9件だけに互換stubを残した。移動した本文はdigestで凍結し、現役面の説明へ使える内容だけをREADME、ADR、runbookへ意味統合した。完了plan、旧監査、旧model/provider調査、退役したObserver制御面はcurrent/RAG面から外した。

CIは次を拒否する。

- archive本文の書換え、未登録archive、移動記録と本文の同時削除
- current面へ同義の正本を複製する変更
- 製品固有の導入・状態・migration・診断・更新・CI・releaseをdotagentsへ戻す変更
- default branch相対で既存archiveや互換stubを消す変更

## 追加修正と受入

| 対象 | 修正commit | 実測 |
|---|---|---|
| Caveat | `8f08444353e62000dbe78b44b5331928a5327bc1` | fresh cloneでbuild・typecheck、製品test 588/588、`init`契約5/5、release smoke 13/13、docsとpack/install/version確認が成功。[公開CIはFOX待ち](https://github.com/kitepon/Caveat/actions/runs/33303033764) |
| Throughline | archive `2783b91`、self-update `3f8e238f2a30b709bfe69091899b1adef88d3130` | fresh cloneでself-update/help/docs/package 25/25、74 Markdown、17 archive、4 stub、269 link、package dry-runが成功。既存checkoutの全test 802/802と敵対監査も成功。[公開CIはFOX待ち](https://github.com/kitepon/Throughline/actions/runs/33303864484) |
| Peertable | `7aa548d277878a7df749153d51118ac6a0b6a85f` | archive room logの逆案内を生成元で根治。fresh cloneでruntime 20/20、docs 6/6が成功。[公開CIはFOX待ち](https://github.com/kitepon/peertable/actions/runs/33303488332) |
| Observer | `48a6baaa55e1f09bdc916154a409b5d71f5785ac` | dotagents reusable workflow依存を撤去し、製品CIを自立化。[公開CI成功](https://github.com/kitepon/Observer/actions/runs/33302014850) |
| Desktop overlay | `5b5a9f0b44a74fe13e0d9ffff53ef4d32e39f541` | release verifier、既存asset非上書き、main祖先条件を製品内へ固定。focused 135/135、親再確認117/117、[公開CI成功](https://github.com/kitepon/grok-build-desktop-kitepon/actions/runs/33302859384) |
| AFK Pilot | bootstrap `b2c438c`、deploy入口 `9621cd83972251fce8ceeb76c78d4cf2bffcaeaa` | bare-clone用`gate:ci`と[公開CI成功](https://github.com/kitepon/afkpilot-kitepon/actions/runs/33301387433)。full gateとdeployは未完了 |
| unai | `d5a0ed987b8550e0227189664727fa2c8ab0fdcc` | [公開CI成功](https://github.com/kitepon/unai/actions/runs/33301824194)、[v0.3.0 Release](https://github.com/kitepon/unai/releases/tag/v0.3.0)、tag指定installer smoke成功 |
| ServerManager | `43ead5eb440743a77b4da556fea9364892fddc3a` | BugHub連携文書をv8の現行境界へ統合。[公開CIはFOX待ち](https://github.com/kitepon/ServerManager/actions/runs/33298165176) |

Spotter、Lattice、gpt-connector、aiterm-mcp、codex-sidecar、AIShellのarchive・製品所有CIに関する先行証拠は、この訂正で変更していない。

## 未完了の外部gate

- FOXのWindows native／WSL2 jobがqueuedのため、対象製品のreleaseとServerManager deployは実行していない。
- AFK Pilotの公開`/api/health`はrevision `c3f1f669f3274674ca9277c3b36b870a90e8ab6a`を返す。GitHub mainの`9621cd8`は本番へ未配備である。
- Desktop v3.19.6のtagとReleaseは存在しない。AFK Pilotのfull gate・deploy後にだけ製品release gateへ進める。
- 正規候補`/Users/kite/Developer/grok-build-desktop-kitepon`は未作成である。既存`/Users/kite/Developer/grok-build-vscode`はorigin/mainに対してahead 12／behind 117で、未追跡`app-update.js`もある。基準pathの変更・移動・置換はオーナー承認なしに行わない。
- Lattice task `pda-006`とControlは、これらの外部gateを完了扱いにせずactiveのまま維持する。
