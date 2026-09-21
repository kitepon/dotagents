import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupJevProduct } from '../../lib/factory/jev-setup.mjs';
import { jevProduct } from '../../lib/factory/v9.mjs';

const quiet = { write() {} };
const ok = { ok: true, stdout: '' };
async function homeFor(t) { const home = await mkdtemp(join(tmpdir(), 'jev-setup-')); t.after(() => rm(home, { recursive: true, force: true })); return home; }

test('ブラウザは公式cloneとlock付きuv導入だけを行い、GUIを起動しない', async (t) => {
  const home = await homeFor(t); const calls = [];
  const result = await setupJevProduct('jev-ultrafast', { home, platform: 'win32', output: quiet,
    execute: async (cmd, args, options) => { calls.push({ cmd, args, options }); return ok; } });
  assert.equal(result.state, 'installed');
  assert.deepEqual(calls[0].args, ['clone', 'https://github.com/browser-use/jev-ultrafast.git', join(home, 'Developer', 'jev-ultrafast')]);
  assert.deepEqual(calls[1].args, ['sync', '--locked']);
  assert.deepEqual(calls.map(({ cmd }) => cmd), ['git', 'uv', 'git']);
  assert.equal(calls.some(({ args }) => args.includes('--goal') || args.includes('jev')), false);
});

test('既存checkoutは公式originとdirtyを確認し、ff-onlyで最新版を取得する', async (t) => {
  const home = await homeFor(t); await mkdir(join(home, 'Developer', 'jev-ultrafast'), { recursive: true });
  const calls = [];
  const execute = async (cmd, args) => { calls.push(args); return { ...ok, stdout: args[0] === 'remote' ? 'https://github.com/browser-use/jev-ultrafast.git' : '' }; };
  await setupJevProduct('jev-ultrafast', { home, execute, output: quiet });
  assert.deepEqual(calls[2], ['pull', '--ff-only', 'origin', 'main']);
  assert.equal(calls.some((args) => args.includes('reset') || args.includes('checkout')), false);
  await assert.rejects(setupJevProduct('jev-ultrafast', { home, output: quiet, execute: async (cmd, args) => ({ ...ok, stdout: args[0] === 'remote' ? 'https://github.com/browser-use/jev-ultrafast.git' : ' M changed.py' }) }), /CHECKOUT_DIRTY/);
});

test('デスクトップはMacだけ、npm latestと上流Skillを導入する', async (t) => {
  const home = await homeFor(t); const calls = [];
  const execute = async (cmd, args) => { calls.push([cmd, args]); return ok; };
  for (const platform of ['win32', 'linux']) {
    assert.equal((await setupJevProduct('agent-desktop', { home, platform, execute, output: quiet })).state, 'unsupported');
  }
  assert.equal(calls.length, 0);
  await setupJevProduct('agent-desktop', { home, platform: 'darwin', execute, output: quiet });
  assert.ok(calls.some(([cmd, args]) => cmd === 'npm' && args.includes('agent-desktop@latest')));
  assert.ok(calls.some(([cmd, args]) => cmd === 'npx' && args.includes('jev-desktop')));
  assert.equal(JSON.stringify(calls).includes('0.4.7'), false);
});

test('導入失敗を停止として返し、別版や別経路へ切り替えない', async (t) => {
  const home = await homeFor(t); const calls = [];
  await assert.rejects(setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet,
    execute: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'npm' ? { ok: false, code: 1, stdout: '秘密', stderr: '秘密' } : ok; } }), (error) => /JEV_INSTALL_FAILED/.test(error.message) && !error.message.includes('秘密'));
  assert.deepEqual(calls.map(([cmd]) => cmd), ['git', 'npm']);
});

test('公開probeはOS未対応と導入済みを区別し、GUIの成功を推測しない', async () => {
  assert.equal((await jevProduct('agent-desktop', { platform: 'win32', runCommand: () => assert.fail('呼出し禁止') })).compatibility_status, 'unsupported');
  const result = await jevProduct('agent-desktop', { platform: 'darwin', runCommand: async (cmd) => ({ ok: true, stdout: cmd === 'git' ? 'a'.repeat(40) : 'agent-desktop 0.9.2\n' }) });
  assert.equal(result.installed_version, '0.9.2');
  assert.equal(result.compatibility_status, 'unverified');
  assert.equal(result.source_revision, undefined);
  assert.deepEqual(result.checks[1], { check_id: 'gui_runtime', status: 'skipped', reason_code: 'on_demand_only' });
});
