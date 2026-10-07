import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { finalizeToolchainReport } from '../../lib/factory/v5.mjs';

test('診断済み製品の観測を保持し、工場台帳の確定だけを同じreportへ反映する', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-finalize-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toolchainLedgerPath = join(directory, 'ledger.json');
  const ids = ['claude-code', 'codex-cli', 'grok-build'];
  const report = { report_id: 'report-one', observed_at: '2026-09-10T00:00:00.000Z', products: {
    caveat: { checks: [{ check_id: 'native_diagnostics', status: 'fail', reason_code: 'probe_failed' }] },
    ...Object.fromEntries(ids.map((id) => [id, { presence_status: 'installed', installed_version: '1.0.0',
      checks: [{ check_id: 'version', status: 'pass' }, { check_id: 'last_update', status: 'unverified', reason_code: 'post_gate_pending' }] }])),
  } };
  const pending = structuredClone(report);
  await writeFile(toolchainLedgerPath, JSON.stringify({ schema_version: 'dotagents.toolchain-update.v1',
    products: Object.fromEntries(ids.map((id) => [id, { before_version: '1.0.0', latest_version: '1.0.0',
      after_version: '1.0.0', operation_status: 'skipped', post_gate_status: 'success',
      reason_code: 'already_current', observed_at: report.observed_at }])) }), { mode: 0o600 });
  const result = await finalizeToolchainReport(report, { expectedReportId: 'report-one', toolchainLedgerPath });
  assert.deepEqual(report, pending);
  assert.deepEqual(result.products.caveat, pending.products.caveat);
  assert.equal(result.observed_at, pending.observed_at);
  assert.equal(result.report_id, pending.report_id);
  for (const id of ids) assert.deepEqual(result.products[id].checks, [
    { check_id: 'version', status: 'pass' }, { check_id: 'last_update', status: 'pass' },
  ]);
  await assert.rejects(finalizeToolchainReport(report, { expectedReportId: 'old-report', toolchainLedgerPath }), /finalize_report_mismatch/u);
});

test('v8のreport確定は全件probeを起動せず、指定した診断reportを使う', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-finalize-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'dotagents', 'factory-reporter-v8');
  await mkdir(state, { recursive: true });
  const reportPath = join(state, 'latest-report.json');
  const report = { report_id: 'same-observation', observed_at: '2026-09-10T00:00:00.000Z',
    products: Object.fromEntries(['claude-code', 'codex-cli', 'grok-build'].map((id) => [id, {
      presence_status: 'not_applicable', checks: [],
    }])) };
  await writeFile(reportPath, JSON.stringify(report));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ schema_version: '1.0', host: { id: 'test-host',
    profile: process.platform === 'darwin' ? 'mac' : 'linux' }, collection: { enabled: false }, reporting: { enabled: false } }));
  const runner = resolve(import.meta.dirname, '../../bin/factory-reporter-v8-schedule-runner.mjs');
  const result = spawnSync(process.execPath, [runner, '--config', configPath, '--finalize-update', '--report-id', report.report_id], {
    env: { ...process.env, XDG_STATE_HOME: directory, PATH: directory }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
});

// 重大度は理由コードで決めず、失敗した更新のあとにCLIを起動できるかで決める（bughub/NETWORK_REPORTING.md）。
async function lastUpdate(t, { reason, after, installed }) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-last-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toolchainLedgerPath = join(directory, 'ledger.json');
  const observedAt = '2026-10-07T00:00:00.000Z';
  const ids = ['claude-code', 'codex-cli', 'grok-build'];
  await writeFile(toolchainLedgerPath, JSON.stringify({ schema_version: 'dotagents.toolchain-update.v1',
    products: Object.fromEntries(ids.map((id) => [id, { before_version: after, latest_version: null,
      after_version: after, operation_status: 'failed', post_gate_status: 'success',
      reason_code: reason, observed_at: observedAt }])) }), { mode: 0o600 });
  const report = { report_id: 'report-one', observed_at: observedAt, products: Object.fromEntries(ids.map((id) => [id, {
    presence_status: installed ? 'installed' : 'unverified', ...(installed ? { installed_version: installed } : {}), checks: [],
  }])) };
  const result = await finalizeToolchainReport(report, { expectedReportId: 'report-one', toolchainLedgerPath });
  return result.products['claude-code'].checks.at(-1);
}

test('最新版を確認できなかった回は導入に触れていないので、failにせず未確認として残す', async (t) => {
  assert.deepEqual(await lastUpdate(t, { reason: 'registry_unavailable', after: '1.0.0', installed: '1.0.0' }),
    { check_id: 'last_update', status: 'unverified', reason_code: 'registry_unavailable' });
  assert.deepEqual(await lastUpdate(t, { reason: 'check_failed', after: null, installed: '1.0.0' }),
    { check_id: 'last_update', status: 'unverified', reason_code: 'check_failed' });
});

test('入替に失敗してもCLIを起動できる回はwarn、起動を確かめられない回はhighにする', async (t) => {
  const usable = await lastUpdate(t, { reason: 'install_failed', after: '1.0.0', installed: '1.0.0' });
  assert.equal(usable.status, 'fail');
  assert.equal(usable.severity, 'warn');
  const broken = await lastUpdate(t, { reason: 'install_failed', after: null, installed: null });
  assert.equal(broken.severity, 'high');
  // 同じ失敗は重大度が変わっても同じissueのまま（fingerprintは理由コードまでで決まる）。
  assert.equal(usable.fingerprint, broken.fingerprint);
  assert.equal((await lastUpdate(t, { reason: 'update_failed', after: null, installed: '1.0.0' })).severity, 'warn');
});

test('通信の乱れでも、CLIを起動できない影響が残る回はhighのまま隠さない', async (t) => {
  const missing = await lastUpdate(t, { reason: 'registry_unavailable', after: null, installed: null });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.severity, 'high');
});

test('通信と関係しない失敗の理由は、これまでどおりhighで報告する', async (t) => {
  for (const reason of ['npm_unavailable', 'downgrade_refused', 'post_version_unavailable', 'version_mismatch']) {
    const item = await lastUpdate(t, { reason, after: '1.0.0', installed: '1.0.0' });
    assert.equal(item.status, 'fail', reason);
    assert.equal(item.severity, 'high', reason);
  }
});
