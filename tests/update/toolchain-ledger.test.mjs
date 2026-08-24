import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const CLI = resolve('bin/factory-toolchain-ledger.mjs');
function run(args) { return new Promise((resolveRun) => { const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (x) => { stdout += x; }); child.stderr.on('data', (x) => { stderr += x; }); child.on('close', (code) => resolveRun({ code, stdout, stderr })); }); }
function args(file, product = 'claude-code') { return ['record', '--file', file, '--product', product, '--before', '2.1.0', '--latest', '2.2.0', '--operation', 'success', '--after', '2.2.0', '--post-gate', 'pending', '--reason', 'updated', '--observed-at', '2026-07-13T14:00:00.000Z']; }

test('基盤CLI更新台帳は製品別recordを原子的owner-only JSONへ保存する', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-ledger-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'state', 'ledger.json');
  const first = await run(args(file)); assert.equal(first.code, 0, first.stderr); const second = await run(args(file, 'codex-cli')); assert.equal(second.code, 0, second.stderr);
  const value = JSON.parse(await readFile(file, 'utf8')); assert.equal(value.schema_version, 'dotagents.toolchain-update.v1'); assert.equal(value.products['claude-code'].post_gate_status, 'pending'); assert.equal(value.products['codex-cli'].after_version, '2.2.0');
  assert.equal((await stat(join(root, 'state'))).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('破損台帳とsymlinkは既存bytesを上書きせず拒否する', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-ledger-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'ledger.json');
  await writeFile(file, '{broken', { mode: 0o600 }); assert.equal((await run(args(file))).code, 1); assert.equal(await readFile(file, 'utf8'), '{broken');
  const target = join(root, 'target.json'); await writeFile(target, '{}'); await rm(file); await symlink(target, file); assert.equal((await run(args(file))).code, 1); assert.equal(await readFile(target, 'utf8'), '{}');
});

test('未知・不足引数は台帳を作らず拒否し、Windows ACL契約を実装に固定する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-ledger-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'ledger.json');
  assert.equal((await run([...args(file), '--unknown', 'value'])).code, 1);
  assert.equal((await run(args(file).slice(0, -2))).code, 1);
  await assert.rejects(readFile(file));
  const source = await readFile(CLI, 'utf8');
  assert.match(source, /DOTAGENTS_FACTORY_ACL_TARGET/); assert.match(source, /WindowsIdentity\]::GetCurrent\(\)\.User/); assert.match(source, /Get-Item -LiteralPath \$p/); assert.match(source, /RemoveAccessRuleAll/); assert.doesNotMatch(source, /New-Object Security\.AccessControl\.(?:Directory|File)Security/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/); assert.match(source, /FileSystemAccessRule\]::new\(\$sid, \[Security\.AccessControl\.FileSystemRights\]::FullControl/);
  assert.match(source, /FileSystemAclExtensions\]::GetAccessControl\(.*AccessControlSections\]::Access\)/); assert.match(source, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/); assert.doesNotMatch(source, /Set-Acl /); assert.doesNotMatch(source, /\[IO\.(?:Directory|File)\]::SetAccessControl/); assert.match(source, /timeout: 5_000/); assert.match(source, /acl_apply_failed/); assert.match(source, /ownerOnlyAcl\(path\)/);
  const afterRename = source.slice(source.indexOf('await rename(temporary, path)'), source.indexOf('} finally', source.indexOf('await rename(temporary, path)'))); assert.doesNotMatch(afterRename, /ownerOnlyAcl\(path\)/);
});

test('並行recordでも3製品の成功結果をlost updateしない', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-ledger-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'ledger.json');
  const results = await Promise.all(['claude-code', 'codex-cli', 'grok-build'].map((product) => run(args(file, product))));
  assert.deepEqual(results.map((item) => item.code), [0, 0, 0]);
  const value = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(value.products).sort(), ['claude-code', 'codex-cli', 'grok-build']);
});
