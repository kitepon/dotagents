# Windows一撃展開のLattice hooks契約根治

- Status: 完了（2026-08-24）

## 目的

Windows nativeの工場一撃展開を、既知不整合の成功扱いなしで完走させる。Latticeの
`hooks install`と`hooks status`がnative Windowsで同じtyped
`HOST_PLATFORM_UNSUPPORTED`契約を返すよう根治し、公開版を取り込んだdotagentsから
Lattice専用の例外分岐を撤去する。

## 原因と挙動差

- 実測: Lattice 0.64.0の`hooks install --host claude|codex`は
  `lattice.hooks_error.v1 / HOST_PLATFORM_UNSUPPORTED`を返す。
- 実測: 同じ版の`hooks status --host claude|codex`は
  `lattice.hooks_status_result.v1 / state=unreadable`を返す。
- dotagentsの`setup-windows-native-factory.ps1`はこの製品内不整合を文字列照合し、
  `verify-install`の失敗を成功扱いしていた。
- 修正後: native Windowsの`install|status|uninstall|emit`は全て
  `lattice.hooks_error.v1 / HOST_PLATFORM_UNSUPPORTED`、exit 1で揃う。

## F / A / H

- F: Lattice公開CLI契約、SemVer patch release、npm publish、dotagentsの成功判定、
  実端末への一撃展開と最終合否。
- A: Lattice実装・focused test、dotagents特例撤去・focused test。親が直列で実施する。
- H: なし。

## 順序

1. LatticeにWindows platform gateの失敗テストを追加し、0.64.0で赤を確認する。
2. Latticeのstatus例外を除去し、全hooks commandを同じtyped failureへ揃える。
3. focused test、関連test、version/CHANGELOG、release gate、commit、push、tag、npm publish、
   registry由来のglobal install、公開後CLI smokeを完了する。
4. dotagentsから`known Lattice native-Windows status/install contract mismatch`分岐を撤去し、
   `verify-install`がtyped unsupportedを正規に受理する契約へ揃える。
5. dotagentsのfocused/related gate、対象限定commit、push後、Windows一撃入口を再実行する。
6. 初回runとscheduled-task smokeの両方がexit 0、fresh BugHub delivery acknowledged、
   14製品smoke passedであることを確認する。

## 非目標

- native WindowsでPOSIX hooksを有効化しない。
- Claude/Codex/CursorのPOSIX hook形式や既存設定を変更しない。
- Lattice plan store、sensor、daemon、通常の`lattice status`を変更しない。
- 他の工場製品repoを変更しない。

## 既知の罠

- WSLからWindows PowerShell 5.1のnative childを呼ぶ時だけstdoutと`LASTEXITCODE`が空になる
  既知事象は、今回のnative Windows親→PowerShell/Git Bash再現には該当しない。
- `git status`に出ないstashを同期済みと誤認しない。両repoでstashも確認する。
- npm公開物は既定branchの祖先だけをpublishし、既存versionを上書きしない。

## 検証とrollback

- Lattice: 新規cross-platform focused test、hooks関連test、`npm run check`、release gate。
- dotagents: Windows setup focused test、factory reporter関連gate、修正版一撃の実run。
- Lattice rollback: 0.64.1に公開後欠陥があれば`latest`を直前の0.64.0へ戻し、修正版patchを新規公開する。
- dotagents rollback: Lattice特例撤去commitを独立revert可能に保つ。Lattice公開確認前に撤去しない。

## 完了証拠

- Lattice `60e1b086`を`v0.64.1`として既定branchへpushし、npm public registryへ公開、同registry由来でglobal installした。
- native Windowsの`lattice hooks status --host claude`は`lattice.hooks_error.v1 / HOST_PLATFORM_UNSUPPORTED`、exit 1を返した。
- dotagents `594b189c`でLattice専用の偽成功分岐を撤去し、`make ci`はexit 0で完走した。
- Windows正規入口の最終実走は`initial_run_id=47601a2a-f6e9-433f-9e12-77067e66884ed`、`scheduled_run_id=c875d9a8-60fc-4cc5-96c8-5bbfad9ebcae`、`delivery_acknowledged=true`、`products_checked=14`、daily task `02:00`で完了した。
