import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  resolveWindowsPowerShell7,
  runWindowsPowerShellScript,
  WINDOWS_POWERSHELL_7_COMMAND,
  WINDOWS_POWERSHELL_7_INSTALL,
} from '../../lib/factory/windows-powershell.mjs';
import { windowsTaskExists } from '../../lib/factory/windows-scheduler.mjs';

test('Windows factory shellはpwsh 7だけを正規入口にする', () => {
  assert.equal(WINDOWS_POWERSHELL_7_COMMAND, 'pwsh.exe');
  assert.equal(WINDOWS_POWERSHELL_7_INSTALL,
    'PowerShell公式GitHub releaseのwin-x64 MSIをmachine scopeで導入');
  const resolved = resolveWindowsPowerShell7((file) => file === 'where.exe' ? ({
    status: 0, stdout: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n',
  }) : ({ status: 0, stdout: '{"edition":"Core","major":7}\r\n' }));
  assert.equal(resolved, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.throws(() => resolveWindowsPowerShell7(() => ({ status: 1, stdout: '' })),
    /PowerShell 7.*公式GitHub release.*MSI/u);
});

test('pwsh解決は相対pathと別executableを受理しない', () => {
  assert.throws(() => resolveWindowsPowerShell7(() => ({ status: 0, stdout: 'pwsh.exe\r\n' })),
    /PowerShell 7/u);
  assert.throws(() => resolveWindowsPowerShell7(() => ({
    status: 0,
    stdout: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n',
  })), /PowerShell 7/u);
  const calls = [];
  const unpackaged = resolveWindowsPowerShell7((file) => {
    calls.push(file);
    return file === 'where.exe' ? ({
      status: 0,
      stdout: 'C:\\Users\\kite\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe\r\nC:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n',
    }) : ({ status: 0, stdout: '{"edition":"Core","major":7}\r\n' });
  });
  assert.equal(unpackaged, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(calls[1], 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.throws(() => resolveWindowsPowerShell7((file) => file === 'where.exe' ? ({
    status: 0, stdout: 'C:\\Users\\kite\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe\r\n',
  }) : ({ status: 0, stdout: '{"edition":"Core","major":7}\r\n' })), /PowerShell 7/u);
  assert.throws(() => resolveWindowsPowerShell7((file) => file === 'where.exe' ? ({
    status: 0, stdout: 'C:\\Tools\\PowerShell\\6\\pwsh.exe\r\n',
  }) : ({ status: 0, stdout: '{"edition":"Core","major":6}\r\n' })), /PowerShell 7/u);
  assert.throws(() => windowsTaskExists('factory', () => ({
    status: null, error: { code: 'ENOENT' }, stdout: '', stderr: '',
  })), /PowerShell 7.*公式GitHub release.*MSI/u);
});

test('現役Windows adapterは検証済み絶対PowerShell 7だけをspawnする', async () => {
  const root = resolve(import.meta.dirname, '..', '..');
  const files = [
    'bin/agents-update-scheduler.mjs',
    'bin/factory-reporter-scheduler.mjs',
    'bin/factory-reporter-v2.mjs',
    'bin/factory-reporter-v2-schedule-runner.mjs',
    'bin/factory-reporter-v4.mjs',
    'bin/factory-reporter-v4-schedule-runner.mjs',
    'bin/factory-reporter-v5.mjs',
    'bin/factory-reporter-v5-schedule-runner.mjs',
    'bin/factory-toolchain-ledger.mjs',
    'lib/factory/windows-scheduler.mjs',
  ];
  for (const file of files) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.match(source, /resolveWindowsPowerShell7/u, file);
    assert.doesNotMatch(source, /spawnSync\(['"]pwsh\.exe['"]/u, file);
    assert.doesNotMatch(source, /spawnSync\(WINDOWS_POWERSHELL_7_COMMAND/u, file);
  }
});

test('PowerShell script runnerは通常ファイルの絶対ps1だけを実行する', async () => {
  const calls = [];
  const child = {
    pid: 42, killed: false,
    stdout: { on() {} }, stderr: { on() {} },
    on(event, callback) { if (event === 'close') queueMicrotask(() => callback(0)); },
    kill() { this.killed = true; },
  };
  const result = await runWindowsPowerShellScript('C:\\Users\\kite\\.local\\bin\\unai.ps1', ['--version'], {
    cwd: 'C:\\work',
    fs: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }) },
    resolvePowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(calls[0][1].slice(0, 6), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    'C:\\Users\\kite\\.local\\bin\\unai.ps1',
  ]);
  const rejected = await runWindowsPowerShellScript('unai.ps1', [], {
    fs: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }) },
  });
  assert.equal(rejected.reason, 'spawn');
});
