import assert from 'node:assert/strict';
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ack, fingerprint, mutate, snapshot, status } from '../../lib/factory/external-events.mjs';

const A = '2026-07-13T00:00:00.000Z';
const B = '2026-07-13T00:01:00.000Z';
const C = '2026-07-13T00:02:00.000Z';

async function box(t) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-external-events-'));
  const previous = process.env.FACTORY_REPORTER_STATE_DIR;
  process.env.FACTORY_REPORTER_STATE_DIR = dir;
  t.after(async () => { if (previous === undefined) delete process.env.FACTORY_REPORTER_STATE_DIR; else process.env.FACTORY_REPORTER_STATE_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  return { dir, state: join(dir, 'external-events.json'), lock: join(dir, 'external-events.lock') };
}

test('open→resolveはappend-onlyの二段phaseで、ack済み境界から最古phaseだけを返す', async (t) => {
  await box(t);
  const opened = await mutate('open', 'availability', 'unreachable', A);
  const repeated = await mutate('open', 'availability', 'unreachable', B);
  const resolved = await mutate('resolve', 'availability', 'unreachable', C);
  assert.equal(opened.sequence, 1); assert.equal(repeated.sequence, 2); assert.equal(resolved.sequence, 3);
  let page = await snapshot();
  assert.deepEqual(page.events.map(({ sequence, status: phase }) => [sequence, phase]), [[1, 'open']]);
  assert.equal(page.cursor.next, 1);
  await ack(1);
  page = await snapshot();
  assert.deepEqual(page.events.map(({ sequence, status: phase }) => [sequence, phase]), [[2, 'open']]);
  await ack(2);
  page = await snapshot();
  assert.deepEqual(page.events.map(({ sequence, status: phase }) => [sequence, phase]), [[3, 'resolved']]);
  await mutate('open', 'availability', 'unreachable', C);
  assert.equal((await status()).high_watermark, 4);
  await assert.rejects(mutate('resolve', 'availability', 'unreachable', B), /resolve_invalid/);
  assert.equal((await mutate('resolve', 'availability', 'unreachable', C)).sequence, 5);
});

test('snapshot後の新時刻open retryは新sequenceに隔離され、旧ackで失われない', async (t) => {
  await box(t);
  await mutate('open', 'availability', 'unreachable', A);
  assert.equal((await snapshot()).cursor.next, 1);
  assert.equal((await mutate('open', 'availability', 'unreachable', B)).sequence, 2);
  await ack(1);
  const page = await snapshot();
  assert.deepEqual(page.events.map(({ sequence, occurrence_count, last_seen }) => [sequence, occurrence_count, last_seen]), [[2, 2, B]]);
});

test('同一・古いopenは完全idempotentで、snapshot cursorを越えるackとsequence gapを拒否する', async (t) => {
  const state = await box(t);
  await mutate('open', 'availability', 'unreachable', B);
  await mutate('open', 'availability', 'unreachable', A);
  await mutate('open', 'availability', 'unreachable', B);
  const first = (await snapshot()).events[0];
  assert.deepEqual([first.last_seen, first.occurrence_count], [B, 1]);
  await mutate('resolve', 'availability', 'unreachable', C);
  await assert.rejects(ack(2), /cursor_invalid/);
  const value = JSON.parse(await readFile(state.state));
  value.events[1].sequence = 3;
  value.next = 4;
  await writeFile(state.state, JSON.stringify(value));
  await assert.rejects(snapshot(), /state_invalid/);
});

test('same fingerprint phaseの後ろにある別fingerprintをack cursorへ混ぜない', async (t) => {
  await box(t);
  await mutate('open', 'availability', 'unreachable', A); // 1
  await mutate('open', 'database', 'query_failed', A); // 2
  await mutate('resolve', 'availability', 'unreachable', B); // 3
  await mutate('open', 'schema', 'version_mismatch', A); // 4
  const page = await snapshot();
  assert.deepEqual(page.events.map((event) => event.sequence), [1, 2]);
  assert.equal(page.cursor.next, 2);
  await assert.rejects(ack(4), /cursor_invalid/);
});

test('check別の固定reason以外、非canonical日時、tamper、pathとsymlink stateをfail closedする', async (t) => {
  const state = await box(t);
  await assert.rejects(mutate('open', 'source_revision', 'delivery_failed', A), /arguments_invalid/);
  await assert.rejects(mutate('open', 'factory_ingest', 'disabled', A), /arguments_invalid/);
  await assert.rejects(mutate('open', 'availability', 'unreachable', '2026-07-13T00:00:00Z'), /arguments_invalid/);
  await mutate('open', 'availability', 'unreachable', A);
  const value = JSON.parse(await readFile(state.state));
  value.events[0].check = 'availability'; value.events[0].reason = 'unreachable'; value.events[0].fingerprint = fingerprint('availability', 'unreachable'); value.events[0].private_path = '/home/private';
  await writeFile(state.state, JSON.stringify(value));
  await assert.rejects(snapshot(), /state_invalid/);
  await rm(state.state);
  await symlink('/tmp', state.state);
  await assert.rejects(status(), /state_invalid/);
});

test('1MiBを超えるstate fileを読み込まない', async (t) => {
  const state = await box(t);
  await mutate('open', 'availability', 'unreachable', A);
  const value = await readFile(state.state, 'utf8');
  await writeFile(state.state, `${value}${' '.repeat(1024 * 1024)}`);
  await assert.rejects(snapshot(), /state_invalid/);
});

test('single lockはlive ownerを拒否し、crash lockを回収して0600/0700を維持する', async (t) => {
  const state = await box(t);
  await mkdir(state.dir, { recursive: true, mode: 0o700 });
  await writeFile(state.lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(status(), /state_locked/);
  await writeFile(state.lock, JSON.stringify({ pid: 999999 }), { mode: 0o600 });
  await mutate('open', 'availability', 'unreachable', A);
  const { mode: dirMode } = await (await import('node:fs/promises')).stat(state.dir);
  const { mode: fileMode } = await (await import('node:fs/promises')).stat(state.state);
  if (process.platform !== 'win32') {
    assert.equal(dirMode & 0o777, 0o700); assert.equal(fileMode & 0o777, 0o600);
  }
});

test('bounded retentionは未ack eventを捨てず、ack済みだけをpruneする', async (t) => {
  const state = await box(t);
  for (let index = 0; index < 128; index++) {
    const at = `2026-07-13T00:00:${String(index % 60).padStart(2, '0')}.000Z`;
    const [check, reason] = index % 2 ? ['schema', 'version_mismatch'] : ['database', 'query_failed'];
    await mutate('open', check, reason, at);
    await mutate('resolve', check, reason, '2026-07-13T00:01:00.000Z');
  }
  const data = JSON.parse(await readFile(state.state));
  assert.equal(data.events.length, 256);
  assert.equal(data.events[0].sequence, 1, '未ack eventを静かに失わない');
  await assert.rejects(mutate('open', 'availability', 'unreachable', C), /state_full/);
  while ((await snapshot()).events.length > 0) await ack((await snapshot()).cursor.next);
  await mutate('open', 'availability', 'unreachable', C);
  assert.ok(JSON.parse(await readFile(state.state)).events.length <= 256);
});


test('Windowsの一時的な置換拒否は同じbytesのrenameだけを再試行する', { skip: process.platform !== 'win32' }, async (t) => {
  await box(t);
  await mutate('open', 'availability', 'unreachable', A);
  const realRename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    return realRename(...args);
  });
  await mutate('resolve', 'availability', 'unreachable', B);
  assert.equal(attempts, 3);
  assert.equal((await status()).high_watermark, 2);
});

test('置換の恒久失敗は旧台帳を保ち、非Windowsでは再試行しない', async (t) => {
  const state = await box(t);
  await mutate('open', 'availability', 'unreachable', A);
  const before = await readFile(state.state);
  let attempts = 0;
  const mock = t.mock.method(fs, 'rename', async () => {
    attempts++;
    throw Object.assign(new Error('access denied'), { code: 'EPERM' });
  });
  await assert.rejects(mutate('resolve', 'availability', 'unreachable', B), { code: 'EPERM' });
  mock.mock.restore();
  assert.equal(attempts, process.platform === 'win32' ? 5 : 1);
  assert.deepEqual(await readFile(state.state), before);
  assert.deepEqual((await readdir(state.dir)).sort(), ['external-events.json']);
});
