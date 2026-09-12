# Mac工場での公開形式の受入

2026-09-12、`4071c2f`のMac正規入口をAitermから直接実行した。自己SSHは使用していない。

## 正規入口の実測

- 工場設定・製品更新・予約設定・更新後報告まで進み、全体はexit 1だった。
- 報告IDは`14b33da9-2e66-4302-96d9-384f587287f0`、観測時刻は`2026-09-12T12:48:22.530Z`。batch tokenは`7dbe1531-825a-4eda-873b-fe9e986a3d62`。
- 更新後gateは5件の失敗を返した。内訳はAIShellのpresenceが1件、ClaudeとCodexのnpm_latest・last_updateが各2件で、原因は公開診断とnpm出力の読取りの2つだった。最終報告の送信はsent 1、retained 0、dead_lettered 0、deferred 0、ack_failed 0で成功した。
- Claude・Codexの最新版情報は`version_type`で拒否された。Throughline自己更新は`version_verification_failed`。AIShell診断は`native_schema_invalid`になった。失敗後の更新結果は成功へ書き換えていない。

## 工場で修正した読取り

`npm view <package> version --json`は、このMacのnpm 12.0.2で単一要素配列を返した。[npm公式仕様](https://docs.npmjs.com/cli/v12/commands/npm-view/)と一致する。工場の共通decoderが旧文字列形式しか受理しなかったため、単一要素配列を追加した。複数版・入れ子・非文字列と不正なSemVerは引き続き拒否する。知識は[npmの調査記録](../../rag/npm/npm-view-json-20260912.md)へ保存した。

AIShell 0.7.3の公開MCPはexit 0で正常な診断を返したが、工場はruntime schema v2へ限定していた。製品担当が現在の公開schemaとproducerを確認し、v3の`not_required`は管理UI・旧設定・移行が前提から廃止された意味と確認した。工場は公開診断v1の製品識別・版・正常判定・公開情報の制約を読み、内部runtimeの世代と設定列挙値による判定を削除した。総合`ready: false`とMCP失敗は失敗として保持し、移行不要は`not_applicable`へ投影する。

同じ問題が現行Throughline decoderのDB v8/v9とSpotterのmarker v1/v2にも存在したため、その内部世代の許容一覧を除いた。正常・異常の判定は製品の公開診断から受け取り、未知の公開診断schemaは引き続き拒否する。将来のDB・marker世代の再現はfixtureによるものであり、その版の実製品を検証した意味ではない。

npm更新では、最新版Aを取得した後に新版Bが公開されると、公式`npm install -g <package>@latest`がBを正常に導入しても、Aとの完全一致で失敗にしていた。実際の導入版が取得済みの版以上なら受理し、古い版・取得不能は失敗として保持する。記録には取得時点のlatestと実際の導入版をそれぞれ残す。

## 個別検証

- npm共通decoderの3試験、AIShellの6試験、Throughline・Spotterの内部世代に関する2試験が成功した。未知の公開schema、製品の失敗、不正な版・公開情報は拒否する。
- 更新中の新版公開を模したcron試験は、修正前に期待どおり失敗し、修正後は成功した。古い版が導入される場合の失敗も含め、`tests/update/cron-env.sh`全体が成功した。
- 実際のnpm出力は共通CLIでClaude `2.1.269`、Codex `0.154.0`へ解釈できた。AIShell単独probeはinstalled、版0.7.3、runtime v3、migration not_applicable、compatible、native_diagnostics passになった。
- Grokによる実ファイルの読取り専用反証は採用指摘0件だった。npm形式、更新中の新版公開、AIShell・Throughline・Spotterの公開診断と内部世代の境界を確認した（回答時刻`2026-09-12T13:14:57.415Z`）。
- 最初の最終CIは新規npm調査文書のregistry未登録で停止した。登録を修正後、文書gateが成功し、最後の`make ci`もexit 0で成功した（`2026-09-12T13:18:13Z`開始、`13:24:18Z`完了）。公開後受入は継続中。

## 製品担当へ返す未完条件

Throughline 0.10.16の`self-update --json`は単独でも同じ`version_verification_failed`を返した。公開版と導入版はどちらも0.10.16。製品内部の原因は未確認であり、工場から製品状態を補正しない。Windowsのunaiは以前の改行形式不一致が残り、担当範囲の回答待ち。

AIShellで初回の2文書編集は成功した。その後の4ファイル編集は`CURSOR_EXPIRED`、snapshotを取り直した再試行は`WORKSPACE_CHANGED`で停止した。標準GitとSHAで4対象が未変更と確認した後、この失敗と代替入口をオーナーへ明示し、標準`apply_patch`で工場変更を適用した。

製品担当はcursorなし検索時に他の利用者の変更記録を失わせる欠陥を再現・修理し、0.7.4を公開した。担当の受入記録では、公式導入、4 AIの登録・公開MCP、別プロセスの診断を挟んだ複数ファイル編集が成功した。公開commitは`f532e06c94de271c1377aeae2e2f2f226cf95736`、[公開CI](https://github.com/kitepon/aishell/actions/runs/34695388482)と[通常CI](https://github.com/kitepon/aishell/actions/runs/34695387215)は成功。親が受けた2回目の`WORKSPACE_CHANGED`の原因は未確定であり、この修理で解決済みとは扱わない。既存MCPプロセスへの新版反映には再接続が必要。

`.aishell-transactions/`は製品が所有する予約領域で、外部Gitの未追跡表示は現行仕様と担当が確認したため、工場から削除・Git設定変更はしていない。

この記録は個別修正の受入であり、4端末の工場統合完了を意味しない。
