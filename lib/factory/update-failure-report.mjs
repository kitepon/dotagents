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
// 重大度は手順の名前や回数で決めず、確かめた実害で決める（BugHubのbughub/NETWORK_REPORTING.md）。
// 手順の失敗で確かなのは「この回の更新がその手順で止まった」ことだけで、原因（通信・製品・端末）は未確定。
// - high: 次の定期更新の再試行でも直らず、その手順が担う製品を起動できない事を、この回の工場のreportで確かめた時。
//   止まった機能は製品の起動、影響はこの端末のその製品、復帰はその手順が通るか人の手による導入。
// - 起動できる事を正に観測した回だけ、根拠を付けてwarnへ評価し直す。checkのfail（版照会・期待値検査・診断）は、
//   起動できる製品の全体の利用不能の根拠にしない。どのcheckがfailかは根拠として記録に残し、製品のcheckが製品の名前で運ぶ。
// - 新しい観測が無い回（reportを読めない・古い・製品の状態が未確認）は、前の評価を保持する。確かめたhighも下げない。
// warnは実害を確かめていない事を表し、無害の証明ではない。
const SEVERITY_UNCONFIRMED = 'warn';
const SEVERITY_PRODUCT_STOPPED = 'high';
const EVIDENCE_STATES = ['launchable', 'stopped'];
const EVIDENCE_KEYS = ['failed_checks', 'observed_at', 'products', 'state'];
const FAILED_CHECK = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/u;
// 手順が導入・設定する製品（工場のreportの製品ID）。工場自身の手順とlibraryは、止まる製品を持たない。
const STEP_PRODUCTS = Object.freeze({
  'package.aiterm-mcp': ['aiterm-mcp'], 'package.caveat-cli': ['caveat'], 'package.claude-spotter': ['spotter'],
  'package.gpt-connector': ['gpt-connector'], 'package.peertable': ['peertable'], 'package.quolu.aishell': ['aishell'],
  'package.quolu.lattice': ['lattice'], 'package.throughline': ['throughline'],
  'setup.aishell': ['aishell'], 'setup.aiterm': ['aiterm-mcp'], 'setup.caveat': ['caveat'],
  'setup.gpt-connector': ['gpt-connector'], 'setup.lattice': ['lattice'], 'setup.peertable': ['peertable'],
  'spotter-install': ['spotter'], jev: ['jev-ultrafast', 'agent-desktop'], markitdown: ['markitdown'], unai: ['unai'],
});
// この回の観測として扱うreportの古さの上限。定期更新は1回が数分〜十数分で終わる。
export const REPORT_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RESOLUTION_REASON = 'recovered';
const STATE_SCHEMA = 'dotagents.update_failures.v1';
const SETTINGS_SCHEMA = 'dotagents.update_failure_reporting.v1';
// BugHubのcomponent（stableId）と同じ形。手順の名前はこの形でしか受けない。
const STEP = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION = /^0\.0\.0\+[0-9a-z]{1,64}$/u;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const OUTCOME = /^[a-z0-9_]{1,64}$/u;
const RECORD_KEYS = ['first_seen', 'last_seen', 'occurrence_count', 'product_version', 'resolution_unsent', 'resolved_at', 'status'];
// 重大度を持たないのは、どの失敗もhighで送っていた頃の記録。評価していない値を一括で下げないため、読む時はhighとして扱う。
// severityとevidence（重大度の根拠）は端末の記録だけに持ち、BugHubへ送る形には足さない。
const OPTIONAL_RECORD_KEYS = ['evidence', 'severity'];
const recordSeverity = (record) => record.severity ?? 'high';
const validEvidence = (value) => exact(value, EVIDENCE_KEYS) && EVIDENCE_STATES.includes(value.state) && validTime(value.observed_at)
  && Array.isArray(value.products) && value.products.length >= 1 && value.products.length <= 8 && value.products.every((id) => validStep(id))
  && Array.isArray(value.failed_checks) && value.failed_checks.length <= 32 && value.failed_checks.every((item) => typeof item === 'string' && FAILED_CHECK.test(item));
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
  return plain(record) && RECORD_KEYS.every((key) => key in record)
    && Object.keys(record).every((key) => RECORD_KEYS.includes(key) || OPTIONAL_RECORD_KEYS.includes(key))
    && (!('severity' in record) || [SEVERITY_UNCONFIRMED, SEVERITY_PRODUCT_STOPPED].includes(record.severity))
    && (!('evidence' in record) || ('severity' in record && validEvidence(record.evidence)))
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
 *   重大度は、この回の根拠（evidence）がある時だけ決め直す。前の回も失敗していて（再試行でも直らず）、
 *   製品を起動できない事を確かめた手順はhigh、起動できる事を確かめた手順はwarn。根拠が無い回は前の評価を保持する。
 * - 動いて成功した手順: 未解決だったものを解決済みにする。今回動かなかった手順には触れない。
 */
export function applyRun(state, { ran, failed, evidence = {}, now, version }) {
  const next = structuredClone(state);
  const failedSteps = new Set(failed);
  let changed = false;
  for (const step of failedSteps) {
    const record = next.records[step];
    const continued = record?.status === 'open';
    const observed = Object.hasOwn(evidence, step) ? evidence[step] : null;
    // 直ったあとの失敗は新しい1回目で、前の根拠を引き継がない。
    const kept = observed ?? (continued ? record.evidence : undefined);
    const severity = !continued ? SEVERITY_UNCONFIRMED
      : observed?.state === 'stopped' ? SEVERITY_PRODUCT_STOPPED
        : observed?.state === 'launchable' ? SEVERITY_UNCONFIRMED : recordSeverity(record);
    next.records[step] = {
      occurrence_count: (record?.occurrence_count ?? 0) + 1,
      first_seen: record?.first_seen ?? now,
      last_seen: record ? later(now, record.resolved_at ?? record.last_seen) : now,
      status: 'open',
      resolved_at: null,
      resolution_unsent: false,
      product_version: version,
      severity,
      ...(kept ? { evidence: kept } : {}),
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

/**
 * 失敗した手順ごとに、その手順が担う製品を起動できるかを、この回のreportから読む。
 * - stopped: 製品が無い（missing）。製品の公開入口を起動できない。
 * - launchable: 対象の製品すべてで版を読めた（installed）。failしたcheckは「製品ID:check_id」で根拠に残す。
 * - 根拠なし（結果に載せない）: reportを読めない、製品の状態が未確認、止まる製品を持たない手順。
 * 対象外の製品（not_applicable）は数えない。
 */
export function runEvidence(report, failed) {
  const found = {};
  if (!plain(report) || !plain(report.products) || !validTime(report.observed_at)) return found;
  for (const step of failed) {
    const products = (STEP_PRODUCTS[step] ?? []).map((id) => [id, report.products[id]])
      .filter(([, product]) => !plain(product) || product.presence_status !== 'not_applicable');
    if (products.length === 0) continue;
    const gone = products.filter(([, product]) => plain(product) && product.presence_status === 'missing').map(([id]) => id);
    if (gone.length > 0) {
      found[step] = { state: 'stopped', products: gone, failed_checks: [], observed_at: report.observed_at };
    } else if (products.every(([, product]) => plain(product) && product.presence_status === 'installed')) {
      const failedChecks = products.flatMap(([id, product]) => (Array.isArray(product.checks) ? product.checks : [])
        .filter((item) => item?.status === 'fail' && validStep(item.check_id)).map((item) => `${id}:${item.check_id}`)).slice(0, 32);
      found[step] = { state: 'launchable', products: products.map(([id]) => id), failed_checks: failedChecks, observed_at: report.observed_at };
    }
  }
  return found;
}

/** agents-updateが渡した、この回のreport。読めない・古い時はnull（根拠なし）で、記録は続ける。 */
export async function readRunReport(path, nowMs) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) return null;
    const report = JSON.parse(await readFile(path, 'utf8'));
    const observed = plain(report) && validTime(report.observed_at) ? Date.parse(report.observed_at) : NaN;
    return Number.isFinite(observed) && Math.abs(nowMs - observed) <= REPORT_EVIDENCE_MAX_AGE_MS ? report : null;
  } catch {
    return null;
  }
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
