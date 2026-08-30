---
name: oracle
description: "ChatGPT Chat枠 second-opinion（oracle MCP）の呼び出し標準形。oracle.consult を使う前・oracle の設定/挙動異常を疑った時に読む。"
---

# oracle — 非推奨互換・rollback専用

> 新規のChatGPT second-opinionは `$gpt-connector` と MCP `gpt_connector` を使う。Oracleはv1 client・履歴・手動rollbackの互換期間だけ残す。通常利用や新規MCP登録の入口ではない。

固定実証前提: oracle 0.15.2・GPT-5.6 世代（2026-07 時点）。rollback記録なので日付を現行へ読み替えない。通常入口はgpt-connectorであり、本スキルは期限付き手動rollbackだけに使う。旧Oracleの固定記録は[archive](../../../docs/archive/2026-08_06_oracle-mcp.md)。

## 固定方針

- 入口は MCP `oracle.consult` のみ（サーバー実体はラッパー `~/.local/bin/oracle-mcp-stable`）。素の `oracle`/`oracle-mcp` を直接叩かない。
- API engine 禁止・`OPENAI_API_KEY` を作らない・設定しない（サブスク Chat枠のみを使う）。
- モデルと Effort は **ChatGPT アカウントの現在値**で走る（config の `modelStrategy: "ignore"`）。恒久変更はオーナーが ChatGPT UI で行う。
- 出力は助言として扱い、採用前に必ずローカルの code/diff/test で検証する。

## 封印済みオプション（0.15.2 実測。使うと必ず失敗する）

- `preset: "chatgpt-pro-heavy"` — 旧 "Pro" ラベル照合で失敗
- `browserModelLabel`／`modelStrategy: "select"` — GPT-5.6 UI に不追従（非 gpt 文字列はファジー解決で別モデルに化ける実測）
- `hideWindow` — 描画停止で送信が発火せず、下書き滞留が後続 run に混入。互換shimは固定負座標を付けるが複数displayでは画面内へclampされるため、非可視を保証しない。通常運用はgpt-connectorを使う
- 解除条件は upstream の対応リリースを実測し、このrollback skillと固定記録を更新した時のみ。

## config 正本（`~/.oracle/config.json`）

```json
{
  "browser": {
    "manualLogin": true,
    "modelStrategy": "ignore",
    "archiveConversations": "auto"
  }
}
```

- **この形が正**。`copyProfileSource`（実 Chrome cookie 同期）は置かない——Keychain 毎回認証＋cookie 不適用の罠。`thinkingTime`・`hideWindow` も置かない。
- **config がこの形であることを「リセットされた」と誤診して旧形へ戻さない**（実被弾 2026-07-11: 旧記述のスキルを信じた別セッションが正典 config を"修復"し、可視 Chrome・Keychain 要求が再発）。config は全セッション共有の可変状態——食い違いを見たら旧固定記録と突き合わせ、rollback範囲外の変更はしない。

## golden path

1. `files` は最小十分に選ぶ。秘密（`.env`・key・token・cookie・認証ログ）は添付しない。
2. まず `dryRun: true`——Chrome 非接触で解決構成だけ確認し、`manual login: yes`・`model strategy: ignore` になっていることを見る。
3. 本実行の標準形:

   ```jsonc
   {
     "prompt": "この設計を反証して。重大な見落としだけ指摘して。",
     "engine": "browser",
     "files": ["docs/plan.md", "src/**/*.ts"],
     "slug": "readable-session-id"
     // Effort を一時的に変えたい時だけ "browserThinkingTime": "extra-high" 等を付ける
   }
   ```

4. 長時間・失敗時は再実行せず、MCP `sessions` ツールで状態を確認する。**送信失敗の後は下書き滞留に注意**——次 run の送信に前回プロンプトが混入し得る。

## CLI は保守専用

一回限りの手動ログイン・ブラウザ診断のみ `~/.local/bin/oracle-mcp-stable cli ...` を使う（手順は[固定記録](../../../docs/archive/2026-08_06_oracle-mcp.md)）。通常作業で CLI を直打ちしない。
