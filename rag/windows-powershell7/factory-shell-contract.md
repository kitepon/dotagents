---
sources:
  - https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6
retrieved_at: 2026-08-25
confidence: high
---

# Windows工場shellをPowerShell 7へ統一する

Microsoftの現行Windows client向け推奨導入経路はWinGetで、PowerShell 7は5.1とside-by-sideで入る。
したがって5.1を互換fallbackに残す必要はなく、工場入口は`pwsh.exe`の存在とmajor 7以上を要求できる。

dotagentsのWindows一撃入口・定期Task・Node製Windows adapterは`pwsh.exe`だけを使う。5.1しか
ないhostは`winget install --id Microsoft.PowerShell --source winget`で7を導入してから再実行する。

対話型永続PTYは別レイヤであり、Aitermが所有する。Windowsではpsmuxがterminal/session
multiplexer、PTY内で動くshellがPowerShell 7である。他製品はpsmuxへ直接依存しない。
