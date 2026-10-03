#!/usr/bin/env node
// 定期更新（agents-update）の失敗を記録し、送信を有効にした端末ではBugHubへ報告する。
// agents-update.shが最後に `record` を呼ぶ。届かなかった分は、次の回か `flush` で送る。
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  applyRun, buildReport, emptyState, markAccepted, markFailed, readCredential, readSettings, readState, sendReport,
  updateFailurePaths, validStep, versionFromRevision, writeSettings, writeState,
} from '../lib/factory/update-failure-report.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function installedVersion() {
  const result = spawnSync('git', ['-c', `safe.directory=${REPO_ROOT}`, 'rev-parse', '--short=7', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 });
  return versionFromRevision(result.status === 0 ? result.stdout.trim() : null);
}

function parseSteps(argv) {
  const ran = [];
  const failed = [];
  if (argv.length % 2 !== 0) throw new Error('arguments_invalid');
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const step = argv[index + 1];
    if (!['--ran', '--failed'].includes(key) || !validStep(step)) throw new Error('arguments_invalid');
    (key === '--ran' ? ran : failed).push(step);
  }
  // 失敗した手順は、動いた手順でもある。
  return { ran: [...new Set([...ran, ...failed])], failed: [...new Set(failed)] };
}

async function reportingStatus(paths) {
  if (!(await readSettings(paths.settings)).enabled) return { reporting: 'disabled', credential: null };
  const credential = await readCredential(paths.credential);
  return credential.status === 'ready' ? { reporting: 'enabled', credential } : { reporting: credential.status, credential: null };
}

async function deliver(paths, state) {
  const { reporting, credential } = await reportingStatus(paths);
  if (!credential) return { state, reporting, outcome: 'not_sent' };
  if (!state.unsent) return { state, reporting, outcome: 'nothing_to_send' };
  // observed_atと署名のtsは同じ時刻から作る（BugHubは10分より離れた報告を断る）。
  const nowMs = Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const report = buildReport(state, { observedAt, version: installedVersion() });
  const { outcome } = await sendReport({ credential, report, nowMs });
  const next = outcome === 'accepted' ? markAccepted(state, report, observedAt) : markFailed(state, outcome, observedAt);
  await writeState(paths.state, next);
  return { state: next, reporting, outcome };
}

const openSteps = (state) => Object.keys(state.records).filter((step) => state.records[step].status === 'open').sort();
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const [command, ...rest] = process.argv.slice(2);
  const paths = updateFailurePaths();
  if (command === 'record') {
    const steps = parseSteps(rest);
    const before = await readState(paths.state);
    const recorded = applyRun(before, { ...steps, now: new Date().toISOString(), version: installedVersion() });
    if (JSON.stringify(recorded) !== JSON.stringify(before)) await writeState(paths.state, recorded);
    const { state, reporting, outcome } = await deliver(paths, recorded);
    print({ ok: true, command, failed_steps: steps.failed, open_steps: openSteps(state), reporting, outcome });
  } else if (command === 'flush' && rest.length === 0) {
    const { state, reporting, outcome } = await deliver(paths, await readState(paths.state));
    print({ ok: true, command, open_steps: openSteps(state), reporting, outcome });
  } else if (command === 'status' && rest.length === 0) {
    const state = await readState(paths.state);
    const { reporting } = await reportingStatus(paths);
    print({
      schema: 'dotagents.update_failure_report_status.v1',
      reporting,
      open_steps: openSteps(state),
      unsent: state.unsent,
      last_attempt_at: state.last_attempt_at,
      last_outcome: state.last_outcome,
      last_accepted_at: state.last_accepted_at,
    });
  } else if (command === 'verify' && rest.length === 0) {
    // 記録には触れず、中身が空の報告を1回送る。合鍵・宛先・応答の署名を、失敗が起きる前に確かめるため。
    const { reporting, credential } = await reportingStatus(paths);
    let outcome = 'not_sent';
    if (credential) {
      const nowMs = Date.now();
      const report = buildReport(emptyState(), { observedAt: new Date(nowMs).toISOString(), version: installedVersion() });
      ({ outcome } = await sendReport({ credential, report, nowMs }));
    }
    print({ ok: outcome === 'accepted', command, reporting, outcome });
    if (outcome !== 'accepted') process.exitCode = 1;
  } else if ((command === 'enable' || command === 'disable') && rest.length === 0) {
    await writeSettings(paths.settings, command === 'enable');
    print({ ok: true, command, reporting: (await reportingStatus(paths)).reporting });
  } else {
    throw new Error('arguments_invalid');
  }
} catch (error) {
  process.stderr.write(`[factory-update-failure-report] ${error?.message || '失敗'}\n`);
  process.exitCode = 1;
}
