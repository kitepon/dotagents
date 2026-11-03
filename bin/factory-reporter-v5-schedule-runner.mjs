#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/factory/contract.mjs';
import { extendedSchedulerPath } from '../lib/factory/scheduler-path.mjs';
import { ownerOnlyAcl, privateState, withLock } from '../lib/factory/scheduler-state.mjs';
import { finalizeToolchainReport } from '../lib/factory/v5.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const INVOKED = basename(process.argv[1] || '');
const WIRE_MAJOR = INVOKED.includes('factory-reporter-v9') ? 'v9' : INVOKED.includes('factory-reporter-v8') ? 'v8' : INVOKED.includes('factory-reporter-v7') ? 'v7' : INVOKED.includes('factory-reporter-v6') ? 'v6' : 'v5';
process.env.PATH = extendedSchedulerPath({ platform: platform(), path: process.env.PATH, execPath: process.execPath, home: homedir() });
function statePath() { return platform() === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', `factory-reporter-${WIRE_MAJOR}`) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dotagents', `factory-reporter-${WIRE_MAJOR}`); }
function platformMatches(profile) { return (platform() === 'darwin' && profile === 'mac') || (platform() === 'linux' && ['server', 'linux', 'wsl'].includes(profile)) || (platform() === 'win32' && profile === 'windows-native'); }
function run(script, args) { return new Promise((resolveRun, rejectRun) => { const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' }); child.on('error', rejectRun); child.on('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${script} がexit ${code}で失敗`))); }); }
function parseArgs(argv) {
  const managedEntry = argv.filter((arg) => arg === '--caveat-managed-entry').length;
  if (managedEntry > 1 || (managedEntry && WIRE_MAJOR !== 'v9')) throw new Error('--caveat-managed-entryはv9だけで一度指定できます');
  argv = argv.filter((arg) => arg !== '--caveat-managed-entry');
  const mode = argv[2] || null;
  const reuse = argv.length === 5 && mode === '--finalize-update' && argv[3] === '--report-id' && Boolean(argv[4]);
  if ((!reuse && ![2, 3].includes(argv.length)) || argv[0] !== '--config' || !argv[1]
    || /[\0\r\n]/u.test(argv[1]) || (mode !== null && !['--post-update', '--finalize-update'].includes(mode))) {
    throw new Error(`使い方: factory-reporter-${WIRE_MAJOR}-schedule-runner --config <file> [--post-update|--finalize-update [--report-id <id>]]`);
  }
  return { configPath: argv[1], postUpdate: mode === '--post-update', finalizeUpdate: mode === '--finalize-update', expectedReportId: reuse ? argv[4] : null, managedEntry: managedEntry === 1 };
}
function hasPendingToolchainLedger(report) { return ['claude-code', 'codex-cli', 'grok-build'].some((id) => (report?.products?.[id]?.checks || []).some((item) => item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending')); }
async function writeDeliveryReceipt(state, reportId) {
  const batchToken = process.env.AGENTS_UPDATE_BATCH_TOKEN || null;
  if (batchToken !== null && !/^[0-9a-f-]{36}$/iu.test(batchToken)) throw new Error('delivery receiptのbatch tokenが不正です');
  const receipt = { schema: 'dotagents.factory-delivery-receipt.v1', report_id: reportId, batch_token: batchToken };
  await writeStateJson(state, 'delivery-receipt.json', receipt);
}
async function writeStateJson(state, name, value) {
  const target = join(state, name); const temporary = join(state, `.${name}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); if (platform() !== 'win32') await chmod(temporary, 0o600); else ownerOnlyAcl(temporary); await rename(temporary, target); if (platform() !== 'win32') await chmod(target, 0o600); else ownerOnlyAcl(target); } finally { await rm(temporary, { force: true }); }
}
try {
  const { configPath, postUpdate, finalizeUpdate, expectedReportId, managedEntry } = parseArgs(process.argv.slice(2));
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
      let latestReport = null;
      if (config.collection.enabled || postUpdate || finalizeUpdate) {
        if (!expectedReportId) await run(`factory-scan-${WIRE_MAJOR}.mjs`, ['--config', configPath, '--output', reportPath, '--ack-output', acks, '--cwd', ROOT, ...(managedEntry ? ['--caveat-managed-entry'] : []), ...(WIRE_MAJOR === 'v9' && !postUpdate && !finalizeUpdate && config.collection.enabled ? ['--rabbit-observation-once'] : [])]);
        let report = JSON.parse(await readFile(reportPath, 'utf8'));
        if (expectedReportId) {
          report = await finalizeToolchainReport(report, { expectedReportId });
          await writeStateJson(state, 'latest-report.json', report);
        }
        latestReport = report;
        if (finalizeUpdate && hasPendingToolchainLedger(report)) throw new Error('finalize ledgerにpost_gate_pendingが残っています');
        if (!postUpdate && (config.collection.enabled || (finalizeUpdate && config.reporting.enabled))) await run(`factory-reporter-${WIRE_MAJOR}.mjs`, ['enqueue', '--config', configPath, '--report', reportPath, '--ack-metadata', acks]);
      }
      if (config.reporting.enabled) await run(`factory-reporter-${WIRE_MAJOR}.mjs`, ['flush', '--config', configPath]);
      if (finalizeUpdate && ['v7', 'v8', 'v9'].includes(WIRE_MAJOR) && config.reporting.enabled && latestReport) await writeDeliveryReceipt(state, latestReport.report_id);
      if (finalizeUpdate) process.stdout.write(`${JSON.stringify({ ok: true, finalized: true })}\n`);
      else process.stdout.write(`${JSON.stringify({ ok: true, post_gate_status: 'success', report_id: latestReport?.report_id })}\n`);
    });
  }
} catch (error) {
  process.stderr.write(`[factory-reporter-${WIRE_MAJOR}-schedule-runner] ${error?.message || '失敗'}\n`);
  process.exitCode = 1;
}
