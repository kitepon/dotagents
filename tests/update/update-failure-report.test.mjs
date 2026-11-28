import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import {
  applyRun, buildReport, emptyState, markAccepted, messageTemplate, requestSigningText, responseVerified,
  BUGHUB_RESPONSE_KEY, runEvidence, stepFingerprint, updateFailurePaths, versionFromRevision,
} from '../../lib/factory/update-failure-report.mjs';

const CLI = resolve('bin/factory-update-failure-report.mjs');
// 認証仲介（要求の署名）とBugHub（応答の署名）の代わりの試験用の鍵。実際の鍵は端末に来ない。
const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const REQUEST_KEYS = keyPair();
const RESPONSE_KEYS = keyPair();
const pem = (key) => key.export({ type: 'spki', format: 'pem' });
const SIGN_OPTIONS = (key) => ({ key, dsaEncoding: 'ieee-p1363' });
const esSign = (privateKey, text) => sign('sha256', Buffer.from(text, 'utf8'), SIGN_OPTIONS(privateKey)).toString('base64');
const ITEM = 'bughub-product-dotagents-test-host';
const VERSION = '0.0.0+e31ce55';
const posixOnly = { skip: process.platform === 'win32' };

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'update-failure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  // 認証仲介の中継（main-serverへのssh）の代わり。標準入力を試験用の鍵でES256署名し、呼ばれた命令をssh.logへ残す。
  await writeFile(join(bin, 'ssh'), `#!/usr/bin/env node
const fs = require('fs'); const crypto = require('crypto');
fs.appendFileSync(${JSON.stringify(join(home, 'ssh.log'))}, process.argv.at(-1) + '\\n');
process.stdout.write(crypto.sign('sha256', fs.readFileSync(0), { key: ${JSON.stringify(REQUEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }))}, dsaEncoding: 'ieee-p1363' }).toString('base64'));
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') };
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
  await writeFile(paths.credential, JSON.stringify({ url, key_id: 'test-host.dotagents.es256-0001', sign_item: ITEM, response_key: pem(RESPONSE_KEYS.publicKey) }), { mode });
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
  payload: { accepted: true, report_id: report.report_id, duplicate: false, received_at: receivedAt, sig: esSign(RESPONSE_KEYS.privateKey, `${report.report_id}\n${receivedAt}`), sig_alg: 'ES256' },
});

test('応答の署名は、BugHubの公開鍵でES256として確かめる。方式・本文・鍵・形が違えば受領にしない', () => {
  const text = '00000000-0000-4000-8000-000000000001\n2026-09-21T14:13:21.000Z';
  const good = esSign(RESPONSE_KEYS.privateKey, text);
  const key = pem(RESPONSE_KEYS.publicKey);
  assert.equal(good.length, 88);
  assert.equal(responseVerified(key, good, 'ES256', text), true);
  assert.equal(responseVerified(key, good, 'ES256', text.replace('13:21', '13:22')), false);
  assert.equal(responseVerified(key, good, 'HS256', text), false);
  assert.equal(responseVerified(key, good, undefined, text), false);
  assert.equal(responseVerified(key, esSign(REQUEST_KEYS.privateKey, text), 'ES256', text), false);
  assert.equal(responseVerified(key, 'f'.repeat(64), 'ES256', text), false);
  assert.equal(responseVerified('not a key', good, 'ES256', text), false);
  // 要求の署名文字列は、tsと本文のSHA-256（HMAC時代と同じ）。
  assert.equal(requestSigningText('1790000000', Buffer.from('x')), `1790000000\n${createHash('sha256').update('x').digest('hex')}`);
  // 配るBugHubの公開鍵は、P-256の公開鍵として読める。
  assert.match(BUGHUB_RESPONSE_KEY, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.equal(responseVerified(BUGHUB_RESPONSE_KEY, good, 'ES256', text), false);
});

test('失敗した手順は回数が累計になり、成功した回で解決済みになり、また失敗すれば開き直る', () => {
  const first = applyRun(emptyState(), { ran: ['setup.peertable', 'typesafe'], failed: ['setup.peertable'], now: '2026-10-01T17:00:30.000Z', version: VERSION });
  const second = applyRun(first, { ran: ['setup.peertable', 'typesafe'], failed: ['setup.peertable'], now: '2026-10-02T17:00:30.000Z', version: VERSION });
  assert.deepEqual(Object.keys(second.records), ['setup.peertable']);
  assert.equal(second.records['setup.peertable'].occurrence_count, 2);
  assert.equal(second.records['setup.peertable'].first_seen, '2026-10-01T17:00:30.000Z');
  assert.equal(second.unsent, true);

  const report = buildReport(second, { observedAt: '2026-10-02T17:00:31.000Z', version: VERSION, reportId: '00000000-0000-4000-8000-000000000002' });
  assert.deepEqual(report, {
    schema_version: '1.0',
    report_id: '00000000-0000-4000-8000-000000000002',
    product_id: 'dotagents',
    installed_version: VERSION,
    observed_at: '2026-10-02T17:00:31.000Z',
    runtime_errors: [{
      fingerprint: stepFingerprint('setup.peertable'),
      error_code: 'UPDATE_STEP_FAILED',
      component: 'setup.peertable',
      message_template: 'dotagents update step failed: setup.peertable',
      severity: 'warn',
      status: 'open',
      occurrence_count: 2,
      first_seen: '2026-10-01T17:00:30.000Z',
      last_seen: '2026-10-02T17:00:30.000Z',
      product_version: VERSION,
    }],
    resolutions: [],
  });
  assert.match(report.runtime_errors[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(stepFingerprint('setup.peertable'), stepFingerprint('setup.aiterm'));

  // 今回動かなかった手順は、解決済みにしない。
  const untouched = applyRun(second, { ran: ['typesafe'], failed: [], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  assert.equal(untouched.records['setup.peertable'].status, 'open');

  const recovered = applyRun(markAccepted(second, report, '2026-10-02T17:00:31.000Z'), { ran: ['setup.peertable'], failed: [], now: '2026-10-03T17:00:30.000Z', version: VERSION });
  assert.equal(recovered.unsent, true);
  const resolvedReport = buildReport(recovered, { observedAt: '2026-10-03T17:00:31.000Z', version: VERSION });
  assert.equal(resolvedReport.runtime_errors[0].status, 'resolved');
  assert.deepEqual(resolvedReport.resolutions, [{ fingerprint: stepFingerprint('setup.peertable'), resolved_at: '2026-10-03T17:00:30.000Z', reason_code: 'recovered' }]);

  // 受け取られた解決は、もう載せない。また失敗したら、回数を続きから数えて開き直す。
  const delivered = markAccepted(recovered, resolvedReport, '2026-10-03T17:00:31.000Z');
  assert.equal(delivered.unsent, false);
  assert.deepEqual(buildReport(delivered, { observedAt: '2026-10-03T18:00:00.000Z', version: VERSION }).runtime_errors, []);
  const reopened = applyRun(delivered, { ran: ['setup.peertable'], failed: ['setup.peertable'], now: '2026-10-04T17:00:30.000Z', version: VERSION });
  assert.equal(reopened.records['setup.peertable'].status, 'open');
  assert.equal(reopened.records['setup.peertable'].occurrence_count, 3);
  assert.equal(reopened.records['setup.peertable'].first_seen, '2026-10-01T17:00:30.000Z');
});

const OBSERVED = '2026-10-03T17:00:00.000Z';
const missing = (...products) => ({ state: 'stopped', products, failed_checks: [], observed_at: OBSERVED });
const launchable = (products, failedChecks = []) => ({ state: 'launchable', products, failed_checks: failedChecks, observed_at: OBSERVED });

test('重大度は、失敗が続いた事だけでは上げず、製品を起動できない事を確かめた時だけhighにする', () => {
  const severity = (state) => buildReport(state, { observedAt: '2026-10-09T00:00:00.000Z', version: VERSION }).runtime_errors[0].severity;
  const run = (state, now, evidence) => applyRun(state, { ran: ['markitdown'], failed: ['markitdown'], evidence: evidence ? { markitdown: evidence } : {}, now, version: VERSION });
  // 1回目は、製品を起動できなくても次の回が再試行する。起動できない事は工場のreportが製品の名前で運ぶ。
  const first = run(emptyState(), '2026-10-01T17:00:30.000Z', missing('markitdown'));
  assert.equal(severity(first), 'warn');
  // 再試行も失敗した、というだけでは実害の根拠にならない。
  const repeated = run(first, '2026-10-02T17:00:30.000Z');
  assert.equal(severity(repeated), 'warn');
  assert.equal(repeated.records.markitdown.occurrence_count, 2);
  // 再試行でも直らず、その手順が担う製品を起動できない事をこの回のreportで確かめた時はhigh。根拠も端末の記録に残す。
  const stopped = run(repeated, '2026-10-03T17:00:30.000Z', missing('markitdown'));
  assert.equal(severity(stopped), 'high');
  assert.deepEqual(stopped.records.markitdown.evidence, missing('markitdown'));
  // 動かなかった回は記録に触れない。
  assert.equal(severity(applyRun(stopped, { ran: ['typesafe'], failed: [], now: '2026-10-04T17:00:30.000Z', version: VERSION })), 'high');
  // 新しい観測が無い回（reportを読めない・古い・製品の状態が未確認）は、確かめた重大影響を保持する。根拠も前の観測のまま。
  const unobserved = run(stopped, '2026-10-04T17:00:30.000Z');
  assert.equal(severity(unobserved), 'high');
  assert.deepEqual(unobserved.records.markitdown.evidence, missing('markitdown'));
  assert.equal(unobserved.records.markitdown.occurrence_count, 4);
  // 起動できる事を正に観測した回だけ、根拠を付けて評価し直す。checkのfailが残っていても、全体の利用不能とは扱わない。
  const relaunched = run(unobserved, '2026-10-05T17:00:30.000Z', launchable(['markitdown'], ['markitdown:local_fixture']));
  assert.equal(severity(relaunched), 'warn');
  assert.deepEqual(relaunched.records.markitdown.evidence, launchable(['markitdown'], ['markitdown:local_fixture']));
  // 解決を届ける記録は、解決した時の重大度のまま載せる。直ったあとの失敗は新しい1回目で、前の根拠を引き継がない。
  const recovered = applyRun(stopped, { ran: ['markitdown'], failed: [], now: '2026-10-05T17:00:30.000Z', version: VERSION });
  assert.equal(severity(recovered), 'high');
  const reopened = run(recovered, '2026-10-06T17:00:30.000Z');
  assert.equal(severity(reopened), 'warn');
  assert.equal(reopened.records.markitdown.evidence, undefined);
  assert.equal(reopened.records.markitdown.occurrence_count, 4);
});

test('評価していない以前のhighは、新しい観測が無い失敗では保持し、起動できる事を確かめた回だけ評価し直す', () => {
  const legacy = { occurrence_count: 2, first_seen: '2026-10-01T17:00:30.000Z', last_seen: '2026-10-02T17:00:30.000Z', status: 'open', resolved_at: null, resolution_unsent: false, product_version: VERSION };
  const state = { ...emptyState(), records: { markitdown: legacy } };
  const severity = (next) => buildReport(next, { observedAt: '2026-10-09T00:00:00.000Z', version: VERSION }).runtime_errors[0].severity;
  const run = (evidence) => applyRun(state, { ran: ['markitdown'], failed: ['markitdown'], evidence, now: '2026-10-03T17:00:30.000Z', version: VERSION });
  assert.equal(severity(run({})), 'high');
  assert.equal(severity(run({ markitdown: missing('markitdown') })), 'high');
  assert.equal(severity(run({ markitdown: launchable(['markitdown']) })), 'warn');
});

test('根拠は、この回のreportで製品を起動できたかどうかだけから読む', () => {
  const product = (extra) => ({ presence_status: 'installed', installed_version: '1.0.0', compatibility_status: 'compatible', checks: [{ check_id: 'native_diagnostics', status: 'pass' }], ...extra });
  const report = { observed_at: OBSERVED, products: {
    // 起動できるがcheckがfailの製品: 版照会・期待値検査・診断の失敗は、全体の利用不能の根拠にしない。failしたcheckは根拠として残す。
    caveat: product({ compatibility_status: 'incompatible', checks: [{ check_id: 'native_diagnostics', status: 'fail', severity: 'high' }] }),
    unai: product({ compatibility_status: 'incompatible', checks: [{ check_id: 'manifest', status: 'pass' }, { check_id: 'skill_projection_cursor', status: 'fail', severity: 'high' }] }),
    markitdown: product({ presence_status: 'missing', installed_version: undefined, checks: [{ check_id: 'version', status: 'unverified', reason_code: 'cli_unavailable' }] }),
    lattice: product({}),
    // 版を読めなかった製品は、起動できるとも、できないとも確かめていない。
    throughline: { presence_status: 'unverified', checks: [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_timeout' }] },
    'jev-ultrafast': product({ compatibility_status: 'unverified', checks: [{ check_id: 'installation', status: 'pass' }] }),
    'agent-desktop': { presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [{ check_id: 'platform', status: 'skipped', reason_code: 'upstream_unsupported' }] },
  } };
  const failed = ['setup.caveat', 'unai', 'markitdown', 'setup.lattice', 'package.throughline', 'jev', 'setup.peertable', 'typesafe', 'npm', 'factory-report', 'package.pnpm'];
  assert.deepEqual(runEvidence(report, failed), {
    'setup.caveat': launchable(['caveat'], ['caveat:native_diagnostics']),
    unai: launchable(['unai'], ['unai:skill_projection_cursor']),
    markitdown: missing('markitdown'),
    'setup.lattice': launchable(['lattice']),
    // 対象外の製品（このOSのagent-desktop）は数えない。
    jev: launchable(['jev-ultrafast']),
  });
  // 起動できない製品が1つでもあれば、その手順は「起動できない」。
  const partial = structuredClone(report); partial.products['agent-desktop'] = { presence_status: 'missing', checks: [] };
  assert.deepEqual(runEvidence(partial, ['jev']), { jev: missing('agent-desktop') });
  // reportを読めない回、観測時刻の無いreportは、何も確かめられていない。
  assert.deepEqual(runEvidence(null, failed), {});
  assert.deepEqual(runEvidence({ products: report.products }, failed), {});
  assert.deepEqual(runEvidence({ observed_at: OBSERVED, products: 'broken' }, failed), {});
});

test('recordは、この回のreportを根拠に使い、古いreportや読めないreportでは上げも下げもしない', async (t) => {
  const { env, paths, home } = await workspace(t);
  const reportPath = join(home, 'latest-report.json');
  // 本物のreportは全製品の欄を持つ。このOSで対象外のagent-desktopは数えない。
  const write = (observedAt, product) => writeFile(reportPath, JSON.stringify({ observed_at: observedAt, products: { 'jev-ultrafast': product, 'agent-desktop': { presence_status: 'not_applicable', checks: [] } } }));
  const gone = { presence_status: 'missing', checks: [] };
  const record = async () => JSON.parse(await readFile(paths.state, 'utf8')).records.jev;
  const fail = async (...extra) => { const result = await run(env, ['record', '--ran', 'jev', '--failed', 'jev', ...extra]); assert.equal(result.code, 0, result.stderr); return result; };
  await write(new Date().toISOString(), gone);
  await fail('--report', reportPath);
  assert.equal((await record()).severity, 'warn');
  await fail('--report', reportPath);
  assert.equal((await record()).severity, 'high');
  assert.equal((await record()).evidence.state, 'stopped');
  // 古い観測・読めないreport・reportを渡さない回は、新しい観測が無い。確かめたhighを保持する。
  await write('2026-10-01T00:00:00.000Z', { presence_status: 'installed', installed_version: '1.0.0', checks: [{ check_id: 'installation', status: 'pass' }] });
  await fail('--report', reportPath);
  assert.equal((await record()).severity, 'high');
  await fail('--report', join(home, 'none.json'));
  assert.equal((await record()).severity, 'high');
  await fail();
  assert.equal((await record()).severity, 'high');
  // 製品の状態が未確認のreportも、停止の解除を確かめていない。
  await write(new Date().toISOString(), { presence_status: 'unverified', checks: [{ check_id: 'installation', status: 'unverified', reason_code: 'cli_timeout' }] });
  await fail('--report', reportPath);
  assert.equal((await record()).severity, 'high');
  assert.equal((await record()).occurrence_count, 6);
  // statusは、未解決の記録の重大度と根拠を返す。
  const status = await run(env, ['status']);
  assert.equal(status.json.open_records.length, 1);
  assert.equal(status.json.open_records[0].step, 'jev');
  assert.equal(status.json.open_records[0].severity, 'high');
  assert.deepEqual(status.json.open_records[0].evidence.products, ['jev-ultrafast']);
  // 起動できる事を正に観測した回で、根拠を付けて評価し直す。
  await write(new Date().toISOString(), { presence_status: 'installed', installed_version: '1.0.0', checks: [{ check_id: 'installation', status: 'pass' }] });
  await fail('--report', reportPath);
  assert.equal((await record()).severity, 'warn');
  assert.equal((await record()).evidence.state, 'launchable');
});

test('重大度を持たない以前の記録は読めて、送っていた重大度を変えない', async (t) => {
  const { env, paths } = await workspace(t);
  const legacy = { occurrence_count: 1, first_seen: '2026-10-01T17:00:30.000Z', last_seen: '2026-10-01T17:00:30.000Z', status: 'open', resolved_at: null, resolution_unsent: false, product_version: VERSION };
  await mkdir(join(paths.state, '..'), { recursive: true });
  await writeFile(paths.state, JSON.stringify({ ...emptyState(), records: { jev: legacy } }));
  const status = await run(env, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(status.json.open_steps, ['jev']);
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(buildReport(state, { observedAt: '2026-10-02T00:00:00.000Z', version: VERSION }).runtime_errors[0].severity, 'high');
  // 触れていない記録は書き換えない。
  const recorded = await run(env, ['record', '--ran', 'typesafe']);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(await readFile(paths.state, 'utf8')).records.jev, legacy);
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

test('鍵を認証仲介に預けた端末は、署名を中継経由で作り、秘密を持たずに送って検証する', posixOnly, async (t) => {
  const { env, paths, home } = await workspace(t);
  const receiver = await intake(t, accepted);
  await placeCredential(paths, receiver.url);
  assert.equal((await run(env, ['enable'])).json.reporting, 'enabled');
  const failed = await run(env, ['record', '--ran', 'setup.aiterm', '--failed', 'setup.aiterm']);
  assert.equal(failed.json.outcome, 'accepted', failed.stderr);
  const calls = (await readFile(join(home, 'ssh.log'), 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1); // 署名は要求の1回だけ。応答の確認は端末の中で公開鍵で行う
  assert.match(calls[0], /factory-relay-sign\.sh' 'bughub-product-dotagents-test-host'$/);
  const credential = JSON.parse(await readFile(paths.credential, 'utf8'));
  assert.deepEqual(Object.keys(credential).sort(), ['key_id', 'response_key', 'sign_item', 'url']);
});

test('失敗が無く記録も無い端末では、記録のファイルを作らない', async (t) => {
  const { env, paths } = await workspace(t);
  const result = await run(env, ['record', '--ran', 'typesafe']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json.open_steps, []);
  await assert.rejects(stat(paths.state));
});

test('有効な端末は署名を付けて1か所へ送り、受領されたら解決まで届ける', posixOnly, async (t) => {
  const { env, paths } = await workspace(t);
  const receiver = await intake(t, accepted);
  await placeCredential(paths, receiver.url);
  assert.equal((await run(env, ['enable'])).json.reporting, 'enabled');

  const failed = await run(env, ['record', '--ran', 'setup.peertable', '--ran', 'setup.aiterm', '--failed', 'setup.peertable', '--failed', 'setup.aiterm']);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(failed.json.outcome, 'accepted');
  assert.equal(receiver.requests.length, 1);
  const [first] = receiver.requests;
  const header = /^BugHub-ES256 key_id=test-host\.dotagents\.es256-0001, ts=(\d+), sig=([A-Za-z0-9+/]{86}==)$/.exec(first.authorization);
  assert.ok(header, first.authorization);
  assert.equal(verify('sha256', Buffer.from(requestSigningText(header[1], first.body), 'utf8'), SIGN_OPTIONS(REQUEST_KEYS.publicKey), Buffer.from(header[2], 'base64')), true);
  assert.ok(Math.abs(Date.parse(first.report.observed_at) - Number(header[1]) * 1000) < 1000);
  assert.equal(first.report.product_id, 'dotagents');
  assert.match(first.report.installed_version, /^0\.0\.0\+[0-9a-f]{7}$/);
  // 製品ごとに届け先を分けない。1回の送信に、その端末の全手順をまとめて載せる。
  assert.deepEqual(first.report.runtime_errors.map((item) => item.component), ['setup.aiterm', 'setup.peertable']);

  // 受領済みで変化が無ければ、送らない。
  assert.equal((await run(env, ['flush'])).json.outcome, 'nothing_to_send');
  assert.equal(receiver.requests.length, 1);

  const recovered = await run(env, ['record', '--ran', 'setup.peertable', '--ran', 'setup.aiterm', '--failed', 'setup.aiterm']);
  assert.equal(recovered.json.outcome, 'accepted');
  assert.deepEqual(recovered.json.open_steps, ['setup.aiterm']);
  const second = receiver.requests[1].report;
  assert.deepEqual(second.runtime_errors.map((item) => [item.component, item.status, item.occurrence_count]), [['setup.aiterm', 'open', 2], ['setup.peertable', 'resolved', 1]]);
  assert.deepEqual(second.resolutions.map((item) => item.reason_code), ['recovered']);

  const status = (await run(env, ['status'])).json;
  assert.equal(status.reporting, 'enabled');
  assert.equal(status.unsent, false);
  assert.equal(status.last_outcome, 'accepted');
  assert.deepEqual(status.open_steps, ['setup.aiterm']);
});

test('verifyは記録に触れず、空の報告で合鍵と宛先と応答の署名を確かめる', posixOnly, async (t) => {
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

  reply = (report) => ({ payload: { accepted: true, report_id: report.report_id, received_at: '2026-10-03T12:00:00.000Z', sig: 'f'.repeat(64), sig_alg: 'ES256' } });
  const forged = await run(env, ['verify']);
  assert.equal(forged.code, 1);
  assert.equal(forged.json.outcome, 'response_unverified');
  // 署名を付けられなかった200（sigなし）と、方式の違う署名も、受領にしない。
  reply = (report) => ({ payload: { accepted: true, report_id: report.report_id, duplicate: false, received_at: '2026-10-03T12:00:00.000Z' } });
  assert.equal((await run(env, ['verify'])).json.outcome, 'response_unverified');
  reply = (report) => { const ok = accepted(report); return { payload: { ...ok.payload, sig_alg: 'HS256' } }; };
  assert.equal((await run(env, ['verify'])).json.outcome, 'response_unverified');
});

test('受領を確かめられない応答では、送信待ちのまま残す', posixOnly, async (t) => {
  const { env, paths } = await workspace(t);
  let reply = (report) => ({ payload: { accepted: true, report_id: report.report_id, received_at: '2026-10-03T12:00:00.000Z', sig: '0'.repeat(64), sig_alg: 'ES256' } });
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

test('届かない宛先でも記録は残り、次に送れる', posixOnly, async (t) => {
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
  await writeFile(target, JSON.stringify({ url: receiver.url, key_id: 'test-host.dotagents.es256-0001', sign_item: ITEM }), { mode: 0o600 });
  await symlink(target, paths.credential);
  assert.equal((await run(env, ['status'])).json.reporting, 'credential_unsafe');

  await rm(paths.credential);
  await writeFile(paths.credential, JSON.stringify({ url: receiver.url, key_id: 'test-host.dotagents.0001', secret: 'a-shared-secret-is-no-longer-accepted' }), { mode: 0o600 });
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

test('廃止したgpt-connectorの手順は、動かなくても開いたままの記録を解決済みにする', () => {
  const stale = { ...emptyState(), records: { 'setup.gpt-connector': { occurrence_count: 3, first_seen: '2026-10-04T19:01:37.069Z', last_seen: '2026-11-17T17:02:23.968Z', status: 'open', resolved_at: null, resolution_unsent: false, product_version: VERSION } } };
  const next = applyRun(stale, { ran: ['typesafe'], failed: [], now: '2026-11-18T17:00:30.000Z', version: VERSION });
  assert.equal(next.records['setup.gpt-connector'].status, 'resolved');
  assert.equal(next.records['setup.gpt-connector'].resolved_at, '2026-11-18T17:00:30.000Z');
  assert.equal(next.unsent, true);
});
