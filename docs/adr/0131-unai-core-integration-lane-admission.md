# ADR 0131: unaiコア製品編入の統括レーン採用

日付: 2026-08-29

## Decision

`kitepon/unai` の工場コア製品編入は統括レーンで実行する。

着手時点の4条件は次のとおり。

- 計画に組み込まれた中断: `false`
- 多段に連鎖する受入: `true`
- 複数repoの書込み調整: `true`
- 裁定の検証可能な証跡: `true`

`unai` 自身の公開診断契約を先に成立させ、dotagentsのwire v8 clientとServerManager/BugHubのv8 endpointを別repoで実装する。その後にserver-firstで本番endpointを配備し、4 hostのfresh deliveryと正典同期を受け入れる。この順序は各段の出力が後段の入力になるため、多段受入と複数repo調整が着手時点で確定している。

## F / A / H

- F: wire v8の公開契約、履歴wire v2-v7の不変、ServerManagerのserver-first配備、unaiのrelease、4 host cutover、受入と最終裁定。
- A: 仕様固定後の各repo実装とfocused test。今回は親が単独で直列実装し、Workerへ委譲しない。
- H: なし。repo移動・改名が必要になった場合だけ、別裁定としてオーナーへ明示承認を求める。

## Coordination

Lattice plan `unai-core-integration` を工程正本とする。wire schemaと製品集合を親が一貫して裁定するため、coordination modeは`conversation`、書込みは単一親の直列実行とする。

## Non-goals

- unaiの校正規範や文書種overlayを拡張しない。
- 既存wire v2-v7の固定product集合を変更しない。
- unaiの全文章仕事への適用は、`shared/constitution.md`に「文章・返答の文体はunai skillの規範に従う。」を一行だけ置き、全host生成物へ同文を配る。host deltaやdotagents内へ規範本文を複製しない。
- unai、dotagents、ServerManagerのrepoを移動・改名しない。
- 編入と無関係な既存製品の欠陥を完了条件へ追加しない。

## Verification

- unai: version、native diagnostics、隔離HOME install smoke、全製品test。
- dotagents: wire v8・deployment・installer・privacyのfocused test後、関連gate、最後に`make ci`を1回。
- ServerManager: BugHub v8 contract・expectation・view・lifecycleのfocused test後、関連gate、正規Pi 5 deploy後のreadiness。
- 本番: 4 hostのunai diagnosticsとfresh wire v8 delivery、BugHub期待matrix、共通15製品の非回帰。

## Rollback

unaiは直前commitへ通常revertし、installerが公開mainを再取得する。BugHubはv7 endpointを保持し、dotagents current wireをv7へ独立revertできる形にする。ServerManagerとdotagentsの変更はrepo別commitに分離し、片方の履歴へ混ぜない。
