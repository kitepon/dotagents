import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK = join(ROOT, 'bin', 'windows-factory-runner-job-started.ps1');
// 工場のrunnerの上では `.env` の鍵の場所がjobへ渡る。試験が実物の鍵を待たないよう、既定を空にする。
const ENV = { ...process.env, FACTORY_RUNNER_BUSY_MARKER: '' };
const PWSH = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function runHookWithMarker(marker, extra = []) {
  // 割り当てと優先度は試験のprocessへ掛けず、存在しない対象で注記へ流す。
  return spawnSync('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999', '-BusyMarkerPath', marker, ...extra], { encoding: 'utf8', env: ENV });
}

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
  const result = spawnSync('pwsh.exe', [...PWSH, '-Command', script], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /busy marker/u);
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
  const result = spawnSync('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999'], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning title=factory-runner capacity::/u);
});

test('job開始hookは鍵の場所をrunnerの環境変数から取り、鍵を作らず消さず、待ちの失敗でjobを落とさない', async () => {
  const source = await readFile(HOOK, 'utf8');
  assert.match(source, /\$BusyMarkerPath = \$env:FACTORY_RUNNER_BUSY_MARKER.*\$BusyMarkerMaxWaitSeconds = 300.*\$BusyMarkerStaleMinutes = 15/su);
  assert.match(source, /if \(\$BusyMarkerPath\) \{.*LastWriteTime.*'stale'.*'timeout'.*Start-Sleep/su);
  assert.match(source, /catch \{.*::warning title=factory-runner busy marker::.*\}\s*exit 0\s*$/su);
  assert.doesNotMatch(source, /New-Item|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item/u);
});

test('job開始hookは、鍵が無い時と古い鍵の時は待たずに進む', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'build.lock');

  const absent = runHookWithMarker(marker);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /factory-runner busy marker: result=clear waited=0s/u);

  await writeFile(marker, 'craft 00:00:00 stale\n');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(marker, old, old);
  const stale = runHookWithMarker(marker);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /factory-runner busy marker: result=stale waited=0s/u);
  assert.equal(await readFile(marker, 'utf8'), 'craft 00:00:00 stale\n');
});

test('job開始hookは、鍵が在る間は待ち、消えたら進み、上限を過ぎたら注記を出して進む', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'build.lock');
  await writeFile(marker, 'craft 11:35:02 CraftRuleTests\n');

  const held = runHookWithMarker(marker, ['-BusyMarkerMaxWaitSeconds', '2', '-BusyMarkerPollSeconds', '1']);
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /::warning title=factory-runner busy marker::The busy marker was still present after \d+s; the job starts anyway\./u);
  assert.doesNotMatch(held.stdout, /CraftRuleTests/u);
  assert.equal(await readFile(marker, 'utf8'), 'craft 11:35:02 CraftRuleTests\n');

  const released = await new Promise((resolveRun, reject) => {
    const child = spawn('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999', '-BusyMarkerPath', marker, '-BusyMarkerMaxWaitSeconds', '60', '-BusyMarkerPollSeconds', '1'], { env: ENV });
    let stdout = '';
    let removing = null;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      // 割り当ての注記が出た後は、hookは鍵の待ちに入っている。
      if (removing === null && stdout.includes('factory-runner capacity')) removing = setTimeout(() => rm(marker).catch(reject), 1500);
    });
    child.on('error', reject);
    child.on('close', (status) => resolveRun({ status, stdout }));
  });
  assert.equal(released.status, 0);
  const match = released.stdout.match(/factory-runner busy marker: result=clear waited=(\d+)s/u);
  assert.ok(match, released.stdout);
  assert.ok(Number(match[1]) >= 1 && Number(match[1]) < 60, released.stdout);
});
