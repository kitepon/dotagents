import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caveatUpdateOwner } from '../../lib/factory/caveat-update-owner.mjs';
import { setupOutcome, runProductSetup } from '../../lib/factory/product-setup.mjs';

const result = (value, code) => ({ ok: code === 0, code, stdout: JSON.stringify(value) });

test('Caveatの管理rootは版・pointer破損に関わらずnpm/initの所有を維持する', () => {
  const home = mkdtempSync(join(tmpdir(), 'caveat-update-owner-'));
  try {
    assert.equal(caveatUpdateOwner({ home }), 'factory');
    const parent = join(home, '.caveat-deploy');
    mkdirSync(parent);
    assert.equal(caveatUpdateOwner({ home }), 'factory');
    const root = join(parent, 'managed-v1');
    mkdirSync(root);
    assert.equal(caveatUpdateOwner({ home }), 'managed-v1');
    writeFileSync(join(root, 'active.json'), 'broken pointer');
    assert.equal(caveatUpdateOwner({ home }), 'managed-v1');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Caveat所有のsymlink・読取拒否・不正pathはlegacy writerを許可しない', () => {
  const directory = { isDirectory: () => true };
  assert.equal(caveatUpdateOwner({ inspect: () => ({ isDirectory: () => false }) }), 'unknown:deployment-parent');
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']) {
    for (const failedRead of [1, 2]) {
      let reads = 0;
      assert.equal(caveatUpdateOwner({ inspect: () => {
        if (++reads === failedRead) throw Object.assign(new Error('fixture'), { code });
        return directory;
      } }), `unknown:${code}`);
    }
  }
  let reads = 0;
  assert.equal(caveatUpdateOwner({ inspect: () => ++reads === 1 ? directory : { isSymbolicLink: () => true } }), 'managed-v1');
});
const lattice = (platform) => ({ schema: 'lattice.setup_result.v1', platform, state: 'partial',
  hosts: ['claude', 'codex', 'grok', 'cursor'].map((host) => ({ host, mcp: { state: 'verified' },
    hooks: host === 'grok' ? { state: 'unsupported', code: 'HOST_FEATURE_UNSUPPORTED' }
      : platform === 'win32' ? { state: 'unsupported', code: 'HOST_PLATFORM_UNSUPPORTED' }
        : { state: 'verified' } })) });

test('Lattice自身の公開結果を記録し、内部のhost別状態を工場で再集約しない', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const value = lattice(platform);
    assert.equal(setupOutcome('lattice', result(value, 1), platform), 'partial');
    value.hosts[0].mcp.state = 'failed';
    assert.equal(setupOutcome('lattice', result(value, 1), platform), 'partial');
    value.hosts[0].mcp.state = 'disabled';
    assert.equal(setupOutcome('lattice', result(value, 1), platform), 'partial');
    value.state = 'failed';
    assert.equal(setupOutcome('lattice', result(value, 1), platform), 'failed');
  }
});

test('廃止したgpt-connectorの導入入口は持たない', async () => {
  await assert.rejects(runProductSetup('gpt-connector', { execute: async () => result({}, 0), output: { write() {} } }), /未定義/u);
});

test('公開入口を一回呼び、失敗結果と工程を表示する', async () => {
  const calls = [];
  let text = '';
  const state = await runProductSetup('caveat', {
    execute: async (...args) => { calls.push(args); return { ok: false, code: 7, stdout: '公開された失敗\n', stderr: '' }; },
    output: { write: (value) => { text += value; } },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['caveat', ['init', '--sync', '--yes']]);
  assert.equal(state, 'failed');
  assert.match(text, /公開された失敗/u);
  assert.match(text, /code=7/u);
});
