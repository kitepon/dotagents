# unai-005 BugHub wire v8 cutover

日付: 2026-08-29

## 実施

- ServerManagerへwire v8 endpoint、15製品schema、unai期待値をserver-firstで配備した。
- 本番をrevision`7b9808bf69955f5b5ba618f86e44d022c8a7730f`へ更新し、
  `FACTORY_V8_INGEST_ENABLED=true`を読み戻した。
- v7 endpointをrollback／互換面として残し、dotagentsのcurrent wireだけをv8へ進めた。
- Mac、main-server、FOX WSL2、FOX Windows nativeからfresh v8 reportを送信し、delivery受理まで確認した。

## 本番readiness

- `/readyz`: HTTP 200、status `ready`。
- database、schema、pull_poll、factory_ingest、factory_delivery、source_revisionは全てpass。
- readinessのsource revisionは配備commitと一致した。
- 4 host全てで固定15製品を受理し、unaiはinstalled／compatible、3 check passとなった。

## 修正した誤案内

- BugHubを独立製品として扱う記載は採用せず、ServerManager内部componentという正典へ揃えた。
- 旧自己SSH前提と古い展開案内を、現在のcontainer／公開readiness契約へ修正した。
- v7を現役currentとする案内をv8へ更新し、v7はrollback／互換面と明記した。

## rollback

v8障害時はdotagentsのcurrent wireをv7へ独立revertできる。v7 endpointと保存面は撤去していない。
