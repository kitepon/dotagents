# ADR 0137: 製品固有の更新ライフサイクルを一回入口へ閉じる

- 状態: Accepted
- 日付: 2026-08-30
- 決定者: オーナー／dotagents
- 先行裁定: ADR 0085、ADR 0086、ADR 0135
- 置換: ADR 0085決定1〜4、ADR 0086の親裁定

## 背景

Throughlineの更新では、dotagentsがpackage更新後に製品のmigration commandを別途呼び、そのJSON schema、状態名、version整合、実行順を解釈していた。SQLを複製していなくても、製品内部の更新ライフサイクルを工場が制御する構造であり、Throughlineを単独で使う時には同じ更新保証を失う。

一方、公式package managerによる置換だけで更新が完結する製品へ、独自のself-update実装を一律に要求する必要はない。工場が知るべきなのは製品固有の内部工程ではなく、公開された更新入口の成否である。

## 決定

1. 公式installerまたはpackage managerによる更新だけで完結する製品は、その公式経路を正規入口とする。
2. 更新後に製品固有の設定再適用、host配線、schema migration、状態変換または診断が必要な製品は、それらを更新と連続実行する一回入口を製品repoに公開する。
3. 一回入口の内部順序、入力、状態、schema、migration、検証方法、出力形式は製品が所有する。入口は必要な工程を終えて公開diagnosticsで実効状態を確認し、成立しなければ非0で終わる。
4. dotagentsは製品が公開した入口を一度だけ呼び、終了結果を横断更新結果へ投影する。製品内部のcommand、JSON field、状態名、schema version、migration順序を規定、複製または解釈しない。
5. 製品入口の失敗は更新失敗として明示する。横断reporterは他製品の実状態を観測するため継続できるが、失敗を工場全体の成功へ丸めない。
6. ADR 0085決定5の「製品DBをdotagentsから直接開かず、SQLやschema versionを複製しない」は維持する。ADR 0085決定1〜4とADR 0086の親裁定が定めたThroughline固有の二段呼出しと内部JSON解釈は失効する。

## 帰結

Throughlineはpackage更新、host配線、DB migration、公開diagnostics確認を自身の一回入口で完結する。dotagentsを外しても更新保証は失われず、工場は複数製品の実行と結果集約だけを統括する。
