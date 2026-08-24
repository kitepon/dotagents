#!/usr/bin/env node
// v5/v6はtransport実装だけを共有し、endpoint・state・outbox schemaをmajor別に分離する。
// runtime error acknowledgementのpayload契約はv4以降で同一のため、その実装を共有する。
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { resolveWindowsPowerShell7 } from '../lib/factory/windows-powershell.mjs';
import {
  readAndValidateReportV5,
  readAndValidateReportV6,
  readAndValidateReportV7,
  readConfig,
  validateReportV5,
  validateReportV6,
  validateReportV7,
} from '../lib/factory/contract.mjs';
import {
  acknowledgeRuntimeErrorsV5,
  acknowledgeRuntimeErrorsV6,
  acknowledgeRuntimeErrorsV7,
  validateAcknowledgementBundleV5,
  validateAcknowledgementBundleV6,
  validateAcknowledgementBundleV7,
} from '../lib/factory/runtime-errors.mjs';

const INVOKED = basename(process.argv[1] || '');
const IS_V6 = INVOKED.includes('factory-reporter-v6');
const IS_V7 = INVOKED.includes('factory-reporter-v7');
const WIRE = IS_V7
  ? {
      major: 'v7',
      endpoint: '/api/factory/v7/reports',
      state: 'factory-reporter-v7',
      outboxSchema: 'dotagents.factory-outbox.v7',
      readReport: readAndValidateReportV7,
      validateReport: validateReportV7,
      validateAcknowledgements: validateAcknowledgementBundleV7,
      acknowledgeRuntimeErrors: acknowledgeRuntimeErrorsV7,
    }
  : IS_V6
  ? {
      major: 'v6',
      endpoint: '/api/factory/v6/reports',
      state: 'factory-reporter-v6',
      outboxSchema: 'dotagents.factory-outbox.v6',
      readReport: readAndValidateReportV6,
      validateReport: validateReportV6,
      validateAcknowledgements: validateAcknowledgementBundleV6,
      acknowledgeRuntimeErrors: acknowledgeRuntimeErrorsV6,
    }
  : {
      major: 'v5',
      endpoint: '/api/factory/v5/reports',
      state: 'factory-reporter-v5',
      outboxSchema: 'dotagents.factory-outbox.v5',
      readReport: readAndValidateReportV5,
      validateReport: validateReportV5,
      validateAcknowledgements: validateAcknowledgementBundleV5,
      acknowledgeRuntimeErrors: acknowledgeRuntimeErrorsV5,
    };

const MAX_QUEUE_ITEMS = 128;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 60_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function diagnostic(message) { process.stderr.write(`[factory-reporter-${WIRE.major}] ${message}\n`); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(code, message) { diagnostic(message); emit({ ok: false, code }); process.exitCode = 1; }
function defaultConfigPath() { return platform() === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', 'factory-reporter', 'config.json') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dotagents', 'factory-reporter.json'); }
function defaultStatePath() { return platform() === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', WIRE.state) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dotagents', WIRE.state); }
function locations(stateDir) { return { stateDir, outbox: join(stateDir, 'outbox'), dead: join(stateDir, 'dead-letter'), retry: join(stateDir, 'retry'), lock: join(stateDir, 'flush.lock') }; }

function exact(value, keys, label) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label}が不正です`); }
function wireEndpoint(config) { if (!config.reporting.enabled) return; let url; try { url = new URL(config.reporting.endpoint); } catch { throw new Error(`${WIRE.major} endpointが不正です`); } if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== WIRE.endpoint || url.search || url.hash) throw new Error(`${WIRE.major} endpointが必要です`); }
function assertIdentity(config, report) { if (!config.host || config.host.id !== report.host_id || config.host.profile !== report.host_profile) throw new Error('config host identityとreportが一致しません'); }
function ownerOnlyAcl(path) {
  if (platform() !== 'win32') return;
  const script = String.raw`$ErrorActionPreference = 'Stop'
$p = $env:DOTAGENTS_FACTORY_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($p) -or -not (Test-Path -LiteralPath $p)) { throw 'ACL target is invalid' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$isDirectory = (Get-Item -LiteralPath $p).PSIsContainer
if ($isDirectory) {
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $inherit = [Security.AccessControl.InheritanceFlags]::None
}
$item = Get-Item -LiteralPath $p
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($item, [Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { if ($null -ne $existing) { [void]$acl.RemoveAccessRuleAll($existing) } }
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
[IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)`;
  const result = spawnSync(resolveWindowsPowerShell7(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, DOTAGENTS_FACTORY_ACL_TARGET: path },
  });
  if (result.error || result.status !== 0) throw new Error('Windows owner-only ACL設定に失敗しました');
}

async function ensureState(loc) { for (const directory of [loc.stateDir, loc.outbox, loc.dead, loc.retry]) { await mkdir(directory, { recursive: true, mode: 0o700 }); const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathが不正です'); if (platform() !== 'win32' && (info.mode & 0o077) !== 0) await chmod(directory, 0o700); else ownerOnlyAcl(directory); } }
async function entries(loc) { await ensureState(loc); const names = (await readdir(loc.outbox)).filter((name) => name.endsWith('.json')).sort(); const result = []; for (const name of names) { const file = join(loc.outbox, name); try { const info = await stat(file); result.push({ name, file, size: info.size, mtimeMs: info.mtimeMs }); } catch {} } return result; }
async function stats(loc) { const value = await entries(loc); return { count: value.length, bytes: value.reduce((sum, item) => sum + item.size, 0) }; }
async function moveDead(loc, entry, reason) { await rename(entry.file, join(loc.dead, `${entry.name}.${Date.now()}-${randomUUID().slice(0, 8)}-${reason}`)); await rm(join(loc.retry, entry.name), { force: true }); }
async function expire(loc) { for (const entry of await entries(loc)) if (Date.now() - entry.mtimeMs > MAX_QUEUE_AGE_MS) await moveDead(loc, entry, 'expired'); }
function envelope(bytes, acknowledgements) { return acknowledgements ? Buffer.from(JSON.stringify({ schema_version: WIRE.outboxSchema, report_id: acknowledgements.report_id, report_base64: bytes.toString('base64'), acknowledgements })) : bytes; }
function decode(stored) { let parsed; try { parsed = JSON.parse(UTF8.decode(stored)); } catch { throw new Error('malformed'); } if (parsed?.schema_version !== WIRE.outboxSchema) { WIRE.validateReport(parsed); return { bytes: stored, report: parsed, acknowledgements: null }; } exact(parsed, ['schema_version', 'report_id', 'report_base64', 'acknowledgements'], 'outbox envelope'); if (typeof parsed.report_base64 !== 'string') throw new Error('malformed'); const bytes = Buffer.from(parsed.report_base64, 'base64'); if (bytes.toString('base64') !== parsed.report_base64) throw new Error('malformed'); let report; try { report = JSON.parse(UTF8.decode(bytes)); } catch { throw new Error('malformed'); } WIRE.validateReport(report); if (report.report_id !== parsed.report_id) throw new Error('malformed'); return { bytes, report, acknowledgements: WIRE.validateAcknowledgements(parsed.acknowledgements, parsed.report_id) }; }
async function enqueue(loc, bytes, id, acknowledgements) { await ensureState(loc); await expire(loc); const name = `${id}.json`; const target = join(loc.outbox, name); const stored = envelope(bytes, acknowledgements); try { const existing = await readFile(target); if (Buffer.compare(existing, stored) === 0) return { duplicate: true }; throw new Error('report_id collision: 既存outbox本文と一致しません（既存は保持）'); } catch (error) { if (error?.code !== 'ENOENT') throw error; } const current = await stats(loc); if (current.count >= MAX_QUEUE_ITEMS || current.bytes + stored.length > MAX_QUEUE_BYTES) throw new Error('outbox上限超過: 既存queueを保持したまま新規reportを拒否しました'); const temporary = join(loc.outbox, `.${name}.${randomUUID()}.tmp`); try { await writeFile(temporary, stored, { flag: 'wx', mode: 0o600 }); ownerOnlyAcl(temporary); await rename(temporary, target); ownerOnlyAcl(target); } finally { await rm(temporary, { force: true }); } return { duplicate: false }; }
async function retryInfo(loc, name) { try { const value = JSON.parse(await readFile(join(loc.retry, name), 'utf8')); return Number.isSafeInteger(value.attempt) && Number.isFinite(value.next_retry_at) ? value : null; } catch { return null; } }
async function postpone(loc, name, prior) { const attempt = Math.min((prior?.attempt || 0) + 1, 16); const next_retry_at = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS); const path = join(loc.retry, name); await writeFile(path, JSON.stringify({ attempt, next_retry_at }), { mode: 0o600 }); ownerOnlyAcl(path); }
async function withLock(loc, fn) { try { await mkdir(loc.lock); } catch (error) { if (error?.code !== 'EEXIST') throw error; let stale = false; try { const pid = Number((await readFile(join(loc.lock, 'pid'), 'utf8')).trim()); try { process.kill(pid, 0); } catch (probe) { stale = probe?.code === 'ESRCH'; } } catch {} if (!stale) throw new Error('送信処理はすでに実行中です'); await rm(loc.lock, { recursive: true, force: true }); await mkdir(loc.lock); } ownerOnlyAcl(loc.lock); const pid = join(loc.lock, 'pid'); await writeFile(pid, String(process.pid), { mode: 0o600 }); ownerOnlyAcl(pid); try { return await fn(); } finally { await rm(loc.lock, { recursive: true, force: true }); } }
async function credential(config) { let token; try { token = (await readFile(config.reporting.credential_file, 'utf8')).trim(); } catch (error) { throw new Error(`credential fileを読めません (${error.code || error.message})`); } if (!token) throw new Error('credential fileが空です'); return token; }
async function postOne(config, token, loc, entry) {
  let decoded;
  try { decoded = decode(await readFile(entry.file)); } catch { return { action: 'dead', reason: 'malformed' }; }
  if (decoded.report.host_id !== config.host.id || decoded.report.host_profile !== config.host.profile) return { action: 'dead', reason: 'host-mismatch' };
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.reporting.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-factory-sent-at': new Date().toISOString() }, body: decoded.bytes, signal: controller.signal });
    let body = null; try { body = await response.json(); } catch {}
    if (response.ok && body?.accepted === true && body.report_id === decoded.report.report_id) {
      if (decoded.acknowledgements) { try { await WIRE.acknowledgeRuntimeErrors(decoded.acknowledgements); } catch { return { action: 'keep', reason: 'ack-failed' }; } }
      return { action: 'delete' };
    }
    if ([409, 413, 422].includes(response.status)) return { action: 'dead', reason: `http-${response.status}` };
    return { action: 'keep', reason: `http-${response.status}` };
  } catch (error) { return { action: 'keep', reason: error?.name === 'AbortError' ? 'timeout' : 'network' }; } finally { clearTimeout(timeout); }
}
function parseArgs(argv) { const [command, ...rest] = argv; if (!['preview', 'enqueue', 'flush'].includes(command)) throw new Error(`使い方: factory-reporter-${WIRE.major}.mjs preview|enqueue|flush [--report <file>] [--ack-metadata <file>] [--config <file>]`); const options = {}; for (let i = 0; i < rest.length; i += 1) { if (!['--report', '--ack-metadata', '--config'].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) throw new Error('引数が不正です'); options[rest[i].slice(2)] = rest[++i]; } if ((command === 'preview' || command === 'enqueue') && !options.report) throw new Error('--reportが必要です'); if (command === 'flush' && options.report) throw new Error('flushは--reportを受け取りません'); if (command !== 'enqueue' && options['ack-metadata']) throw new Error('--ack-metadataはenqueue専用です'); return { command, options }; }
async function main() { const { command, options } = parseArgs(process.argv.slice(2)); const config = await readConfig(options.config || defaultConfigPath()); const loc = locations(defaultStatePath()); if (config.reporting.enabled) wireEndpoint(config); if (command === 'preview') { const { bytes, report } = await WIRE.readReport(options.report); assertIdentity(config, report); emit({ ok: true, command, reporting_enabled: config.reporting.enabled, report_id: report.report_id, body_bytes: bytes.length, report }); return; } if (command === 'enqueue') { const { bytes, report } = await WIRE.readReport(options.report); if (!config.reporting.enabled) { emit({ ok: true, command, reporting_enabled: false, enqueued: false, report_id: report.report_id, ...(await stats(loc)) }); return; } assertIdentity(config, report); let acknowledgements = null; if (options['ack-metadata']) { let value; try { value = JSON.parse(UTF8.decode(await readFile(options['ack-metadata']))); } catch { throw new Error('ack metadataが不正です'); } acknowledgements = WIRE.validateAcknowledgements(value, report.report_id); } const result = await enqueue(loc, bytes, report.report_id, acknowledgements); emit({ ok: true, command, reporting_enabled: true, enqueued: !result.duplicate, report_id: report.report_id, ...(await stats(loc)) }); return; } if (!config.reporting.enabled) { emit({ ok: true, command, reporting_enabled: false, sent: 0, retained: (await stats(loc)).count, dead_lettered: 0, deferred: 0 }); return; } await ensureState(loc); const token = await credential(config); const outcome = await withLock(loc, async () => { await expire(loc); let sent = 0; let retained = 0; let deadLettered = 0; let deferred = 0; let ackFailed = 0; for (const entry of await entries(loc)) { const retry = await retryInfo(loc, entry.name); if (retry && retry.next_retry_at > Date.now()) { deferred += 1; continue; } const result = await postOne(config, token, loc, entry); if (result.action === 'delete') { await rm(entry.file, { force: true }); await rm(join(loc.retry, entry.name), { force: true }); sent += 1; } else if (result.action === 'dead') { await moveDead(loc, entry, result.reason); deadLettered += 1; } else { await postpone(loc, entry.name, retry); retained += 1; if (result.reason === 'ack-failed') ackFailed += 1; } } return { sent, retained, dead_lettered: deadLettered, deferred, ack_failed: ackFailed }; }); const failed = outcome.retained > 0 || outcome.dead_lettered > 0 || outcome.deferred > 0 || outcome.ack_failed > 0; emit({ ok: !failed, command, reporting_enabled: true, ...outcome, ...(await stats(loc)) }); if (failed) { diagnostic(outcome.ack_failed > 0 ? 'BugHub受理後のruntime error acknowledgementに失敗しました' : outcome.dead_lettered > 0 ? 'BugHubに永久拒否されたreportをdead-letterへ隔離しました' : 'outboxに未送信reportが残っています'); process.exitCode = 1; } }
main().catch((error) => fail(`FACTORY_REPORTER_${WIRE.major.toUpperCase()}_ERROR`, error?.message || '失敗'));
