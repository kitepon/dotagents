// 任務に合う子のハーネス×モデル×effortを、02の順位表と利用枠の現況を渡したJevに選ばせる。
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HARNESS_IDS = Object.freeze({ Codex: 'codex', 'Claude Code': 'claude-code', 'Grok Build': 'grok-build', Cursor: 'cursor' });

function tableRows(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`MODELS_SECTION_MISSING: ${heading}`);
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next < 0 ? undefined : next).split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/u.test(line))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

// 02の「役割」から、子へ渡せる役割（統括を除く）と説明を読む。
export function roles(markdown) {
  const start = markdown.indexOf('## 役割');
  const end = markdown.indexOf('\n## ', start + 1);
  const found = [...markdown.slice(start, end).matchAll(/^\d+\. \*\*(.+?)\*\* — (.+)$/gmu)]
    .map(([, name, description]) => ({ name, description }))
    .filter((role) => role.name !== '統括');
  if (start < 0 || found.length === 0) throw new Error('MODELS_ROLES_MISSING');
  return found;
}

// 02の「順位」と「諸元」から、使えるハーネス×モデル×effortの選択肢を作る。roleを渡すとその役割の候補だけにする。
export function modelOptions(markdown, role = null) {
  const harnessesByModel = new Map(tableRows(markdown, '諸元').map(([model, , harnesses, id]) => [
    model,
    { id: id.replaceAll('`', ''), harnesses: harnesses.split('/').map((name) => name.trim()) },
  ]));
  const candidates = new Map();
  for (const [rowRole, ...groups] of tableRows(markdown, '順位')) {
    if (role !== null && rowRole !== role) continue;
    for (const group of groups) {
      for (const raw of group.replace('（同格）', '').split('、')) {
        const text = raw.trim();
        if (!text || text === '—' || text === 'オーナー指定') continue;
        const [model, effort = null] = text.split('×');
        if (!harnessesByModel.has(model)) throw new Error(`MODELS_UNKNOWN_MODEL: ${model}（${rowRole}）`);
        candidates.set(`${model}×${effort}`, { model, effort });
      }
    }
  }
  const options = [];
  for (const { model, effort } of candidates.values()) {
    const spec = harnessesByModel.get(model);
    for (const harness of spec.harnesses) {
      if (!HARNESS_IDS[harness]) throw new Error(`MODELS_UNKNOWN_HARNESS: ${harness}`);
      options.push({ harness, harness_id: HARNESS_IDS[harness], model, model_id: spec.id, effort });
    }
  }
  if (options.length === 0) throw new Error('MODELS_NO_OPTIONS');
  return options;
}

async function latestRollout(directory) {
  let latest = null;
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const { mtimeMs } = await stat(child);
        if (latest === null || mtimeMs > latest.mtimeMs) latest = { path: child, mtimeMs };
      }
    }
  }
  await visit(directory);
  return latest?.path ?? null;
}

// Codexのセッション記録に残る最新の週次利用枠を読む。記録が無ければnull（未観測）。
export async function codexUsage({ codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), now = Date.now() } = {}) {
  const rollout = await latestRollout(join(codexHome, 'sessions'));
  if (rollout === null) return null;
  const lines = (await readFile(rollout, 'utf8')).split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    const primary = JSON.parse(line).payload?.rate_limits?.primary;
    if (!primary || typeof primary.used_percent !== 'number') continue;
    const windowMs = primary.window_minutes * 60_000;
    const resetMs = primary.resets_at * 1000;
    const evenPace = Math.min(100, Math.max(0, (100 * (now - (resetMs - windowMs))) / windowMs));
    return { used_percent: primary.used_percent, even_pace_percent: Number(evenPace.toFixed(1)), resets_at: new Date(resetMs).toISOString() };
  }
  return null;
}

export function closuresPath(env = process.env) {
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dotagents', 'harness-closures.json');
}

export async function readClosures(path, now = Date.now()) {
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return Object.fromEntries(Object.entries(data).filter(([, until]) => Date.parse(until) > now));
}

export async function recordClosure(path, harnessId, until, now = Date.now()) {
  if (!Object.values(HARNESS_IDS).includes(harnessId)) throw new Error(`UNKNOWN_HARNESS: ${harnessId}`);
  const time = Date.parse(until);
  if (!Number.isFinite(time)) throw new Error(`INVALID_UNTIL: ${until}`);
  const closures = { ...await readClosures(path, now), [harnessId]: new Date(time).toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(closures, null, 2)}\n`, 'utf8');
  return closures;
}

function situation({ task, closures, codex }) {
  const usage = codex === null
    ? 'Codexの週次利用枠: 未観測。'
    : `Codexの週次利用枠: 使用率${codex.used_percent}%、均等ペース${codex.even_pace_percent}%、リセット${codex.resets_at}。`;
  const closed = Object.keys(closures).length === 0
    ? '閉じているハーネス: なし。'
    : `閉じているハーネス（選択肢から除外済み）: ${Object.entries(closures).map(([id, until]) => `${id}（${until}まで）`).join('、')}。`;
  return `## 利用枠の現況\n\n${usage}\n${closed}\n\n## 任務\n\n${task}\n`;
}

export function roleRequest({ task, models, roleList }) {
  return {
    model: 'jev-latest',
    state: `${models}\n\n## 任務\n\n${task}\n`,
    questions: {
      role: {
        type: 'choice',
        instructions: '02の役割の定義に照らして、この任務を子に任せる時の役割を一つ選ぶ。',
        criteria: Object.fromEntries(roleList.map((role, index) => [`r${index + 1}`, `${role.name} — ${role.description}`])),
      },
    },
  };
}

export function pickRequest({ task, role, models, options, closures, codex }) {
  const criteria = Object.fromEntries(options.map((option, index) => [
    `o${index + 1}`,
    `${option.harness}で${option.model}${option.effort ? `×${option.effort}` : ''}を使う`,
  ]));
  return {
    model: 'jev-latest',
    state: `${models}\n\n${situation({ task, closures, codex })}\n役割: ${role}\n`,
    questions: {
      pick: {
        type: 'choice',
        instructions: `役割「${role}」の候補群を02の順位表の左から見る。閉じているハーネスしか無い候補群は飛ばす。同じ候補群に複数のモデルがあれば「同格候補のハーネス選択」の条件を上から判定し、一つ成立した時点で確定して以降を判定しない。示された選択肢から一つ選ぶ。`,
        criteria,
      },
    },
  };
}

async function ask(request, key, body, id) {
  let response;
  try {
    response = await request('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw new Error('JEV_UNREACHABLE'); }
  if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
  const answer = (await response.json()).answers?.[id];
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') throw new Error('JEV_INVALID_ANSWER');
  return answer;
}

export async function pickModel({ task, modelsPath, closures, codex, key, request = fetch }) {
  if (!task?.trim()) throw new Error('TASK_REQUIRED');
  const models = await readFile(modelsPath, 'utf8');
  const effectiveClosures = { ...closures, ...(codex !== null && codex.used_percent >= 100 ? { codex: codex.resets_at } : {}) };
  const roleList = roles(models);
  const roleAnswer = await ask(request, key, roleRequest({ task, models, roleList }), 'role');
  const role = roleList[Number(roleAnswer.choice.slice(1)) - 1];
  if (role === undefined) throw new Error('JEV_INVALID_ANSWER');
  const options = modelOptions(models, role.name).filter((option) => !(option.harness_id in effectiveClosures));
  if (options.length === 0) throw new Error(`NO_OPEN_HARNESS: ${role.name}`);
  const pickAnswer = await ask(request, key, pickRequest({ task, role: role.name, models, options, closures: effectiveClosures, codex }), 'pick');
  const option = options[Number(pickAnswer.choice.slice(1)) - 1];
  if (option === undefined) throw new Error('JEV_INVALID_ANSWER');
  return {
    task,
    role: role.name,
    harness: option.harness,
    model: option.model,
    model_id: option.model_id,
    effort: option.effort,
    confidence: { role: roleAnswer.confidence ?? null, pick: pickAnswer.confidence ?? null },
    closed: effectiveClosures,
    codex_usage: codex,
  };
}
