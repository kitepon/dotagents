# Cursor Origin

所有: dotagents所有・Cursor Origin運用のL2正典。

オーナーはCursor Originを作業の主へ移す方針。Originは初期βで仕様が動くため、下の判断は使う時点で再実測してから頼る。実測した仕様・導入手順は[rag/tools/cursor-origin.md](../../rag/tools/cursor-origin.md)にある。

- 使う形は「Sync from GitHub」だけとし、形式上の正はGitHubのまま置く。repoの`origin` remoteをOriginにし、GitHub直は`github` remoteとして控える。
- Originでrepoを切り離し（detach）しない。切り離すとGitHubへ一切流れなくなり、raw配信・plugin marketplace・deploy webhookなどの配布面が止まる。主従を入れ替えるのは、Origin生まれのrepoをGitHubへ反映する機能が出てから。
- 公開OSSの顔（README・topics・Social preview）はGitHub側で整える。
- 同期の追加はcursor.comの管理画面でオーナーが行う。
