# Git hygiene

所有: dotagents所有・全project向けL2正典。

## コミットとrepo所有

- 複数行のコミットメッセージは`-F <file>`で渡す。PTYへの複数行`-m`は引用が崩れる。
- 自作repositoryのownerは公開段階で分ける。プロトタイプは個人account `quolu`、オーナーが正式リリースと扱ったものは`kitepon` Organizationへ移管する。

## 削除・移行の前

- 消費者ゼロの確認はgrep単独にしない。grepはバイナリ判定したファイルを黙って飛ばすので、Lattice sensor等の索引を併用する。
- 削除・移行・remote乗換の前に、statusに出ない資産（stash、gitignore済みの貴重物、shallow clone等）を疑う。個別の罠はCaveatが正。

## sync-sweep

プロジェクト作業は`bin/sync-sweep.sh`の台帳がgreenの状態から始める。掃引台帳はcampaign単位で`docs/`に起票し、完了後はarchiveする。

## リポの終活

- 継続・休眠・削除候補に分ける。生死はオーナーの宣言だけで決め、削除の承認は端末ごとにオーナーが出す。
- 削除できるのは、remoteがあり、全branch push済み、dirtyゼロ、stash空、gitignore済みの貴重物なしを実走査で確かめた時だけ。欠けていればdirtyはcommit、stashはbranch化、gitignore済みの貴重物は`git add -f`で収容する。鍵と`.env`だけはpushせずtarで退避する。
- GitHub側は削除せず`gh repo archive`にする。
