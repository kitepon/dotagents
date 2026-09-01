# Factory CI

所有: dotagents所有・工場runnerと製品CI接続のL2正典。

製品所有CIの不変判断は[ADR 0136](../../docs/adr/0136-document-ci-ownership-and-base-relative-immutability.md)が正である。

各製品はworkflow名、起動条件、対応OS、依存導入、試験command、文書検査、並列度、timeout、release gateと合否を自身のrepoで所有する。dotagentsは共通self-hosted runner、label、capacity、repo access、標準toolchain、host障害と横断結果だけを所有する。製品CIをdotagentsのworkflowへ委譲せず、このrunbookへ製品workflowの内部構造を複製しない。

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
