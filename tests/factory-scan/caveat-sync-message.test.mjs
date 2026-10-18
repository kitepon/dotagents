import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  validateReportV5, validateReportV6, validateReportV7, validateReportV8, validateReportV9,
} from '../../lib/factory/contract.mjs';
import { caveatChecks, scanV5 } from '../../lib/factory/v5.mjs';
import { scanV6 } from '../../lib/factory/v6.mjs';
import { scanV7 } from '../../lib/factory/v7.mjs';
import { scanV8 } from '../../lib/factory/v8.mjs';
import { scanV9 } from '../../lib/factory/v9.mjs';

const NOW = '2026-10-18T06:00:00.000Z';
const MESSAGE = 'Caveat同期診断で共有先HEADと端末HEADの不一致を検出。同期操作の成否・原因・実害は未確認。';
const fingerprint = (id) => createHash('sha256').update(`caveat\0${id}`).digest('hex');
const find = (checks, id = 'sync') => checks.find((item) => item.check_id === id);

function diagnostic(status = 'not_ready', reason = 'remote_mismatch') {
  return {
    schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '0.20.3',
    overall: { status },
    database: { status: 'ready', reason_code: 'ready', schema_version: 3, migration_status: 'current' },
    sync: { status, reason_code: reason },
  };
}

function expectedFailure(id, reason, now = NOW) {
  return {
    check_id: id, status: 'fail', severity: 'warn', fingerprint: fingerprint(id),
    message_template: id === 'sync' && reason === 'remote_mismatch' ? MESSAGE : `caveat ${id} failed`,
    occurrence_count: 1, first_seen: now, last_seen: now, reason_code: reason,
  };
}

test('Caveat sync remote_mismatchの文面だけを変え、check全項目と入力を保持する', () => {
  const value = diagnostic();
  const original = structuredClone(value);
  const checks = caveatChecks(value, 'not_ready', NOW);
  assert.deepEqual(checks, [{ check_id: 'database', status: 'pass' }, expectedFailure('sync', 'remote_mismatch')]);
  assert.deepEqual(value, original);
  // 理由や時刻が変わっても、同じ部品のissueのidentityは変えない。
  const otherReason = find(caveatChecks(diagnostic('not_ready', 'behind'), 'not_ready', NOW));
  const { message_template, reason_code, ...identityAndState } = find(checks);
  const { message_template: oldMessage, reason_code: oldReason, ...oldIdentityAndState } = otherReason;
  assert.deepEqual(identityAndState, oldIdentityAndState);
  assert.equal(oldMessage, 'caveat sync failed');
  assert.equal(oldReason, 'behind');
  assert.equal(message_template, MESSAGE);
  assert.equal(reason_code, 'remote_mismatch');
});

test('別理由・別部品・ready/unverified・不正部品・旧native_diagnosticsの文面と状態を保持する', () => {
  for (const reason of ['behind', 'ahead', 'diverged', 'origin_missing', 'remote_mismatch_extra']) {
    assert.deepEqual(find(caveatChecks(diagnostic('not_ready', reason), 'not_ready', NOW)), expectedFailure('sync', reason));
  }
  const otherPart = diagnostic('ready', 'ready');
  Object.assign(otherPart.database, { status: 'not_ready', reason_code: 'remote_mismatch' });
  otherPart.overall.status = 'not_ready';
  assert.deepEqual(find(caveatChecks(otherPart, 'not_ready', NOW), 'database'), expectedFailure('database', 'remote_mismatch'));
  assert.deepEqual(find(caveatChecks(diagnostic('ready'), 'ready', NOW)), { check_id: 'sync', status: 'pass' });
  assert.deepEqual(find(caveatChecks(diagnostic('unverified'), 'unverified', NOW)), {
    check_id: 'sync', status: 'unverified', reason_code: 'remote_mismatch',
  });
  for (const part of [null, [], { status: 'unknown', reason_code: 'remote_mismatch' },
    { status: 'not_ready', reason_code: 'Remote Mismatch' }, { status: 'not_ready' }]) {
    const value = diagnostic(); value.sync = part;
    assert.deepEqual(find(caveatChecks(value, 'not_ready', NOW)), {
      check_id: 'sync', status: 'unverified', reason_code: 'detail_schema_invalid',
    });
    assert.ok(!JSON.stringify(caveatChecks(value, 'not_ready', NOW)).includes(MESSAGE));
  }
  assert.deepEqual(caveatChecks({}, 'not_ready', NOW), [{
    check_id: 'native_diagnostics', status: 'fail', severity: 'warn',
    fingerprint: createHash('sha256').update('caveat\0native_diagnostics\0native_not_ready_unattributed').digest('hex'),
    message_template: 'caveat native_diagnostics failed', occurrence_count: 1,
    first_seen: NOW, last_seen: NOW, reason_code: 'native_not_ready_unattributed',
  }]);
});

const WIRES = [
  [5, scanV5, validateReportV5], [6, scanV6, validateReportV6], [7, scanV7, validateReportV7],
  [8, scanV8, validateReportV8], [9, scanV9, validateReportV9],
];
const PLATFORMS = [['linux', 'linux'], ['darwin', 'mac'], ['win32', 'windows-native']];

// Every command, including git and all unrelated products, stays in memory.
// The outer test invocation also supplies an isolated HOME and an empty PATH.
function fakeRunner(value, exitOk, calls) {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === 'caveat') {
      assert.deepEqual(args, ['factory-diagnostics', '--json', '--require-connector', 'cursor', '--require-connector', 'grok']);
      return { ok: exitOk, code: exitOk ? 0 : 1, reason: exitOk ? null : 'exit', stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
    }
    if (command === 'gpt-connector') return {
      ok: false, code: 1, reason: 'exit', stderr: '', stdout: JSON.stringify({
        package_version: '0.16.3', overall: 'not_ready', state: { schema: '1', migration: 'current' },
        checks: [{ id: 'sync', status: 'not_ready', reason: 'remote_mismatch' }],
      }),
    };
    if (command === 'git') {
      assert.deepEqual(args.slice(-3), ['rev-parse', '--short=7', 'HEAD']);
      return { ok: true, code: 0, reason: null, stdout: 'abc1234\n', stderr: '' };
    }
    return { ok: false, reason: 'spawn', stdout: '', stderr: '', error: { code: 'ENOENT' } };
  };
}

for (const [major, scan, validate] of WIRES) {
  test(`wire v${major}は偽runnerの同一診断を投影し、他製品と不正schemaを保持する`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'caveat-sync-message-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [platform, profile] of PLATFORMS) {
      for (const [label, value, exitOk, status, reason] of [
        ['mismatch', diagnostic(), false, 'fail', 'remote_mismatch'],
        ['other-reason', diagnostic('not_ready', 'behind'), false, 'fail', 'behind'],
        ['ready', diagnostic('ready'), true, 'pass', undefined],
        ['unverified', diagnostic('unverified'), false, 'unverified', 'remote_mismatch'],
        ['schema', { ...diagnostic(), version: null }, false, 'unverified', 'native_diagnostics_schema'],
        ['json', '{', false, 'unverified', 'native_schema_invalid'],
        ['exit', diagnostic(), true, 'unverified', 'native_exit_mismatch'],
      ]) {
        const calls = [];
        const report = await scan({ host: { id: 'test-host', profile }, cwd: root,
          arch: 'x64', platform, home: root, toolchainLedgerPath: join(root, 'absent-ledger.json'),
          runCommand: fakeRunner(value, exitOk, calls) });
        const context = `v${major}/${platform}/${label}`;
        assert.doesNotThrow(() => validate(report), context);
        assert.equal(report.schema_version, `${major}.0`, context);
        const check = find(report.products.caveat.checks, ['schema', 'json', 'exit'].includes(label) ? 'native_diagnostics' : 'sync');
        assert.equal(check.status, status, context);
        assert.equal(check.reason_code, reason, context);
        if (status === 'fail') {
          assert.deepEqual(check, expectedFailure('sync', reason, check.first_seen), context);
          assert.equal(check.last_seen, check.first_seen, context);
          assert.ok(check.last_seen <= report.observed_at, context);
        } else assert.ok(!('message_template' in check), context);
        const other = find(report.products['gpt-connector'].checks);
        assert.equal(other.message_template, 'gpt-connector sync failed', context);
        assert.equal(other.severity, 'high', context);
        assert.equal(other.reason_code, 'remote_mismatch', context);
        assert.equal(calls.filter(({ command }) => command === 'caveat').length, 1, context);
        assert.equal(calls.filter(({ args }) => args.includes('runtime-errors') || args.includes('report') || args.includes('sync')).length, 0, context);
        assert.deepEqual(report.products.caveat.runtime_errors, [], context);
        assert.deepEqual(report.products.caveat.resolutions, [], context);
      }
    }
  });
}
