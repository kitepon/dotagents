# Jev関連Forkの上流復帰判定

出典: [agent-desktop PR #231](https://github.com/lahfir/agent-desktop/pull/231)、[Browser Harness PR #747](https://github.com/browser-use/browser-harness/pull/747)、[許可シート補正PR #1](https://github.com/ironerumi/browser-harness/pull/1)。取得日: 2026-09-26。確度: PRの状態はGitHub APIで実測、将来のマージと配布は未確定。

Mac向けagent-desktopの修正は、所有者名を返さないウィンドウで画面取得が止まる問題を扱う。Browser Harnessの上流PRは許可ダイアログの多言語化を扱い、補正PRは名前のないAXSheetでもAllow見出しを探す変更を加える。現時点で3件とも未マージ。

復帰条件は、対象PRがマージ済みであること、GitHubの公式release tagがそのmerge commitを含むこと、npm/PyPIの配布版がそのrelease版と一致すること。Browser Harnessは補正PRが上流PRより先にマージ済みであることも確認する。工場の更新入口はこの条件を満たすまで端末別Forkを維持する。
