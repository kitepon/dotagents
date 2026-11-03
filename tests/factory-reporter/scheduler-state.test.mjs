import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { privateState, withLock } from '../../lib/factory/scheduler-state.mjs';
import { runFixtureChild } from './fixtures/child-process.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const nonce = '00000000-0000-4000-8000-000000000001';
const owner = (value = nonce) => ({ schema_version: 'dotagents.factory-scheduler-lock.v1', nonce: value, pid: process.pid, acquired_at: new Date().toISOString() });
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-state-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const major of ['v2', 'v4', 'v5', 'v9']) {
  test(`${major} runner delegates private state and lock while preserving OFF and live owner`, async (t) => {
    const root = await sandbox(t);
    const config = join(root, 'config.json');
    const credential = join(root, 'credential');
    const profile = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'linux';
    const state = join(root, process.platform === 'win32' ? 'local-app-data' : 'state-home', 'dotagents', `factory-reporter-${major}`);
    const runner = join(ROOT, 'bin', `factory-reporter-${major}-schedule-runner.mjs`);
    const settings = { schema_version: '1.0', host: { id: 'test-host', profile }, collection: { enabled: false }, reporting: { enabled: false } };
    await writeFile(config, JSON.stringify(settings));
    const off = await runFixtureChild(runner, ['--config', config], { root });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(off.json.skipped, 'collection-and-reporting-disabled');
    await assert.rejects(readdir(state), { code: 'ENOENT' });
    await writeFile(credential, 'fixture-token\n', { mode: 0o600 });
    settings.reporting = { enabled: true, endpoint: `http://127.0.0.1:1/api/factory/${major}/reports`, credential_file: credential };
    await writeFile(config, JSON.stringify(settings));
    await privateState(state);
    const path = join(state, `schedule.lock.${nonce}.owner`);
    const bytes = `${JSON.stringify(owner())}\n`;
    await writeFile(path, bytes, { mode: 0o600 });
    const blocked = await runFixtureChild(runner, ['--config', config], { root });
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /すでに実行中/);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await readdir(state), [`schedule.lock.${nonce}.owner`]);
    await rm(path);
    const empty = await runFixtureChild(runner, ['--config', config], { root });
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.json.post_gate_status, 'success');
    assert.deepEqual((await readdir(state)).filter((name) => name.includes('schedule.lock')), []);
    const source = await readFile(join(ROOT, 'bin', `factory-reporter-${major === 'v9' ? 'v5' : major}-schedule-runner.mjs`), 'utf8');
    assert.match(source, /import \{ [^}]*privateState, withLock \} from '\.\.\/lib\/factory\/scheduler-state\.mjs'/u);
    assert.match(source, /await privateState\(state\);\s+await withLock\(state,/u);
    if (major === 'v5') assert.match(source, /else ownerOnlyAcl\(temporary\); await rename\(temporary, target\);.*else ownerOnlyAcl\(target\)/u);
  });
}

test('lock returns task value and releases owner after task rejection without replacing its error', async (t) => {
  const root = await sandbox(t);
  await privateState(root);
  const value = {};
  assert.equal(await withLock(root, async () => value), value);
  assert.deepEqual(await readdir(root), []);
  const failure = new Error('task failed');
  await assert.rejects(withLock(root, async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(await readdir(root), []);
});

test('invalid peer original survives rejection and own contender is removed', async (t) => {
  const root = await sandbox(t);
  await privateState(root);
  const path = join(root, `schedule.lock.${nonce}.owner`);
  await writeFile(path, 'invalid original\n', { mode: 0o600 });
  await assert.rejects(withLock(root, () => assert.fail('must not run')), /contenderが不正/);
  assert.equal(await readFile(path, 'utf8'), 'invalid original\n');
  assert.deepEqual(await readdir(root), [`schedule.lock.${nonce}.owner`]);
});

test('release preserves owner whose nonce changed during task', async (t) => {
  const root = await sandbox(t);
  await privateState(root);
  let path;
  const bytes = `${JSON.stringify(owner())}\n`;
  await withLock(root, async () => {
    const names = await readdir(root);
    assert.equal(names.length, 1);
    path = join(root, names[0]);
    await writeFile(path, bytes);
  });
  assert.equal(await readFile(path, 'utf8'), bytes);
});
