# 追加実測 — Windowsの正規入口を開始

AIShell担当から0.6.1の公開とMacでの公開後setup・4 AI登録・6ファイル変更の成功記録を回収した。公開gitHeadは`cd1ea1ff33165c34ee3acc74c0b460ec83f92948`。Aitermの再接続も済み、WindowsのPowerShell 7を使うSSHセッションで工場checkoutを`99cf8d9`へfast-forwardした。設定をtarへ退避後、正規setupを実行した。

Windowsの工場setupはCodex設定適用で終了code 126となった。前提確認は`python`を使用していたが、Codex・Claudeの適用だけGit Bash経由で`python3`を呼んでいた。実機では`python`がPython 3.14.7を起動し、両適用器のdry-runは成功した。`python3`は旧Python配置内のsymlinkで、Git BashからPermission deniedとなった。リンク作成者とアクセス拒否の原因は未特定であり、Python製品の欠陥とは断定しない。

[Python公式文書のWindows起動方法](https://docs.python.org/3/using/windows.html#basic-use)（2026-09-10取得）は`python`を推奨し、`python3`を一般的な推奨呼出しとしていない。工場の2か所をPowerShellから`python`で直接実行する形へ修正した。独自リンク、固定配置、失敗時の切替は追加していない。関連静的試験は2件成功、Macで実行できないWindows専用試験2件は未実行。

この修正をAIShellで保存しようとした際、workspace取得・読取は成功したが、2ファイルの`apply_change_set`が`CHANGE_SET_SECRET_STORE_UNAVAILABLE: Keychain read failed: 100002`で変更前に失敗した。既存MCP processが旧版である可能性を含め、製品担当へ再現を返した。工場に補完実装は置かず、この編集は通常のファイル編集で行った。全体の統合受入は未完了である。
