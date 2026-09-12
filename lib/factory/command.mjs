import { spawn, spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { resolveWindowsPowerShell7 } from './windows-powershell.mjs';

const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

function windowsArguments(command, args) {
  return ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; & " + [command, ...args].map(quote).join(' ') + '; exit $LASTEXITCODE'];
}

function terminateProcess(child, platform) {
  if (!child || child.killed) return;
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  const taskkill = process.env.SystemRoot
    ? win32.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore', timeout: 5000, windowsHide: true,
  });
  if (result.error || result.status !== 0) child.kill('SIGKILL');
}

function runProcess(command, args, {
  cwd,
  timeoutMs = 5000,
  maxOutputBytes = 64 * 1024,
  env = process.env,
  input,
  platform = process.platform,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timer;
    let terminationResult;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const terminateAndSettle = (value) => {
      if (settled || terminationResult) return;
      terminationResult = value;
      clearTimeout(timer);
      terminateProcess(child, platform);
    };
    const collect = (kind) => (chunk) => {
      if (settled || terminationResult) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        terminateAndSettle({ ok: false, reason: 'output_limit', stdout: '', stderr: '' });
        return;
      }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };

    try {
      child = spawn(command, args, {
          cwd, env, detached: platform !== 'win32',
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
      settle({ ok: false, reason: 'spawn', stdout: '', stderr: '', error });
      return;
    }
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => {
      settle(terminationResult ?? { ok: false, reason: 'spawn', stdout: '', stderr: '', error });
    });
    child.on('close', (code) => {
      settle(terminationResult ?? { ok: code === 0, code, reason: code === 0 ? null : 'exit', stdout, stderr });
    });
    timer = setTimeout(() => {
      terminateAndSettle({ ok: false, reason: 'timeout', stdout: '', stderr: '' });
    }, timeoutMs);
  });
}

export async function run(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return runProcess(command, args, options);
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let powershell;
  try {
    powershell = resolveWindowsPowerShell7();
  } catch (error) {
    return { ok: false, reason: 'spawn', stdout: '', stderr: '', error };
  }
  const remaining = () => deadline - Date.now();
  const timedOut = () => ({ ok: false, reason: 'timeout', stdout: '', stderr: '' });
  if (remaining() <= 0) return timedOut();
  // コマンドの存在と公開入口の解決はPowerShellの標準機能へ委譲する。
  // 製品の終了code 127と、呼出し前のcommand不在を区別する。
  const lookup = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; try { $app = Get-Command -Name " + quote(command)
      + " -CommandType Application,ExternalScript -TotalCount 1; [Console]::Out.Write($app.Source) }"
      + ' catch [System.Management.Automation.CommandNotFoundException] { [Console]::Error.Write($_.Exception.Message); exit 127 }'],
  { ...options, input: undefined, maxOutputBytes: 64 * 1024, timeoutMs: remaining() });
  if (!lookup.ok) {
    if (lookup.reason !== 'exit') return lookup;
    return { ...lookup, reason: 'spawn', error: { code: lookup.code === 127 ? 'ENOENT' : 'EIO' } };
  }
  if (remaining() <= 0) return timedOut();
  const executable = lookup.stdout.trim();
  return /\.exe$/iu.test(executable)
    ? runProcess(executable, args, { ...options, timeoutMs: remaining() })
    : runProcess(powershell, windowsArguments(executable, args), { ...options, timeoutMs: remaining() });
}
