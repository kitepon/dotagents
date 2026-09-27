# Jev関連Forkの上流復帰判定

出典: [agent-desktop PR #231](https://github.com/lahfir/agent-desktop/pull/231)、[Browser Harness PR #747](https://github.com/browser-use/browser-harness/pull/747)、[許可シート補正PR #1](https://github.com/ironerumi/browser-harness/pull/1)、[jev-ultrafast Issue #1](https://github.com/browser-use/jev-ultrafast/issues/1)と[PR #153](https://github.com/browser-use/jev-ultrafast/pull/153)。取得日: 2026-09-27。確度: PRの状態とMacの分離Chromeによる再現は実測、将来のマージと配布は未確定。

Mac向けagent-desktopの修正は、所有者名を返さないウィンドウで画面取得が止まる問題を扱う。Browser Harnessの上流PRは許可ダイアログの多言語化を扱い、補正PRは名前のないAXSheetでもAllow見出しを探す変更を加える。現時点で3件とも未マージ。

jev-ultrafastの初回`BLOCKED`修正は、SPAの操作対象が後から描画される場合に、操作前の停止判断を最大3秒の画面変化確認へ回す。上流の初回空画面修正PR #2・#56は空の操作対象を主に扱い、今回の先にナビゲーションだけ表示される画面には十分でない。分離Chromeの遅延描画ページで修正前はクリック0回、修正後は追加ボタンを1回クリックしてフォーム表示に到達した。修正を含むForkの[プレビューRelease](https://github.com/quolu/jev-ultrafast/releases/tag/mac-initial-blocked-1)はソース配布で、Python内部versionは上流と同じ0.1.0。

jev-ultrafastはGitソースから導入し、上流にreleaseとregistry配布がないため、PR #153のマージcommitが公式mainに含まれた時点でForkを卒業する。agent-desktopとBrowser Harnessは対象PRのマージ後、公式release tagがmerge commitを含み、npm/PyPIの配布版がそのrelease版と一致することを要求する。Browser Harnessは補正PRが上流PRより先にマージ済みであることも確認する。工場の更新入口は条件成立まで端末別Forkを維持する。
