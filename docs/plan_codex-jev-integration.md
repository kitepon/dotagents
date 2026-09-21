# codex-jev 工場統合計画

所有: dotagents。製品の計画・設計・導入・診断・実機受入は独立した[codex-jev製品repo](https://github.com/quolu/codex-jev)のdocs/plan.md、docs/design.md、docs/operations.md、docs/verification.mdを正とする。

## 現在地

製品のMac検証版は単独導入・標準更新・診断・復旧・配布後smokeまで確認済み。証拠は[製品の受入結果](https://github.com/quolu/codex-jev/blob/main/docs/acceptance.md)、配布は[製品Releases](https://github.com/quolu/codex-jev/releases)を参照する。工場コア登録は未着手。Windowsは実機観測がなく、対応済みと扱わない。

## 工場が受け入れるもの

1. 製品が公開する標準導入・更新・診断・復旧・releaseと、Macの実API・実操作の証拠を確認する。
2. README「工場コア製品の変更管理」に従い、製品契約台帳、host matrix、公開診断adapter、BugHubの固定集合・期待matrix・privacy fixture、rollout/verifyへ追加する。
3. 製品内部の設定・キー保存・OS差・GUI制御をdotagentsへ複製しない。工場は公開結果と製品正本への参照だけを扱う。
4. Windowsはその端末の実機受入が揃ってから対応状態を更新する。全repoを独立commit・pushし、公開probeで横断受入する。

## 再開

製品docs/verification.mdの現在地から再開する。次の工程は製品が所有するWindows実機観測と、工場が所有するコア変更管理。現役wireの固定product集合へ追加する際はserver-firstの互換展開を先に設計・実行し、表やPRODUCT_IDSだけを先行変更しない。製品内部の手順と待機位置は製品計画を参照する。
