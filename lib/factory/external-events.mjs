import { createHash, randomUUID } from 'node:crypto';
import { chmodIfPosix, isWin32 } from '../platform.mjs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHECKS = Object.freeze(['availability', 'database', 'schema', 'pull_poll', 'factory_ingest', 'factory_delivery', 'source_revision']);
export const REASONS = Object.freeze(['unreachable', 'ready', 'database_unavailable', 'query_failed', 'version_mismatch', 'not_observed', 'timestamp_invalid', 'source_status_invalid', 'source_failed', 'delivery_failed', 'poll_failed', 'stale', 'disabled', 'not_configured', 'factory_state_unavailable', 'state_invalid', 'delivered', 'not_needed', 'revision_match', 'revision_missing', 'revision_invalid', 'revision_mismatch']);
const REASONS_BY_CHECK = Object.freeze({
  availability: new Set(['unreachable']),
  database: new Set(['query_failed']),
  schema: new Set(['version_mismatch', 'query_failed']),
  pull_poll: new Set(['not_observed', 'timestamp_invalid', 'source_status_invalid', 'source_failed', 'delivery_failed', 'poll_failed', 'stale', 'query_failed']),
  factory_ingest: new Set(['stale', 'query_failed']),
  factory_delivery: new Set(['state_invalid', 'stale', 'delivery_failed', 'query_failed']),
  source_revision: new Set(['revision_missing', 'revision_invalid', 'revision_mismatch']),
});
const SCHEMA = 'dotagents.external-events.v1';
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_EVENTS = 256;
const MAX_STATE_BYTES = 1024 * 1024;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 3_000;
const root = () => process.env.FACTORY_REPORTER_STATE_DIR || (isWin32() ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', 'factory-reporter') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dotagents', 'factory-reporter'));
export const fingerprint = (check, reason) => createHash('sha256').update(`servermanager:${check}:${reason}`).digest('hex');

function canonicalUtc(value) { return typeof value === 'string' && UTC.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function valid(check, reason, at) { return CHECKS.includes(check) && REASONS.includes(reason) && REASONS_BY_CHECK[check]?.has(reason) && canonicalUtc(at); }
function emptyState() { return { schema: SCHEMA, next: 1, acknowledged_through: 0, events: [] }; }

async function statePaths() {
  const dir = root();
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('state_invalid');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await chmodIfPosix(dir, 0o700);
  return { file: join(dir, 'external-events.json'), lock: join(dir, 'external-events.lock') };
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function validateState(value) {
  if (!exact(value, ['schema', 'next', 'acknowledged_through', 'events']) || value.schema !== SCHEMA
    || !Number.isSafeInteger(value.next) || value.next < 1
    || !Number.isSafeInteger(value.acknowledged_through) || value.acknowledged_through < 0
    || value.acknowledged_through >= value.next || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) throw new Error('state_invalid');
  let prior = null;
  for (const event of value.events) {
    if (!exact(event, ['sequence', 'fingerprint', 'check', 'reason', 'status', 'first_seen', 'last_seen', 'occurrence_count', 'resolved_at'])
      || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || (prior !== null && event.sequence !== prior + 1) || event.sequence >= value.next
      || event.fingerprint !== fingerprint(event.check, event.reason) || !CHECKS.includes(event.check) || !REASONS.includes(event.reason)
      || !REASONS_BY_CHECK[event.check]?.has(event.reason)
      || !['open', 'resolved'].includes(event.status) || !canonicalUtc(event.first_seen) || !canonicalUtc(event.last_seen)
      || Date.parse(event.first_seen) > Date.parse(event.last_seen) || !Number.isSafeInteger(event.occurrence_count) || event.occurrence_count < 1
      || (event.status === 'open' ? event.resolved_at !== null : !canonicalUtc(event.resolved_at) || Date.parse(event.resolved_at) < Date.parse(event.last_seen))) throw new Error('state_invalid');
    prior = event.sequence;
  }
  if (value.events.length > 0 && prior !== value.next - 1) throw new Error('state_invalid');
  return value;
}

async function read(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('state_invalid');
    return validateState(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function save(file, value) {
  validateState(value);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
    await chmodIfPosix(file, 0o600);
  } finally { await rm(tmp, { force: true }); }
}

async function withLock(fn) {
  const { file, lock } = await statePaths();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    let handle;
    try {
      handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      try { return await fn(file); } finally { await handle.close(); await rm(lock, { force: true }); }
    } catch (error) {
      if (handle) {
        try { await handle.close(); } finally { await rm(lock, { force: true }); }
        throw error;
      }
      if (error?.code !== 'EEXIST') throw error;
      const info = await lstat(lock);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('state_invalid');
      try {
        const owner = JSON.parse(await readFile(lock, 'utf8'));
        if (!exact(owner, ['pid']) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('state_invalid');
        try { process.kill(owner.pid, 0); } catch (ownerError) {
          if (ownerError?.code === 'ESRCH') { await rm(lock, { force: true }); continue; }
          if (ownerError?.code !== 'EPERM') throw ownerError;
        }
      } catch (lockError) {
        if (lockError?.message === 'state_invalid') throw lockError;
        throw new Error('state_invalid');
      }
      if (Date.now() >= deadline) throw new Error('state_locked');
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function trimAcknowledged(value) {
  while (value.events.length > MAX_EVENTS) {
    if (value.events[0].sequence > value.acknowledged_through) throw new Error('state_full');
    value.events.shift();
  }
}

export async function mutate(action, check, reason, observedAt) {
  if (!['open', 'resolve'].includes(action) || !valid(check, reason, observedAt)) throw new Error('arguments_invalid');
  return withLock(async (file) => {
    const value = await read(file);
    const fp = fingerprint(check, reason);
    const latest = [...value.events].reverse().find((event) => event.fingerprint === fp);
    let sequence;
    if (action === 'open') {
      if (latest?.status === 'open') {
        if (Date.parse(observedAt) > Date.parse(latest.last_seen)) {
          sequence = value.next++;
          value.events.push({ sequence, fingerprint: fp, check, reason, status: 'open', first_seen: latest.first_seen, last_seen: observedAt, occurrence_count: latest.occurrence_count + 1, resolved_at: null });
        } else {
          sequence = latest.sequence;
        }
      } else {
        sequence = value.next++;
        value.events.push({ sequence, fingerprint: fp, check, reason, status: 'open', first_seen: observedAt, last_seen: observedAt, occurrence_count: 1, resolved_at: null });
      }
    } else if (!latest || latest.status === 'open' && Date.parse(observedAt) < Date.parse(latest.last_seen)) {
      throw new Error('resolve_invalid');
    } else if (latest.status === 'open') {
      sequence = value.next++;
      value.events.push({ sequence, fingerprint: fp, check, reason, status: 'resolved', first_seen: latest.first_seen, last_seen: latest.last_seen, occurrence_count: latest.occurrence_count, resolved_at: observedAt });
    } else {
      sequence = latest.sequence;
    }
    trimAcknowledged(value);
    await save(file, value);
    return { ok: true, fingerprint: fp, sequence };
  });
}

export async function snapshot() {
  return withLock(async (file) => {
    const value = await read(file);
    const events = selectable(value);
    return { schema: SCHEMA, cursor: { high_watermark: value.next - 1, acknowledged_through: value.acknowledged_through, next: events.at(-1)?.sequence || 0 }, events };
  });
}

export async function ack(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('arguments_invalid');
  return withLock(async (file) => {
    const value = await read(file);
    const sendable = selectable(value).at(-1)?.sequence || value.acknowledged_through;
    if (cursor > value.next - 1 || cursor > sendable) throw new Error('cursor_invalid');
    value.acknowledged_through = Math.max(value.acknowledged_through, cursor);
    trimAcknowledged(value);
    await save(file, value);
    return { ok: true, acknowledged_through: value.acknowledged_through };
  });
}

export async function status() {
  return withLock(async (file) => {
    const value = await read(file);
    return { schema: SCHEMA, high_watermark: value.next - 1, acknowledged_through: value.acknowledged_through, pending: value.events.filter((event) => event.sequence > value.acknowledged_through).length };
  });
}

function selectable(value) {
  const seen = new Set();
  const events = [];
  for (const event of value.events) {
    if (event.sequence <= value.acknowledged_through) continue;
    if (seen.has(event.fingerprint)) break;
    seen.add(event.fingerprint);
    events.push(event);
  }
  return events;
}
