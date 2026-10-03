import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { scanV9WithAcknowledgements } from '../../lib/factory/v9.mjs';

const EXITED = Object.freeze({ ok: false, code: 1, reason: 'exit', stdout: '', stderr: '' });
const ok = (value) => ({ ok: true, code: 0, reason: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const PROFILE = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'linux';

test('工場のscanはgpt-connectorの実行時エラーを読まず、ackも作らない', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-gpt-runtime-errors-'));
  const home = join(root, 'home');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const { report, acknowledgements } = await scanV9WithAcknowledgements({
    host: { id: 'test-host', profile: PROFILE }, cwd: root, arch: 'x64', platform: process.platform, home,
    collectionEnabled: true, toolchainLedgerPath: join(root, 'toolchain-ledger.json'),
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'git') return ok('abc1234\n');
      if (command === 'gpt-connector' && args[0] === 'factory-diagnostics') {
        return ok({ package_version: '1.2.3', overall: 'ready', state: { schema: 'state.v1', migration: 'current' }, checks: [] });
      }
      // 製品が自分でBugHubへ上げている記録。工場が読みに行けば、ここで見つかる。
      if (command === 'gpt-connector' && args[0] === 'runtime-errors') {
        return ok({ schema: 'gpt-connector.runtime-errors.v1', product: 'gpt-connector', version: '1.2.3', state_schema_version: '1.0',
          cursor: { high_watermark: 1, acknowledged_through: 0, next: 1 }, runtime_errors: [], resolutions: [],
          diagnostics: { collection: 'enabled', status: 'ready', total_count: 1, pending_count: 1, truncated: false } });
      }
      if (command === 'lattice' && args[0] === 'factory-diagnostics') return ok({ version: '1.2.3', overall: 'ok' });
      if (command === 'lattice' && args[0] === 'runtime-errors') {
        return ok({ schema: 'lattice.runtime_errors.v1', product: 'lattice', version: '1.2.3', state_schema_version: '1.0',
          cursor: { high_watermark: 0, acknowledged_through: 0, next: 0 }, runtime_errors: [], resolutions: [],
          diagnostics: { collection: 'enabled', status: 'ready', total_count: 0, pending_count: 0, truncated: false } });
      }
      return EXITED;
    },
  });
  validateReportV9(report);
  assert.deepEqual(calls.filter((line) => line.startsWith('gpt-connector ')), ['gpt-connector factory-diagnostics --json']);
  const product = report.products['gpt-connector'];
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '1.2.3');
  assert.equal(product.compatibility_status, 'compatible');
  assert.deepEqual(product.runtime_errors, []);
  assert.deepEqual(product.resolutions, []);
  assert.deepEqual(product.checks.filter((item) => item.check_id === 'runtime_errors'), []);
  assert.deepEqual(acknowledgements.acknowledgements.filter((item) => item.product === 'gpt-connector'), []);
});
