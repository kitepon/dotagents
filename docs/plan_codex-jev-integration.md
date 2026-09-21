# codex-jev 工場統合計画

所有: dotagents。製品の計画・設計・導入・診断・実機受入は独立した[codex-jev製品repo](https://github.com/quolu/codex-jev)のdocs/plan.md、docs/design.md、docs/operations.md、docs/verification.mdを正とする。

## 現在地

製品のMac単独受入を先行中。工場コア登録は未着手。Windowsを対応済みと扱わない。

## 工場が受け入れるもの

1. 製品が公開する標準導入・更新・診断・復旧・releaseと、Macの実API・実操作の証拠を確認する。
2. README「工場コア製品の変更管理」に従い、製品契約台帳、host matrix、公開診断adapter、BugHubの固定集合・期待matrix・privacy fixture、rollout/verifyへ追加する。
3. 製品内部の設定・キー保存・OS差・GUI制御をdotagentsへ複製しない。工場は公開結果と製品正本への参照だけを扱う。
4. Windowsはその端末の実機受入が揃ってから対応状態を更新する。全repoを独立commit・pushし、公開probeで横断受入する。

## 再開

製品docs/verification.mdの現在地から再開し、単独製品の受入条件が揃うまでPRODUCT_IDSや現行host集合を変更しない。TypeSafeキー設定とWindows実機観測の待機位置は製品計画へ記録する。
