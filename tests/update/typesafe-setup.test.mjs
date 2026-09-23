import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

test('未配布端末はSSHで受け取り、次回は保存済みキーを使う', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (...args) => {
    calls.push(args);
    return { ok: true, stdout: `TYPESAFE_API_KEY=${secret}\n` };
  };
  assert.equal(await loadTypeSafeKey({ home, env: {}, execute, platform: 'linux' }), secret);
  assert.deepEqual(calls[0].slice(0, 2), ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    'kite@192.168.1.2', 'cat .config/dotagents/credentials/typesafe/api.env']]);
  assert.equal(await loadTypeSafeKey({ home, env: {}, execute }), secret);
  assert.equal(calls.length, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(typeSafeKeyPath(home))).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(typeSafeKeyPath(home)))).mode & 0o777, 0o700);
  }
});

test('環境変数は明示指定として優先し、不正な保存済みキーは転送で隠さない', async (t) => {
  const home = await temporaryHome(t);
  const execute = async () => assert.fail('転送へ進んだ');
  assert.equal(await loadTypeSafeKey({ home, env: { TYPESAFE_API_KEY: secret }, execute }), secret);
  await mkdir(dirname(typeSafeKeyPath(home)), { recursive: true });
  await writeFile(typeSafeKeyPath(home), 'OTHER=value');
  await assert.rejects(loadTypeSafeKey({ home, env: {}, execute }), /TYPESAFE_CREDENTIAL_READ_FAILED/u);
});

test('転送失敗と不正な内容ではキーを保存しない', async (t) => {
  const home = await temporaryHome(t);
  for (const result of [{ ok: false, stdout: secret }, { ok: true, stdout: 'OTHER=value' }]) {
    await assert.rejects(loadTypeSafeKey({ home, env: {}, execute: async () => result }), /TYPESAFE_CREDENTIAL_/u);
    await assert.rejects(readFile(typeSafeKeyPath(home)), { code: 'ENOENT' });
  }
});

test('Windowsではキー書込前に所有者ACLを適用し、失敗時は保存しない', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const gitSsh = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
  const execute = async (command, args, options) => {
    calls.push(command);
    if (command === gitSsh) return { ok: true, stdout: `TYPESAFE_API_KEY=${secret}\n` };
    assert.equal(command, 'pwsh.exe');
    assert.equal(options.env.DOTAGENTS_FACTORY_ACL_TARGET, dirname(typeSafeKeyPath(home)));
    assert.match(args.at(-1), /SetAccessRuleProtection/u);
    await assert.rejects(readFile(typeSafeKeyPath(home)), { code: 'ENOENT' });
    return { ok: false };
  };
  await assert.rejects(loadTypeSafeKey({ home, env: { ProgramFiles: 'C:\\Program Files' }, execute, platform: 'win32' }), /TYPESAFE_CREDENTIAL_ACL_FAILED/u);
  assert.deepEqual(calls, [gitSsh, 'pwsh.exe']);
  await assert.rejects(readFile(typeSafeKeyPath(home)), { code: 'ENOENT' });
});
