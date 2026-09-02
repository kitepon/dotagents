# Factory CI

所有: dotagents所有・工場runnerと製品CI接続のL2正典。

製品所有CIの不変判断は[ADR 0136](../../docs/adr/0136-document-ci-ownership-and-base-relative-immutability.md)が正である。

各製品はworkflow名、起動条件、対応OS、依存導入、試験command、文書検査、並列度、timeout、release gateと合否を自身のrepoで所有する。dotagentsは共通self-hosted runner、label、capacity、repo access、標準toolchain、host障害と横断結果だけを所有する。製品CIをdotagentsのworkflowへ委譲せず、このrunbookへ製品workflowの内部構造を複製しない。

## 製品CIの選択と合否

- 各製品は変更内容と自身が所有する依存関係から必要な検査を選び、選択理由と実行結果を自身のCIで機械判定する。分類不能、差分取得失敗、未知の入力は、製品が定めた広い検査または明示失敗だけを許す。
- 条件付きjobを持つ製品は、変更分類の成功、選択されたjobの成功、選択されなかったjobの明示skipが一致した時だけ最終gateを成功させる。選択されたjobのskip、cancel、timeout、結果欠落は失敗とする。
- pull request、merge queue、default branch、定期実行、releaseで検査範囲を変える判断は各製品が所有する。マージを防ぐ契約はマージ前に完了する検査へ置き、遅れて検出してよい健康診断だけを定期実行へ置く。
- 同じcommandと入力による検査は一つの正規実装から呼ぶ。イベントごとに検査範囲や対応環境を変える時は、その差が検出する欠陥の違いを製品repoで説明できる形にする。
- 新しい重いjobまたはrequired checkを追加できるのは、既存検査が防げない欠陥と起動条件を同じ変更で示せる時だけとする。CI変更は直近実行の所要時間、critical path、同じcommandと入力の重複を実測してから行う。

本節は製品CIの合否契約だけを定める。変更分類の実装、job名、GitHub Actionsの構成、cache、検査command、時間予算は各製品repoが所有する。

## 検査範囲の既定と所要時間

- CIの目的には、欠陥検出と同じ重みで所有者の待ち時間と費用を含める。検査を増やす判断も減らす判断も、この両方を実測で比べてから行う。
- push／pull requestの既定はLinux 1環境で、変更に関係する検査だけとする。他OSは、そのOS固有pathを触った変更、週1回の定期健康診断、手動実行だけで回す。version番号や配布metadataだけの変更を全環境展開の理由にしない。
- releaseの公開jobは、同じcommitの他eventのCI結果を前提にしない。tagが公開の決定であり、gateは既定ブランチの祖先確認と配布物の検査だけとする。
- 実測（2026-09-02、Aitermとdotagents）: Linux 2〜3分、macOS 2分、Windows 5〜6分。全環境展開ではWindowsが常にcritical pathになり、release 1回あたり約6分の待ちが所有者の費用として発生していた。

## 工場runner契約

- self-hosted runnerは`factory`とhostを表すlabelを持つ。現役runner名とhost labelの対応は[工場の現行状態](../../docs/factory-current-state.md)が正である。どのlabelを製品が要求するかは製品repoが決める。
- dotagentsの通常full CIと変更分類jobは、現行状態で`full CI`としたrunnerだけを使う。main-server runnerは運用workflow専用とし、通常CIの重複実行へ使わない。
- full CIはrunnerの利用可能な論理CPU数を`FACTORY_CI_JOBS`へ設定する。dotagentsはその値をGNU Makeのjob数へ渡し、独立gateを全論理CPUまで並列実行する。
- WSL2 runnerと`wsl2` labelは退役済みであり、Organizationへ再登録せず、workflowの実行対象にも戻さない。Windows CIは`windows-native` runnerだけを使い、PowerShell 7とGit for Windowsで閉じる。
- runner groupのrepo access、同時実行capacity、online/busy、標準toolchainを工場の観測対象にする。
- runnerは個人用PATHや対話sessionを前提にしない。runnerやtoolchainの障害を別環境への迂回で隠さない。
- 製品repoからrunnerが見えない、要求labelに割り当たらない、queuedのまま進まない、標準toolchainがない問題はdotagentsで直す。
- 製品workflowが開始した後のコード、fixture、依存、試験、文書、release gateの失敗は製品repoで直す。

dotagentsの`.github/workflows/factory-full-ci.yml`はdotagents自身のCIと参照実装にだけ使う。製品repoから参照しない。

## 責任境界

- 各製品repo: workflow全体、対応環境、dependency command、full command、文書確認、release gate、試験結果。
- dotagents: self-hosted runner、`factory`とhost label、runner groupのrepo access、標準toolchain、capacity、host障害。

製品repoの正規command、workflow、文書CI、release gateは、そのrepoのAGENTS、README、CI文書を直接読む。工場runnerを外した時にも製品側だけで受入可能にする判断はADR 0136が所有し、具体形は中央で固定しない。

## runner登録とrepo移転

1. 対象repoからrunnerとlabelを確認する。

   ```sh
   gh api repos/OWNER/REPO/actions/runners \
     --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'
   ```

2. Organization runnerとrunner groupのrepo accessを確認する。

   ```sh
   gh api orgs/OWNER/actions/runners
   gh api orgs/OWNER/actions/runner-groups/GROUP_ID/repositories \
     --jq '.repositories[].full_name'
   ```

3. Organizationにrunnerがあり、対象repoからだけ見えない時はrunner groupへrepoを追加する。旧ownerや旧repo scopeへ登録されている時だけ各hostのrunnerを登録し直す。OS再導入で同名runnerを置き換える時は、旧登録を削除してから現行hostを同じ正規名で登録する。登録tokenと確認codeを文書、log、shell履歴へ残さない。
4. [工場の現行状態](../../docs/factory-current-state.md)にある全runnerが`factory`と対応host labelを持ち、onlineであることを確認する。退役したrunnerや`wsl2` labelが残っていれば削除する。
5. 対象repo自身の正規CI入口を実行し、要求したhostへ割り当てられたことと横断結果を確認する。製品内部のstepやcommandはこのrunbookの受入対象にしない。
