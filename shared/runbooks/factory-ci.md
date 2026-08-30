# Factory CI

所有: dotagents所有・工場runnerと製品CI接続のL2正典。

製品所有CIの不変判断は[ADR 0134](../../docs/adr/0134-product-owned-document-ci.md)が正である。

各製品はCIの合否、依存導入、試験command、対応OSを自身のrepoで所有する。dotagentsは共通self-hosted runner、label、capacity、host障害の復旧を所有する。製品CIをdotagentsのworkflowへ委譲しない。

## 標準契約

- 製品repoは`.github/workflows/product-full-ci.yml`を持ち、同repoのcallerから`./.github/workflows/product-full-ci.yml`として呼ぶ。
- product workflowは製品repoにversion管理する。dotagentsの削除、非公開化、main変更が製品CIの意味や起動可否を変えない構造にする。
- macOS native、Linux native、Windows native、WSL2へ対応する製品は、4環境で同じfull commandを並列実行する。対応OSを限定する製品は製品契約に従って対象だけを選ぶ。非対応環境を成功へ丸めない。
- Markdownだけの変更はLinux上で製品所有の文書契約を必ず検査する。各製品は`documentation-command`を空にせず、現役索引、archive/stub、ローカルリンク、配布物へ含める文書の閉包を自身のrepoで検査する。Markdown以外を含む変更、tag、手動実行は対象環境のfull testを行う。
- checkout、依存導入、full testを別stepにして所要時間を観測する。依存cacheは実測で効果が確認できた製品だけがpackage managerの標準機能で持つ。
- workflowは論理CPU数を`FACTORY_CI_JOBS`として渡す。並列度は製品のtest runnerが決める。
- 製品full jobの上限は30分を既定とする。変更には製品repoの実測根拠を残す。
- runnerは標準toolchainを常備し、個人用PATHや対話sessionを前提にしない。runnerやtoolchainの障害を別環境への迂回で隠さない。

dotagentsの`.github/workflows/factory-full-ci.yml`はdotagents自身のCIと参照実装にだけ使う。製品repoから参照しない。

## 責任境界

- 各製品repo: caller、local reusable workflow、dependency command、full command、文書確認、releaseとの`needs`、試験結果。
- dotagents: self-hosted runner、`factory`とhost label、runner groupのrepo access、標準toolchain、capacity、host障害。
- 製品のfull command開始後に出たコード、fixture、試験の失敗は製品repoで根治する。
- queuedのまま進まない、対象labelが見えない、runner groupからrepoが見えない、標準toolchainがない問題はdotagentsで直す。

製品は工場runnerを使わなくても、repo内のdependency commandとfull commandを手元で直接実行できる状態を保つ。CI workflowはその正規commandを呼ぶだけにする。

## 製品repoの構成

callerは製品所有workflowだけを呼ぶ。

```yaml
jobs:
  ownership:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - run: |
          test -f .github/workflows/product-full-ci.yml
          git grep -q 'uses: \.\/\.github\/workflows\/product-full-ci\.yml' -- .github/workflows

  full:
    uses: ./.github/workflows/product-full-ci.yml
    with:
      environment: ${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'all' }}
      dependency-command: PRODUCT_DEPENDENCY_COMMAND
      documentation-command: PRODUCT_DOCUMENTATION_COMMAND
      full-command: PRODUCT_FULL_COMMAND
```

`ownership` jobは、dotagentsのworkflowを参照する`uses:`が存在しないことと、callerが空でない`documentation-command`を渡すことも検査する。tag publishは`ownership`と`full`の両方を`needs`に持つ。依存導入が不要な製品は`dependency-command`を省略できるが、文書確認は省略できない。

製品の追加時は、既存repoからworkflowをsymlinkや外部参照で借りない。参照実装を新repoへ置き、その製品が自分の履歴として変更できる状態から始める。

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
4. `factory`と対象環境のlabel（`macos-native`、`linux-native`、`windows-native`、`wsl2`）を持つrunnerがonlineであることを確認する。
5. 対象repoの`workflow_dispatch`で各環境を実行し、製品repo内の同じfull commandが割り当てられたことを確認する。
