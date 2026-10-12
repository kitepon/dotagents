import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK = join(ROOT, 'bin', 'windows-factory-runner-job-started.ps1');

test('Windowsの工場runnerのjob開始hookはRunner.Workerの優先度と割り当てを下げ、失敗でjobを落とさない', async () => {
  const source = await readFile(HOOK, 'utf8');
  assert.match(source, /\$ReservedLogicalProcessors = 8.*\$PriorityClass = 'BelowNormal'/su);
  assert.match(source, /Runner\.Worker\.exe.*ParentProcessId.*was not found among the ancestors/su);
  assert.match(source, /\$logical - \$ReservedLogicalProcessors\) -ge 4.*ProcessorAffinity = \[IntPtr\].*\$target\.PriorityClass = \$PriorityClass/su);
  assert.match(source, /catch \{.*::warning title=factory-runner capacity::.*\}\s*exit 0\s*$/su);
  assert.doesNotMatch(source, /\bexit 1\b|\bthrow \$_/u);
});

test('job開始hookを掛けたprocessの子は、割り当てた論理CPU数と優先度を引き継ぐ', { skip: process.platform !== 'win32' }, () => {
  const script = [
    `& '${HOOK}' -TargetProcessId $PID | Out-Host`,
    "$parallelism = node -p \"require('node:os').availableParallelism()\"",
    "$child = pwsh.exe -NoProfile -NonInteractive -Command '(Get-Process -Id $PID).PriorityClass'",
    "[pscustomobject]@{ exit = $LASTEXITCODE; parallelism = [int]$parallelism; own = [string](Get-Process -Id $PID).PriorityClass; child = [string]$child } | ConvertTo-Json -Compress",
  ].join('; ');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  const logical = cpus().length;
  const expected = logical <= 64 && logical - 8 >= 4 ? logical - 8 : logical;
  assert.match(result.stdout, /factory-runner capacity: pwsh pid=\d+ priority=BelowNormal/u);
  assert.doesNotMatch(result.stdout, /::warning/u);
  assert.equal(value.parallelism, expected);
  assert.equal(value.own, 'BelowNormal');
  assert.equal(value.child, 'BelowNormal');
});

test('job開始hookは対象のprocessが無くても終了値0で注記だけを出す', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOOK, '-TargetProcessId', '999999999'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning title=factory-runner capacity::/u);
});
