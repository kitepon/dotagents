# unai-003 ServerManager／BugHub wire v8

日付: 2026-08-29

## 実施

- ServerManager／BugHubへwire v8 endpoint、schema、15製品matrix、unai期待値を追加した。
- v7互換面を維持したままv8 ingestを有効化し、本番revisionを
  `7b9808bf69955f5b5ba618f86e44d022c8a7730f`へ更新した。
- staleだったBugHubの自己SSH前提と展開案内を、現在のcontainer／公開readiness契約へ修正した。

## 検証

- ServerManager commit `0e009343`、`7b9808b`を`origin/main`へpushした。
- 本番`FACTORY_V8_INGEST_ENABLED=true`を読み戻した。
- `http://127.0.0.1:39310/readyz`: HTTP 200、status `ready`。
- database、schema、pull_poll、factory_ingest、factory_delivery、source_revisionの全checkがpass。
- readinessのsource revisionは`7b9808bf69955f5b5ba618f86e44d022c8a7730f`と一致した。

## スキップ

- BugHubの独立製品化: ServerManager内部componentという工場契約に反するため実施していない。
- v7 endpointの撤去: 互換面を維持する契約のため実施していない。
