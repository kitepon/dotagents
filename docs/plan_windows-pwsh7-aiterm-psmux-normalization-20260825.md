# Windows工場shell・Aiterm／psmux正常化 campaign

## ゴール

Peertable 0.7.0導入後に実利用で踏んだ工場コア欠陥を、製品所有境界ごとに原因特定・修理・配布し、
Windows工場shellと永続PTYの責務を一つの契約へ揃える。その後にOpenLogicool Phase 12を再開する。

## 確定契約

- Windows native工場shellはPowerShell 7（`pwsh.exe`）だけ。5.1／`cmd.exe` fallbackは持たない。
- 5.1しかないhostはMicrosoft公式installer／package managerでPowerShell 7を導入してから再実行する。
- Windows nativeはWSL2・Docker・Hyper-V・Virtual Machine Platformを前提にもfallbackにもせず、Git for Windowsのnative `bash.exe`／`sh.exe`だけをPOSIX script互換入口にする。
- Aitermが対話型永続PTYとsession lifecycleを所有し、Windows backendはpsmuxだけを使う。
- psmuxはshellではない。PTY内shellがPowerShell 7である。
- Aiterm以外の製品はpsmuxへ直接依存せず、永続PTYが必要な時だけAiterm公開APIを使う。
- OS層は下層、harness層はその上、coreはharness interfaceだけへ依存する既存分離を維持する。

## 実行順と現在地

1. **Lattice — 完了**: 0.64.2〜0.64.4でtodo store CRLF修復、dirty／staged保全、index refresh、
   Windows product-test並列境界、source inventory LF↔CRLF照合を根治。main・npm・global install・
   bridge 0.64.4・Peertable実利用smokeまで成立。
2. **dotagents — 進行中**: 正典とWindows adapterをPowerShell 7へ統一し、定期Taskも`pwsh.exe`へ移行。
3. **Peertable — 未着手**: 既存team再開時にPeertable所有MCP configを現行版へ更新しない欠陥を修理し、
   release・install・OpenLogicool room smokeまで行う。利用者所有の未知MCP設定は上書きしない。
4. **Aiterm — 未着手**: Windows psmux backend内shellをPowerShell 7へ統一し、5.1 fallbackなしで
   release・install・日本語／`rg`／永続PTY smokeまで行う。
5. **OpenLogicool — 未着手**: 工場正常化後にPhase 12 t03〜t07、続いてNIKKE lobby↔squadの
   safe live sliceをNano Serial HID・fresh observation・Confirmed限定で完遂する。

## 受入

- 各自作製品はfocused test→関連gate→既定branch着地→push→release→install→実利用smokeで閉じる。
- OS／harness依存は既存の独立adapter／test harness内だけで修理し、共通runtimeへ移さない。
- PeertableとOpenLogicoolの既存dirty差分はhash／statusで保全し、対象pathだけをcommitする。
- fallback、無根拠retry、未確認状態のSupported化は行わない。
