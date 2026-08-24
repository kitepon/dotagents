#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isWin32 } from '../lib/platform.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const PRODUCTS = new Set(['claude-code', 'codex-cli', 'grok-build']);
const STATUS = new Set(['success', 'failed', 'skipped', 'pending']);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const REASONS = new Set(['npm_unavailable', 'install_failed', 'registry_unavailable', 'downgrade_refused', 'post_version_unavailable', 'version_mismatch', 'updated', 'already_current', 'optional_missing', 'check_failed', 'check_schema_invalid', 'update_failed', 'post_contract_failed', 'not_observed']);
const ARGUMENTS = new Set(['file', 'product', 'before', 'latest', 'operation', 'after', 'post-gate', 'reason', 'observed-at']);

function parse(argv) { const [command, ...rest] = argv; if (command !== 'record') throw new Error('recordだけを受理します'); const value = {}; for (let i = 0; i < rest.length; i += 2) { const key = rest[i]; const next = rest[i + 1]; const name = key?.slice(2); if (!key?.startsWith('--') || next === undefined || !ARGUMENTS.has(name) || name in value) throw new Error('引数が不正です'); value[name] = next; } if (Object.keys(value).length !== ARGUMENTS.size) throw new Error('引数が不足しています'); return value; }
function nullableVersion(value) { if (value === 'none') return null; if (!SEMVER.test(value)) throw new Error('versionが不正です'); return value; }
function validUtc(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function validateRecord(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'after_version,before_version,latest_version,observed_at,operation_status,post_gate_status,reason_code') throw new Error('record schemaが不正です'); for (const key of ['before_version', 'latest_version', 'after_version']) if (value[key] !== null && !SEMVER.test(value[key])) throw new Error('record versionが不正です'); if (!STATUS.has(value.operation_status) || !STATUS.has(value.post_gate_status) || !REASONS.has(value.reason_code) || !validUtc(value.observed_at)) throw new Error('record valueが不正です'); }
function validateLedger(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'products,schema_version' || value.schema_version !== 'dotagents.toolchain-update.v1' || !value.products || typeof value.products !== 'object' || Array.isArray(value.products)) throw new Error('ledger schemaが不正です'); for (const [product, record] of Object.entries(value.products)) { if (!PRODUCTS.has(product)) throw new Error('ledger productが不正です'); validateRecord(record); } return value; }
async function existing(path) { try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('ledger pathが不正です'); return validateLedger(JSON.parse(await readFile(path, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT') return { schema_version: 'dotagents.toolchain-update.v1', products: {} }; throw error; } }
function ownerOnlyAcl(path) {
  if (!isWin32()) return;
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
$acl = $item.GetAccessControl('Access')
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($existing) }
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, DOTAGENTS_FACTORY_ACL_TARGET: path },
    timeout: 5_000,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Windows owner-only ACL設定に失敗しました (acl_timeout)');
  if (result.error) throw new Error('Windows owner-only ACL設定に失敗しました (acl_process_failed)');
  if (result.status !== 0) throw new Error('Windows owner-only ACL設定に失敗しました (acl_apply_failed)');
}
async function atomic(path, value) { const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 }); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ledger directoryが不正です'); if (!isWin32()) await chmod(directory, 0o700); else ownerOnlyAcl(directory); const temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); if (!isWin32()) await chmod(temporary, 0o600); else ownerOnlyAcl(temporary); await rename(temporary, path); if (!isWin32()) await chmod(path, 0o600); } finally { await rm(temporary, { force: true }); } }
async function withLock(path, task) { const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 }); const directoryInfo = await lstat(directory); if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('ledger directoryが不正です'); if (!isWin32()) await chmod(directory, 0o700); else ownerOnlyAcl(directory); const lock = `${path}.lock`; for (let attempt = 0; ; attempt += 1) { try { await mkdir(lock, { mode: 0o700 }); if (!isWin32()) await chmod(lock, 0o700); else ownerOnlyAcl(lock); const owner = join(lock, 'owner.json'); await writeFile(owner, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 }); if (!isWin32()) await chmod(owner, 0o600); else ownerOnlyAcl(owner); break; } catch (error) { if (error?.code !== 'EEXIST') throw error; const info = await lstat(lock); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ledger lockが不正です'); const oldEnough = Date.now() - info.mtimeMs > 5 * 60 * 1000; let alive = true; try { const value = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('owner'); try { process.kill(value.pid, 0); } catch (probe) { if (probe?.code === 'ESRCH') alive = false; else throw probe; } } catch (probe) { if (probe?.code === 'ENOENT' || probe?.message === 'owner' || probe instanceof SyntaxError) alive = !oldEnough; else throw probe; } if (!alive) { await rm(lock, { recursive: true, force: true }); continue; } if (attempt >= 100) throw new Error('ledger更新はすでに実行中です'); await new Promise((resolve) => setTimeout(resolve, 25)); } } try { return await task(); } finally { await rm(lock, { recursive: true, force: true }); } }

try {
  const args = parse(process.argv.slice(2));
  if (!args.file || !PRODUCTS.has(args.product) || !STATUS.has(args.operation) || !STATUS.has(args['post-gate']) || !REASONS.has(args.reason) || !validUtc(args['observed-at'])) throw new Error('record引数が不正です');
  await withLock(args.file, async () => { const ledger = await existing(args.file); ledger.products[args.product] = { before_version: nullableVersion(args.before), latest_version: nullableVersion(args.latest), operation_status: args.operation, after_version: nullableVersion(args.after), post_gate_status: args['post-gate'], reason_code: args.reason, observed_at: args['observed-at'] }; validateLedger(ledger); await atomic(args.file, ledger); }); process.stdout.write(`${JSON.stringify({ ok: true, product: args.product })}\n`);
} catch (error) { process.stderr.write(`[factory-toolchain-ledger] ${error?.message || '失敗'}\n`); process.exitCode = 1; }
