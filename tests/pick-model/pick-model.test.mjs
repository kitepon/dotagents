import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { codexUsage, modelOptions, pickModel, readClosures, recordClosure, roles } from '../../lib/pick-model.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS = join(ROOT, 'shared', 'runbooks', '02_models.md');

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pick-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function jev(answers) {
  const calls = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const id = Object.keys(body.questions)[0];
    return { ok: true, json: async () => ({ answers: { [id]: { type: 'choice', ...answers[id] } } }) };
  };
  return { calls, request };
}

test('02から統括以外の役割と、役割ごとの選択肢を読む', async () => {
  const models = await readFile(MODELS, 'utf8');
  const names = roles(models).map((role) => role.name);
  assert.ok(names.includes('反証'));
  assert.ok(!names.includes('統括'));
  const options = modelOptions(models, '反証');
  assert.ok(options.length > 0);
  assert.ok(options.every((option) => option.harness_id && option.model_id));
});

test('Codexの最新記録から週次利用枠を読み、記録が無ければ未観測にする', async (t) => {
  const home = await temp(t);
  assert.equal(await codexUsage({ codexHome: home }), null);
  const day = join(home, 'sessions', '2026', '09', '23');
  await mkdir(day, { recursive: true });
  const resetsAt = Date.parse('2026-09-26T00:00:00Z') / 1000;
  const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 60, window_minutes: 10080, resets_at: resetsAt } } } });
  await writeFile(join(day, 'rollout-a.jsonl'), `{"payload":{}}\n${line}\n`, 'utf8');
  const usage = await codexUsage({ codexHome: home, now: Date.parse('2026-09-22T12:00:00Z') });
  assert.equal(usage.used_percent, 60);
  assert.equal(usage.resets_at, '2026-09-26T00:00:00.000Z');
  assert.equal(usage.even_pace_percent, 50);
});

test('閉鎖の記録は期限切れで消え、未知のハーネスは拒否する', async (t) => {
  const path = join(await temp(t), 'closures.json');
  const now = Date.parse('2026-09-23T00:00:00Z');
  await recordClosure(path, 'claude-code', '2026-09-23T05:00:00Z', now);
  assert.deepEqual(Object.keys(await readClosures(path, now)), ['claude-code']);
  assert.deepEqual(await readClosures(path, Date.parse('2026-09-23T06:00:00Z')), {});
  await assert.rejects(recordClosure(path, 'unknown', '2026-09-24T00:00:00Z', now), /UNKNOWN_HARNESS/);
});

test('役割をJevに選ばせ、閉じたハーネスを除いた候補から選ばせる', async () => {
  const models = await readFile(MODELS, 'utf8');
  const roleIndex = roles(models).findIndex((role) => role.name === '反証');
  const { calls, request } = jev({ role: { choice: `r${roleIndex + 1}`, confidence: 0.9 }, pick: { choice: 'o1', confidence: 0.6 } });
  const codex = { used_percent: 100, even_pace_percent: 50, resets_at: '2026-09-26T00:00:00.000Z' };
  const result = await pickModel({ task: '主張を反証して', modelsPath: MODELS, closures: {}, codex, key: 'k', request });
  assert.equal(calls.length, 2);
  assert.equal(result.role, '反証');
  assert.equal(result.closed.codex, codex.resets_at);
  assert.doesNotMatch(JSON.stringify(calls[1].questions.pick.criteria), /Codexで/);
  assert.notEqual(result.harness, 'Codex');
});

test('Jevの失敗は別経路へ逃がさずエラーにする', async () => {
  const request = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    pickModel({ task: '任務', modelsPath: MODELS, closures: {}, codex: null, key: 'k', request }),
    /JEV_HTTP_503/,
  );
});
