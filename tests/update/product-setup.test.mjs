import test from 'node:test';
import assert from 'node:assert/strict';
import { setupOutcome, runProductSetup } from '../../lib/factory/product-setup.mjs';

const result = (value, code) => ({ ok: code === 0, code, stdout: JSON.stringify(value) });
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

test('gpt-connector自身の公開結果を記録し、対応OSを工場で再判定しない', () => {
  const value = { schema: 'gpt-connector.setup.v1', overall: 'partial', live: { supported: false } };
  assert.equal(setupOutcome('gpt-connector', result(value, 2), 'linux'), 'partial');
  assert.equal(setupOutcome('gpt-connector', result(value, 2), 'win32'), 'partial');
  assert.equal(setupOutcome('gpt-connector', result(value, 2), 'darwin'), 'partial');
  assert.equal(setupOutcome('gpt-connector', result({ overall: 'failed' }, 2), 'linux'), 'failed');
  assert.equal(setupOutcome('gpt-connector', result(value, 1), 'linux'), 'failed');
  assert.equal(setupOutcome('gpt-connector', { ok: false, reason: 'timeout', stdout: JSON.stringify(value) }, 'linux'), 'failed');
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
