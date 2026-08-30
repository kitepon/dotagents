# ChatGPT Chat枠を MCP で使う手段の実勢調査（2026-07-11）

出典: GitHub API 更新順検索・各リポ README 実読・oracle 0.15.2 dist 実装読解・steipete/oracle issues。取得日: 2026-07-11。確度: claim 別に付記。コンパイル記事（一次ソース verbatim は保存せず、リンクで参照）。

## 問い

ChatGPT サブスクの **Chat枠**（Work枠=Codex 消費分と別勘定）を、追加課金 API なしで MCP からプログラマティックに叩く最良手段は何か。ヘッドレス・認証レス・後始末のきれいさを重視。

## 結論

1. **公式プログラマティック経路は存在しない**（確度: 高）。Codex OAuth（Sign in with ChatGPT)は Work枠に落ちる。Chat枠は Web UI 自動化のみ。
2. **真のヘッドレスは Cloudflare が塞ぐ**（確度: 高・独立2ソース）:
   - oracle 実装コメント「disable headless; Cloudflare blocks it」（dist/src/cli/browserConfig.js:159）
   - ChatGPT-Web2API README「headless Chrome triggers ChatGPT's bot detection」
   - 検知回避ブラウザ（patchright/camoufox）で ChatGPT 向けに保守された製品は GitHub 更新順検索でゼロ。自作は ToS 違反＝Pro アカウント BAN リスク。
3. **2026-07-11時点では[steipete/oracle](https://github.com/steipete/oracle)を採用したが、2026-07-13のオーナー裁定で自作gpt-connectorへ置換済み**。Oracleはv1互換・手動rollback専用である（確度: 高）。現行構成は[docs/06_gpt-connector.md](../../docs/06_gpt-connector.md)。

## 候補の実勢（実物確認済み）

| 候補 | 実態 | 判定 |
|---|---|---|
| [steipete/oracle](https://github.com/steipete/oracle) 0.15.2 | manual-login 永続プロファイル・MCP ネイティブ・hideWindow・ファイル添付・モデル/effort 指定・保守活発（0.15.2=2026-07-06）。GPT-5.6 ラベル未対応は upstream 修正進行中（issue #303/#305・PR #304/#306、07-10 起票） | **採用**（無改造・config と引数で構成） |
| [Octo-Lex/ChatGPT-Web2API](https://github.com/Octo-Lex/ChatGPT-Web2API) | 常駐 Chrome＋CDP、MCP/SSE/OpenAI 互換 REST。思想は近い。4★・v0.2.0（2026-06）。**cookie 約2週で失効＝定期再ログイン**・ヘッドレス不可・単一セッション・モデル表が旧世代 | 見送り。**再訪条件: セッション分離＋cookie 永続（またはプロファイル方式）が入ったら** |
| [xncbf/chatgpt-mcp](https://github.com/xncbf/chatgpt-mcp)（75★）/ [cdpath ChatGPT App](https://www.pulsemcp.com/servers/cdpath-chatgpt-app) | macOS デスクトップアプリを AppleScript で UI 操作。ブラウザ不要だが**アプリを前面に奪取**・応答検出が英韓のみ（日本語不安）・モデル選択不可 | 見送り（フォーカス奪取が要件違反） |
| [cbusillo/chatgpt-automation-mcp](https://github.com/cbusillo/chatgpt-automation-mcp) | Playwright 系。2026-04 アーカイブ（OUT OF DATE 明記） | 死亡 |

## oracle 実装読解の要点（0.15.2・再調査の節約用）

- config は `~/.oracle/config.json` の `browser` セクション。`manualLogin` / `hideWindow` / `thinkingTime` / `modelStrategy` / `copyProfileSource` 等（dist/src/config.js）。MCP サーバー（oracle-mcp）も同 config を読む。
- `copyProfileSource`（実 Chrome cookie 同期）と `manualLogin` は**排他**（dist/src/browser/index.js:641）。cookie 同期は macOS Keychain 許可を毎回要求し、失敗すると未ログインのまま走る（実被弾 2026-07-09 セッションログ）。
- 手動ログインの既定プロファイルは `~/.oracle/browser-profile`（dist/src/browser/manualLoginProfile.js:52）。
- `hideWindow` は CDP 接続直後に AppleScript `set visible to false`＝Cmd-H 相当（chromeLifecycle.js:113-135）。**起動 1〜2 秒はウィンドウが見える**。macOS のみ。
- Chrome 起動フラグはハードコード（`--window-size=1280,720` 等・chromeLifecycle.js:462-493）で注入手段なし。ただし `CHROME_PATH` 環境変数でバイナリ差し替え可＝画面外起動フラグを足すシムを挟める（採否は実測）。
- thinkingTime の enum は GPT-5.6 の Effort 名（instant/low/medium/high/extra-high）を受理済み＝Effort ピッカー対応は入っているが、モデルラベル表が旧世代（"Pro"）のまま。
- **MCP 経路の `browserModelLabel` は死んでいる**（確度: 高・実測）: `runModel` が `gpt-` 始まりだとラベルを無視して旧表へ落とし（dist/src/mcp/tools/consult.js `buildConsultBrowserConfig` の `isChatGptModel` 分岐）、非 gpt 文字列を `model` に渡すとファジー解決で別モデルに化ける（実測: "GPT-5.6 Sol" → gpt-5.2）。0.15.2 で 5.6 を確実に使う形は `modelStrategy: "ignore"`＋アカウント現在値。

## 導入時に実測で踏んだ罠（2026-07-11・すべて再現済み）

1. **Node undici の `setTypeOfService` EINVAL 即死**: undici（2026-03 の IP 優先度ヒント機能）が全 HTTP/1.1 リクエストで `socket.setTypeOfService(request.typeOfService ?? 0)` を**無条件・ガードなし**に呼ぶ（lib/dispatcher/client-h1.js）。macOS で特定ソケット状態だと未捕捉例外→プロセスごと死ぬ。**Node 24.18.0 / 26.4.0 の両方で再現**＝バージョン替えでは逃げられない。単純な fetch（IPv4/IPv6/localhost/https）では再現せず、発火条件は未特定（oracle のブラウザ実行後クリーンアップ中の HTTP 呼び出しで安定的に発生）。対処: `--import 'data:text/javascript,...'` プリロードで try/catch ラップ（dotagents `bin/oracle-mcp-stable.sh`）。MCP サーバーが「静かに接続クローズ」する事象の正体でもある。
2. **oracle `hideWindow`（Cmd-H）は送信を壊す**: 非表示アプリの描画停止で ChatGPT の送信が発火せず、**プロンプトが下書きのまま滞留して後続 run の送信に混入**（実測: 3 run 分が1メッセージで送信された）。当時は`--window-position=-32000,-32000`（CHROME_PATH shim）を採用したが、2026-07-14の複数display実測でmacOS/Chromeが画面内へclampすることを確認したため、非可視保証は撤回する。通常運用は窓なしcold起動とCDP最小化を持つgpt-connectorへ移行済み。
3. **Google SSO が自動化ブラウザを弾く**: oracle 専用プロファイルでの初回ログインで「ChatGPT はブロックされています」（Google の insecure-browser 判定）。パスキー認証なら通ることを実測。ダメなら ChatGPT ネイティブのメールコードへ。
