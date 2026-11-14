import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { FACTORY_RUNNERS } from '../../lib/factory/deployment-contract.mjs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK = join(ROOT, 'bin', 'windows-factory-runner-job-started.ps1');
// 旧runnerにcached marker環境が残っても、CI開始を直列化しない。
const ENV = { ...process.env, FACTORY_RUNNER_BUSY_MARKER: '', RUNNER_NAME: '' };
const PWSH = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function runHookWithMarker(marker, extra = []) {
  // 割り当てと優先度は試験のprocessへ掛けず、存在しない対象で注記へ流す。
  return spawnSync('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999', '-BusyMarkerPath', marker, ...extra], { encoding: 'utf8', env: ENV });
}

test('Windowsの工場runnerのjob開始hookはRunner.Workerの優先度とCPU塊を設定し、失敗でjobを落とさない', async () => {
  const source = await readFile(HOOK, 'utf8');
  assert.match(source, /\$PriorityClass = 'BelowNormal'/u);
  assert.match(source, /Runner\.Worker\.exe.*ParentProcessId.*was not found among the ancestors/su);
  assert.match(source, /\$target\.PriorityClass = \$PriorityClass/u);
  assert.match(source, /\$target\.ProcessorAffinity = /u);
  assert.match(source, /Threading\.Mutex\]::new\(\$false, 'dotagents-factory-runner-cpuset'\)/u);
  // The installed hook's default is the contract's per-job CPU budget (runner-capacity.md "Fox per-job CPU budget").
  const seat = FACTORY_RUNNERS.find((runner) => runner.label === 'windows-native');
  assert.equal(Number(source.match(/\[int\]\$CpusPerJob = (\d+)/u)?.[1]), seat.cpusPerJob);
  assert.ok(seat.maxRunning * seat.cpusPerJob <= 32, 'Fox blocks must not overlap at the cap');
  assert.match(source, /catch \{.*::warning title=factory-runner capacity::.*\}\s*exit 0\s*$/su);
  assert.doesNotMatch(source, /\bexit 1\b|\bthrow \$_/u);
});

test('job開始hookを掛けたprocessの子は、8 CPUの塊と下げた優先度を引き継ぐ', { skip: process.platform !== 'win32' }, () => {
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
  assert.match(result.stdout, /factory-runner capacity: runner= pwsh pid=\d+ priority=BelowNormal/u);
  assert.doesNotMatch(result.stdout, /::warning/u);
  assert.equal(value.parallelism, cpus().length >= 8 ? 8 : availableParallelism()); // one block, or unchanged on small hosts
  assert.equal(value.own, 'BelowNormal');
  assert.equal(value.child, 'BelowNormal');
});

test('job開始hookは他のjobと重ならないCPU塊を選ぶ', { skip: process.platform !== 'win32' || cpus().length < 16 }, async (t) => {
  // A copy of node under a unique name stands in for another job's Runner.Worker pinned to block 0.
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-cpuset-'));
  const name = `fixture-worker-${process.pid}`;
  const exe = join(dir, `${name}.exe`);
  await writeFile(exe, await readFile(process.execPath));
  const script = [
    `$other = Start-Process -FilePath '${exe}' -ArgumentList '-e','setTimeout(()=>{},60000)' -PassThru -WindowStyle Hidden`,
    '$other.ProcessorAffinity = [IntPtr]0xFF',
    `$self = Start-Process -FilePath '${exe}' -ArgumentList '-e','setTimeout(()=>{},60000)' -PassThru -WindowStyle Hidden`,
    // try and finally stay in one element: join('; ') between them is a PowerShell parse error.
    `try { & '${HOOK}' -TargetProcessId $self.Id -WorkerName '${name}' | Out-Host; $self.Refresh(); 'MASK=' + ([int64]$self.ProcessorAffinity) } finally { Stop-Process -Id $other.Id,$self.Id -Force -ErrorAction SilentlyContinue }`,
  ].join('; ');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const result = spawnSync('pwsh.exe', [...PWSH, '-Command', script], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  // Any free block but block 0; which one depends on the live load sample (selection itself is tested below).
  assert.match(result.stdout, /^MASK=(65280|16711680|4278190080)$/mu, result.stdout);
  assert.match(result.stdout, /affinity=0x\w+ load=(\d+%|unknown)$/mu, result.stdout);
});

test('job開始hookの塊選び: 重なりが負荷より先、同数なら空いた塊、採取できなければ大きい番号', { skip: process.platform !== 'win32' }, () => {
  const block = (b0, b1, b2, b3) => `([double[]](@(${b0})*8 + @(${b1})*8 + @(${b2})*8 + @(${b3})*8))`;
  const script = [
    `. '${HOOK}'`,
    '$pick = { param($others, $load) [string](Select-CpuBlock -Blocks 4 -CpusPerJob 8 -Others $others -Load $load).Mask }',
    `$r = [ordered]@{
      overlapFirst = & $pick @([uint64]0xFF00) ${block(90, 0, 50, 20)}
      leastLoaded = & $pick @() ${block(90, 1, 50, 20)}
      noSample = & $pick @() $null
      noSampleBusyTop = & $pick @([uint64]4278190080) $null # 0xFF000000 would parse as a negative int32
      incomplete = $null -eq (Get-CpuLoad 4096)
    }`,
    '$r | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('pwsh.exe', [...PWSH, '-Command', script], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)), {
    overlapFirst: String(0xFF000000), // block 1 is idle but taken by another worker; block 3 is the least loaded free one
    leastLoaded: String(0xFF00),
    noSample: String(0xFF000000),
    noSampleBusyTop: String(0xFF0000),
    incomplete: true, // fewer CPUs than asked: no sample, so ties fall back to the highest index
  });
});

test('job開始hookは対象のprocessが無くても終了値0で注記だけを出す', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999'], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning title=factory-runner capacity::/u);
});

test('job開始hookはmarker引数を受け取ってもファイルを読まず待たない', async () => {
  const source = await readFile(HOOK, 'utf8');
  assert.match(source, /\$BusyMarkerPath = ''/u);
  assert.doesNotMatch(source, /Get-Item|LastWriteTime|Start-Sleep|New-Item|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item/u);
});

test('job開始hookは鍵が無い時も古い鍵が在る時もそのまま進む', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'build.lock');
  const absent = runHookWithMarker(marker);
  assert.equal(absent.status, 0, absent.stderr);
  assert.doesNotMatch(absent.stdout, /busy marker/u);
  await writeFile(marker, 'fixture-owner\n');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(marker, old, old);
  const stale = runHookWithMarker(marker);
  assert.equal(stale.status, 0, stale.stderr);
  assert.doesNotMatch(stale.stdout, /busy marker/u);
  assert.equal(await readFile(marker, 'utf8'), 'fixture-owner\n');
});

test('job開始hookは現在の鍵やcached環境があっても終了を待たない', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'build.lock');
  await writeFile(marker, 'active-fixture-owner\n');
  const result = spawnSync('pwsh.exe', [...PWSH, '-File', HOOK, '-TargetProcessId', '999999999', '-BusyMarkerPath', marker, '-BusyMarkerMaxWaitSeconds', '60'], {
    encoding: 'utf8', env: { ...ENV, FACTORY_RUNNER_BUSY_MARKER: marker }, timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.doesNotMatch(result.stdout, /busy marker|active-fixture-owner/u);
  assert.equal(await readFile(marker, 'utf8'), 'active-fixture-owner\n');
});
