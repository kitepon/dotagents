import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultToolchainLedgerPath, readToolchainLedger } from '../../lib/factory/toolchain-ledger.mjs';

const unavailable = { value: null, error: 'toolchain_ledger_unavailable' };
const record = () => ({ before_version: null, latest_version: '01.2.3-a..b+build', after_version: '1.2.3',
  operation_status: 'success', post_gate_status: 'pending', reason_code: 'updated', observed_at: '2026-11-03T00:00:00.000Z' });
const ledger = () => ({ schema_version: 'dotagents.toolchain-update.v1', products: { 'claude-code': record() } });

test('reader retains accepted values and rejects malformed input without changing bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ledger.json');
  for (const value of [ledger(), { schema_version: 'dotagents.toolchain-update.v1', products: {} },
    ...['success', 'failed', 'skipped', 'pending'].map((status) => {
      const value = ledger(); value.products['claude-code'].operation_status = status;
      value.products['claude-code'].post_gate_status = status; return value;
    })]) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    assert.deepEqual(await readToolchainLedger(file), { value, error: null });
  }
  const mutations = [
    (x) => { x.extra = true; }, (x) => { x.schema_version = 'unknown'; },
    (x) => { x.products = []; }, (x) => { x.products.other = record(); },
    (x) => { x.products['claude-code'].extra = true; },
    (x) => { delete x.products['claude-code'].after_version; },
    (x) => { x.products['claude-code'].after_version = ['1.2.3']; },
    (x) => { x.products['claude-code'].before_version = 123; },
    (x) => { x.products['claude-code'].latest_version = 'text'; },
    (x) => { x.products['claude-code'].operation_status = 'unknown'; },
    (x) => { x.products['claude-code'].post_gate_status = 'unknown'; },
    (x) => { x.products['claude-code'].reason_code = 'unknown'; },
    (x) => { x.products['claude-code'].observed_at = '2026-11-03T00:00:00Z'; },
    (x) => { x.products['claude-code'].observed_at = 'invalid'; },
  ];
  const invalid = ['{broken', 'null', '[]', ...mutations.map((mutate) => {
    const value = ledger(); mutate(value); return JSON.stringify(value);
  })];
  for (const bytes of invalid) {
    await writeFile(file, bytes);
    assert.deepEqual(await readToolchainLedger(file), unavailable, bytes);
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
  await writeFile(file, ' '.repeat(1024 * 1024 + 1));
  assert.deepEqual(await readToolchainLedger(file), unavailable);
  assert.deepEqual(await readToolchainLedger(root), unavailable);
  assert.deepEqual(await readToolchainLedger(join(root, 'missing')), unavailable);
});

test('reader rejects symlinks and public POSIX permissions', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-reader-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ledger.json'); const link = join(root, 'link.json');
  await writeFile(file, JSON.stringify(ledger()), { mode: 0o600 });
  await symlink(file, link);
  assert.deepEqual(await readToolchainLedger(link), unavailable);
  await chmod(file, 0o640);
  assert.deepEqual(await readToolchainLedger(file), unavailable);
});

test('default paths resolve the environment at call time', (t) => {
  const keys = ['LOCALAPPDATA', 'USERPROFILE', 'XDG_STATE_HOME', 'HOME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  const root = join(tmpdir(), 'ledger-path-fixture');
  process.env.XDG_STATE_HOME = join(root, 'state-one');
  assert.equal(defaultToolchainLedgerPath('linux'), join(root, 'state-one', 'agents-update', 'toolchain-ledger.json'));
  process.env.XDG_STATE_HOME = join(root, 'state-two');
  assert.equal(defaultToolchainLedgerPath('darwin'), join(root, 'state-two', 'agents-update', 'toolchain-ledger.json'));
  delete process.env.XDG_STATE_HOME; process.env.HOME = root;
  assert.equal(defaultToolchainLedgerPath('linux'), join(root, '.local', 'state', 'agents-update', 'toolchain-ledger.json'));
  process.env.LOCALAPPDATA = join(root, 'local');
  assert.equal(defaultToolchainLedgerPath('win32'), join(root, 'local', 'dotagents', 'agents-update', 'toolchain-ledger.json'));
  delete process.env.LOCALAPPDATA; process.env.USERPROFILE = root;
  assert.equal(defaultToolchainLedgerPath('win32'), join(root, 'AppData', 'Local', 'dotagents', 'agents-update', 'toolchain-ledger.json'));
});
