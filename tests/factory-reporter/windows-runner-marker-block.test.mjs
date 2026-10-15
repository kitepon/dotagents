import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('専用Windows runnerは保持中markerや旧環境変数でCIを直列化しない', { skip: process.platform !== 'win32' }, async () => {
  const [guard, fixture] = await Promise.all([
    readFile(new URL('../../bin/windows-factory-runner-job-started-dedicated.ps1', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/windows-runner-marker-block.ps1', import.meta.url), 'utf8'),
  ]);
  const command = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;& ([scriptblock]::Create($p.fixture)) -GuardSource $p.guard";
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    input: JSON.stringify({ guard, fixture }), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const value = JSON.parse(result.stdout);
  assert.equal(value.result, 'PASS');
  assert.equal(value.count, 6);
});
