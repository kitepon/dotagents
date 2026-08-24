#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { isWin32 } from '../lib/platform.mjs';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  assertConfigIdentity,
  readAndValidateReport,
  readConfig,
  validateReport,
} from '../lib/factory/contract.mjs';
import {
  acknowledgeRuntimeErrors,
  validateAcknowledgementBundle,
} from '../lib/factory/runtime-errors.mjs';

const MAX_QUEUE_ITEMS = 128;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ACK_METADATA_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function diagnostic(message) { process.stderr.write(`[factory-reporter] ${message}\n`); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(code, message) {
  diagnostic(message);
  emit({ ok: false, code });
  process.exitCode = 1;
}

function defaultConfigPath() {
  if (isWin32()) {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'dotagents', 'factory-reporter', 'config.json',
    );
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dotagents', 'factory-reporter.json');
}

function defaultStatePath() {
  if (isWin32()) {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'dotagents', 'factory-reporter',
    );
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'dotagents', 'factory-reporter',
  );
}

function locations(stateDir) {
  return {
    stateDir,
    outbox: join(stateDir, 'outbox'),
    dead: join(stateDir, 'dead-letter'),
    lock: join(stateDir, 'flush.lock'),
  };
}

async function ensureState(loc) {
  for (const directory of [loc.stateDir, loc.outbox, loc.dead]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathが不正です');
    if (!isWin32() && (info.mode & 0o077) !== 0) await chmod(directory, 0o700);
  }
}

async function queueEntries(loc) {
  await ensureState(loc);
  const names = (await readdir(loc.outbox)).filter((name) => name.endsWith('.json')).sort();
  const result = [];
  for (const name of names) {
    const file = join(loc.outbox, name);
    try {
      const info = await stat(file);
      result.push({ name, file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 並行flushが先に削除したentryは次回一覧から消える。
    }
  }
  return result;
}

async function moveDead(loc, entry, reason) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}-${reason}`;
  await rename(entry.file, join(loc.dead, `${entry.name}.${suffix}`));
}

async function expireQueue(loc) {
  for (const entry of await queueEntries(loc)) {
    if (Date.now() - entry.mtimeMs > MAX_QUEUE_AGE_MS) await moveDead(loc, entry, 'expired');
  }
}

async function queueStats(loc) {
  const entries = await queueEntries(loc);
  return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
}

async function enqueue(loc, bytes, reportId) {
  await ensureState(loc);
  await expireQueue(loc);
  const name = `${reportId}.json`;
  const target = join(loc.outbox, name);
  try {
    const existing = await readFile(target);
    if (Buffer.compare(existing, bytes) === 0) return { name, duplicate: true };
    throw new Error('report_id collision: 既存outbox本文と一致しません（既存は保持）');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stats = await queueStats(loc);
  if (stats.count >= MAX_QUEUE_ITEMS || stats.bytes + bytes.length > MAX_QUEUE_BYTES) {
    throw new Error('outbox上限超過: 既存queueを保持したまま新規reportを拒否しました');
  }
  const temporary = join(loc.outbox, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { name, duplicate: false };
}

function outboxEnvelope(reportBytes, acknowledgements) {
  return Buffer.from(JSON.stringify({
    schema_version: 'dotagents.factory-outbox.v1',
    report_id: acknowledgements.report_id,
    report_base64: reportBytes.toString('base64'),
    acknowledgements,
  }));
}

function decodeOutboxEntry(storedBytes) {
  const value = JSON.parse(UTF8.decode(storedBytes));
  if (value?.schema_version !== 'dotagents.factory-outbox.v1') {
    return { bytes: storedBytes, report: value, acknowledgements: null };
  }
  const keys = Object.keys(value);
  if (keys.length !== 4 || keys.some((key) => !['schema_version', 'report_id', 'report_base64', 'acknowledgements'].includes(key))
    || typeof value.report_id !== 'string' || typeof value.report_base64 !== 'string'
    || value.report_base64.length > Math.ceil(MAX_QUEUE_BYTES * 4 / 3) + 4) throw new Error('outbox envelopeが不正です');
  const bytes = Buffer.from(value.report_base64, 'base64');
  if (bytes.toString('base64') !== value.report_base64) throw new Error('outbox envelopeが不正です');
  const report = JSON.parse(UTF8.decode(bytes));
  if (report?.report_id !== value.report_id) throw new Error('outbox envelopeが不正です');
  return {
    bytes,
    report,
    acknowledgements: validateAcknowledgementBundle(value.acknowledgements, value.report_id),
  };
}

async function withLock(loc, fn) {
  try {
    await mkdir(loc.lock);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const pid = Number((await readFile(join(loc.lock, 'pid'), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probeError) { stale = probeError?.code === 'ESRCH'; }
      }
    } catch {
      // pid未記録の競合lockは現行処理として扱う。
    }
    if (!stale) throw new Error('送信処理はすでに実行中です');
    await rm(loc.lock, { recursive: true, force: true });
    await mkdir(loc.lock);
  }
  await writeFile(join(loc.lock, 'pid'), String(process.pid), { mode: 0o600 });
  try { return await fn(); } finally { await rm(loc.lock, { recursive: true, force: true }); }
}

async function credential(config) {
  let token;
  try {
    token = (await readFile(config.reporting.credential_file, 'utf8')).trim();
  } catch (error) {
    throw new Error(`credential fileを読めません (${error.code || error.message})`);
  }
  if (!token) throw new Error('credential fileが空です');
  return token;
}

async function postOne(config, token, loc, entry) {
  const storedBytes = await readFile(entry.file);
  let bytes;
  let report;
  let acknowledgements;
  try {
    ({ bytes, report, acknowledgements } = decodeOutboxEntry(storedBytes));
    validateReport(report);
  } catch {
    return { action: 'dead', reason: 'malformed' };
  }
  if (!config.host || report.host_id !== config.host.id || report.host_profile !== config.host.profile) {
    return { action: 'dead', reason: 'host-mismatch' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.reporting.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-factory-sent-at': new Date().toISOString(),
      },
      body: bytes,
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* 不正responseはqueueへ保持する。 */ }
    if (response.ok && body?.accepted === true && body.report_id === report.report_id) {
      if (acknowledgements) {
        try { await acknowledgeRuntimeErrors(acknowledgements); }
        catch (error) { return { action: 'keep', reason: 'ack-failed', product: error?.product_id ?? 'unknown' }; }
      }
      return { action: 'delete' };
    }
    if ([409, 413, 422].includes(response.status)) {
      return { action: 'dead', reason: `http-${response.status}` };
    }
    return { action: 'keep', reason: `http-${response.status}` };
  } catch (error) {
    return { action: 'keep', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['preview', 'enqueue', 'flush'].includes(command)) {
    throw new Error('使い方: factory-reporter.mjs preview|enqueue|flush [--report <file>] [--ack-metadata <file>] [--config <file>]');
  }
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    if (!['--report', '--ack-metadata', '--config'].includes(rest[index]) || !rest[index + 1] || options[rest[index]]) {
      throw new Error('引数が不正です');
    }
    options[rest[index].slice(2)] = rest[++index];
  }
  if ((command === 'preview' || command === 'enqueue') && !options.report) {
    throw new Error('--reportが必要です');
  }
  if (command === 'flush' && options.report) throw new Error('flushは--reportを受け取りません');
  if (command !== 'enqueue' && options['ack-metadata']) throw new Error('--ack-metadataはenqueue専用です');
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = await readConfig(options.config || defaultConfigPath());
  const loc = locations(defaultStatePath());
  if (command === 'preview') {
    const { bytes, report } = await readAndValidateReport(options.report);
    assertConfigIdentity(config, report);
    emit({
      ok: true, command, reporting_enabled: config.reporting.enabled,
      report_id: report.report_id, body_bytes: bytes.length, report,
    });
    return;
  }
  if (command === 'enqueue') {
    const { bytes, report } = await readAndValidateReport(options.report);
    let acknowledgementBytes = null;
    let acknowledgementValue = null;
    if (options['ack-metadata']) {
      const info = await stat(options['ack-metadata']);
      if (!info.isFile() || info.size > MAX_ACK_METADATA_BYTES) throw new Error('ack metadataが不正です');
      acknowledgementBytes = await readFile(options['ack-metadata']);
      acknowledgementValue = validateAcknowledgementBundle(JSON.parse(UTF8.decode(acknowledgementBytes)), report.report_id);
    }
    if (!config.reporting.enabled) {
      emit({
        ok: true, command, reporting_enabled: false, enqueued: false,
        report_id: report.report_id, ...(await queueStats(loc)),
      });
      return;
    }
    assertConfigIdentity(config, report);
    const queuedBytes = acknowledgementValue ? outboxEnvelope(bytes, acknowledgementValue) : bytes;
    const result = await enqueue(loc, queuedBytes, report.report_id);
    emit({
      ok: true, command, reporting_enabled: true, enqueued: !result.duplicate,
      report_id: report.report_id, ...(await queueStats(loc)),
    });
    return;
  }
  if (!config.reporting.enabled) {
    emit({
      ok: true, command, reporting_enabled: false,
      sent: 0, retained: (await queueStats(loc)).count, dead_lettered: 0,
    });
    return;
  }
  const token = await credential(config);
  const outcome = await withLock(loc, async () => {
    await expireQueue(loc);
    let sent = 0;
    let retained = 0;
    let deadLettered = 0;
    let ackFailed = 0;
    const ackFailedProducts = new Set();
    for (const entry of await queueEntries(loc)) {
      const result = await postOne(config, token, loc, entry);
      if (result.action === 'delete') {
        await rm(entry.file, { force: true });
        sent++;
      } else if (result.action === 'dead') {
        await moveDead(loc, entry, result.reason);
        deadLettered++;
      } else {
        retained++;
        if (result.reason === 'ack-failed') {
          ackFailed++;
          ackFailedProducts.add(result.product);
        }
      }
    }
    return {
      sent, retained, dead_lettered: deadLettered, ack_failed: ackFailed,
      ...(ackFailed > 0 ? { ack_failed_products: [...ackFailedProducts].sort() } : {}),
    };
  });
  const failed = outcome.retained > 0 || outcome.dead_lettered > 0 || outcome.ack_failed > 0;
  emit({ ok: !failed, command, reporting_enabled: true, ...outcome, ...(await queueStats(loc)) });
  if (failed) {
    diagnostic(outcome.ack_failed > 0
      ? 'BugHub受理後のruntime error acknowledgementに失敗しました'
      : outcome.dead_lettered > 0
        ? 'BugHubに永久拒否されたreportをdead-letterへ隔離しました'
        : 'outboxに未送信reportが残っています');
    process.exitCode = 1;
  }
}

main().catch((error) => fail('FACTORY_REPORTER_ERROR', error?.message || '失敗'));
