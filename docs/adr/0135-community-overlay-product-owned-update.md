# ADR 0135: Community overlayの更新入口を製品所有にする

- 状態: Accepted
- 日付: 2026-08-30
- 決定者: オーナー／dotagents
- 先行裁定: ADR 0133、ADR 0134

## 背景

Grok Build Desktopのkitepon overlayとAFK Pilotは独立した製品である。しかし、dotagentsの`update-grok-community-overlay`が両repoの取得、rebase、検証、pushに加え、buildやdeployの具体的なcommandまで持っていた。この構造では、製品repoだけを取り出すと正規の上流追従手順を失い、dotagents側の変更で製品の更新条件も変わる。

## 決定

1. DesktopとAFK Pilotは、それぞれのrepoに上流追従の一回入口を公開し、その前提、内部処理、検証、公開条件を自身で所有する。
2. dotagentsは各製品が公開した入口と入力だけを呼び、その終了結果を横断受入へ投影する。製品内部のbranch、remote、rebase、依存導入、試験、push手順を規定または複製しない。
3. build、release、deploy、rollbackは、上流追従とは別の製品責務として各repoの既存正典と入口が所有する。

## 帰結

各製品はdotagentsを外しても上流追従と検証を完結できる。dotagentsは二つの独立した入口を工場からまとめて呼べるが、製品内部の更新条件や公開判断を制御しない。
