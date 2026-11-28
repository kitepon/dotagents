import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { authRoutePath, moduleRequest, moduleSign } from '../../lib/factory/auth-module-http.mjs';

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'auth-module-http-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const reply = (result) => async (...call) => { reply.calls.push(call); return result; };
reply.calls = [];

test('端末はmain-serverの中継をsshで呼び、本文は標準入力で渡す（鍵・引数に本文を出さない）', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (...call) => { calls.push(call); return { ok: true, stdout: '{"accepted":true}', stderr: '' }; };
  const response = await moduleRequest('bughub-reporter-mac-kite', { execute, home, env: {}, platform: 'linux' })(
    'http://192.168.1.2:39310/api/factory/v9/reports?a=b', { method: 'POST', body: '{"x":1}', headers: { authorization: 'Bearer NOT-SENT', 'x-factory-sent-at': '2026-11-28T07:00:00.123Z' } });
  assert.deepEqual([response.ok, response.status, await response.json()], [true, 200, { accepted: true }]);
  const [command, args, options] = calls[0];
  assert.equal(command, 'ssh');
  assert.deepEqual(args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'kite@192.168.1.2']);
  assert.equal(args[5], "'sh' '/home/kite/Developer/dotagents/bin/factory-relay-http.sh' 'bughub-reporter-mac-kite' 'POST' '/api/factory/v9/reports?a=b' '2026-11-28T07:00:00.123Z'");
  assert.equal(options.input, '{"x":1}');
  assert.equal(JSON.stringify(calls).includes('NOT-SENT'), false);
});

test('経路fileがlocalならこの端末の中継scriptを直接走らせる', async (t) => {
  const home = await temporaryHome(t);
  await mkdir(dirname(authRoutePath(home)), { recursive: true });
  await writeFile(authRoutePath(home), 'local\n');
  const calls = [];
  const execute = async (...call) => { calls.push(call); return { ok: true, stdout: '{}', stderr: '' }; };
  await moduleRequest('typesafe', { execute, home, env: {}, platform: 'linux' })('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: '{}' });
  assert.equal(calls[0][0], 'sh');
  assert.match(calls[0][1][0], /bin\/factory-relay-http\.sh$/u);
  assert.deepEqual(calls[0][1].slice(1), ['typesafe', 'POST', '/v1/systemone']);
});

test('Windowsの端末は標準のOpenSSH（名前付きpipeのagentが使える）を使う', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (...call) => { calls.push(call); return { ok: true, stdout: '{}', stderr: '' }; };
  await moduleRequest('bughub-reporter-mac-kite', { execute, home, env: { SystemRoot: 'C:\\Windows' }, platform: 'win32' })('http://x/a', { method: 'POST', body: '{}' });
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
});

test('4xxはstderrのHTTP codeを返し、拒否・不達は到達不能として投げる', async (t) => {
  const home = await temporaryHome(t);
  const answer = (result) => moduleRequest('bughub-reporter-mac-kite', { execute: async () => result, home, env: {}, platform: 'linux' })('http://x/a', { method: 'POST', body: '{}' });
  const conflict = await answer({ ok: false, code: 22, stdout: '{"error":"x"}', stderr: 'HTTP 409\n' });
  assert.deepEqual([conflict.ok, conflict.status], [false, 409]);
  const partial = await answer({ ok: true, stdout: '{}', stderr: 'HTTP 202\n' });
  assert.equal(partial.status, 202);
  for (const result of [{ ok: false, code: 1, stdout: '', stderr: 'Refused.\n' }, { ok: false, reason: 'timeout', stdout: '', stderr: '' }]) {
    await assert.rejects(answer(result), /AUTH_MODULE_UNREACHABLE/u);
  }
});

test('moduleSignはsshで署名中継を呼び、base64の署名を小文字hexで返す', async (t) => {
  const home = await temporaryHome(t);
  const calls = [];
  const execute = async (...call) => { calls.push(call); return { ok: true, stdout: Buffer.from('abc').toString('base64') + '\n', stderr: '' }; };
  assert.equal(await moduleSign('bughub-product-dotagents-rabbit', '1790000000\nabcd', { execute, home, env: {}, platform: 'linux' }), '616263');
  assert.equal(calls[0][1].at(-1), "'sh' '/home/kite/Developer/dotagents/bin/factory-relay-sign.sh' 'bughub-product-dotagents-rabbit'");
  assert.equal(calls[0][2].input, '1790000000\nabcd');
  for (const result of [{ ok: false, code: 1, stdout: '', stderr: 'Refused.\n' }, { ok: true, stdout: 'not base64!', stderr: '' }]) {
    await assert.rejects(moduleSign('bughub-product-dotagents-rabbit', 'x', { execute: async () => result, home, env: {}, platform: 'linux' }), /AUTH_MODULE_UNREACHABLE/u);
  }
});
