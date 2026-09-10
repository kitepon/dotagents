# 製品公開入口への工場切替 — 作業中の実測

2026-09-10時点。工場統合は未完了。これは製品担当の受入記録と、工場で実行した試験を区別した途中記録である。

## 製品担当から回収した公開記録

| 製品 | 公開版 | 担当repoの記録 | 留意点 |
|---|---|---|---|
| Aiterm | 0.33.1 | `docs/evidence/20260910-ssh-powershell-mark.md` | 3 OS導入とSSH先PowerShellの成功・失敗・遅延を検証。工場タスクの既存MCPは0.33.0で再接続待ち |
| Caveat | 0.19.1 | `docs/archive/20260910_setup_completion.md` | 3 OSの初回・同期・再実行・4 AI検索を検証。Windowsの既存hook拒否は未解消 |
| gpt-connector | 0.5.2 | `docs/2026-09-10-setup-verification.md` | 非Macは読取り機能対応、live未対応のpartial。Chat送信は未実施 |
| codex-sidecar | 0.3.13 | `docs/evidence/2026-09-10-standalone-setup-publication.md` | 3 OS・4 AI登録とMCP smoke。実モデルturnは未実施 |
| AIShell | 0.6.0 | `docs/evidence/standalone-setup-public-mac-20260910.md` | 対応Macで公開導入・再実行・4 AI確認。工場作業中に発生した変更適用の停止は担当が修理中 |
| Lattice | 0.69.0 | `docs/evidence/product-setup-verification-20260910.md` | 3 OS隔離導入・4 AI MCP。WindowsとGrokの製品hookは公開された未対応 |
| Peertable | 0.8.57 | `docs/evidence/skill-install-aiterm-boundary-20260910/published-acceptance.md` | 3 OSの公式導入・再実行・diagnostics・harness lifecycle |
| ServerManager/BugHub | commit `1e8a5b2` | `docs/evidence/bughub-new-only-production-20260910.md` | 本番反映済み。現役4端末のfresh report待ち |

製品担当の記録を工場の実端末受入へ読み替えない。各版はこの時点の証拠であり、現行版の案内ではない。

## 工場で実行した確認

- Grok/Cursorの工場適用器は製品MCP設定を保存したまま工場hookを適用する隔離試験に成功。
- unaiは公式installerの公開結果と失敗終了codeを保持する隔離試験に成功。
- MacとLinuxの一撃入口、Throughline初回・更新・失敗、cron最小環境の関連試験に成功。
- 公開setupの未対応判定と同一reportの結果確定は5試験成功。予約・配送は37試験成功。
- wire v8の公開probeは10試験成功。Windows入口の静的試験は成功し、Mac上で実行できない2試験はスキップ。
- shell・Python・JavaScript・Markdown lintと文書台帳の照合に成功。別ベンダー反証は採用指摘0件で完了。最終`make ci`は、旧Lattice個別導入の必須文書テストを公開setup契約へ更新し、focused成功後の再実行で終了code 0。

## 実端末の観測

main-serverのAiterm SSHセッションで既存Dockerコンテナの稼働とcleanなdotagents checkoutを確認した。
LinuxのNodeは一時ディレクトリで[公式nvm installer](https://github.com/nvm-sh/nvm)を実行し、Node 24.21.0とnpm 11.19.0の導入に成功した。既存Nodeの選択と配置は変更していない。

WindowsはAiterm SSHセッションでPowerShell 7.6.5を確認した。既存MCP 0.33.0がSSH先へPOSIX完了印を送ったため、製品担当へ再現を返した。担当の公開済み0.33.1では修正済みと報告され、公式のMCP再起動待ちである。

AIShell担当から修正版0.6.1の公開認証がE404で失敗したと報告された。修正commitは`0209f9a4883c58c23d31ee590ad1c23e46227eed`と`660e3209bf85eae123416be739508ba31a613e9e`。候補版の6ファイル変更は2834msで成功したが、公開後setup・変更適用smokeは未実施である。工場は修理待ちを維持する。

工場入口の現役端末への本番実行、fresh report、BugHub統合受入は未実施。未完条件はAitermの接続更新、AIShell修正版の公開回収、現役4端末の順次導入と公開probeである。
