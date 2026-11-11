import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setupTypeSafe } from '../../lib/factory/typesafe-setup.mjs';
import { loadTypeSafeKey, serverServiceAccountPath, TYPESAFE_OP_REFERENCE } from '../../lib/factory/typesafe-credentials.mjs';

const secret = '試験専用の秘密';
const installed = [{ name: 'typesafe-ai', scope: 'global', source: 'typesafe-ai/skills', agents: ['Claude Code', 'Codex', 'Cursor', 'Grok Build'] }];
const success = { ok: true, stdout: JSON.stringify(installed) };
const apiSuccess = () => ({ ok: true, json: async () => ({ answers: { intent: { type: 'choice', choice: 'purchase_advice' } } }) });
const quiet = { write() {} };

test('公式導入・一覧確認・実APIの順に完了し、秘密を報告しない', async () => {
  const calls = [];
  let output = '';
  const receipt = await setupTypeSafe({
    loadKey: async () => secret,
    execute: async (command, args) => { calls.push([command, args]); return success; },
    request: async (url, init) => {
      assert.equal(calls.length, 2);
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      assert.equal(JSON.parse(init.body).model, 'jev-latest');
      return apiSuccess();
    },
    output: { write: (text) => { output += text; } },
  });
  assert.deepEqual(calls[0], ['npx', ['--yes', 'skills', 'add', 'typesafe-ai/skills', '--skill', 'typesafe-ai', '--global', '--agent', 'codex', 'claude-code', 'cursor', 'grok', '--yes']]);
  assert.deepEqual(calls[1], ['npx', ['--yes', 'skills', 'list', '--global', '--json']]);
  assert.equal(receipt.state, 'ready');
  assert.equal((output + JSON.stringify(receipt)).includes(secret), false);
});

test('導入失敗または一覧不整合からAPI確認へ進まない', async () => {
  for (const [result, message] of [
    [{ ok: false, reason: 'exit', code: 3 }, 'TYPESAFE_INSTALL_FAILED'],
    [{ ok: true, stdout: 'invalid' }, 'TYPESAFE_LIST_INVALID'],
    [{ ok: true, stdout: '[]' }, 'TYPESAFE_SKILL_NOT_INSTALLED'],
  ]) {
    await assert.rejects(setupTypeSafe({ loadKey: async () => secret, execute: async () => result,
      request: async () => assert.fail('APIへ進んだ'), output: quiet }), new RegExp(message));
  }
});

test('無効キー・通信障害・誤分類・不正JSONは成功にしない', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401 }), /TYPESAFE_API_HTTP_401/u],
    [async () => { throw new Error(secret); }, /TYPESAFE_API_UNREACHABLE/u],
    [async () => ({ ok: true, json: async () => ({}) }), /TYPESAFE_API_SMOKE_FAILED/u],
    [async () => ({ ok: true, json: async () => { throw new Error(secret); } }), /TYPESAFE_API_INVALID_JSON/u],
  ];
  for (const [request, expected] of cases) {
    await assert.rejects(setupTypeSafe({ loadKey: async () => secret, execute: async () => success,
      request, output: quiet }), expected);
  }
});

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'typesafe-setup-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('キーは1Passwordの参照からだけ読み、端末にfileを作らない', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push([command, args, options.env.OP_SERVICE_ACCOUNT_TOKEN]);
    return { ok: true, stdout: secret };
  };
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(await loadTypeSafeKey({ home, env: {}, execute, platform }), secret);
  }
  assert.deepEqual(calls.map(([command, args]) => [command, args]),
    Array(3).fill(['op', ['read', '--no-newline', TYPESAFE_OP_REFERENCE]]));
  assert.match(TYPESAFE_OP_REFERENCE, /^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/credential$/u);
  await assert.rejects(stat(join(home, '.config', 'dotagents', 'credentials', 'typesafe')), { code: 'ENOENT' });
});

test('環境変数は明示指定として優先し、1Passwordを呼ばない', async (t) => {
  const home = await temporaryHome(t);
  assert.equal(await loadTypeSafeKey({ home, env: { TYPESAFE_API_KEY: ` ${secret} ` },
    execute: async () => assert.fail('1Passwordを呼んだ') }), secret);
});

test('main-serverの暗号化Service Accountはopの子の環境だけへ渡す', async (t) => {
  const home = await temporaryHome(t);
  await mkdir(dirname(serverServiceAccountPath(home)), { recursive: true });
  await writeFile(serverServiceAccountPath(home), 'ciphertext');
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push(command);
    if (command === 'systemd-creds') {
      assert.deepEqual(args, ['--user', '--refuse-null', '--name=op-service-account-token', 'decrypt', serverServiceAccountPath(home), '-']);
      return { ok: true, stdout: 'sa-token\n' };
    }
    assert.equal(options.env.OP_SERVICE_ACCOUNT_TOKEN, 'sa-token');
    return { ok: true, stdout: secret };
  };
  const env = {};
  assert.equal(await loadTypeSafeKey({ home, env, execute, platform: 'linux' }), secret);
  assert.deepEqual(calls, ['systemd-creds', 'op']);
  assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  // 既に渡されたService Accountは復号し直さない。
  calls.length = 0;
  const preset = async (command, args, options) => { calls.push(command); assert.equal(options.env.OP_SERVICE_ACCOUNT_TOKEN, 'given'); return { ok: true, stdout: secret }; };
  assert.equal(await loadTypeSafeKey({ home, env: { OP_SERVICE_ACCOUNT_TOKEN: 'given' }, execute: preset, platform: 'linux' }), secret);
  assert.deepEqual(calls, ['op']);
});

test('復号・読取の失敗と不正な値は名前で止まる', async (t) => {
  const home = await temporaryHome(t);
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute: async () => ({ ok: false }), platform: 'darwin' }), /TYPESAFE_OP_READ_FAILED/u);
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute: async () => ({ ok: true, stdout: 'a b' }), platform: 'darwin' }), /TYPESAFE_CREDENTIAL_INVALID/u);
  await mkdir(dirname(serverServiceAccountPath(home)), { recursive: true });
  await writeFile(serverServiceAccountPath(home), 'ciphertext');
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute: async () => ({ ok: false }), platform: 'linux' }), /TYPESAFE_SERVICE_ACCOUNT_DECRYPT_FAILED/u);
});
