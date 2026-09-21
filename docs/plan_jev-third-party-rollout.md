# Jev上流製品の工場配布

所有: dotagents。2026-09-21の依頼により、jev-ultrafastとagent-desktopを第三者製品として一撃展開・定期更新・状態報告へ追加する。導入時は上流最新版を使い、旧版固定と自動降格はしない。

## 境界と受入

- 上流が本体・依存・操作・OS対応・診断を所有する。公式Git checkout、uv、npm、Skill installerだけで導入し、本体のpatch・独自操作wrapper・追加の判断gateは作らない。
- dotagentsは製品区分、公式導入更新の呼出し、既存工場キーの配布、公開結果の報告を所有する。Browser Harnessはjev-ultrafastの依存として上流lockに従う。
- ServerManagerはBugHubの受信schema・保存・表示・公開を所有する。新製品を既存wireへ混ぜず、新majorをserver-firstで追加する。旧wireを維持する。
- agent-desktopはMacだけを導入対象にする。ブラウザ実行系は各OSの標準Python/uvとChrome接続を使う。初回の認証やAPIキー不足は実状態として記録し、無人GUI操作で補わない。
- 導入・定期診断はGUIを起動しない。定期報告は公開versionだけを読み、GUI利用可能とは混同しない。
- 成功条件は公式最新版の導入経路、冪等更新、OS別対象、失敗の伝播、秘密を含まない状態報告、BugHubの新旧wire受理と表示、対象限定commit・push。全端末への即時再展開は今回の依頼に含めない。

## 工程

1. 既存契約とbaselineを確認する。既存23件のfocused testは成功。
2. 公式導入・更新と公開probeをdotagentsへ実装し、隔離環境で再実行・失敗・OS差を確認する。
3. ServerManagerへ受信互換を追加し、製品のrelease入口で先に公開する。
4. dotagentsへ新wireと製品登録を接続し、Macの報告で横断確認する。
5. 契約境界の独立反証、関連検証、最終CI、文書生成、commit・pushで完了する。

複数repoの公開順序があるため統括レーン。Lattice工程管理は使わない。実装は契約を確定する順に親が直列処理し、契約critical部分だけ独立反証を行う。対象製品の最新versionは構造化観測から取り、散文へ現行値を固定しない。

## 現在地

機能受入完了。公式最新版の導入・再実行、OS別対象、ServerManagerの先行配備、Macからの報告と公開matrixの一致、独立反証、両repoの必須試験を確認した。[受入記録](evidence/jev-third-party-20260921-acceptance.md)と[最終裁定](adr/20260921-jev-third-party-acceptance.md)を参照。対象限定commit・pushで閉じ、既存dirtyは別作業として保持する。
