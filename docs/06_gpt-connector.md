# 06_gpt-connector — ChatGPT接続の正規ランブック

更新日: 2026-07-26。ChatGPTのsecond opinionは自作コア製品 `gpt-connector` を正規入口とする。旧Oracleの運用記録は [06_oracle-mcp.md](06_oracle-mcp.md) に互換・rollback用として残すが、新規導入・通常利用・MCP登録の正本ではない。

## 正規入口

- CLI command: `gpt-connector-mcp`
- Claude/Codex MCP server ID: `gpt_connector`
- 製品CLI: `gpt-connector`
- state・job・sessionの正本は製品所有。dotagentsは直接読解しない。

各端末では専用Chrome profileを使い、既存ChromeやOracle profileを流用しない。モデルとeffortは呼び出しごとに明示する。callerが既知のmodel slugだけを渡し、未知slugを推測・置換しない。timeout後は `sessions` でjobを回収して状態を確認する。Oracle、OpenAI API、prompt再展開への暗黙fallbackは禁止する。

## 専用Chromeの起動と表示

```bash
gpt-connector browser start
```

macOSのcold startは、`--no-startup-window`で窓なしの専用Chromeを起動し、CDPでbackgroundのChatGPT targetを最初から最小化してから正規PIDだけをunhideする。アプリをhiddenのまま運用しない。成功条件はCDPの自己申告だけではなく、同じPIDに属するWindow Server layer 0の画面内windowが0件であること（実測記録は製品repo／rag側が保持）。

認証や手動確認で表示が必要な時だけ、次を使う。

```bash
gpt-connector browser show
```

Chromeは表示復帰後もCDPへ古い`minimized`状態を返す場合がある。そのため`show`は一意のChatGPT targetへ`Page.bringToFront`を送り、同じPIDの画面内windowが1件以上になった時だけ成功する。`start`を再実行すると0件へ戻す。`AUTH_REQUIRED`時も同じwindowを表示してからtyped errorを返す。固定負座標、`Cmd-H`、Oracle shimへのfallbackは禁止する。

## MCP登録（H承認が必要）

実登録・解除は端末状態を変えるH操作であり、この文書は実行を承認しない。承認後の正規形は次のserver IDとcommandだけを使う。

```bash
claude mcp add --scope user gpt_connector -- gpt-connector-mcp
codex mcp add gpt_connector -- gpt-connector-mcp
```

登録後は各親のMCP一覧で `gpt_connector` を確認し、read-only `sessions` だけで疎通を確認する。Chat送信、login、添付、model選択は依頼された時だけ行う。

## 移行・rollback

1. v1 clientはOracleを `not_applicable` として明示し、必要なresolutionを送る。
2. MCP登録を `gpt_connector` へ切り替える。
3. 現役wire v8の固定15製品full snapshotを送る。v7はhost別rollback、v6は二段目rollback、旧v2／v4は履歴契約としてだけ維持する。`products.observer`は出さない。
4. timeout等では `sessions` によりgpt-connector側を回収する。自動fallbackはしない。

必要なOracle一時切戻しは手動・期限付きのrollbackであり、H承認後にだけ行う。Oracleをコア製品や新規導入推奨へ戻さない。
