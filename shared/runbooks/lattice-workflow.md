# Lattice workflow

所有: dotagents所有・全project向けL2正典。

Latticeの工程管理を使うのは、オーナーが指示した時と、オーナー承認済みの進行中工程を継続する時だけ。CLIの状態・`next_action`・run操作の意味は[Lattice README](https://github.com/kitepon/Lattice#readme)と製品契約が正。

- 工程を読む・作る前に`lattice status --json`で判定する。`.lattice/`の有無で判定しない。`invalid`はエラーとして止め、Markdownへ切り替えない。
- `ready`／`active_run`ならtask・依存・状態・完了証拠の正本はLattice storeだけとし、Markdownへ二重化しない。Markdownのplanが持つのは目的・判断理由・非目標・受入条件とLattice planへの導線だけ。
- Markdownを工程の正本にするのは、Lattice CLIが使えない時と、未初期化projectでオーナー裁定により導入しない時だけ。
- runを使う前に既存runを確認し、active runのTODOを二重にdispatchしない。中断runは引き継ぐか、理由を付けて明示的に退役させてから新しいrunを作る。
