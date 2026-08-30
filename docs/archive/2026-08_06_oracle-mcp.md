# 06_oracle-mcp — 非推奨互換・rollbackランブック

> **移行先:** [06_gpt-connector.md](06_gpt-connector.md) がChatGPT接続の生きた正本である。Oracleはv1 client・履歴・手動rollbackの互換期限中だけ残す。以下は新規導入・通常MCP登録の手順ではなく、承認済みrollback時だけ参照する記録である。

<!-- 固定実証前提: oracle 0.15.2・GPT-5.6 世代・Node 24/26 の undici バグ現存（2026-07 時点）。
     rollback記録なので日付を現行へ読み替えない。現行の役割配置は docs/02_models.md。経緯と調査・切り分けの全記録は docs/archive/2026-07_oracle-chat-quota.md（2026-07-11 完了・退避済み） -->

[oracle](https://github.com/steipete/oracle)（`@steipete/oracle`・npm -g）で ChatGPT サブスクの **Chat枠**を MCP 経由の第二意見に使う。Work枠（Codex 消費分）と別勘定・追加課金なし。**API engine / `OPENAI_API_KEY` は禁止**（憲法）。**oracle 本体は改造しない**——構成は config・起動ラッパー・呼び出し引数で行う。

## 設計の根拠（要旨・実測 2026-07-11）

- Chat枠を課金なしで叩く経路は Web UI 自動化のみ（公式プログラマティック経路なし）。
- **真のヘッドレスは Cloudflare が塞いでいる**（oracle 実装コメント・ChatGPT-Web2API README の独立一致）。検知回避ブラウザ自作は ToS 違反＝BAN リスクで不採用。
- 代替製品調査で oracle より上は現存せず（詳細: [rag/tools/chatgpt-chat-quota-mcp-survey.md](../rag/tools/chatgpt-chat-quota-mcp-survey.md)）。
- ただし素の oracle 0.15.2 には環境起因の地雷が3つあり、**全て外付けで無害化済み**（下記「入口は必ず oracle-mcp-stable」）。

## 入口は必ず `oracle-mcp-stable`（ラッパー経由）

正体: [bin/oracle-mcp-stable.sh](../bin/oracle-mcp-stable.sh) → `~/.local/bin/oracle-mcp-stable`。素の `oracle`/`oracle-mcp` を直接叩かない。ラッパーが握る地雷:

1. **Node undici の `setTypeOfService` EINVAL 即死**: undici が全 HTTP/1.1 リクエストで `socket.setTypeOfService(0)` を無条件に呼び（ガードなし）、macOS で特定ソケット状態だと未捕捉例外でプロセスごと死ぬ。Node 24.18.0 / 26.4.0 の両方で実測。MCP サーバーが「静かに接続クローズ」する事象の正体。→ ラッパーが `--import` の data: URL ガードで EINVAL を握って無害化（発動時 stderr に1回記録）。Node と Oracle の global root は `PATH` / `npm root -g` から解決し、macOS・Linux・Windows Git Bash の固定パスへ依存しない。upstream 修正確認までの一時手段。
2. **`hideWindow`（Cmd-H）は使用禁止**: 非表示アプリは描画が止まり、**送信が発火せずプロンプトが下書きのまま滞留 → 後続 run に混入する**（実測: 3 run 分のプロンプトが1メッセージで送信された）。互換shim [bin/oracle-chrome-shim.sh](../bin/oracle-chrome-shim.sh) は`--window-position=-32000,-32000`を付けるが、2026-07-14の複数display実測でChrome/macOSが画面内へclampすることが判明したため、**非可視を保証しない**。Oracleはrollback専用であり、この欠陥を理由にshimやOracle本体へ新規改造を足さない。非可視が必要な通常運用はgpt-connectorの正規launcherを使う。
3. **GPT-5.6 UI にモデルラベル照合が不追従**（preset/`browserModelLabel` とも 0.15.2 では機能しない。下記「呼び出しの標準形」）。

## セットアップ（新しい端末）

1. **導入**: `agents-update` の対象（`bin/agents-update.sh` PACKAGES に `@steipete/oracle`）。手動なら `npm install -g @steipete/oracle@latest`。通常は `./install.sh --profile official` で `oracle-mcp-stable` / `oracle-chrome-shim` が `~/.local/bin` に入る（legacy 入口を選ぶ端末は `--profile legacy`）。
2. **一回限りの手動ログイン**（オーナー操作・CLI 直打ちはこの用途のみ憲法許容）:

   ```bash
   ~/.local/bin/oracle-mcp-stable cli --engine browser --browser-manual-login \
     --browser-keep-browser --browser-input-timeout 300000 \
     --browser-model-strategy ignore -p "login check: reply with OK"
   ```

   開いた oracle 専用 Chrome（`~/.oracle/browser-profile`・実 Chrome と別物）でオーナーが ChatGPT にログイン。以後セッションは専用プロファイルに永続。
   **罠**: Google SSO は自動化フラグ付きブラウザを「安全でないブラウザ」として弾くことがある（「ChatGPT はブロックされています」表示）。パスキー認証で通るか、ダメなら ChatGPT ネイティブの**メールコードログイン**に切り替える（実測でパスキー成功）。
3. **config 正本を配置**（`~/.oracle/config.json`・バックアップしてから）:

   ```json
   {
     "browser": {
       "manualLogin": true,
       "modelStrategy": "ignore",
       "archiveConversations": "auto"
     }
   }
   ```

   - `manualLogin: true` … 専用プロファイル使用＝**Keychain アクセスゼロ・毎回認証の撲滅**
   - `copyProfileSource` は**置かない**（manual-login と排他。cookie 同期経路は Keychain 毎回認証＋不適用の罠）
   - `modelStrategy: "ignore"` … ピッカー操作を丸ごとスキップ（0.15.2 暫定。upstream 5.6 対応リリース後に `"select"` へ戻す）
   - `hideWindow` / `thinkingTime` は**置かない**（前者は送信破壊、後者はアカウント既定に委ねる）
4. **MCP 登録**:
   - Claude Code: `claude mcp add --scope user oracle -- "$HOME/.local/bin/oracle-mcp-stable"`
   - Codex: [`05_codex-fragments.md`](05_codex-fragments.md) の限定 applier は MCP を変更しない。H 承認後に `codex mcp add oracle -- "$HOME/.local/bin/oracle-mcp-stable"` を実行し、`codex mcp get oracle --json` で確認する。

## 呼び出しの標準形（GPT-5.6 世代・0.15.2 時点）

**モデルと Effort は ChatGPT アカウントの現在値で走る**（変更はオーナーが ChatGPT UI で行う。現在値は共有文書に書かない）。0.15.2 の暫定仕様として以下は**全部封印**:

- preset `chatgpt-pro-heavy` — 旧 "Pro" ラベル照合で必ず失敗
- `browserModelLabel` — MCP 経路では gpt-* モデル時に無視され、非 gpt 文字列はファジー解決で別モデルに化ける（実測: "GPT-5.6 Sol" → gpt-5.2）
- `modelStrategy: "select"` — 同じラベル照合で失敗

標準形（MCP `consult`）:

```jsonc
{
  "prompt": "…",
  "engine": "browser",
  "files": ["src/**/*.ts"]          // 必要時
  // modelStrategy は config の "ignore" が効く。Effort を一時的に変えたい時だけ
  // "browserThinkingTime": "extra-high" 等を付ける（メニュー読取は新 UI 対応済みを実測）
}
```

- 事前確認は `dryRun: true`（Chrome に触らず解決構成を返す）。
- セッション確認は MCP `sessions` ツール（または `oracle-mcp-stable cli status`）。
- **解除条件**: upstream の 5.6 対応（issue #303/#305・PR #304/#306）が `agents-update` で入ったら、dryRun→実走で preset / select を再評価し、本ファイルを更新する。

## 後始末と健全性

- 正常・異常どちらのパスも Chrome は終了する（実測）。残置を疑ったら `pgrep -fl "browser-profile"`。
- 「送信失敗」エラー後は**下書き滞留に注意**: 次の run に前回プロンプトが混入し得る。混入を検知したら ChatGPT 側の該当会話（アーカイブ済み）を確認する。
- ガード発動は stderr の `[oracle-mcp-stable] setTypeOfService guard` 行で分かる（MCP ログに出る）。
- **`~/.oracle/config.json` は全セッション共有の可変状態**（実被弾 2026-07-11: 別セッションの AI が oracle エラーを"直そう"とバックアップ復元し、旧構成〔copyProfileSource＋cookieSync＋select〕が復活→可視 Chrome・Keychain・ピッカー暴走が再発）。oracle の挙動異常を見たら**まず本節上の config 正本と diff**。直すときは必ずこの正典の形へ——バックアップ `.bak-*` からの復元は旧構成の復活なので禁止。

## upstream への報告（起票済み・2026-07-11）

1. [nodejs/undici#5544](https://github.com/nodejs/undici/issues/5544): `writeH1` の `setTypeOfService` 無ガード呼び出しが macOS で未捕捉 EINVAL → プロセス死（try/catch 要望）。**解決したらラッパーの guard を外す**
2. [steipete/oracle#312](https://github.com/steipete/oracle/issues/312): `hideWindow` が新 ChatGPT UI で送信を壊す（当時は画面外配置を提案）。後続実測で固定負座標も複数displayでは非可視を保証しないと判明。Oracleはrollback専用のため、通常運用はgpt-connectorへ移行する
