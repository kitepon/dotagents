import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  applyRun, buildReport, emptyState, markAccepted, messageTemplate, requestSignature, responseSignature,
  stepFingerprint, updateFailurePaths, versionFromRevision,
} from '../../lib/factory/update-failure-report.mjs';

const CLI = resolve('bin/factory-update-failure-report.mjs');
const SECRET = 'bughub-test-secret-do-not-use-0123456789abcdef';
const VERSION = '0.0.0+e31ce55';
const posixOnly = { skip: process.platform === 'win32' };

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'update-failure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') };
  return { home, env, paths: updateFailurePaths(env) };
}

function run(env, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null }));
  });
}

async function placeCredential(paths, url, mode = 0o600) {
  await mkdir(join(paths.credential, '..'), { recursive: true, mode: 0o700 });
  await writeFile(paths.credential, JSON.stringify({ url, key_id: 'test-host.dotagents.0001', secret: SECRET }), { mode });
  await chmod(paths.credential, mode);
}

// BugHubの受け口の代わり。届いた要求を控え、reply(report)が返す応答を返す。
async function intake(t, reply) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ authorization: request.headers.authorization, body, report: JSON.parse(body.toString('utf8')) });
      const { status = 200, headers = {}, payload } = reply(requests.at(-1).report);
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise((done) => { server.listen(0, '127.0.0.1', done); });
  t.after(() => new Promise((done) => { server.close(done); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}/api/products/v1/runtime-errors` };
}

const accepted = (report, receivedAt = '2026-10-03T12:00:00.000Z') => ({
  payload: { accepted: true, report_id: report.report_id, duplicate: false, received_at: receivedAt, sig: responseSignature(SECRET, report.report_id, receivedAt) },
});

test('署名は、BugHubの契約の試験値と一致する', () => {
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}', 'utf8');
  assert.equal(body.length, 205);
  assert.equal(requestSignature(SECRET, '1790000000', body), 'e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a');
  assert.equal(responseSignature(SECRET, '00000000-0000-4000-8000-000000000001', '2026-09-21T14:13:21.000Z'), 'cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb');
});

test('失敗した手順は回数が累計になり、成功した回で解決済みになり、また失敗すれば開き直る', () => {
  const first = applyRun(emptyState(), { ran: ['setup.gpt-connector', 'typesafe'], failed: ['setup.gpt-connector'], now: '2026-10-01T17:00:30.000Z', version: VERSION });
  const second = applyRun(first, { ran: ['setup.gpt-connector', 'typesafe'], failed: ['setup.gpt-connector'], now: '2026-10-02T17:00:30.000Z', version: VERSION });
  assert.deepEqual(Object.keys(second.records), ['setup.gpt-connector']);
  assert.equal(second.records['setup.gpt-connector'].occurrence_count, 2);
  assert.equal(second.records['setup.gpt-connector'].first_seen, '2026-10-01T17:00:30.000Z');
  assert.equal(second.unsent, true);

  const report = buildReport(second, { observedAt: '2026-10-02T17:00:31.000Z', version: VERSION, reportId: '00000000-0000-4000-8000-000000000002' });
  assert.deepEqual(report, {
    schema_version: '1.0',
    report_id: '00000000-0000-4000-8000-000000000002',
    product_id: 'dotagents',
    installed_version: VERSION,
    observed_at: '2026-10-02T17:00:31.000Z',
    runtime_errors: [{
      fingerprint: stepFingerprint('setup.gpt-connector'),
      error_code: 'UPDATE_STEP_FAILED',
      component: 'setup.gpt-connector',
      message_template: 'dotagents update step failed: setup.gpt-connector',
      severity: 'high',
      status: 'open',
      occurrence_count: 2,
      first_seen: '2026-10-01T17:00:30.000Z',
      last_seen: '2026-10-02T17:00:30.000Z',
      product_version: VERSION,
    }],
    resolutions: [],
  });
  assert.match(report.runtime_errors[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(stepFingerprint('setup.gpt-connector'), stepFingerprint('setup.aiterm'));

  // 今回動かなかった手順は、解決済みにしない。
  const untouched = applyRun(second, { ran: ['typesafe'], failed: [], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  assert.equal(untouched.records['setup.gpt-connector'].status, 'open');

  const recovered = applyRun(markAccepted(second, report, '2026-10-02T17:00:31.000Z'), { ran: ['setup.gpt-connector'], failed: [], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  assert.equal(recovered.unsent, true);
  const resolvedReport = buildReport(recovered, { observedAt: '2026-10-03T17:00:31.000Z', version: VERSION });
  assert.equal(resolvedReport.runtime_errors[0].status, 'resolved');
  assert.deepEqual(resolvedReport.resolutions, [{ fingerprint: stepFingerprint('setup.gpt-connector'), resolved_at: '2026-10-03T17:00:30.000Z', reason_code: 'recovered' }]);

  // 受け取られた解決は、もう載せない。また失敗したら、回数を続きから数えて開き直す。
  const delivered = markAccepted(recovered, resolvedReport, '2026-10-03T17:00:31.000Z');
  assert.equal(delivered.unsent, false);
  assert.deepEqual(buildReport(delivered, { observedAt: '2026-10-03T18:00:00.000Z', version: VERSION }).runtime_errors, []);
  const reopened = applyRun(delivered, { ran: ['setup.gpt-connector'], failed: ['setup.gpt-connector'], now: '2026-10-04T17:00:30.000Z', version: VERSION });
  assert.equal(reopened.records['setup.gpt-connector'].status, 'open');
  assert.equal(reopened.records['setup.gpt-connector'].occurrence_count, 3);
  assert.equal(reopened.records['setup.gpt-connector'].first_seen, '2026-10-01T17:00:30.000Z');
});

test('端末の時計が戻っても、記録の時刻は前へ戻らない', () => {
  const failed = applyRun(emptyState(), { ran: ['jev'], failed: ['jev'], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  const again = applyRun(failed, { ran: ['jev'], failed: ['jev'], now: '2026-10-01T17:00:30.000Z', version: VERSION });
  assert.equal(again.records.jev.last_seen, '2026-10-03T17:00:30.000Z');
  assert.equal(again.records.jev.occurrence_count, 2);
  const recovered = applyRun(again, { ran: ['jev'], failed: [], now: '2026-10-02T17:00:30.000Z', version: VERSION });
  assert.equal(recovered.records.jev.resolved_at, '2026-10-03T17:00:30.000Z');
  const reopened = applyRun(recovered, { ran: ['jev'], failed: ['jev'], now: '2026-10-02T18:00:00.000Z', version: VERSION });
  assert.equal(reopened.records.jev.last_seen, '2026-10-03T17:00:30.000Z');
});

test('報告に載る値は、BugHubの受け口が受ける形に収まる', () => {
  const state = applyRun(emptyState(), { ran: ['package.quolu.lattice'], failed: ['package.quolu.lattice'], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  const [record] = buildReport(state, { observedAt: '2026-10-03T17:00:31.000Z', version: VERSION }).runtime_errors;
  assert.match(record.error_code, /^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/);
  assert.match(record.component, /^[a-z0-9][a-z0-9._-]*$/);
  assert.ok(record.component.length <= 64);
  assert.equal(record.message_template, messageTemplate('package.quolu.lattice'));
  assert.deepEqual(Object.keys(record).sort(), ['component', 'error_code', 'fingerprint', 'first_seen', 'last_seen', 'message_template', 'occurrence_count', 'product_version', 'severity', 'status']);
  assert.equal(versionFromRevision('e31ce55'), '0.0.0+e31ce55');
  assert.equal(versionFromRevision(''), '0.0.0+unknown');
});

test('送信を有効にしていない端末では、記録だけして何も送らない', async (t) => {
  const { env, paths } = await workspace(t);
  const receiver = await intake(t, accepted);
  await placeCredential(paths, receiver.url);
  const result = await run(env, ['record', '--ran', 'typesafe', '--ran', 'setup.aiterm', '--failed', 'setup.aiterm']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json, { ok: true, command: 'record', failed_steps: ['setup.aiterm'], open_steps: ['setup.aiterm'], reporting: 'disabled', outcome: 'not_sent' });
  assert.equal(receiver.requests.length, 0);
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.records['setup.aiterm'].occurrence_count, 1);
  assert.equal(state.unsent, true);
  if (process.platform !== 'win32') assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
});

test('失敗が無く記録も無い端末では、記録のファイルを作らない', async (t) => {
  const { env, paths } = await workspace(t);
  const result = await run(env, ['record', '--ran', 'typesafe']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json.open_steps, []);
  await assert.rejects(stat(paths.state));
});

test('有効な端末は署名を付けて1か所へ送り、受領されたら解決まで届ける', async (t) => {
  const { env, paths } = await workspace(t);
  const receiver = await intake(t, accepted);
  await placeCredential(paths, receiver.url);
  assert.equal((await run(env, ['enable'])).json.reporting, 'enabled');

  const failed = await run(env, ['record', '--ran', 'setup.gpt-connector', '--ran', 'setup.aiterm', '--failed', 'setup.gpt-connector', '--failed', 'setup.aiterm']);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(failed.json.outcome, 'accepted');
  assert.equal(receiver.requests.length, 1);
  const [first] = receiver.requests;
  const header = /^BugHub-HMAC-SHA256 key_id=test-host\.dotagents\.0001, ts=(\d+), sig=([0-9a-f]{64})$/.exec(first.authorization);
  assert.ok(header, first.authorization);
  assert.equal(header[2], requestSignature(SECRET, header[1], first.body));
  assert.ok(Math.abs(Date.parse(first.report.observed_at) - Number(header[1]) * 1000) < 1000);
  assert.equal(first.report.product_id, 'dotagents');
  assert.match(first.report.installed_version, /^0\.0\.0\+[0-9a-f]{7}$/);
  // 製品ごとに届け先を分けない。1回の送信に、その端末の全手順をまとめて載せる。
  assert.deepEqual(first.report.runtime_errors.map((item) => item.component), ['setup.aiterm', 'setup.gpt-connector']);

  // 受領済みで変化が無ければ、送らない。
  assert.equal((await run(env, ['flush'])).json.outcome, 'nothing_to_send');
  assert.equal(receiver.requests.length, 1);

  const recovered = await run(env, ['record', '--ran', 'setup.gpt-connector', '--ran', 'setup.aiterm', '--failed', 'setup.aiterm']);
  assert.equal(recovered.json.outcome, 'accepted');
  assert.deepEqual(recovered.json.open_steps, ['setup.aiterm']);
  const second = receiver.requests[1].report;
  assert.deepEqual(second.runtime_errors.map((item) => [item.component, item.status, item.occurrence_count]), [['setup.aiterm', 'open', 2], ['setup.gpt-connector', 'resolved', 1]]);
  assert.deepEqual(second.resolutions.map((item) => item.reason_code), ['recovered']);

  const status = (await run(env, ['status'])).json;
  assert.equal(status.reporting, 'enabled');
  assert.equal(status.unsent, false);
  assert.equal(status.last_outcome, 'accepted');
  assert.deepEqual(status.open_steps, ['setup.aiterm']);
});

test('verifyは記録に触れず、空の報告で合鍵と宛先と応答の署名を確かめる', async (t) => {
  const { env, paths } = await workspace(t);
  let reply = accepted;
  const receiver = await intake(t, (report) => reply(report));
  await placeCredential(paths, receiver.url);

  // 送信を有効にしていない端末では送らない。
  const disabled = await run(env, ['verify']);
  assert.equal(disabled.code, 1);
  assert.deepEqual(disabled.json, { ok: false, command: 'verify', reporting: 'disabled', outcome: 'not_sent' });
  assert.equal(receiver.requests.length, 0);

  await run(env, ['enable']);
  const verified = await run(env, ['verify']);
  assert.equal(verified.code, 0, verified.stderr);
  assert.deepEqual(verified.json, { ok: true, command: 'verify', reporting: 'enabled', outcome: 'accepted' });
  assert.deepEqual(receiver.requests[0].report.runtime_errors, []);
  assert.deepEqual(receiver.requests[0].report.resolutions, []);
  await assert.rejects(stat(paths.state));

  reply = (report) => ({ payload: { accepted: true, report_id: report.report_id, received_at: '2026-10-03T12:00:00.000Z', sig: 'f'.repeat(64) } });
  const forged = await run(env, ['verify']);
  assert.equal(forged.code, 1);
  assert.equal(forged.json.outcome, 'response_unverified');
});

test('受領を確かめられない応答では、送信待ちのまま残す', async (t) => {
  const { env, paths } = await workspace(t);
  let reply = (report) => ({ payload: { accepted: true, report_id: report.report_id, received_at: '2026-10-03T12:00:00.000Z', sig: '0'.repeat(64) } });
  const receiver = await intake(t, (report) => reply(report));
  await placeCredential(paths, receiver.url);
  await run(env, ['enable']);

  assert.equal((await run(env, ['record', '--ran', 'jev', '--failed', 'jev'])).json.outcome, 'response_unverified');
  assert.equal(JSON.parse(await readFile(paths.state, 'utf8')).unsent, true);

  reply = () => ({ status: 422, payload: { error: 'invalid_report', violations: [] } });
  assert.equal((await run(env, ['flush'])).json.outcome, 'invalid_report');

  // 転送には従わない。
  reply = () => ({ status: 302, headers: { location: receiver.url } });
  assert.equal((await run(env, ['flush'])).json.outcome, 'http_302');

  reply = accepted;
  assert.equal((await run(env, ['flush'])).json.outcome, 'accepted');
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.unsent, false);
  assert.equal(state.records.jev.occurrence_count, 1);
});

test('届かない宛先でも記録は残り、次に送れる', async (t) => {
  const { env, paths } = await workspace(t);
  await placeCredential(paths, 'http://127.0.0.1:1/api/products/v1/runtime-errors');
  await run(env, ['enable']);
  const result = await run(env, ['record', '--ran', 'markitdown', '--failed', 'markitdown']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.outcome, 'unreachable');
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.unsent, true);
  assert.equal(state.last_outcome, 'unreachable');
});

test('合鍵が本人だけのものでない時は送らない', posixOnly, async (t) => {
  const { env, paths } = await workspace(t);
  const receiver = await intake(t, accepted);
  await run(env, ['enable']);
  assert.equal((await run(env, ['status'])).json.reporting, 'credential_missing');

  await placeCredential(paths, receiver.url, 0o644);
  assert.equal((await run(env, ['record', '--ran', 'unai', '--failed', 'unai'])).json.reporting, 'credential_unsafe');

  await rm(paths.credential);
  const target = join(paths.credential, '..', 'target.json');
  await writeFile(target, JSON.stringify({ url: receiver.url, key_id: 'test-host.dotagents.0001', secret: SECRET }), { mode: 0o600 });
  await symlink(target, paths.credential);
  assert.equal((await run(env, ['status'])).json.reporting, 'credential_unsafe');

  await rm(paths.credential);
  await writeFile(paths.credential, JSON.stringify({ url: receiver.url, key_id: 'test-host.dotagents.0001', secret: 'short' }), { mode: 0o600 });
  assert.equal((await run(env, ['status'])).json.reporting, 'credential_invalid');
  assert.equal(receiver.requests.length, 0);
});

test('不正な引数と壊れた記録は、既存のファイルを書き換えずに断る', async (t) => {
  const { env, paths } = await workspace(t);
  for (const args of [['record', '--ran'], ['record', '--failed', 'Setup.Bad'], ['record', '--failed', '/etc/passwd'], ['record', '--unknown', 'x'], ['flush', 'extra'], []]) {
    assert.equal((await run(env, args)).code, 1, args.join(' '));
  }
  await assert.rejects(stat(paths.state));

  await mkdir(join(paths.state, '..'), { recursive: true });
  await writeFile(paths.state, '{broken');
  const result = await run(env, ['record', '--ran', 'jev', '--failed', 'jev']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /state_invalid/);
  assert.equal(await readFile(paths.state, 'utf8'), '{broken');
});
