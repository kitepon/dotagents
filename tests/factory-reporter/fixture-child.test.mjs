import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runFixtureChild } from './fixtures/child-process.mjs';

test('fixtureの実spawn失敗をrejectし、待受HTTP serverのfinally cleanupへ戻す', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-fixture-spawn-'));
  const server = createServer();
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let cleaned = false;
  await assert.rejects(async () => {
    try {
      await runFixtureChild('unused.mjs', [], { root }, {}, { executable: join(root, 'missing-node') });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      cleaned = true;
    }
  }, { code: 'ENOENT' });
  assert.equal(cleaned, true);
  assert.equal(server.listening, false);
});

test('fixtureの非0終了と診断JSONを成功へ読み替えず保持する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-fixture-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runFixtureChild('-e', [
    'console.log(JSON.stringify({ok:false,reason:"fixture_failure"})); console.error("original diagnostic"); process.exitCode=7;',
  ], { root });
  assert.deepEqual(result, { code: 7, json: { ok: false, reason: 'fixture_failure' }, stderr: 'original diagnostic\n' });
});
