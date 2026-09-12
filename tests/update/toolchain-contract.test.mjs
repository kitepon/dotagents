import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  compareSemver,
  parseGrokUpdateJson,
  parseNpmLatestJson,
  parseStrictSemver,
} from '../../lib/factory/toolchain-contract.mjs';

const CLI = resolve('bin/factory-toolchain-contract.mjs');
const GROK = {
  currentVersion: '0.2.99',
  latestVersion: '0.2.101',
  updateAvailable: true,
  installer: 'internal',
  channel: 'stable',
  autoUpdate: null,
  error: null,
};

function run(operation, input = '', args = []) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, operation, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('npm latestは単一のstrict semverを旧JSON stringとnpm 12配列から受理する', async () => {
  assert.equal(parseNpmLatestJson('"2.1.207"\n'), '2.1.207');
  for (const input of ['{"version":"2.1.207"}', 'latest=2.1.207', '[]', '["2.1.207","2.1.208"]', '[["2.1.207"]]', '[{"version":"2.1.207"}]', '"01.2.3"', '"unknown"', '"2.1.0-01"']) {
    assert.throws(() => parseNpmLatestJson(input));
    assert.equal((await run('npm-latest', input)).code, 1);
  }
  assert.deepEqual(await run('npm-latest', '"2.1.207"'), { code: 0, stdout: '2.1.207\n', stderr: '' });
  assert.equal(parseNpmLatestJson('["2.1.269"]\n'), '2.1.269');
  assert.deepEqual(await run('npm-latest', '["0.154.0"]'), { code: 0, stdout: '0.154.0\n', stderr: '' });
});

test('SemVer大小はprereleaseを含めてdowngrade判定できる', async () => {
  assert.equal(compareSemver('2.1.0', '2.1.0'), 0);
  assert.equal(compareSemver('2.1.0-beta.2', '2.1.0-beta.11'), -1);
  assert.equal(compareSemver('2.1.0', '2.1.0-rc.1'), 1);
  assert.equal(compareSemver('2.2.0', '2.1.99'), 1);
  assert.equal(parseStrictSemver('0.2.101').value, '0.2.101');
  assert.deepEqual(await run('compare', '', ['2.2.0', '2.1.99']), { code: 0, stdout: '1\n', stderr: '' });
});

test('Grok checkはactual stable internal schemaとversion flag整合だけを受理する', async () => {
  assert.deepEqual(parseGrokUpdateJson(JSON.stringify(GROK)), GROK);
  const current = { ...GROK, currentVersion: GROK.latestVersion, updateAvailable: false };
  assert.deepEqual(parseGrokUpdateJson(JSON.stringify(current), { postUpdate: true }), current);
  const invalid = [
    { ...GROK, installer: 'native' },
    { ...GROK, error: 'network' },
    { ...GROK, updateAvailable: false },
    { ...GROK, currentVersion: '0.2.102', latestVersion: '0.2.101', updateAvailable: false },
    { ...GROK, extra: true },
  ];
  for (const value of invalid) assert.throws(() => parseGrokUpdateJson(JSON.stringify(value)));
  assert.throws(() => parseGrokUpdateJson(JSON.stringify(GROK), { postUpdate: true }));
  assert.equal((await run('grok-check', JSON.stringify(GROK))).code, 0);
  assert.equal((await run('grok-post', JSON.stringify(GROK))).code, 1);
  assert.equal((await run('grok-post', JSON.stringify(current))).code, 0);
});
