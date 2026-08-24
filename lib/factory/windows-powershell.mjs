import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

export const WINDOWS_POWERSHELL_7_COMMAND = 'pwsh.exe';
export const WINDOWS_POWERSHELL_7_INSTALL = 'winget install --id Microsoft.PowerShell --source winget';
let resolvedDefault = null;

export function resolveWindowsPowerShell7(spawn = spawnSync) {
  if (spawn === spawnSync && resolvedDefault !== null) return resolvedDefault;
  const located = spawn('where.exe', [WINDOWS_POWERSHELL_7_COMMAND], {
    encoding: 'utf8', timeout: 5_000,
  });
  const resolved = located.stdout?.split(/\r?\n/u)
    .find((candidate) => win32.isAbsolute(candidate) && win32.basename(candidate).toLowerCase() === WINDOWS_POWERSHELL_7_COMMAND);
  if (located.status !== 0 || !resolved) {
    throw new Error(`PowerShell 7が必要です。Microsoft公式経路で導入してください: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  }
  const version = spawn(resolved, ['-NoProfile', '-NonInteractive', '-Command',
    '[ordered]@{ edition = $PSVersionTable.PSEdition; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress'], {
    encoding: 'utf8', timeout: 5_000,
  });
  let identity = null;
  try { identity = JSON.parse(version.stdout?.trim() ?? ''); } catch { /* typed failure below */ }
  if (version.status !== 0 || identity?.edition !== 'Core'
    || !Number.isInteger(identity?.major) || identity.major < 7) {
    throw new Error(`PowerShell 7が必要です。Microsoft公式経路で導入してください: ${WINDOWS_POWERSHELL_7_INSTALL}`);
  }
  if (spawn === spawnSync) resolvedDefault = resolved;
  return resolved;
}
