# Factory CI

所有: dotagents所有・工場runnerと製品CI接続のL2正典。

製品所有CIの不変判断は[ADR 0136](../../docs/adr/0136-document-ci-ownership-and-base-relative-immutability.md)が正。

## 責任境界

- 各製品repo: workflow全体、起動条件、対応OSと要求label、依存導入、試験command、文書検査、並列度、timeout、release gateと合否。製品CIをdotagentsのworkflowへ委譲せず、このrunbookへ製品workflowの内部を複製しない。
- dotagents: 共通self-hosted runner、`factory`とhost label、runner groupのrepo access、capacity、標準toolchain、host障害と横断結果。
- 製品が現行に無いlabelを要求して割り当たらない時は、製品repoのworkflowを現行labelへ直す。現行labelなのにrunnerが見えない・割り当たらない・queuedのまま進まない・標準toolchainが無い時は、dotagentsで直す。
- workflowが開始した後のコード、fixture、依存、試験、文書、release gateの失敗は製品repoで直す。

## 製品CIの合否

- 各製品は変更内容と自身の依存関係から必要な検査を選び、選択理由と結果を自身のCIで機械判定する。分類不能・差分取得失敗・未知の入力には、製品が定めた広い検査か明示失敗だけを許す。
- 条件付きjobを持つ製品は、変更分類の成功、選択したjobの成功、選択しなかったjobの明示skipが揃った時だけ最終gateを成功にする。選択したjobのskip・cancel・timeout・結果欠落は失敗にする。
- マージを防ぐ検査はマージ前に完了する検査に置き、遅れて見つけてよい健康診断だけを定期実行に置く。
- CIの目的には、欠陥検出と同じ重みで所有者の待ち時間と費用を含める。検査を増やす・減らす判断は両方を実測で比べてから行い、重いjobやrequired checkを足すのは既存検査が防げない欠陥を同じ変更で示せる時だけ。
- push・pull requestは変更に関係する検査を、影響する全対応OSで行う。所要時間だけを理由に対応OSを外さない。版番号だけの変更は版の整合性と配布物の確認を1環境で行う。
- releaseの公開jobは、同じcommitの他eventのCI結果を前提にしない。tagが公開の決定で、gateは既定ブランチの祖先確認と配布物の検査だけ。

## 工場runner

- 現役runner名とhost labelの対応は[工場の現行状態](../../docs/factory-current-state.md)が正。通常のfull CIは、そこで`full CI`としたrunnerだけを使い、main-server runnerは運用workflow専用にする。
- WSL2 runnerと`wsl2` labelは退役済み。Organizationへ再登録せず、workflowの実行対象にも戻さない。Windows CIは`windows-native` runnerだけを使い、PowerShell 7とGit for Windowsで閉じる。
- `windows-native`席は所有者が対話で使うPCである。runnerのjob開始hook（`bin/windows-factory-runner-job-started.ps1`）で、jobのprocessを先頭8個を除いた論理CPUと優先度`BelowNormal`で動かす。製品は並列数を`os.availableParallelism()`から決め、論理CPUの総数を固定値や`NUMBER_OF_PROCESSORS`から取らない。hookは端末の`C:\ProgramData\dotagents\factory-runner\job-started.ps1`へ管理者とSYSTEMだけが書ける形で置き、runnerの`.env`の`ACTIONS_RUNNER_HOOK_JOB_STARTED`で指す。hookの失敗はjobを落とさず、jobの注記に出る。
- 所有者の側が重い仕事（ビルドや試験）の間だけ置く鍵のファイルがある端末では、その場所をrunnerの`.env`の`FACTORY_RUNNER_BUSY_MARKER`で指す。同じhookが、鍵が在る間はjobの開始を待つ（5秒おきに見直し、最大5分。更新が15分より古い鍵は待たない）。hookは鍵を読むだけで、作らず消さない。上限を過ぎた時はjobを始め、jobの注記に出す。所有者の側は、`Runner.Worker.exe`が在る間を「工場のjobが走っている」と読める。未設定の端末では待たない。
- runnerは個人用PATHや対話sessionを前提にしない。runnerやtoolchainの障害を別環境への迂回で隠さない。
- OS再導入で同名runnerを置き換える時は、旧登録を削除してから現行hostを同じ正規名で登録する。登録tokenと確認codeを文書・log・shell履歴へ残さない。
- dotagentsの`.github/workflows/factory-full-ci.yml`はdotagents自身のCIと参照実装だけに使い、製品repoから参照しない。
