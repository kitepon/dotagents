# UNAIとThroughlineの更新失敗の修理

2026-09-12、オーナーの明示指示により、工場統合の親が両製品の正規repoで原因を修理した。MacはAitermから直接操作し、Windowsは既存のSSH接続で操作した。

## UNAI

Windowsの公式installerが使うGitは端末設定を継承していた。既存cloneのCRLFと`core.autocrlf=false`が食い違い、改行以外の変更がなくても更新が停止した。製品の取得と更新だけに共通の`-c core.autocrlf=true`を指定した。端末設定・clone設定の変更、reset、再cloneによる回避は行っていない。

- 修理commitは`4bd70a64a0549fe94bcfa5d620d3fb758327a8fe`。日英README、2つのmanifest、Windows installer、関連testを更新した。
- Windows実機の隔離fixtureで、修正前の失敗と修正後の成功を確認した。新規取得、通常pullの拒否、公式installerによる更新、競合する本文変更とHEADの保持、Git設定の保持を実際のGitとPowerShellで検証した。PowerShell parserも成功した。
- Macの関連試験は19成功・Windows限定5件スキップ、文書試験は4成功。bash構文と文書リンク検査も成功した。[公開CI](https://github.com/kitepon/unai/actions/runs/34697231454)はMac・Linux・Windowsすべて成功した。
- Grokの実ファイル反証は採用指摘0件（`2026-09-12T13:46:01.024Z`）。
- [unai 0.6.3](https://github.com/kitepon/unai/releases/tag/v0.6.3)をmain上のcommitから公開した。
- Windowsの既存配線をtarで退避し、READMEの公開一行installerを実行した。既存0.4.0から0.6.3へ更新成功、公開診断はClaude・Codex・Grok・Cursorすべてready、exit 0。端末の`core.autocrlf=false`は保持され、製品が指定するGit設定で変更なしを確認した。

## Throughline

npm 12が返す単一結果のJSON配列を製品の自己更新処理が拒否し、`version_verification_failed`で停止していた。旧文字列と単一文字列配列を受理し、空・複数・入れ子・不正版は引き続き拒否するよう修理した。公開前の梱包検査でもnpm 12のpackage名をキーにしたJSONを拒否する実害があり、同じ製品repoで修理した。

- 修理commitは`631aa5bd0611dd492035ec3cedec7b03f2aa2120`。自己更新、梱包検査、関連試験、package版数、CHANGELOGと現行案内を更新した。
- 自己更新の個別18試験、文書契約6試験が成功した。最終`npm test`は`2026-09-12T13:35:10Z`〜`13:35:42Z`、exit 0。[公開CI](https://github.com/kitepon/Throughline/actions/runs/34697058253)はMac・Linux・Windowsと最終gateすべて成功した。
- 最初の全試験は梱包JSONとCHANGELOG比較リンクの2件で失敗した。それぞれの原因を修正し、個別試験後の最終全試験が成功した。Grokの追加反証は採用指摘0件（`2026-09-12T13:34:55.294Z`）。
- mainへの着地、cleanな公開commit、梱包内容を確認した。npm公開は二要素認証で一度停止し、本人認証後の正式な`npm publish`が0.10.17を受理した。反映待ちの404の後、registryで版・commit・shasum `233dc06bd9c11239d454678fa14297cb97896b74`の一致を確認した。[Throughline 0.10.17](https://github.com/kitepon/Throughline/releases/tag/v0.10.17)も公開した。
- registryから隔離prefixへ導入し、別のHOMEでversion、install、status、migrate、doctor、factory-diagnosticsを実行した。4 AIのhook配置、DB v9、doctor全項目、公開診断readyが成功した。
- Macの正式な工場セットアップが呼ぶ自己更新で、`beforeVersion: 0.10.16`から`afterVersion: 0.10.17`、`status: updated`、`migrationStatus: already_current`、`diagnosticsStatus: ready`を確認した。
- Windowsとmain-serverでも0.10.16から0.10.17への公式自己更新と公開診断readyが成功した。rabbitは自己更新コマンド導入前の0.10.3だったため、製品が案内する公式npm導入を一度実行してから`self-update --json`を確認した。0.10.17、already_current、diagnosticsStatus ready、既存DBなしのmigration not_applicableだった。UNAIも4端末すべて0.6.3へ公式更新済み。

## 工場の公開確認

`eeaa21d1b0ca4365e84a385a8fd6493512b31790`の[公開CI](https://github.com/kitepon/dotagents/actions/runs/34696413282)はMac・Linux・Windowsと最終gateがすべて成功した。

同commitの正式な通常報告は4端末とも送信成功した。Macは`78ab8f72-c1ee-4b29-a3ae-29fc1719382e`、main-serverは`478e3e54-28c7-4c40-b0cc-77dfbe027e29`、Windowsは`573825dc-dac3-4019-bf42-b3e55cee1453`、rabbitは`1dc50ac0-2601-4af2-849a-f8a00b8acb5a`。すべてsent 1、retained・dead_lettered・deferred・ack_failedは0だった。通常報告の成功は製品更新の成功と別に記録する。

rabbitの既存UNAI読取許可はpatchとstashへ保存してから工場repoを更新し、同じ1行を未commit差分として復元した。非対話SSHではNodeのPATHがなく報告できなかったため、通常のlogin shellで公開報告入口を再実行して成功した。

修理後のMac全体セットアップは、gpt-connectorの`CDP_UNAVAILABLE`で停止した。UNAI・Throughlineの更新と公開診断は正常であり、Mac全体の失敗と区別する。報告`a0f8b810-cb9b-4146-af62-1c84eb836db4`は配送成功、batch tokenは`5936a1e3-423e-47e0-9bc8-14ddde2c4159`。gpt-connectorの既存担当へ、公式setupの接続失敗とCodex MCP観測の`gpt-connector-mcp ENOENT`の原因確認・復旧を依頼した。

Linuxの正式セットアップは、製品更新より前のGitHub組織runner照会で停止した。main-serverは権限不足の403、rabbitは認証失効の401。2台とも公式`gh auth refresh -h github.com -s admin:org`を起動し、本人認証を依頼した。4端末の統合完了とは扱っていない。

main-serverで最初に起動したrefreshは、保存済み`kitepon-rgb`と本人が認証した`quolu`の不一致により保存されなかった。事前にアカウントを照合しなかった親の手順ミスであり、`gh auth login`で正しいアカウントを追加する認証を準備した。rabbitは既存の`quolu`で認証保存と組織runnerの照会成功を確認し、公式入口を再開した。

Windowsの再実行はUNAI・Throughline更新と更新後report gate・配送が成功したが、gpt-connectorのCodex登録が`SETUP_REGISTRATION_FAILED`で全体は失敗した。報告IDは`5cdfe1dc-51c2-441f-a400-0d5560b987d4`、batch tokenは`f93edd60-08d2-4786-a34c-2a4ec71b8c8f`。同じ製品担当が原因確認を継続する。
