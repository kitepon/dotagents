import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setupTypeSafe } from '../../lib/factory/typesafe-setup.mjs';
import { loadTypeSafeKey, typeSafeKeyPath } from '../../lib/factory/typesafe-credentials.mjs';

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

test('端末に鍵が無ければABSENTで止まり、鍵を端末へ写す経路を持たない', async (t) => {
  const home = await temporaryHome(t);
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute: async () => assert.fail('外部commandへ進んだ') }), /TYPESAFE_CREDENTIAL_ABSENT/u);
  await assert.rejects(readFile(typeSafeKeyPath(home)), { code: 'ENOENT' });
});

test('鍵が無い端末のsetupは認証仲介の品目`typesafe`で実API確認まで進む', async () => {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push([command, args]);
    if (command === 'ssh') {
      assert.equal(args.at(-1).startsWith("'sh' '/home/kite/Developer/dotagents/bin/factory-relay-http.sh' 'typesafe' 'POST' '/v1/systemone'"), true);
      assert.match(options.input, /purchase_advice/u);
      return { ok: true, stdout: JSON.stringify({ answers: { intent: { type: 'choice', choice: 'purchase_advice' } } }), stderr: 'HTTP 200\n' };
    }
    return success;
  };
  const receipt = await setupTypeSafe({ loadKey: async () => { throw new Error('TYPESAFE_CREDENTIAL_ABSENT'); }, execute, env: {}, output: quiet });
  assert.deepEqual(receipt, { schema: 'dotagents.typesafe-setup.v1', installed: true, state: 'ready' });
  assert.equal(calls.filter(([command]) => command === 'ssh').length, 1);
});

test('環境変数は明示指定として優先し、不正な保存済みキーは別経路で隠さない', async (t) => {
  const home = await temporaryHome(t);
  const execute = async () => assert.fail('外部commandへ進んだ');
  assert.equal(await loadTypeSafeKey({ home, env: { TYPESAFE_API_KEY: secret }, execute }), secret);
  await mkdir(dirname(typeSafeKeyPath(home)), { recursive: true });
  await writeFile(typeSafeKeyPath(home), 'OTHER=value');
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute }), /TYPESAFE_CREDENTIAL_READ_FAILED/u);
});

const reference = 'op://vault/item/credential';

test('envかapi.envの値がop://参照の時だけ1Passwordから読み、平文はopを呼ばない', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (command, args) => { calls.push([command, args]); return { ok: true, stdout: `${secret}\n` }; };
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(await loadTypeSafeKey({ home, env: { TYPESAFE_API_KEY: reference, OP_SERVICE_ACCOUNT_TOKEN: 'sa' }, execute, platform }), secret);
  }
  await mkdir(dirname(typeSafeKeyPath(home)), { recursive: true });
  await writeFile(typeSafeKeyPath(home), `TYPESAFE_API_KEY=${reference}\n`);
  assert.equal(await loadTypeSafeKey({ home, env: { OP_SERVICE_ACCOUNT_TOKEN: 'sa' }, execute, platform: 'darwin' }), secret);
  assert.deepEqual(calls, Array(4).fill(['op', ['read', '--no-newline', reference]]));
  await writeFile(typeSafeKeyPath(home), `TYPESAFE_API_KEY=${secret}\n`);
  assert.equal(await loadTypeSafeKey({ home, env: {}, execute: async () => assert.fail('opを呼んだ') }), secret);
});

test('参照の読取失敗と空の値はTYPESAFE_の名前で止まる', async (t) => {
  const home = await temporaryHome(t);
  const env = { TYPESAFE_API_KEY: reference, OP_SERVICE_ACCOUNT_TOKEN: 'given' };
  await assert.rejects(loadTypeSafeKey({ home, env, execute: async () => ({ ok: false }), platform: 'darwin' }), /TYPESAFE_OP_READ_FAILED/u);
  await assert.rejects(loadTypeSafeKey({ home, env, execute: async () => ({ ok: true, stdout: ' ' }), platform: 'darwin' }), /TYPESAFE_OP_READ_EMPTY/u);
});
