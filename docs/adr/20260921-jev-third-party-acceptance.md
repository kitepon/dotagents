# Jev第三者製品の工場配布を受け入れる

2026-09-21。[受入記録](../evidence/jev-third-party-20260921-acceptance.md)と[独立反証](../evidence/jev-third-party-20260921-review.md)に基づき、公式最新版の導入・更新・工場報告を受け入れる。

上流本体・GUI操作ループ・OS対応は上流が所有する。dotagentsは公式導入・更新の呼出しと公開結果の報告を所有し、ServerManagerは受信schema・保存・表示・配備を所有する。工場から上流本体を改造せず、npmバイナリとGit checkoutの版を混同しない。製品導入の成否へ独自GUI診断を重ねない。

Macで導入・再実行と公開報告を確認し、受信サーバーを先に公開してからMacを切り替えた。旧wireを保持した。関連試験、dotagentsの必須CI、ServerManagerの必須試験と正規release gateは成功した。GUI実行と全端末への即時再展開は今回の受入対象に含めない。

今回のpathだけをcommit・pushし、その到達を確認してControlを完了・archiveする。既存の別作業差分は保持する。
