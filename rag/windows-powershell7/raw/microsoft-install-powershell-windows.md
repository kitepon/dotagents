---
source: https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6
retrieved_at: 2026-08-25
confidence: high
---

# Microsoft Learn: Install PowerShell on Windows

MicrosoftはWindows clientへのPowerShell 7導入でWinGetを推奨している。

```powershell
winget search --id Microsoft.PowerShell --exact
winget install --id Microsoft.PowerShell --source winget
```

PowerShell 7はWindows PowerShell 5.1を置換せず、side-by-sideで導入される。
