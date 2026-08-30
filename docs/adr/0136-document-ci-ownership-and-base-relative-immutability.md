# ADR 0136: 文書CIの所有境界と基準commit相対の不変性

- 状態: Accepted
- 日付: 2026-08-30
- 決定者: オーナー／dotagents
- 先行裁定: ADR 0132、ADR 0133、ADR 0134
- 置換: ADR 0132決定1のcatch-all部分、ADR 0134決定3〜5

## 背景

製品文書を各repoへ戻した後も、dotagentsが全製品へ同じparser、workflow trigger、取消条件、release gateを指示する余地が残っていた。これは文書を移しただけで制御を中央へ残す構造になる。また、archive本文と台帳digestを同時に書き換えると、現在のworktreeだけを見る自己整合検査は改変を検出できない。新規文書を暗黙にcurrentへ分類するcatch-allも、所有者と役割を未決定のまま現役面へ入れる。

## 決定

1. ADR 0134の決定1と2を維持する。製品CIとrelease gateは製品repoが所有し、dotagentsはrunner、host接続、横断結果を所有する。
2. ADR 0134の決定3から5は、全製品へ共通実装を命じる部分を廃止する。文書の解析方法、検査範囲、依存導入、trigger、取消、workflow、release条件は各製品が決める。
3. 工場が要求するのは、各製品が単独のclean cloneで自身の文書と配布物を受け入れられることだけである。dotagentsは製品が公開した入口を実行し、結果を横断受入へ投影する。製品内部のcommandや判定を複製しない。
4. ADR 0132の「新規文書を末尾規則で自動的にcurrentへする」決定を廃止する。dotagentsのcurrent文書はclosedなpath集合とroleへ明示登録し、未分類の新規文書を受け入れない。`integration`、`product-pointer`、`factory-skill`は完全な対象集合を登録する。
5. 既存のarchive、compatibility stub、evidenceは、比較元commitに対してpath、role、台帳entry、digest、本文を不変とする。archive全path inventoryも追加方向だけを許し、既存pathの再利用、削除、移動、本文と台帳の同時改変、symlinkへの置換を拒否する。
6. current文書のpath、role、全文保護対象を削除または再分類する時は、新しいarchive relocationと新しいarchive pathを同じ変更で追加する。既存archiveを移設先に偽装してはならない。
7. dotagents自身の文書CIでは、GitHub Actionsの比較元をpull requestではbase commit、pushではbefore commit、手動実行では明示入力だけから取る。比較元の欠落、zero SHA、未取得、現在HEADと同一、非ancestorはfail loudにする。分類時に確定した同じcommitをdotagentsの全document checkへ渡し、後段で推測し直さない。この比較方式を製品repoのworkflowへ命じない。
8. dotagents自身のローカル通常検査では、`make lint-current-docs`がHEADを比較元として履歴不変性まで確認する。`node bin/render-current-docs.mjs --check`を直接実行した時だけ現在worktreeの自己整合を確認し、履歴比較が必要なら`--base-ref`で既存commitを明示する。dotagentsのCIでは比較元なしの検査を成功扱いにしない。

## 帰結

各製品は単独性を保ったまま、自分に適した文書CIを選べる。dotagentsは製品を統括するが、製品の検査実装やrelease判断を制御しない。dotagents自身の履歴面は、台帳と本文を一緒に書き換える方法でも過去を改変できず、新しい文書は所有者と役割を決めない限り現役面へ入らない。
