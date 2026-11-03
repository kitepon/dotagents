import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveWindowsPowerShell7 } from './windows-powershell.mjs';

export function ownerOnlyAcl(path) {
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
export async function privateState(state) { try { const info = await lstat(state); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('state pathはsymlinkでないdirectoryでなければなりません'); } catch (error) { if (error?.code !== 'ENOENT') throw error; await mkdir(state, { recursive: true, mode: 0o700 }); } if (platform() !== 'win32') await chmod(state, 0o700); else ownerOnlyAcl(state); }
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
export async function withLock(state, task) {
  const contender = await acquireContender(state);
  try {
    return await task();
  } finally {
    await releaseContender(contender.published, contender.owner.nonce);
  }
}
