#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { assertDeliveryReceipt } from '../lib/factory/delivery-receipt.mjs';

function fail(message) { process.stderr.write(`[agents-update-schedule-runner] ${message}\n`); process.exitCode = 1; }
if (platform() !== 'win32' || process.argv.length !== 2) fail('Windows nativeのscheduled taskだけが実行できます');
else {
  const token = randomUUID();
  const home = process.env.USERPROFILE || homedir();
  const runner = join(home, '.local', 'bin', 'agents-update');
  const bash = process.env.AGENTS_UPDATE_BASH || join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const log = join(local, 'dotagents', 'agents-update', 'agents-update.log');
  const state = join(local, 'dotagents', 'factory-reporter-v8');
  if (!existsSync(runner) || !existsSync(bash)) fail('scheduled runner preflightが失敗しました（install.sh配布またはGit Bashがありません）');
  else {
    const beforeReport = (() => { try { return JSON.parse(readFileSync(join(state, 'latest-report.json'), 'utf8')).report_id; } catch { return null; } })();
    const msysHome = home.replace(/^([A-Za-z]):[\\/]/u, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
    const result = spawnSync(bash, [runner], { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), AGENTS_UPDATE_PATH_PREFIX: `${msysHome}/.local/bin`, AGENTS_UPDATE_BATCH_TOKEN: token, FACTORY_REPORTER_RUNNER: join(home, '.local', 'bin', 'factory-reporter-v8-schedule-runner') } });
    if (result.status !== 0) fail(`agents-updateがexit ${result.status}で失敗しました`);
    else {
      let logText = ''; try { logText = readFileSync(log, 'utf8'); } catch {}
      if (!logText.includes(`agents-update batch-token: ${token}`) || !logText.includes('agents-update end:')) fail('scheduled batch receiptが不足しています');
      else try { const report = JSON.parse(readFileSync(join(state, 'latest-report.json'), 'utf8')); const receipt = JSON.parse(readFileSync(join(state, 'delivery-receipt.json'), 'utf8')); assertDeliveryReceipt({ report, priorReportId: beforeReport, receipt, batchToken: token }); process.stdout.write(`${JSON.stringify({ ok: true, batch_token: token, report: 'v8', delivery_acknowledged: true })}\n`); } catch { fail('今回のv8 reportとBugHub accepted後のdelivery receiptを確認できません'); }
    }
  }
}
