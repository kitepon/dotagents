import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';
import { createFragmentManifest, fragmentEnvelope, validateFragmentManifest } from '../../lib/factory/report-fragments.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reporter = resolve(import.meta.dirname, '../../bin/factory-reporter-v9.mjs');
function report() {
  return { schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904', host_id: 'mac-kite', host_profile: 'mac',
    platform: { os: 'darwin', arch: 'arm64' }, report_mode: 'full', observed_at: '2026-10-27T03:17:00.000Z', created_at: '2026-10-27T03:17:01.000Z',
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' }, products: Object.fromEntries(V9_PRODUCT_IDS.map(id => [id,
      { presence_status: 'missing', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] }])) };
}
function pending(e, received = 1) {
  return { accepted: false, complete: false, fragment_accepted: true, duplicate: false,
    report_id: e.report_id, fragment_id: e.fragment_id, received_fragments: received, fragment_count: e.fragment_count };
}
function completed(e) { return { accepted: true, complete: true, duplicate: false, report_id: e.report_id, report_sha256: e.report_sha256 }; }

test('byte分割はUTF8境界と空白を変えず、HTTP envelope/片数/復号上限も守る', () => {
  const r = report(); const bytes = Buffer.from('星🌟'.repeat(300) + '\n');
  const manifest = createFragmentManifest(r, bytes, 1024);
  assert.ok(manifest.fragment_ids.length > 1);
  assert.equal(validateFragmentManifest(r, bytes, manifest), manifest);
  const chunks = manifest.fragment_ids.map((_, i) => {
    const e = fragmentEnvelope(r, bytes, manifest, i); assert.equal(Object.keys(e).length, 12);
    assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 1024); assert.equal(e.observed_at, r.observed_at); assert.equal(e.created_at, r.created_at);
    const chunk = Buffer.from(e.data_base64, 'base64'); assert.equal(hash(chunk), e.fragment_sha256); return chunk;
  });
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.equal(manifest.report_sha256, hash(bytes));
  assert.throws(() => validateFragmentManifest(r, Buffer.from('different'), manifest), /invalid/u);
  assert.throws(() => validateFragmentManifest(r, bytes, { ...manifest, fragment_ids: manifest.fragment_ids.map(() => manifest.fragment_ids[0]) }), /invalid/u);
  for (const limit of [0, -1, NaN, 1]) assert.throws(() => createFragmentManifest(r, bytes, limit));
  assert.throws(() => createFragmentManifest(r, Buffer.alloc(128 * 1024), 1024), /count_exceeds/u);
  const large = Buffer.alloc(2 * 1024 * 1024); const m = createFragmentManifest(r, large, 64 * 1024 * 1024);
  assert.equal(m.chunk_bytes, 1024 * 1024); assert.equal(m.fragment_ids.length, 2);
});

async function sandbox(t, handler, padding = 0) {
  const root = await mkdtemp(join(tmpdir(), 'factory-fragments-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const ackLog = join(root, 'ack.log'); const ackScript = join(root, 'ack.mjs');
  const ackFail = join(root, 'ack-fail');
  await writeFile(ackScript, `import {appendFileSync,existsSync,unlinkSync} from 'node:fs'; if(existsSync(process.env.FRAGMENT_ACK_FAIL)){unlinkSync(process.env.FRAGMENT_ACK_FAIL);process.exit(17);} appendFileSync(process.env.FRAGMENT_ACK_LOG, 'ack\\n'); console.log(JSON.stringify({ok:true,acknowledged_through:7}));`);
  if (process.platform === 'win32') await writeFile(join(bin, 'factory-external-event.cmd'), `@"${process.execPath}" "${ackScript}" %*\r\n`);
  else { await writeFile(join(bin, 'factory-external-event'), `#!${process.execPath}\nimport('${pathToFileURL(ackScript).href}');\n`); await chmod(join(bin, 'factory-external-event'), 0o755); }
  const bytes = Buffer.from(JSON.stringify(report(), null, 2) + ' '.repeat(padding) + '\n');
  const config = join(root, 'config.json'); const reportPath = join(root, 'report.json'); const ackPath = join(root, 'acks.json');
  await writeFile(reportPath, bytes); await writeFile(join(root, 'token'), 'fixture-token\n');
  await writeFile(ackPath, JSON.stringify({ schema_version: '9.0', report_id: report().report_id, acknowledgements:
    [{ product: 'servermanager', cursor: 7, command: 'factory-external-event', args: ['ack', '--cursor', '7', '--json'] }] }));
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks); const body = JSON.parse(raw); requests.push({ url: request.url, raw, body });
      await handler(request, response, body, raw);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ fixture_error: String(error) })); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => server.close(done)));
  await writeFile(config, JSON.stringify({ schema_version: '1.0', host: { id: 'mac-kite', profile: 'mac' }, collection: { enabled: true }, reporting:
    { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}/api/factory/v9/reports`, credential_file: join(root, 'token') } }));
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state'),
    PATH: bin + delimiter + process.env.PATH, FRAGMENT_ACK_LOG: ackLog, FRAGMENT_ACK_FAIL: ackFail };
  const run = args => new Promise(done => {
    const child = spawn(process.execPath, [reporter, ...args, '--config', config], { env }); let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('close', code => done({ code, stderr, json: JSON.parse(stdout) }));
  });
  assert.equal((await run(['enqueue', '--report', reportPath, '--ack-metadata', ackPath])).code, 0);
  const state = join(root, 'state', 'dotagents', 'factory-reporter-v9');
  const queued = join(state, 'outbox', `${report().report_id}.json`);
  const manifestPath = join(state, 'retry', `${report().report_id}.json.fragments`);
  const flush = async () => { await writeFile(join(state, 'retry', `${report().report_id}.json`), JSON.stringify({ attempt: 0, next_retry_at: 0 })); return run(['flush']); };
  return { root, state, bytes, requests, ackLog, ackFail, queued, manifestPath, flush };
}
function reply(response, status, body) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

test('大きい原本の413→部分失敗→staging失効→終端消失→固定片再送後の全受理でだけACKする', async t => {
  let box; let phase = 0; const staged = new Map(); let wholeAccepted = false;
  box = await sandbox(t, async (request, response, e, raw) => {
    if (request.url.endsWith('/reports')) return reply(response, 413, { error: 'report_too_large', limit_bytes: 128 * 1024, split_supported: true });
    assert.ok(raw.length <= 128 * 1024); assert.equal(e.report_sha256, hash(box.bytes));
    assert.equal(e.fragment_sha256, hash(Buffer.from(e.data_base64, 'base64')));
    if (wholeAccepted) return reply(response, 200, { ...completed(e), duplicate: true });
    if (phase === 0 && e.fragment_index === 2) return reply(response, 503, { error: 'fragment_store_full' });
    staged.set(e.fragment_index, Buffer.from(e.data_base64, 'base64'));
    if (staged.size < e.fragment_count) return reply(response, 202, pending(e, staged.size));
    assert.deepEqual(Buffer.concat([...staged].sort((a, b) => a[0] - b[0]).map(x => x[1])), box.bytes);
    wholeAccepted = true; request.socket.destroy();
  }, 2 * 1024 * 1024 + 1);
  const originalEnvelope = await readFile(box.queued);
  const first = await box.flush(); assert.equal(first.code, 1);
  const contexts = first.stderr.split('\n').filter(line => line.startsWith('[dotagents-runtime-context] '))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.deepEqual(contexts.map(context => context.consumer), ['reporter', 'reporter-fragments']);
  for (const context of contexts) {
    assert.equal(context.report_id, report().report_id); assert.equal(context.exec_path, process.execPath);
    assert.equal(context.node_version, process.version); assert.equal(context.initial_transport, 'http');
    assert.equal(context.evidence_scope, 'current_process_configuration_only');
  }
  assert.equal(contexts[0].pid, contexts[1].pid);
  assert.doesNotMatch(first.stderr, /fixture-token/u);
  await assert.rejects(readFile(box.ackLog), { code: 'ENOENT' });
  assert.deepEqual(await readFile(box.queued), originalEnvelope);
  const manifestBytes = await readFile(box.manifestPath); const manifest = JSON.parse(manifestBytes);
  staged.clear(); phase = 1;
  assert.equal((await box.flush()).code, 1);
  await assert.rejects(readFile(box.ackLog), { code: 'ENOENT' });
  assert.deepEqual(await readFile(box.manifestPath), manifestBytes);
  const done = await box.flush(); assert.equal(done.code, 0, done.stderr); assert.equal(done.json.sent, 1);
  assert.equal(await readFile(box.ackLog, 'utf8'), 'ack\n');
  assert.deepEqual(await readdir(join(box.state, 'outbox')), []); await assert.rejects(readFile(box.manifestPath), { code: 'ENOENT' });
  assert.equal(box.requests.filter(x => x.url.endsWith('/reports')).length, 1);
  for (const { body } of box.requests.filter(x => x.url.endsWith('/report-fragments'))) assert.equal(body.fragment_id, manifest.fragment_ids[body.fragment_index]);
});

for (const outcome of ['all202', 'wrong-sha', 'incomplete200', 'conflict409', 'limit413', 'invalid422', 'capacity503']) {
  test(`fragment ${outcome}では原本/manifestを残しACKしない`, async t => {
    const box = await sandbox(t, (request, response, e) => {
      if (request.url.endsWith('/reports')) return reply(response, 413, { error: 'report_too_large', limit_bytes: 1200, split_supported: true });
      if (outcome === 'all202') return reply(response, 202, pending(e, e.fragment_count));
      if (outcome === 'wrong-sha') return reply(response, 200, { ...completed(e), report_sha256: 'f'.repeat(64) });
      if (outcome === 'incomplete200') return reply(response, 200, { ...completed(e), complete: false });
      reply(response, Number(outcome.slice(-3)), { error: 'fixture_private_text_must_not_be_logged' });
    });
    const original = await readFile(box.queued); const result = await box.flush(); assert.equal(result.code, 1);
    assert.equal(result.json.retained, 1); assert.equal(result.json.dead_lettered, 0);
    assert.deepEqual(await readFile(box.queued), original); assert.ok((await readFile(box.manifestPath)).length > 0);
    await assert.rejects(readFile(box.ackLog), { code: 'ENOENT' });
    assert.doesNotMatch(result.stderr, /fixture_private_text_must_not_be_logged|fixture-token/u);
  });
}

test('改変されたmanifestはnetwork/ACKなしで保持する', async t => {
  const box = await sandbox(t, (request, response, e) => request.url.endsWith('/reports')
    ? reply(response, 413, { error: 'report_too_large', limit_bytes: 1200, split_supported: true })
    : reply(response, 503, {}));
  await box.flush(); const manifest = JSON.parse(await readFile(box.manifestPath)); manifest.report_sha256 = '0'.repeat(64);
  await writeFile(box.manifestPath, JSON.stringify(manifest)); const before = box.requests.length;
  const result = await box.flush(); assert.equal(result.code, 1); assert.equal(box.requests.length, before);
  assert.match(result.stderr, /fragment_manifest_invalid/u); await assert.rejects(readFile(box.ackLog), { code: 'ENOENT' });
});

test('全受理後の製品ACK失敗でも原本を保持し、同manifestのduplicate終端から復帰する', async t => {
  const box = await sandbox(t, (request, response, e) => request.url.endsWith('/reports')
    ? reply(response, 413, { error: 'report_too_large', limit_bytes: 1200, split_supported: true })
    : reply(response, 200, completed(e)));
  await writeFile(box.ackFail, 'fail-once');
  const first = await box.flush(); assert.equal(first.code, 1); assert.equal(first.json.ack_failed, 1);
  await readFile(box.queued); const manifest = await readFile(box.manifestPath);
  const done = await box.flush(); assert.equal(done.code, 0, done.stderr);
  assert.equal(await readFile(box.ackLog, 'utf8'), 'ack\n');
  const fragments = box.requests.filter(x => x.url.endsWith('/report-fragments'));
  assert.equal(fragments.length, 2); assert.deepEqual(fragments[0].raw, fragments[1].raw);
  assert.ok(manifest.length > 0); assert.deepEqual(await readdir(join(box.state, 'outbox')), []);
});
