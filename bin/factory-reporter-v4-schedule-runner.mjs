#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/factory/contract.mjs';
import { extendedSchedulerPath } from '../lib/factory/scheduler-path.mjs';
import { privateState, withLock } from '../lib/factory/scheduler-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
process.env.PATH = extendedSchedulerPath({ platform: platform(), path: process.env.PATH, execPath: process.execPath, home: homedir() });
function statePath() { return platform() === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', 'factory-reporter-v4') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dotagents', 'factory-reporter-v4'); }
function platformMatches(profile) { return (platform() === 'darwin' && profile === 'mac') || (platform() === 'linux' && ['server', 'linux', 'wsl'].includes(profile)) || (platform() === 'win32' && profile === 'windows-native'); }
function run(script, args) { return new Promise((resolveRun, rejectRun) => { const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' }); child.on('error', rejectRun); child.on('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${script} がexit ${code}で失敗`))); }); }
function parseArgs(argv) { const mode = argv[2] || null; if (![2, 3].includes(argv.length) || argv[0] !== '--config' || !argv[1] || /[\0\r\n]/u.test(argv[1]) || (mode !== null && !['--post-update', '--finalize-update'].includes(mode))) throw new Error('使い方: factory-reporter-v4-schedule-runner --config <file> [--post-update|--finalize-update]'); return { configPath: argv[1], postUpdate: mode === '--post-update', finalizeUpdate: mode === '--finalize-update' }; }
function gateFailures(report, profile, postUpdate) { const required = ['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar']; if (profile === 'server') required.push('servermanager'); if (profile !== 'windows-native') required.push('claude-code', 'codex-cli'); const allowedUnverified = new Set(['spotter\0codex_hooks\0trust_not_machine_verifiable', 'throughline\0evidence_restore_smoke\0diagnostic_unverified', 'throughline\0claude_connector\0diagnostic_unverified', 'aiterm-mcp\0pty_list\0pty_list_unverified']); const failures = []; for (const id of required) { const product = report?.products?.[id]; if (!product || product.presence_status !== 'installed') { failures.push(`${id}:presence`); continue; } if ((['claude-code', 'codex-cli'].includes(id) && product.compatibility_status !== 'compatible') || product.compatibility_status === 'incompatible') failures.push(`${id}:compatibility`); for (const item of product.checks || []) { if (postUpdate && item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending') continue; if (item.status === 'fail' || (item.status === 'unverified' && !allowedUnverified.has(`${id}\0${item.check_id}\0${item.reason_code}`))) failures.push(`${id}:${item.check_id}`); } } return failures; }
function hasPendingToolchainLedger(report) { return ['claude-code', 'codex-cli', 'grok-build'].some((id) => (report?.products?.[id]?.checks || []).some((item) => item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending')); }
try {
  const { configPath, postUpdate, finalizeUpdate } = parseArgs(process.argv.slice(2));
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
      let failures = [];
      if (config.collection.enabled || postUpdate || finalizeUpdate) {
        await run('factory-scan-v4.mjs', ['--config', configPath, '--output', reportPath, '--ack-output', acks, '--cwd', ROOT]);
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        if (finalizeUpdate && hasPendingToolchainLedger(report)) throw new Error('finalize ledgerにpost_gate_pendingが残っています');
        if (postUpdate) failures = gateFailures(report, config.host.profile, true);
        if (!postUpdate && (config.collection.enabled || (finalizeUpdate && config.reporting.enabled))) await run('factory-reporter-v4.mjs', ['enqueue', '--config', configPath, '--report', reportPath, '--ack-metadata', acks]);
      }
      if (config.reporting.enabled) await run('factory-reporter-v4.mjs', ['flush', '--config', configPath]);
      if (finalizeUpdate) process.stdout.write(`${JSON.stringify({ ok: true, finalized: true })}\n`);
      else if (failures.length) {
        process.stdout.write(`${JSON.stringify({ ok: false, post_gate_status: 'failed', failed_checks: failures.length })}\n`);
        process.exitCode = 1;
      } else process.stdout.write(`${JSON.stringify({ ok: true, post_gate_status: 'success' })}\n`);
    });
  }
} catch (error) {
  process.stderr.write(`[factory-reporter-v4-schedule-runner] ${error?.message || '失敗'}\n`);
  process.exitCode = 1;
}
