import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveSecret, unattendedToken, unattendedTokenPath, UNATTENDED_KEYCHAIN_SERVICE } from '../../lib/factory/op-secret.mjs';
import { prepare } from '../../bin/dotagents-op-run.mjs';

const reference = 'op://vault/item/credential';

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'op-secret-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('平文はopを呼ばず、op://参照だけを読む', async () => {
  assert.equal(await resolveSecret(' plain ', { execute: async () => assert.fail('opを呼んだ') }), 'plain');
  const calls = [];
  const execute = async (command, args, options) => { calls.push([command, args, options.env.OP_SERVICE_ACCOUNT_TOKEN]); return { ok: true, stdout: 'secret\n' }; };
  assert.equal(await resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'given' }, execute }), 'secret');
  assert.deepEqual(calls, [['op', ['read', '--no-newline', reference], 'given']]);
  // launchdの最小PATHでもHomebrewのopへ届く。PATHに別のnodeがある端末（NVMのserver）では先頭にrunnerのnodeの置き場が付く。
  let path;
  await resolveSecret(reference, { platform: 'darwin', home: '/Users/kite', env: { PATH: '/usr/bin:/bin', OP_SERVICE_ACCOUNT_TOKEN: 'x' },
    execute: async (command, args, options) => { path = options.env.PATH; return { ok: true, stdout: 'secret' }; } });
  assert.match(path, /^(?:[^:]+:)?\/usr\/bin:\/bin:.*:\/opt\/homebrew\/bin/u);
});

test('保存済みtokenをOSごとのstoreから読み、opの子へだけ渡す', async (t) => {
  const home = await temporaryHome(t);
  for (const platform of ['linux', 'win32']) {
    const env = { LOCALAPPDATA: join(home, 'Local') };
    await mkdir(dirname(unattendedTokenPath(platform, { home, env })), { recursive: true });
    await writeFile(unattendedTokenPath(platform, { home, env }), 'ciphertext');
    const calls = [];
    const execute = async (command, args, options) => {
      calls.push(command);
      if (command === 'op') { assert.equal(options.env.OP_SERVICE_ACCOUNT_TOKEN, 'sa-token'); return { ok: true, stdout: 'secret' }; }
      if (platform === 'win32') assert.equal(options.env.DOTAGENTS_UNATTENDED_TOKEN_FILE, unattendedTokenPath(platform, { home, env }));
      else assert.deepEqual(args, ['--user', '--refuse-null', '--name=op-service-account-token', 'decrypt', unattendedTokenPath(platform, { home }), '-']);
      return { ok: true, stdout: 'sa-token\n' };
    };
    assert.equal(await resolveSecret(reference, { platform, home, env, execute }), 'secret');
    assert.deepEqual(calls, [platform === 'win32' ? 'pwsh.exe' : 'systemd-creds', 'op']);
    assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  }
  const mac = async (command, args) => {
    assert.equal(command, 'security');
    assert.deepEqual(args, ['find-generic-password', '-s', UNATTENDED_KEYCHAIN_SERVICE, '-a', 'kite', '-w']);
    return { ok: true, stdout: 'sa-token\n' };
  };
  assert.equal(await unattendedToken({ platform: 'darwin', env: { USER: 'kite' }, execute: mac }), 'sa-token');
});

test('未保存ならopの本人認証へ任せ、保存済みで読めなければ止まる', async (t) => {
  const home = await temporaryHome(t);
  assert.equal(await unattendedToken({ platform: 'linux', home, execute: async () => assert.fail('復号した') }), undefined);
  assert.equal(await unattendedToken({ platform: 'darwin', env: { USER: 'kite' }, execute: async () => ({ ok: false, code: 44 }) }), undefined);
  await assert.rejects(unattendedToken({ platform: 'darwin', env: { USER: 'kite' }, execute: async () => ({ ok: false, code: 51 }) }), /OP_UNATTENDED_TOKEN_UNREADABLE/u);
  await mkdir(dirname(unattendedTokenPath('linux', { home })), { recursive: true });
  await writeFile(unattendedTokenPath('linux', { home }), 'ciphertext');
  await assert.rejects(resolveSecret(reference, { platform: 'linux', home, env: {}, execute: async () => ({ ok: false }) }), /OP_UNATTENDED_TOKEN_UNREADABLE/u);
  await assert.rejects(resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'x' }, execute: async () => ({ ok: false }) }), /OP_READ_FAILED/u);
  await assert.rejects(resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'x' }, execute: async () => ({ ok: true, stdout: ' ' }) }), /OP_READ_EMPTY/u);
});

test('MacのSSH席（exit 36）はGUI domainの一度だけのjobからFIFO経由で読み、後片付けする', async (t) => {
  const tmp = await temporaryHome(t);
  for (const booted of [true, false]) {
    const calls = [];
    let plist;
    const execute = async (command, args) => {
      calls.push([command, ...args.slice(0, 2)]);
      if (command === 'security') return { ok: false, code: 36 };
      if (command === 'mkfifo') { assert.match(args[2], /[/\\]token$/u); return { ok: true }; }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        plist = await readFile(args[2], 'utf8');
        return { ok: booted };
      }
      if (command === 'cat') return { ok: true, stdout: booted ? 'sa-token\n' : '' };
      return { ok: true };
    };
    const reading = unattendedToken({ platform: 'darwin', env: { USER: 'kite' }, execute, gui: { uid: 501, tmp } });
    if (!booted) { await assert.rejects(reading, /OP_UNATTENDED_TOKEN_UNREADABLE/u); assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501']); continue; } // 入らなかったjobはbootoutしない
    assert.equal(await reading, 'sa-token');
    const label = plist.match(/<key>Label<\/key><string>([^<]+)</u)[1];
    assert.deepEqual(calls, [['security', 'find-generic-password', '-s'], ['mkfifo', '-m', '600'], ['cat', calls[2][1]],
      ['launchctl', 'bootstrap', 'gui/501'], ['launchctl', 'bootout', `gui/501/${label}`]]);
    assert.match(plist, /<string>\/bin\/sh<\/string>.*<string>dotagents-1password-unattended<\/string><string>-a<\/string><string>kite<\/string><string>-w<\/string>/u);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  }
  assert.deepEqual(await readdir(tmp), []); // tmp dir（FIFOとplist）は残さない
});

test('trim:falseはop readの値をそのまま返す（PEMの末尾改行を残す）', async () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';
  const execute = async () => ({ ok: true, stdout: pem });
  assert.equal(await resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'x' }, execute, trim: false }), pem);
  assert.equal(await resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'x' }, execute }), pem.trim());
  assert.equal(await resolveSecret(' plain ', { trim: false, execute: async () => assert.fail('opを呼んだ') }), ' plain ');
  await assert.rejects(resolveSecret(reference, { env: { OP_SERVICE_ACCOUNT_TOKEN: 'x' }, trim: false, execute: async () => ({ ok: true, stdout: ' \n' }) }), /OP_READ_EMPTY/u);
});

test('dotagents-op-runは参照を解決し、子へService Account tokenを渡さない', async () => {
  const resolved = [];
  const prepared = await prepare(['--env-file', 'app.env', '--', 'app', '--flag'], {
    env: { PATH: '/bin', OP_SERVICE_ACCOUNT_TOKEN: 'sa' },
    readText: async () => `TYPESAFE_API_KEY=${reference}\nPLAIN=value\n`,
    resolve: async (value, { env, trim }) => { assert.equal(trim, false); resolved.push([value, env.OP_SERVICE_ACCOUNT_TOKEN]); return value === reference ? 'secret' : value; },
  });
  assert.deepEqual(prepared, { command: 'app', args: ['--flag'], env: { PATH: '/bin', TYPESAFE_API_KEY: 'secret', PLAIN: 'value' } });
  assert.deepEqual(resolved.sort(), [[reference, 'sa'], ['value', 'sa']]);
  for (const argv of [[], ['--env-file', 'x'], ['--env-file', 'x', 'app'], ['--env-file', 'x', '--']]) {
    await assert.rejects(prepare(argv), /OP_RUN_USAGE/u);
  }
  await assert.rejects(prepare(['--env-file', 'x', '--', 'app'], { readText: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), /OP_RUN_ENV_FILE_UNREADABLE: ENOENT/u);
  await assert.rejects(prepare(['--env-file', 'x', '--', 'app'], { readText: async () => `A=${reference}`, resolve: async () => { throw new Error('OP_READ_FAILED'); } }), /OP_READ_FAILED/u);
});
