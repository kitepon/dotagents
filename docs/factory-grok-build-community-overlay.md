# Grok Build Community overlay（工場所有の差分面）

更新日: 2026-08-17。正本はdotagents。これは新しい自作コア製品でも基盤toolchainの新IDでもない。公式 `grok` CLI（product `grok-build`）はそのまま black-box 管理する。本面は、自前 Desktop（Mac / Windows / Linux）と main-server の自前 AFK Pilot だけを工場が追従する。

## 所有

| 面 | 作業ディレクトリ | origin | upstream |
|---|---|---|---|
| Desktop overlay | `~/Developer/grok-build-vscode` | `kitepon/grok-build-desktop-kitepon`（private） | `phuryn/grok-build-vscode` |
| AFK overlay | `~/Developer/afkpilot` | `kitepon/afkpilot-kitepon`（private） | `phuryn/afkpilot` |
| 公開ホスト | main-server `~/afkpilot/deploy/kitepon` | — | — |

公開面は `https://afk.kitepon.dev`。Access は `kitepon@gmail.com`、セッション 720h。Desktop の API/uplink と `/update/*` `/desktop-update` `/download/*` だけ Bypass。Caddy は `192.168.1.2:18870`。公式 `Grok Build Desktop.app` は残し、運用は `Grok Build Desktop (kitepon).app`（Windows NSIS / Linux AppImage も同 appId）。

禁止: 上流 `phuryn/*` への push。公式 dmg の上書き。コア11＋toolchain 3 の product ID 追加。第三者本体への無関係 patch。

## 更新

入口は `bin/update-grok-community-overlay.sh`（dirty なら停止、`upstream/main` へ rebase、focused test。`--push` で origin へ `--force-with-lease`）。ビルドと本番 compose は別手。詳細は grok-build-community-overlay runbook。

Desktop のレール「Update available」は kitepon feed（`https://afk.kitepon.dev/update/{mac,win,linux}/`）の新しい配布物合図。ボタンは公式 dmg を開かず、electron-updater で kitepon 成果物を入れて Restart する。サーバー側の自己更新通知は無い。

## 差分の置き場

Desktop: 既定リレー `wss://afk.kitepon.dev`、パッケージ済みでも `GROK_RELAY_URL` / `~/.grok/afk-relay.json`、updater は kitepon feed、appId/profile 分離、空 cwd の回復。

AFK: `RELAY_DEVICE_STORE` のファイル永続、`deploy/kitepon/`。`web/vendor` は手で持たず、必要なら上流手順の `npm run sync-ui`。`web/chat.html` は vendor ではない。

## リモートでプロジェクトを足す

入口は PROJECTS の `＋`。`$HOME` 配下のディレクトリ一覧で、`~/Developer` があればそこから始める。ホーム自体は追加しない。外す操作はデスクだけ。

届ける面は二つ。Desktop host が `listHostDir` / パス付き `addProjectFolder` を処理し、AFK の vendored `chat.js` と `web/chat.html` が一覧 UI と即送信を持つ。片方だけ新しいと `Loading folders...` のまま止まる。`hostDirListing` に会話スコープを付けない。`listHostDir` は identity 復元の outbox に入れない。

Desktop の差し替えは席でアプリを開き直す。動いているプロセスは古い asar のまま。リモート作業中に Desktop を quit しない（uplink が切れ、その作業も止まる）。
