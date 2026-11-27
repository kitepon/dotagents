import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const STORE = new URL('../../bin/factory-reporter-credential-store.mjs', import.meta.url).pathname;
const PUSH = new URL('../../bin/factory-reporter-credential-push.sh', import.meta.url).pathname;
const TOKEN = 'tok_ABC123-secret';

async function box(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cred-push-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credential = join(dir, 'credentials', 'factory.token');
  const config = join(dir, 'factory-reporter.json');
  await writeFile(config, JSON.stringify({ schema_version: '1.0', host: { id: 'rabbit', profile: 'linux' }, collection: { enabled: true }, reporting: { enabled: true, endpoint: 'http://127.0.0.1:1/api/factory/v9/reports', credential_file: credential } }));
  return { dir, credential, config };
}

test('storeは標準入力のtokenを0600の平文fileへ置き、出力へ出さない', async (t) => {
  const { credential, config } = await box(t);
  const run = spawnSync(process.execPath, [STORE, '--config', config], { input: `${TOKEN}\n`, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(credential, 'utf8'), TOKEN);
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
  // 置き直しは同じfileを原子的に置き換える。
  assert.equal(spawnSync(process.execPath, [STORE, '--config', config], { input: 'second-token', encoding: 'utf8' }).status, 0);
  assert.equal(await readFile(credential, 'utf8'), 'second-token');
});

test('storeは空・空白入り・op://参照・設定なしでは既存のfileを変えない', async (t) => {
  const { dir, credential, config } = await box(t);
  assert.equal(spawnSync(process.execPath, [STORE, '--config', config], { input: TOKEN, encoding: 'utf8' }).status, 0);
  for (const input of ['', '\n', 'a b', 'op://vault/item/credential', 'x'.repeat(5000)]) {
    const run = spawnSync(process.execPath, [STORE, '--config', config], { input, encoding: 'utf8' });
    assert.equal(run.status, 1, input);
    assert.equal(await readFile(credential, 'utf8'), TOKEN);
  }
  const missing = spawnSync(process.execPath, [STORE, '--config', join(dir, 'none.json')], { input: TOKEN, encoding: 'utf8' });
  assert.equal(missing.status, 1);
});

test('pushはtokenをsshの標準入力だけで渡し、argvへ出さない', async (t) => {
  const { dir, credential } = await box(t);
  const fake = join(dir, 'ssh');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\n`);
  await chmod(fake, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOTAGENTS_REPORTER_TOKEN: TOKEN };
  for (const [host, target] of [['rabbit', 'rabbit'], ['mac-kite', 'macbook'], ['fox', 'fox']]) {
    const run = spawnSync('sh', [PUSH, host], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(await readFile(join(dir, 'stdin'), 'utf8'), TOKEN);
    const argv = await readFile(join(dir, 'argv'), 'utf8');
    assert.ok(!argv.includes(TOKEN));
    assert.match(argv, new RegExp(`^-o\\nBatchMode=yes\\n-o\\nConnectTimeout=15\\n${target}\\n.*factory-reporter-credential-store`, 's'));
  }
  // main-serverはsshを使わず、同じclone内のstoreをそのまま走らせる。
  await mkdir(join(dir, 'dotagents'));
  await copyFile(join(dir, 'factory-reporter.json'), join(dir, 'dotagents', 'factory-reporter.json'));
  const local = spawnSync('sh', [PUSH, 'main-server'], { env: { ...env, XDG_CONFIG_HOME: dir }, encoding: 'utf8' });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(await readFile(credential, 'utf8'), TOKEN);
  assert.equal(spawnSync('sh', [PUSH, 'nowhere'], { env, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('sh', [PUSH, 'rabbit'], { env: { ...env, DOTAGENTS_REPORTER_TOKEN: '' }, encoding: 'utf8' }).status, 2);
});

test('typesafe: api.envへTYPESAFE_API_KEY=値で置き、parseEnvで読み戻せる。引数のhostへだけsshする', async (t) => {
  const { dir } = await box(t);
  const run = spawnSync(process.execPath, [STORE, '--typesafe'], { input: TOKEN, encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.equal(run.status, 0, run.stderr);
  const file = join(dir, '.config', 'dotagents', 'credentials', 'typesafe', 'api.env');
  assert.equal(parseEnv(await readFile(file, 'utf8')).TYPESAFE_API_KEY, TOKEN);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const input of ['a#b', 'a"b', 'a b', 'op://v/i/c']) {
    assert.equal(spawnSync(process.execPath, [STORE, '--typesafe'], { input, encoding: 'utf8', env: { ...process.env, HOME: dir } }).status, 1, input);
  }
  assert.equal(parseEnv(await readFile(file, 'utf8')).TYPESAFE_API_KEY, TOKEN);
  const fake = join(dir, 'ssh');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\n`);
  await chmod(fake, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TYPESAFE_API_KEY: TOKEN };
  assert.equal(spawnSync('sh', [PUSH, 'typesafe', 'rabbit'], { env, encoding: 'utf8' }).status, 0);
  assert.equal(await readFile(join(dir, 'stdin'), 'utf8'), TOKEN);
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  assert.ok(!argv.includes(TOKEN) && argv.includes('--typesafe'));
  assert.equal(spawnSync('sh', [PUSH, 'typesafe', 'nowhere'], { env, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('sh', [PUSH, 'typesafe', 'rabbit'], { env: { ...env, TYPESAFE_API_KEY: '' }, encoding: 'utf8' }).status, 2);
});
