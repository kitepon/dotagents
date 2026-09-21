# codex-jev 工場統合計画

所有: dotagents。製品の計画・設計・導入・診断・実機受入は独立した[codex-jev製品repo](https://github.com/quolu/codex-jev)のdocs/plan.md、docs/design.md、docs/operations.md、docs/verification.mdを正とする。

## 現在地

2026-09-21、オーナーが自作codex-jevの不採用と、jev-ultrafast / agent-desktopの上流実装をそのまま利用することを指示。下記の自作製品の工場登録計画は撤回し、Macの利用経路を上流へ置き換える。旧repoと証拠は履歴として保持する。

実行順序は、標準導入、既存キーの非表示設定、公式の診断と可逆操作、旧Skillの標準uninstall、利用案内の更新。両者は同じデスクトップ・ブラウザを使うため操作試験は親が直列で行う。上流製品のコード・判断ループ・チェックを改変せず、独自wrapperを作らない。旧ローカルfile URL試験の拒否を別経路で回避せず、上流の公開ページ用例と可逆なアプリ操作で確認する。OS権限など人の操作が必要なら実際の不足だけを報告する。Windowsへの展開は今回に含めない。

成功条件は、両方の標準入口でJevを呼び実操作を完了し、次のCodexタスクから利用方法を辿れること。速度は起動準備と実行時間を混同せず、取れた値だけを掲載する。

現在、両者の標準導入、上流Skillの導入、自作Skillの標準uninstallは完了。ブラウザは1リンク遷移を通常操作と各5回比較し、両方5/5成功、中央値は通常9.444秒・Jev1.261秒。2リンクの連続操作もJevで5/5成功した。デスクトップはCodex標準shellから既存の権限で呼出し可能で、バイナリ追加の手元操作依頼は撤回。現在は上流の画面一覧取得が`kCGWindowOwnerName`欠落でタイムアウトし、実操作前に停止する。ブラウザ文字入力は別モデルのAPIキーの回答待ち。[導入結果](evidence/jev-upstream-adoption-20260921.md)、[反復評価](evidence/jev-upstream-evaluation-20260921.md)、[デスクトップの原因訂正](evidence/jev-desktop-launcher-diagnosis-20260921.md)、[利用先](../shared/runbooks/jev-computer-use.md)を参照する。

## 撤回した旧計画

1. 製品が公開する標準導入・更新・診断・復旧・releaseと、Macの実API・実操作の証拠を確認する。
2. README「工場コア製品の変更管理」に従い、製品契約台帳、host matrix、公開診断adapter、BugHubの固定集合・期待matrix・privacy fixture、rollout/verifyへ追加する。
3. 製品内部の設定・キー保存・OS差・GUI制御をdotagentsへ複製しない。工場は公開結果と製品正本への参照だけを扱う。
4. Windowsはその端末の実機受入が揃ってから対応状態を更新する。全repoを独立commit・pushし、公開probeで横断受入する。

## 旧計画の再開位置（履歴）

製品docs/verification.mdの現在地から再開する。次の工程は製品が所有するWindows実機観測と、工場が所有するコア変更管理。現役wireの固定product集合へ追加する際はserver-firstの互換展開を先に設計・実行し、表やPRODUCT_IDSだけを先行変更しない。製品内部の手順と待機位置は製品計画を参照する。
