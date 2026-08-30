# grok-build-community-overlay runbook

工場が所有する Grok Build Community overlay の更新手順。契約の正本は [docs/factory-grok-build-community-overlay.md](../../docs/factory-grok-build-community-overlay.md)。

## いつ使う

上流 `phuryn/grok-build-vscode` または `phuryn/afkpilot` が動いたとき。Desktop 側は overlay を rebase して Mac/Windows/Linux の updater 成果物（zip / NSIS / AppImage と `latest*.yml`）を kitepon GitHub Release に載せ、AFK が `https://afk.kitepon.dev/update/` で配る。席のレールボタンがそれを入れる。

## 手順

1. 両作業ディレクトリが dirty でないことを確認する。
2. `bin/update-grok-community-overlay.sh` を実行する。衝突したら overlay コミットだけ直して続行する。
3. 問題なければ `--push`。
4. Desktop 配布物: `~/Developer/grok-build-vscode` で `npm run dist:mac` / `dist:win` / `dist:linux`（updater 用）。席の dir 差し替えは任意。公式 app は触らない。リモート席から quit しない。Release に yml と installer を載せる。
5. リモート UI を変えたら AFK 作業ディレクトリで `npm run sync-ui`。送信経路（`web/chat.html`）を変えたら vendor と一緒に上げる。上げるなら source を main-server `~/afkpilot` へ rsync（`--delete` の前は dry-run。`.env` と `*.bak.json` は除外）し、`deploy/kitepon` で `docker compose up -d --build`。`.env` の `DEVICE_KEYS_PEPPER` を回さない。`GITHUB_TOKEN` は private overlay repo の Release 読取ができること。
6. LAN `http://192.168.1.2:18870/api/health` が 200、公開トップが Access のまま、kitepon Desktop のリンクが残ることを見る。スマホはタブを閉じて入り直す。

## やってはいけないこと

`phuryn/*` へ push しない。公式 Desktop を上書きしない。core 製品 ID や wire 集合へ足さない。
