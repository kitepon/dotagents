import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { FACTORY_RUNNERS } from '../../lib/factory/deployment-contract.mjs';

// Boundary checks for docs/feature-map/runner-capacity.md (Fox parallel instances).
const ROOT = resolve(import.meta.dirname, '..', '..');
const ENTRY = join(ROOT, 'bin', 'windows-factory-runner-task-entry.ps1');
const RUN = join(ROOT, 'bin', 'windows-factory-runner-run.ps1');
const APPLY = join(ROOT, 'bin', 'windows-factory-runner-instances.ps1');
const seat = FACTORY_RUNNERS.find((runner) => runner.label === 'windows-native');
const pairs = (text) => Object.fromEntries([...text.matchAll(/'(factory-windows-[^']+)'\s*=\s*'([^']+)'/gu)].map((m) => [m[1], m[2]]));

test('task entry and apply script pin exactly the contract instances', async () => {
  const contract = Object.fromEntries(seat.instances.map((item) => [item.name, item.root]));
  assert.deepEqual(pairs((await readFile(ENTRY, 'utf8')).match(/\$Instances = \[ordered\]@\{([^}]*)\}/u)[1]), contract);
  const apply = await readFile(APPLY, 'utf8');
  const [first, ...rest] = seat.instances;
  assert.ok(apply.includes(`$existingRoot = '${first.root}'`));
  assert.deepEqual(pairs(apply.match(/\$newRoots = \[ordered\]@\{([^}]*)\}/u)[1]), Object.fromEntries(rest.map((item) => [item.name, item.root])));
});

test('apply never resets the factory password and restarts only while idle', async () => {
  const apply = await readFile(APPLY, 'utf8');
  assert.doesNotMatch(apply, /Set-LocalUser|-Password|Register-ScheduledTask|Set-ScheduledTask/u);
  assert.match(apply, /if \(\(Get-Workers\)\.Count\) \{ \[ordered\]@\{ result = 'busy'[^\n]*exit 3 \}\n\s*Stop-ScheduledTask/u);
  assert.match(apply, /524288/u); // FILE_FLAG_FIRST_PIPE_INSTANCE: a squatted pipe name fails before any token is sent.
  assert.doesNotMatch(await readFile(RUN, 'utf8'), /Write-(Host|Output)/u);
});

test('Fox runner helpers parse', { skip: process.platform !== 'win32' }, () => {
  const script = [ENTRY, RUN, APPLY].map((file) => `$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e);$e.Count`).join(';');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ['0', '0', '0']);
});
