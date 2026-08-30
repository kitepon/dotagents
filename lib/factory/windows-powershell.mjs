import { spawn, spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { win32 } from 'node:path';

export const WINDOWS_POWERSHELL_7_COMMAND = 'pwsh.exe';
export const WINDOWS_POWERSHELL_7_INSTALL = 'PowerShell公式GitHub releaseのwin-x64 MSIをmachine scopeで導入';
let resolvedDefault = null;

function isUsableWindowsPowerShellPath(candidate) {
  if (!win32.isAbsolute(candidate)
    || win32.basename(candidate).toLowerCase() !== WINDOWS_POWERSHELL_7_COMMAND) return false;
  // The Microsoft Store/MSIX App Execution Alias can report a valid Core 7
  // version while running in a packaged context that cannot read the
  // owner-only factory state.  Factory ACL helpers require the unpackaged MSI
  // executable (normally under Program Files).
  return !candidate.toLowerCase().includes('\\windowsapps\\');
}

export function resolveWindowsPowerShell7(spawn = spawnSync) {
  if (spawn === spawnSync && resolvedDefault !== null) return resolvedDefault;
  const located = spawn('where.exe', [WINDOWS_POWERSHELL_7_COMMAND], {
    encoding: 'utf8', timeout: 5_000,
  });
  const resolved = located.stdout?.split(/\r?\n/u)
    .find(isUsableWindowsPowerShellPath);
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

export async function runWindowsPowerShellScript(script, args, {
  cwd,
  env = process.env,
  timeoutMs = 5000,
  maxOutputBytes = 64 * 1024,
  fs = { lstat },
  pathModule = win32,
  resolvePowerShell = resolveWindowsPowerShell7,
  spawnProcess = spawn,
  killProcess = spawnSync,
} = {}) {
  try {
    if (!pathModule.isAbsolute(script) || pathModule.extname(script).toLowerCase() !== '.ps1') {
      throw Object.assign(new Error('PowerShell script pathが不正です'), { code: 'EINVAL' });
    }
    const info = await fs.lstat(script);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw Object.assign(new Error('PowerShell scriptが通常ファイルではありません'), { code: 'EINVAL' });
    }
  } catch (error) {
    return { ok: false, reason: 'spawn', stdout: '', stderr: '', error };
  }

  let powershell;
  try {
    powershell = resolvePowerShell();
  } catch (error) {
    return { ok: false, reason: 'spawn', stdout: '', stderr: '', error };
  }

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const terminate = () => {
      if (!child || child.killed) return;
      const taskkill = env.SystemRoot
        ? pathModule.join(env.SystemRoot, 'System32', 'taskkill.exe')
        : 'taskkill.exe';
      const result = killProcess(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 5000, windowsHide: true,
      });
      if (result.error || result.status !== 0) child.kill('SIGKILL');
    };
    const collect = (kind) => (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        terminate();
        settle({ ok: false, reason: 'output_limit', stdout: '', stderr: '' });
        return;
      }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    try {
      child = spawnProcess(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
      ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      settle({ ok: false, reason: 'spawn', stdout: '', stderr: '', error });
      return;
    }
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => settle({ ok: false, reason: 'spawn', stdout: '', stderr: '', error }));
    child.on('close', (code) => settle({ ok: code === 0, code, reason: code === 0 ? null : 'exit', stdout, stderr }));
    timer = setTimeout(() => {
      terminate();
      settle({ ok: false, reason: 'timeout', stdout: '', stderr: '' });
    }, timeoutMs);
  });
}
