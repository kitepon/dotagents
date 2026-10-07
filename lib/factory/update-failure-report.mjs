// 定期更新（agents-update）の失敗を、dotagentsが自分の名前でBugHubへ報告する。
// 届け先は1つで、製品ごとに振り分けない。載せるのは失敗した手順の名前と回数・時刻だけで、
// 製品が返したエラーの中身は扱わない（オーナー裁定 K-DNC248・K-N4QYA4）。
// 送る形はBugHubの製品報告の契約（bughub/PRODUCT_REPORTING.md）に従う。
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PRODUCT_ID = 'dotagents';
export const ERROR_CODE = 'UPDATE_STEP_FAILED';
// BugHubの一覧と通知の題名はmessage_templateになる。どの手順かを題名で読めるよう、手順の名前を入れる。
export const messageTemplate = (step) => `dotagents update step failed: ${step}`;
// 重大度は手順の名前や累計の回数で決めず、次の定期更新の再試行で直ったかで決める（BugHubのbughub/NETWORK_REPORTING.md）。
// 1回目は原因（通信・製品・端末）が未確定で、次の回が同じ手順をやり直す。再試行でも直らなければ人の手が要る。
// 製品が動くかどうかは、工場のreportが製品の診断として別に運ぶ。
const SEVERITY_FIRST_FAILURE = 'warn';
const SEVERITY_RETRY_FAILED = 'high';
const RESOLUTION_REASON = 'recovered';
const STATE_SCHEMA = 'dotagents.update_failures.v1';
const SETTINGS_SCHEMA = 'dotagents.update_failure_reporting.v1';
// BugHubのcomponent（stableId）と同じ形。手順の名前はこの形でしか受けない。
const STEP = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION = /^0\.0\.0\+[0-9a-z]{1,64}$/u;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const OUTCOME = /^[a-z0-9_]{1,64}$/u;
const RECORD_KEYS = ['first_seen', 'last_seen', 'occurrence_count', 'product_version', 'resolution_unsent', 'resolved_at', 'status'];
// 重大度を持たないのは、どの失敗もhighで送っていた頃の記録。送った値を変えないため、読む時はhighとして扱う。
const RECORD_KEYS_WITH_SEVERITY = [...RECORD_KEYS, 'severity'].sort();
const recordSeverity = (record) => record.severity ?? SEVERITY_RETRY_FAILED;
const STATE_KEYS = ['last_accepted_at', 'last_attempt_at', 'last_outcome', 'records', 'schema', 'unsent'];

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join() === keys.join();
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableTime = (value) => value === null || validTime(value);
// 端末の時計が戻っても、記録の時刻は前へ戻さない（ISO 8601のUTCは文字列の順が時刻の順）。
const later = (left, right) => (left > right ? left : right);

/** 記録・設定・合鍵の置き場。合鍵の場所はBugHubの契約が決めている。 */
export function updateFailurePaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return {
      state: join(local, 'dotagents', 'update-failures.json'),
      settings: join(local, 'dotagents', 'update-failure-reporting.json'),
      credential: join(local, 'bughub', 'product-credentials', `${PRODUCT_ID}.json`),
    };
  }
  return {
    state: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'dotagents', 'update-failures.json'),
    settings: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'dotagents', 'update-failure-reporting.json'),
    credential: join(home, '.config', 'bughub', 'product-credentials', `${PRODUCT_ID}.json`),
  };
}

export const validStep = (value) => typeof value === 'string' && STEP.test(value);

/** dotagentsにはSemVerの版が無い。配っているrevisionをbuild metadataに載せる。 */
export const versionFromRevision = (revision) => `0.0.0+${/^[0-9a-f]{7,64}$/u.test(revision ?? '') ? revision : 'unknown'}`;

export const stepFingerprint = (step) => createHash('sha256')
  .update([PRODUCT_ID, step, ERROR_CODE, messageTemplate(step)].join('\0')).digest('hex');

export function emptyState() {
  return { schema: STATE_SCHEMA, records: {}, unsent: false, last_attempt_at: null, last_outcome: null, last_accepted_at: null };
}

function validateRecord(record) {
  return (exact(record, RECORD_KEYS) || (exact(record, RECORD_KEYS_WITH_SEVERITY) && [SEVERITY_FIRST_FAILURE, SEVERITY_RETRY_FAILED].includes(record.severity)))
    && Number.isSafeInteger(record.occurrence_count) && record.occurrence_count >= 1
    && validTime(record.first_seen) && validTime(record.last_seen) && record.first_seen <= record.last_seen
    && VERSION.test(record.product_version) && typeof record.resolution_unsent === 'boolean'
    && (record.status === 'open'
      ? record.resolved_at === null && record.resolution_unsent === false
      : record.status === 'resolved' && validTime(record.resolved_at) && record.resolved_at >= record.last_seen);
}

function validateState(value) {
  if (!exact(value, STATE_KEYS) || value.schema !== STATE_SCHEMA || !plain(value.records) || typeof value.unsent !== 'boolean'
    || !nullableTime(value.last_attempt_at) || !nullableTime(value.last_accepted_at)
    || !(value.last_outcome === null || (typeof value.last_outcome === 'string' && OUTCOME.test(value.last_outcome)))) {
    throw new Error('state_invalid');
  }
  for (const [step, record] of Object.entries(value.records)) {
    if (!validStep(step) || !validateRecord(record)) throw new Error('state_invalid');
  }
  return value;
}

async function regularFile(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('path_unsafe');
  return info;
}

/** 壊れた記録は上書きしない。読めない時は失敗にして、人が見られる形で残す。 */
export async function readState(path) {
  if (!(await regularFile(path))) return emptyState();
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('state_invalid'); }
  return validateState(value);
}

async function writeOwnerOnly(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('path_unsafe');
  await regularFile(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export const writeState = (path, state) => writeOwnerOnly(path, validateState(state));

/**
 * 1回の定期更新の結果を記録へ反映する。
 * - 失敗した手順: 回数を1つ足し、未解決にする（解決済みだった手順は再発として開き直す）。
 *   前の回も失敗していた手順（未解決のまま）は、再試行でも直らなかったものとして重大度を上げる。
 * - 動いて成功した手順: 未解決だったものを解決済みにする。今回動かなかった手順には触れない。
 */
export function applyRun(state, { ran, failed, now, version }) {
  const next = structuredClone(state);
  const failedSteps = new Set(failed);
  let changed = false;
  for (const step of failedSteps) {
    const record = next.records[step];
    next.records[step] = {
      occurrence_count: (record?.occurrence_count ?? 0) + 1,
      first_seen: record?.first_seen ?? now,
      last_seen: record ? later(now, record.resolved_at ?? record.last_seen) : now,
      status: 'open',
      resolved_at: null,
      resolution_unsent: false,
      product_version: version,
      severity: record?.status === 'open' ? SEVERITY_RETRY_FAILED : SEVERITY_FIRST_FAILURE,
    };
    changed = true;
  }
  for (const step of new Set(ran)) {
    const record = next.records[step];
    if (failedSteps.has(step) || record?.status !== 'open') continue;
    next.records[step] = { ...record, status: 'resolved', resolved_at: later(now, record.last_seen), resolution_unsent: true };
    changed = true;
  }
  if (changed) next.unsent = true;
  return next;
}

/** 未解決の手順は毎回載せる（回数は累計）。解決済みは、BugHubが受け取るまで載せる。 */
export function buildReport(state, { observedAt, version, reportId = randomUUID() }) {
  const runtimeErrors = [];
  const resolutions = [];
  for (const step of Object.keys(state.records).sort()) {
    const record = state.records[step];
    if (record.status !== 'open' && !record.resolution_unsent) continue;
    const fingerprint = stepFingerprint(step);
    runtimeErrors.push({
      fingerprint,
      error_code: ERROR_CODE,
      component: step,
      message_template: messageTemplate(step),
      severity: recordSeverity(record),
      status: record.status,
      occurrence_count: record.occurrence_count,
      first_seen: record.first_seen,
      last_seen: record.last_seen,
      product_version: record.product_version,
    });
    if (record.status === 'resolved') resolutions.push({ fingerprint, resolved_at: record.resolved_at, reason_code: RESOLUTION_REASON });
  }
  return {
    schema_version: '1.0',
    report_id: reportId,
    product_id: PRODUCT_ID,
    installed_version: version,
    observed_at: observedAt,
    runtime_errors: runtimeErrors,
    resolutions,
  };
}

/** BugHubが受け取った後の記録。送った解決は、もう載せない。 */
export function markAccepted(state, report, acceptedAt) {
  const next = structuredClone(state);
  const delivered = new Map(report.resolutions.map((item) => [item.fingerprint, item.resolved_at]));
  for (const [step, record] of Object.entries(next.records)) {
    if (record.status === 'resolved' && delivered.get(stepFingerprint(step)) === record.resolved_at) record.resolution_unsent = false;
  }
  next.unsent = false;
  next.last_attempt_at = acceptedAt;
  next.last_accepted_at = acceptedAt;
  next.last_outcome = 'accepted';
  return next;
}

export function markFailed(state, outcome, attemptedAt) {
  return { ...structuredClone(state), last_attempt_at: attemptedAt, last_outcome: OUTCOME.test(outcome) ? outcome : 'failed' };
}

const hmac = (secret, text) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(text).digest('hex');

/** 署名するのは、tsと、実際に送るバイト列のSHA-256。 */
export function requestSignature(secret, ts, bodyBytes) {
  return hmac(secret, `${ts}\n${createHash('sha256').update(bodyBytes).digest('hex')}`);
}

export const responseSignature = (secret, reportId, receivedAt) => hmac(secret, `${reportId}\n${receivedAt}`);

function sameSignature(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 合鍵を読む。本人だけが読める通常のファイルでなければ使わない。
 * WindowsはACLを確かめない（通常のファイルで、リンクでないことだけを見る）。
 */
export async function readCredential(path, platform = process.platform) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return { status: 'credential_missing' }; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) return { status: 'credential_unsafe' };
  if (platform !== 'win32' && ((info.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    return { status: 'credential_unsafe' };
  }
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return { status: 'credential_invalid' }; }
  if (!exact(value, ['key_id', 'secret', 'url']) || typeof value.key_id !== 'string' || !KEY_ID.test(value.key_id)
    || typeof value.secret !== 'string' || value.secret.length < 16 || value.secret.length > 1024
    || typeof value.url !== 'string' || !URL.canParse(value.url) || !['http:', 'https:'].includes(new URL(value.url).protocol)) {
    return { status: 'credential_invalid' };
  }
  return { status: 'ready', url: value.url, key_id: value.key_id, secret: value.secret };
}

/** 送信は、端末で明示して有効にした時だけ。設定が無ければ送らない。 */
export async function readSettings(path) {
  if (!(await regularFile(path))) return { enabled: false };
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('settings_invalid'); }
  if (!exact(value, ['enabled', 'schema']) || value.schema !== SETTINGS_SCHEMA || typeof value.enabled !== 'boolean') throw new Error('settings_invalid');
  return { enabled: value.enabled };
}

export const writeSettings = (path, enabled) => writeOwnerOnly(path, { schema: SETTINGS_SCHEMA, enabled });

/**
 * BugHubへ1回送る。受領済みにしてよいのは、200・accepted・同じreport_id・応答の署名が合う時だけ。
 * 転送（3xx）には従わない。
 */
export async function sendReport({ credential, report, nowMs, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const body = Buffer.from(JSON.stringify(report), 'utf8');
  const ts = String(Math.floor(nowMs / 1000));
  let response;
  try {
    response = await fetchImpl(credential.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        authorization: `BugHub-HMAC-SHA256 key_id=${credential.key_id}, ts=${ts}, sig=${requestSignature(credential.secret, ts, body)}`,
      },
      body,
    });
  } catch {
    return { outcome: 'unreachable' };
  }
  let value = null;
  try { value = await response.json(); } catch { /* 本文がJSONでない応答は、状態codeだけで扱う。 */ }
  if (response.status === 200) {
    const accepted = plain(value) && value.accepted === true && value.report_id === report.report_id
      && typeof value.received_at === 'string' && typeof value.sig === 'string'
      && sameSignature(value.sig, responseSignature(credential.secret, report.report_id, value.received_at));
    return accepted ? { outcome: 'accepted' } : { outcome: 'response_unverified' };
  }
  const code = plain(value) && typeof value.error === 'string' && OUTCOME.test(value.error) ? value.error : `http_${response.status}`;
  return { outcome: code };
}
