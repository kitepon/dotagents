# ADR 0132: 全document分類と現行状態生成をCI契約にする

- 状態: Accepted
- 日付: 2026-08-30
- 決定者: オーナー／dotagents

## 背景

製品編入ではコード、installer、wire、README、契約台帳、host matrix、公開案内が別々に更新されていた。「全ドキュメントを更新する」という作業指示はあったが、同じ現行値を複数の散文へ置く構造、現行案内と履歴の境界、更新漏れを拒否するCIがなかった。そのため各変更は局所的に正しくても、古い製品数や現役wireが別文書へ残った。

## 決定

1. `docs/document-registry.json`が全Markdown／MDCを先頭一致で`generated`／`current`／`contract`／`history`／`evidence`へ分類する。新規文書は末尾規則で自動的に`current`となる。
2. 製品集合、区分、現役wire、schema、endpoint、rollback先の正本は`lib/factory/deployment-contract.mjs`だけとする。
3. `bin/render-current-docs.mjs`が正本から`docs/factory-current-state.md`を生成する。current文書は変動値を手入力せず、この生成物を参照する。
4. `make lint-current-docs`は生成drift、分類不備、current文書の手書き現行値を拒否する。`make ci`はこのgateと動的testを必須にする。
5. wire各版の固定契約、履歴、証拠は値を保持する。現行案内には使わず、分類に応じて別の検査対象にする。

## 帰結

製品やwireを変える作業は、構造化正本の変更と生成を行わない限りCIを通過できない。正しい値を複数箇所へ手で写す運用も拒否されるため、次回の編入では更新対象の探索を人の記憶へ依存しない。
