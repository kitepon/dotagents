import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearRetiredPackage, retiredNamePattern } from '../../lib/factory/npm-retired.mjs';

const CLI = resolve('bin/factory-npm-retired.mjs');
const RETIRED = '.codex-3WgO6fmv';
const EXE = ['node_modules', '@openai', 'codex-win32-x64', 'vendor', 'bin', 'codex.exe'];

async function tree(t) {
  const home = await mkdtemp(join(tmpdir(), 'npm-retired-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const root = join(home, 'npm', 'node_modules');
  const parkDir = join(home, 'state', 'retired-executables');
  await mkdir(join(root, '@openai', 'codex'), { recursive: true });
  await writeFile(join(root, '@openai', 'codex', 'package.json'), '{"version":"0.161.0"}');
  return { home, root, parkDir, scope: join(root, '@openai') };
}

async function leftover(scope, name = RETIRED) {
  const exe = join(scope, name, ...EXE);
  await mkdir(join(exe, '..'), { recursive: true });
  await writeFile(exe, 'old exe');
  await writeFile(join(scope, name, 'package.json'), '{"version":"0.160.0"}');
  return exe;
}

// Windowsが稼働中のexeに返す形（unlinkはEPERM、renameは通る）を、渡したpathにだけ再現する。
const locked = (paths, { renameFails = false } = {}) => ({
  ...nodeFs,
  unlink: async (path) => {
    if (paths.includes(path)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return nodeFs.unlink(path);
  },
  rename: async (from, to) => {
    if (renameFails && paths.includes(from)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    return nodeFs.rename(from, to);
  },
});

test('退避先の名前だけを対象にし、似た名前のpackageは対象にしない', () => {
  const pattern = retiredNamePattern('codex');
  assert.equal(pattern.test('.codex-3WgO6fmv'), true);
  assert.equal(pattern.test('.codex-win32-x64-3WgO6fmv'), false);
  assert.equal(pattern.test('codex'), false);
  assert.equal(pattern.test('.codexx-3WgO6fmv'), false);
  assert.equal(retiredNamePattern('claude-code').test('.claude-code-ha7JHwJu'), true);
});

test('退避フォルダが無い時は何も変えない', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  const result = await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir });
  assert.deepEqual(result, { retired: [], parked: [], remaining: [] });
  assert.deepEqual(await readdir(scope), ['codex']);
  assert.deepEqual(await clearRetiredPackage({ root, packageName: 'not-installed', parkDir }), { retired: [], parked: [], remaining: [] });
  assert.deepEqual(await clearRetiredPackage({ root, packageName: '@missing/scope', parkDir }), { retired: [], parked: [], remaining: [] });
});

test('消せる退避フォルダは消し、導入済みのpackageと他のpackageの退避には触れない', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  await leftover(scope);
  await leftover(scope, '.other-3WgO6fmv');
  const result = await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir });
  assert.deepEqual(result, { retired: [RETIRED], parked: [], remaining: [] });
  assert.deepEqual((await readdir(scope)).sort(), ['.other-3WgO6fmv', 'codex']);
  assert.equal(await readFile(join(scope, 'codex', 'package.json'), 'utf8'), '{"version":"0.161.0"}');
});

test('消せないexeだけを置き場へ移し、退避フォルダを空けて消す', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  const exe = await leftover(scope);
  const result = await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir, stamp: 'S1', fs: locked([exe]) });
  const parkedAt = join(parkDir, `S1-${RETIRED}`, ...EXE);
  assert.deepEqual(result, { retired: [RETIRED], parked: [{ from: exe, to: parkedAt }], remaining: [] });
  assert.equal(await readFile(parkedAt, 'utf8'), 'old exe');
  assert.deepEqual(await readdir(scope), ['codex']);
});

test('置き場へ移せない時は残りとして返し、複製を置き場へ作らない', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  const exe = await leftover(scope);
  const result = await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir, stamp: 'S1', fs: locked([exe], { renameFails: true }) });
  assert.deepEqual(result, { retired: [RETIRED], parked: [], remaining: [exe] });
  assert.equal(await readFile(exe, 'utf8'), 'old exe');
  await assert.rejects(readFile(join(parkDir, `S1-${RETIRED}`, ...EXE)), { code: 'ENOENT' });
});

test('置き場の古いexeは、消せるようになった回に消す', async (t) => {
  const { root, parkDir } = await tree(t);
  const freed = join(parkDir, `S0-${RETIRED}`, 'codex.exe');
  const held = join(parkDir, `S0-.claude-code-ha7JHwJu`, 'claude.exe');
  for (const path of [freed, held]) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'old exe'); }
  await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir, fs: locked([held]) });
  assert.deepEqual(await readdir(parkDir), ['S0-.claude-code-ha7JHwJu']);
  assert.equal(await readFile(held, 'utf8'), 'old exe');
});

test('package名として読めない入力は断り、何も消さない', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  await leftover(scope);
  for (const packageName of ['../codex', '@openai/../codex', '@openai/codex@latest', '', undefined]) {
    await assert.rejects(clearRetiredPackage({ root, packageName, parkDir }), /usage/);
  }
  assert.deepEqual((await readdir(scope)).sort(), [RETIRED, 'codex']);
});

test('CLIは、片付けば0、試せなければ2で終わり、退避フォルダが無い時は何も出さない', async (t) => {
  const { root, parkDir, scope } = await tree(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const quiet = run('clear', '--root', root, '--package', '@openai/codex', '--park', parkDir);
  assert.deepEqual([quiet.status, quiet.stdout], [0, '']);
  await leftover(scope);
  const cleared = run('clear', '--root', root, '--package', '@openai/codex', '--park', parkDir);
  assert.equal(cleared.status, 0);
  assert.deepEqual(JSON.parse(cleared.stdout), { ok: true, package: '@openai/codex', retired: [RETIRED], parked: [], remaining: [] });
  assert.equal(run('clear', '--root', root, '--package', '../codex', '--park', parkDir).status, 2);
  assert.equal(run('clear', '--root', root).status, 2);
  assert.equal(run('remove', '--root', root, '--package', '@openai/codex', '--park', parkDir).status, 2);
});

// Windowsの実物: 稼働中のexeは消せないが、同じvolumeへは動かせる。プロセスは止まらない。
test('Windowsで稼働中のexeを抱えた退避フォルダを片付け、プロセスを止めない', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, parkDir, scope } = await tree(t);
  const exe = join(scope, RETIRED, ...EXE);
  await mkdir(join(exe, '..'), { recursive: true });
  await copyFile(process.execPath, exe);
  await writeFile(join(scope, RETIRED, 'package.json'), '{"version":"0.160.0"}');
  const child = spawn(exe, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { child.kill(); });
  await new Promise((done, fail) => { child.stdout.once('data', done); child.once('error', fail); child.once('exit', () => fail(new Error('exited'))); });
  await assert.rejects(nodeFs.unlink(exe), (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));

  const cli = spawnSync(process.execPath, [CLI, 'clear', '--root', root, '--package', '@openai/codex', '--park', parkDir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual([result.ok, result.retired, result.parked.length, result.remaining], [true, [RETIRED], 1, []]);
  assert.deepEqual(await readdir(scope), ['codex']);
  assert.equal(child.exitCode, null);

  // 掴んでいる間は置き場に残り、プロセスが終わった後の回で消える。
  await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir });
  assert.equal((await readdir(parkDir)).length, 1);
  const exited = new Promise((done) => { child.once('exit', done); });
  child.kill();
  await exited;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await clearRetiredPackage({ root, packageName: '@openai/codex', parkDir });
    if (await readdir(parkDir).then((names) => names.length === 0, (error) => error.code === 'ENOENT')) return;
    await new Promise((done) => { setTimeout(done, 100); });
  }
  assert.fail('プロセスが終わった後も置き場のexeを消せない');
});
