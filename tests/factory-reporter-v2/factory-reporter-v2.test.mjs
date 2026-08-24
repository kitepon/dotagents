import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile as readSource } from 'node:fs/promises';
import test, { after } from 'node:test';

const ROOT = new URL('../..', import.meta.url);
const CLI = new URL('../../bin/factory-reporter-v2.mjs', import.meta.url).pathname;
const PRODUCT_IDS = ['caveat', 'throughline', 'spotter', 'codegraph', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager', 'claude-code', 'codex-cli', 'grok-build'];
const roots = [];

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'factory-reporter-v2-test-')); roots.push(root);
  return { root, state: join(root, 'state'), config: join(root, 'config.json'), report: join(root, 'report.json'), credential: join(root, 'credential'), ack: join(root, 'ack.json') };
}
function report(id = '018f0000-0000-8000-8000-000000000001') {
  return { schema_version: '2.0', report_id: id, host_id: 'test-host', host_profile: 'mac', platform: { os: 'darwin', arch: 'arm64' }, report_mode: 'full', observed_at: '2026-07-13T00:00:00Z', created_at: '2026-07-13T00:00:01Z', reporter: { version: '2.0.0', dotagents_revision: '1234567' }, products: Object.fromEntries(PRODUCT_IDS.map((id) => [id, { presence_status: 'unverified', contract_version: '2.0', checks: [], runtime_errors: [], resolutions: [] }])) };
}
async function writeConfig(box, endpoint, enabled = true) {
  await writeFile(box.credential, 'unit-test-token\n', { mode: 0o600 });
  await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host', profile: 'mac' }, collection: { enabled: false }, reporting: enabled ? { enabled: true, endpoint, credential_file: box.credential } : { enabled: false } }));
}
async function writeReport(box, value = report()) { await writeFile(box.report, JSON.stringify(value, null, 2)); return readFile(box.report); }
function run(box, args, env = {}, cli = CLI) { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, XDG_STATE_HOME: box.state, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => resolve({ code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null })); }); }
async function startServer(handler) { const received = []; const server = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); received.push({ body: Buffer.concat(chunks), headers: req.headers }); await handler(req, res, received.length); }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return { received, endpoint: `http://127.0.0.1:${server.address().port}/api/factory/v2/reports`, close: () => new Promise((resolve) => server.close(resolve)) }; }
function outbox(box) { return join(box.state, 'dotagents', 'factory-reporter-v2', 'outbox'); }
function dead(box) { return join(box.state, 'dotagents', 'factory-reporter-v2', 'dead-letter'); }
function accepted(res, id) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accepted: true, report_id: id })); }

after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test('配布symlink経由でもv2 reporterがmainを実行する', async () => {
  const box = await sandbox(); const link = join(box.root, 'factory-reporter-v2');
  await symlink(CLI, link); await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api/factory/v2/reports');
  const result = await run(box, ['preview', '--report', box.report, '--config', box.config], {}, link);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json?.ok, true); assert.equal(result.json?.command, 'preview');
});

test('enqueue-before-sendし、accepted後だけ同一body bytesを削除する', async () => {
  const box = await sandbox(); const server = await startServer((req, res) => accepted(res, report().report_id)); const bytes = await writeReport(box); await writeConfig(box, server.endpoint);
  assert.equal((await run(box, ['enqueue', '--report', box.report, '--config', box.config])).json.enqueued, true);
  assert.deepEqual(await readFile(join(outbox(box), `${report().report_id}.json`)), bytes);
  const result = await run(box, ['flush', '--config', box.config]);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json.sent, 1); assert.deepEqual(server.received[0].body, bytes); assert.deepEqual(await readdir(outbox(box)), []); await server.close();
});

test('v1 endpoint・v1 queueは使わず、v2 endpoint以外をfail closedする', async () => {
  const box = await sandbox(); await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api/factory/v1/reports');
  const result = await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  assert.equal(result.code, 1); assert.match(result.stderr, /v2 endpoint/);
  const v1 = join(box.state, 'dotagents', 'factory-reporter', 'outbox'); await mkdir(v1, { recursive: true }); await writeFile(join(v1, 'v1.json'), '{}');
  await writeConfig(box, 'http://127.0.0.1:1/api/factory/v2/reports'); const flushed = await run(box, ['flush', '--config', box.config]);
  assert.equal(flushed.code, 0, flushed.stderr); assert.equal(flushed.json.retained, 0); assert.deepEqual(await readdir(v1), ['v1.json']);
});

for (const [status, action, exitCode] of [[401, 'retained', 1], [403, 'retained', 1], [429, 'retained', 1], [500, 'retained', 1], [409, 'dead_lettered', 1], [413, 'dead_lettered', 1], [422, 'dead_lettered', 1]]) test(`HTTP ${status} は${action}として観測する`, async () => {
  const box = await sandbox(); const server = await startServer((req, res) => { res.statusCode = status; res.end('{}'); }); await writeReport(box); await writeConfig(box, server.endpoint); await run(box, ['enqueue', '--report', box.report, '--config', box.config]); const result = await run(box, ['flush', '--config', box.config]);
  assert.equal(result.code, exitCode, result.stderr); assert.equal(result.json.ok, exitCode === 0); assert.equal(result.json[action], 1); if (action === 'retained') assert.equal((await readdir(outbox(box))).length, 1); else assert.equal((await readdir(dead(box))).length, 1);
  if (status === 401) { const deferred = await run(box, ['flush', '--config', box.config]); assert.equal(deferred.code, 1); assert.equal(deferred.json.ok, false); assert.equal(deferred.json.deferred, 1); }
  await server.close();
});

test('応答消失後も保存済みbytesを再送し、timeoutは成功扱いにしない', async () => {
  const box = await sandbox(); let calls = 0; const server = await startServer((req, res) => { calls += 1; if (calls === 1) return req.socket.destroy(); accepted(res, report().report_id); }); const bytes = await writeReport(box); await writeConfig(box, server.endpoint); await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const first = await run(box, ['flush', '--config', box.config]); await new Promise((resolve) => setTimeout(resolve, 120)); const second = await run(box, ['flush', '--config', box.config]);
  assert.equal(first.json.retained, 1); assert.equal(second.json.sent, 1); assert.deepEqual(server.received[0].body, bytes); assert.deepEqual(server.received[1].body, bytes); await server.close();
});

test('single-flight lockは並行flushを拒否する', async () => {
  const box = await sandbox(); const server = await startServer(async (req, res) => { await new Promise((resolve) => setTimeout(resolve, 250)); accepted(res, report().report_id); }); await writeReport(box); await writeConfig(box, server.endpoint); await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  const first = run(box, ['flush', '--config', box.config]); await new Promise((resolve) => setTimeout(resolve, 50)); const second = await run(box, ['flush', '--config', box.config]);
  assert.equal(second.code, 1); assert.match(second.stderr, /すでに実行中/); assert.equal((await first).json.sent, 1); await server.close();
});

test('bounded outboxは既存queueを保持したまま新規enqueueを拒否する', async () => {
  const box = await sandbox(); const bytes = await writeReport(box); await writeConfig(box, 'http://127.0.0.1:1/api/factory/v2/reports'); await mkdir(outbox(box), { recursive: true }); for (let index = 0; index < 128; index += 1) await writeFile(join(outbox(box), `queued-${index}.json`), bytes);
  const result = await run(box, ['enqueue', '--report', box.report, '--config', box.config]);
  assert.equal(result.code, 1); assert.match(result.stderr, /outbox上限超過/); assert.equal((await readdir(outbox(box))).length, 128);
});

test('受理後のv2 ack失敗はoutboxを残し非0で観測可能にする', async () => {
  const box = await sandbox(); const server = await startServer((req, res) => accepted(res, report().report_id)); await writeReport(box); await writeConfig(box, server.endpoint);
  await writeFile(box.ack, JSON.stringify({ schema_version: '2.0', report_id: report().report_id, acknowledgements: [{ product: 'gpt-connector', cursor: 1, command: 'gpt-connector', args: ['runtime-errors', 'ack', '1', '--json'] }] }));
  await run(box, ['enqueue', '--report', box.report, '--ack-metadata', box.ack, '--config', box.config]); const result = await run(box, ['flush', '--config', box.config], { PATH: '' });
  assert.equal(result.code, 1); assert.equal(result.json.ok, false); assert.equal(result.json.ack_failed, 1); assert.equal((await readdir(outbox(box))).length, 1); await server.close();
});

test('v2 gpt-connector ack bundleは受理後だけ実行する', async () => {
  const box = await sandbox(); const server = await startServer((req, res) => accepted(res, report().report_id)); await writeReport(box); await writeConfig(box, server.endpoint);
  await writeFile(box.ack, JSON.stringify({ schema_version: '2.0', report_id: report().report_id, acknowledgements: [{ product: 'gpt-connector', cursor: 1, command: 'gpt-connector', args: ['runtime-errors', 'ack', '1', '--json'] }] }));
  const queued = await run(box, ['enqueue', '--report', box.report, '--ack-metadata', box.ack, '--config', box.config]);
  assert.equal(queued.code, 0, queued.stderr); const result = await run(box, ['flush', '--config', box.config], { PATH: '' });
  assert.equal(result.code, 1); assert.equal(result.json.ack_failed, 1); assert.equal((await readdir(outbox(box))).length, 1); await server.close();
});

test('Windows owner-only ACLはパスを明示注入し、SID取得・継承遮断・owner full controlを正規処理に含む', async () => {
  const source = await readSource(CLI, 'utf8');
  assert.match(source, /DOTAGENTS_FACTORY_ACL_TARGET/); assert.match(source, /WindowsIdentity\]::GetCurrent\(\)\.User/); assert.match(source, /Get-Item -LiteralPath \$p/); assert.match(source, /RemoveAccessRuleAll/); assert.doesNotMatch(source, /New-Object Security\.AccessControl\.(?:Directory|File|FileSystem)Security/); assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/); assert.match(source, /FileSystemAccessRule\]::new\(\$sid, \[Security\.AccessControl\.FileSystemRights\]::FullControl/); assert.match(source, /FileSystemAclExtensions\]::GetAccessControl\(.*AccessControlSections\]::Access\)/); assert.match(source, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/); assert.doesNotMatch(source, /Set-Acl /); assert.doesNotMatch(source, /\[IO\.(?:Directory|File)\]::SetAccessControl/); assert.match(source, /ownerOnlyAcl\(target\)/);
});

test('v2 gpt-connector ack成功後だけoutboxを削除する', async () => {
  const box = await sandbox(); const server = await startServer((req, res) => accepted(res, report().report_id)); await writeReport(box); await writeConfig(box, server.endpoint);
  await writeFile(box.ack, JSON.stringify({ schema_version: '2.0', report_id: report().report_id, acknowledgements: [{ product: 'gpt-connector', cursor: 7, command: 'gpt-connector', args: ['runtime-errors', 'ack', '7', '--json'] }] }));
  const bin = join(box.root, 'bin'); await mkdir(bin); const marker = join(box.root, 'ack-called');
  const fake = join(bin, 'gpt-connector'); await writeFile(fake, `#!/bin/sh\nprintf '%s' "$*" > "$ACK_MARKER"\necho '{"status":"acknowledged","acknowledgedThrough":7}'\n`); await chmod(fake, 0o755);
  await run(box, ['enqueue', '--report', box.report, '--ack-metadata', box.ack, '--config', box.config]);
  const result = await run(box, ['flush', '--config', box.config], { PATH: `${bin}:${process.env.PATH}`, ACK_MARKER: marker });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.json.sent, 1); assert.deepEqual(await readdir(outbox(box)), []);
  assert.equal(await readFile(marker, 'utf8'), 'runtime-errors ack 7 --json'); await server.close();
});
