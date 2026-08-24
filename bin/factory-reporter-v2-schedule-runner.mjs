#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/factory/contract.mjs';
import { extendedSchedulerPath } from '../lib/factory/scheduler-path.mjs';
import { resolveWindowsPowerShell7 } from '../lib/factory/windows-powershell.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
process.env.PATH = extendedSchedulerPath({ platform: platform(), path: process.env.PATH, execPath: process.execPath, home: homedir() });
function statePath() { return platform() === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', 'factory-reporter-v2') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dotagents', 'factory-reporter-v2'); }
function platformMatches(profile) { return (platform() === 'darwin' && profile === 'mac') || (platform() === 'linux' && ['server', 'wsl'].includes(profile)) || (platform() === 'win32' && profile === 'windows-native'); }
function run(script, args) { return new Promise((resolveRun, rejectRun) => { const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' }); child.on('error', rejectRun); child.on('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${script} がexit ${code}で失敗`))); }); }
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
    timeout: 5_000,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Windows owner-only ACL設定に失敗しました (acl_timeout)');
  if (result.error) throw new Error('Windows owner-only ACL設定に失敗しました (acl_process_failed)');
  if (result.status !== 0) throw new Error('Windows owner-only ACL設定に失敗しました (acl_apply_failed)');
}
function parseArgs(argv) { const mode = argv[2] || null; if (![2, 3].includes(argv.length) || argv[0] !== '--config' || !argv[1] || /[\0\r\n]/u.test(argv[1]) || (mode !== null && !['--post-update', '--finalize-update'].includes(mode))) throw new Error('使い方: factory-reporter-v2-schedule-runner --config <file> [--post-update|--finalize-update]'); return { configPath: argv[1], postUpdate: mode === '--post-update', finalizeUpdate: mode === '--finalize-update' }; }
async function privateState(state) { try { const info = await lstat(state); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathはsymlinkでないdirectoryでなければなりません'); } catch (error) { if (error?.code !== 'ENOENT') throw error; await mkdir(state, { recursive: true, mode: 0o700 }); } if (platform() !== 'win32') await chmod(state, 0o700); else ownerOnlyAcl(state); }
function parseLockOwner(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'acquired_at,nonce,pid,schema_version') return null;
    if (value.schema_version !== 'dotagents.factory-scheduler-lock.v1' || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.nonce) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.acquired_at !== 'string' || !Number.isFinite(Date.parse(value.acquired_at))) return null;
    return value;
  } catch {
    return null;
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}
async function publishContender(state) {
  const nonce = randomUUID();
  const temporary = join(state, `.schedule.lock.${nonce}.tmp`);
  const published = join(state, `schedule.lock.${nonce}.owner`);
  const owner = { schema_version: 'dotagents.factory-scheduler-lock.v1', nonce, pid: process.pid, acquired_at: new Date().toISOString() };
  try {
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    if (platform() !== 'win32') await chmod(temporary, 0o600);
    else ownerOnlyAcl(temporary);
    await link(temporary, published);
    return { owner, published };
  } finally {
    await rm(temporary, { force: true });
  }
}
async function releaseContender(published, nonce) {
  try {
    const current = parseLockOwner(await readFile(published, 'utf8'));
    if (current?.nonce === nonce) await rm(published, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
async function rejectLegacyLock(state) {
  try {
    await lstat(join(state, 'schedule.lock'));
    throw new Error('scheduler lockが旧形式です。所有者不在を確認して明示回収してください');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
async function acquireContender(state) {
  await rejectLegacyLock(state);
  const contender = await publishContender(state);
  try {
    const entries = await readdir(state);
    for (const name of entries) {
      if (!/^schedule\.lock\.[0-9a-f-]{36}\.owner$/iu.test(name) || join(state, name) === contender.published) continue;
      const path = join(state, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('scheduler contenderが不正です');
      if (info.size > 4_096) throw new Error('scheduler lockが不正です');
      const observed = parseLockOwner(await readFile(path, 'utf8'));
      if (!observed || path !== join(state, `schedule.lock.${observed.nonce}.owner`)) throw new Error('scheduler contenderが不正です');
      if (processIsAlive(observed.pid)) throw new Error('schedulerはすでに実行中です');
      await rm(path, { force: true });
    }
    return contender;
  } catch (error) {
    await releaseContender(contender.published, contender.owner.nonce);
    throw error;
  }
}
async function withLock(state, task) {
  const contender = await acquireContender(state);
  try {
    return await task();
  } finally {
    await releaseContender(contender.published, contender.owner.nonce);
  }
}
function gateFailures(report, profile, postUpdate) { const required = ['caveat', 'throughline', 'spotter', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar']; if (profile === 'server') required.push('servermanager'); if (profile !== 'windows-native') required.push('claude-code', 'codex-cli'); const allowedUnverified = new Set(['spotter\0codex_hooks\0trust_not_machine_verifiable', 'throughline\0evidence_restore_smoke\0diagnostic_unverified', 'throughline\0claude_connector\0diagnostic_unverified', 'aiterm-mcp\0pty_list\0pty_list_unverified']); const failures = []; for (const id of required) { const product = report?.products?.[id]; if (!product || product.presence_status !== 'installed') { failures.push(`${id}:presence`); continue; } if ((['claude-code', 'codex-cli'].includes(id) && product.compatibility_status !== 'compatible') || product.compatibility_status === 'incompatible') failures.push(`${id}:compatibility`); for (const item of product.checks || []) { if (postUpdate && item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending') continue; if (item.status === 'fail' || (item.status === 'unverified' && !allowedUnverified.has(`${id}\0${item.check_id}\0${item.reason_code}`))) failures.push(`${id}:${item.check_id}`); } } return failures; }
function hasPendingToolchainLedger(report) { return ['claude-code', 'codex-cli', 'grok-build'].some((id) => (report?.products?.[id]?.checks || []).some((item) => item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending')); }
try {
  const { configPath, postUpdate, finalizeUpdate } = parseArgs(process.argv.slice(2));
  const config = await readConfig(configPath);
  if (config.source !== 'file') throw new Error('schedulerは設定ファイルなしでは実行しません');
  if (!platformMatches(config.host.profile)) throw new Error(`host.profile=${config.host.profile}は実行中platformと一致しません`);
  if (!postUpdate && !finalizeUpdate && !config.collection.enabled && !config.reporting.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: true, post_gate_status: 'skipped', skipped: 'collection-and-reporting-disabled' })}\n`);
  } else {
    const state = statePath();
    await privateState(state);
    await withLock(state, async () => {
      const reportPath = join(state, 'latest-report.json');
      const acks = join(state, 'latest-acks.json');
      let failures = [];
      if (config.collection.enabled || postUpdate || finalizeUpdate) {
        await run('factory-scan-v2.mjs', ['--config', configPath, '--output', reportPath, '--ack-output', acks, '--cwd', ROOT]);
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        if (finalizeUpdate && hasPendingToolchainLedger(report)) throw new Error('finalize ledgerにpost_gate_pendingが残っています');
        if (postUpdate) failures = gateFailures(report, config.host.profile, true);
        if (!postUpdate && (config.collection.enabled || (finalizeUpdate && config.reporting.enabled))) await run('factory-reporter-v2.mjs', ['enqueue', '--config', configPath, '--report', reportPath, '--ack-metadata', acks]);
      }
      if (config.reporting.enabled) await run('factory-reporter-v2.mjs', ['flush', '--config', configPath]);
      if (finalizeUpdate) process.stdout.write(`${JSON.stringify({ ok: true, finalized: true })}\n`);
      else if (failures.length) {
        process.stdout.write(`${JSON.stringify({ ok: false, post_gate_status: 'failed', failed_checks: failures.length })}\n`);
        process.exitCode = 1;
      } else process.stdout.write(`${JSON.stringify({ ok: true, post_gate_status: 'success' })}\n`);
    });
  }
} catch (error) {
  process.stderr.write(`[factory-reporter-v2-schedule-runner] ${error?.message || '失敗'}\n`);
  process.exitCode = 1;
}
