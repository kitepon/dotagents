import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCHEDULER = join(ROOT, 'bin', 'agents-update-scheduler.mjs');

test('Windows native daily factory schedulerはdry-run既定で2:00・一撃setup・rollbackを示す', async () => {
  const result = spawnSync(process.execPath, [SCHEDULER, 'install', ...(process.platform === 'win32' ? [] : ['--sid', 'S-1-5-21-100-200-300-400'])], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.dry_run, true);
  assert.equal(value.task_name, 'dotagents-agents-update');
  assert.match(value.artifact_content, /encoding="UTF-16"/u);
  assert.match(value.artifact_content, /<StartBoundary>2026-01-01T02:00:00<\/StartBoundary>/u);
  assert.match(value.artifact_content, /<ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay>/u);
  assert.match(value.artifact_content, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(value.artifact_content, process.platform === 'win32' ? /<UserId>S-1-[0-9-]+<\/UserId>/u : /<UserId>S-1-5-21-100-200-300-400<\/UserId>/u);
  assert.match(value.artifact_content, /setup-windows-native-factory\.ps1/u);
  assert.match(value.artifact_content, /-ScheduledRun/u);
  assert.match(value.artifact_content, /PowerShell.*7.*pwsh\.exe/u);
  assert.doesNotMatch(value.artifact_content, /WindowsPowerShell|powershell\.exe/u);
  assert.match(value.rollback, /uninstall --apply/u);
  const source = await readFile(SCHEDULER, 'utf8');
  assert.match(source, /windowsTaskExists\(TASK_NAME\)/u);
  assert.match(source, /windowsDailyFactoryTaskMatches\(TASK_NAME, location\.runner, powershell\)/u);
  assert.match(source, /already_installed/u);
  assert.match(source, /登録後の読み戻し/u);
  assert.match(source, /writeWindowsTaskXml/u);
  assert.doesNotMatch(source, /Start-ScheduledTask/u);
});

test('SIDはinstall dry-runだけが受理され、status/uninstallはSID照会なしで動く', () => {
  const status = spawnSync(process.execPath, [SCHEDULER, 'status'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const apply = spawnSync(process.execPath, [SCHEDULER, 'install', '--apply', '--sid', 'S-1-5-21-100-200-300-400'], { encoding: 'utf8' });
  assert.equal(apply.status, 1); assert.match(apply.stderr, /install --dry-run専用/u);
  const noSid = spawnSync(process.execPath, [SCHEDULER, 'install'], { encoding: 'utf8' });
  if (process.platform === 'win32') assert.equal(noSid.status, 0, noSid.stderr);
  else { assert.equal(noSid.status, 1); assert.match(noSid.stderr, /--sidが必要/u); }
  const statusSid = spawnSync(process.execPath, [SCHEDULER, 'status', '--sid', 'S-1-5-21-100-200-300-400'], { encoding: 'utf8' }); assert.equal(statusSid.status, 1); assert.match(statusSid.stderr, /install --dry-run専用/u);
  const uninstall = spawnSync(process.execPath, [SCHEDULER, 'uninstall'], { encoding: 'utf8' }); assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstallSid = spawnSync(process.execPath, [SCHEDULER, 'uninstall', '--sid', 'S-1-5-21-100-200-300-400'], { encoding: 'utf8' }); assert.equal(uninstallSid.status, 1); assert.match(uninstallSid.stderr, /install --dry-run専用/u);
});

test('既存日次タスクが契約一致なら再登録せず already_installed にする', async () => {
  const { windowsDailyFactoryTaskMatches } = await import('../../lib/factory/windows-scheduler.mjs');
  const runner = 'C:\\Users\\kite_\\Documents\\Program\\dotagents\\bin\\setup-windows-native-factory.ps1';
  const powershell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.equal(windowsDailyFactoryTaskMatches('dotagents-agents-update', runner, powershell, () => ({ status: 0 })), true);
  assert.equal(windowsDailyFactoryTaskMatches('dotagents-agents-update', runner, powershell, () => ({ status: 4 })), false);
  assert.equal(windowsDailyFactoryTaskMatches('dotagents-agents-update', runner, powershell, () => ({ status: 3 })), false);
  assert.throws(() => windowsDailyFactoryTaskMatches('dotagents-agents-update', runner, powershell, () => ({ status: 1, stderr: 'boom' })), /照合に失敗/u);
  let command = null;
  let check = null;
  windowsDailyFactoryTaskMatches('dotagents-agents-update', runner, powershell, (file, args) => {
    command = file;
    check = args.at(-1);
    return { status: 0 };
  });
  assert.equal(command, powershell);
  assert.match(check, /C:\\Program Files\\PowerShell\\7\\pwsh\.exe/u);
  const source = await readFile(SCHEDULER, 'utf8');
  assert.match(source, /昇格作成の残骸/u);
});

test('fixture SIDは非Windows install dry-runだけを受理する', async () => {
  const { assertFixtureSidUsage } = await import('../../lib/factory/agents-update-scheduler-contract.mjs');
  const request = { sid: 'S-1-5-21-100-200-300-400', command: 'install', dryRun: true };
  assert.doesNotThrow(() => assertFixtureSidUsage({ ...request, os: 'darwin' }));
  assert.throws(() => assertFixtureSidUsage({ ...request, os: 'win32' }), /非Windows/u);
});

test('delivery receiptは未配送・古いreceipt・token不一致を拒否し、同一batchの受理だけ通す', async () => {
  const { assertDeliveryReceipt, DELIVERY_RECEIPT_SCHEMA } = await import('../../lib/factory/delivery-receipt.mjs');
  const token = '11111111-1111-4111-8111-111111111111'; const report = { schema_version: '8.0', report_id: 'new-report' };
  const valid = { schema: DELIVERY_RECEIPT_SCHEMA, report_id: 'new-report', batch_token: token };
  assert.throws(() => assertDeliveryReceipt({ report, priorReportId: 'old-report', receipt: null, batchToken: token }));
  assert.throws(() => assertDeliveryReceipt({ report, priorReportId: 'new-report', receipt: valid, batchToken: token }));
  assert.throws(() => assertDeliveryReceipt({ report, priorReportId: 'old-report', receipt: { ...valid, batch_token: '22222222-2222-4222-8222-222222222222' }, batchToken: token }));
  assert.equal(assertDeliveryReceipt({ report, priorReportId: 'old-report', receipt: valid, batchToken: token }), true);
});

test('scheduled runnerは実行ごとのbatch tokenと今回のv8 delivery receiptを必須にする', async () => {
  const source = await readFile(join(ROOT, 'bin', 'agents-update-schedule-runner.mjs'), 'utf8');
  assert.match(source, /randomUUID\(\)/u);
  assert.match(source, /FACTORY_REPORTER_RUNNER/u);
  assert.match(source, /HOME: home/u);
  assert.match(source, /CODEX_HOME: join\(home, '\.codex'\)/u);
  assert.match(source, /AGENTS_UPDATE_PATH_PREFIX/u);
  assert.match(source, /agents-update end/u);
  assert.match(source, /latest-report\.json/u);
  assert.match(source, /delivery-receipt\.json/u);
  assert.match(source, /assertDeliveryReceipt\(/u);
  const scheduleRunner = await readFile(join(ROOT, 'bin', 'factory-reporter-v5-schedule-runner.mjs'), 'utf8');
  assert.match(scheduleRunner, /dotagents\.factory-delivery-receipt\.v1/u);
  assert.match(scheduleRunner, /await rename\(temporary, target\)/u);
});
