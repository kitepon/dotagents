# Factory CI

所有: dotagents所有・工場runnerと製品CI接続のL2正典。

製品所有CIの不変判断は[ADR 0136](../../docs/adr/0136-document-ci-ownership-and-base-relative-immutability.md)が正である。

各製品はworkflow名、起動条件、対応OS、依存導入、試験command、文書検査、並列度、timeout、release gateと合否を自身のrepoで所有する。dotagentsは共通self-hosted runner、label、capacity、repo access、標準toolchain、host障害と横断結果だけを所有する。製品CIをdotagentsのworkflowへ委譲せず、このrunbookへ製品workflowの内部構造を複製しない。

## 工場runner契約

- self-hosted runnerは`factory`とhostを表すlabelを持つ。現役labelは`macos-native`、`linux-server`、`linux-workstation`、`windows-native`である。どのlabelを製品が要求するかは製品repoが決める。
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

3. Organizationにrunnerがあり、対象repoからだけ見えない時はrunner groupへrepoを追加する。旧ownerや旧repo scopeへ登録されている時だけ各hostのrunnerを登録し直す。登録tokenを文書、log、shell履歴へ残さない。
4. `factory`と製品が要求するhost labelを持つrunnerがonlineであることを確認する。
5. 対象repo自身の正規CI入口を実行し、要求したhostへ割り当てられたことと横断結果を確認する。製品内部のstepやcommandはこのrunbookの受入対象にしない。
