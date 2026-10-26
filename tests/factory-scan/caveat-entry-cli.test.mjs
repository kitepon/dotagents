import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { resolveWindowsPowerShell7 } from '../../lib/factory/windows-powershell.mjs';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'caveat-entry-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  // runnerがPATHへNode prefixを補っても実製品へ到達しない。
  // 不在CLIのstubごとにNodeを起こすと、並列CIではscan自体より起動待ちが長くなる。
  const missingCli = process.platform === 'win32'
    ? `#!${process.execPath}\nprocess.exit(1);\n` : '#!/bin/sh\nexit 1\n';
  for (const name of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice', 'markitdown',
    'aiterm-mcp', 'claude', 'codex', 'npm', 'grok', 'unai', 'peertable', 'aishell-mcp', 'uv', 'agent-desktop', 'browser-harness']) {
    await writeFile(join(bin, name), missingCli, { mode: 0o700 });
  }
  await writeFile(join(bin, 'git'), process.platform === 'win32'
    ? `#!${process.execPath}\nconsole.log('abc1234');\n` : "#!/bin/sh\nprintf 'abc1234\\n'\n", { mode: 0o700 });
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ schema_version: '1.0', host: { id: 'fixture', profile: process.platform === 'darwin' ? 'mac' : 'linux' },
    collection: { enabled: true }, reporting: { enabled: false } }), { mode: 0o600 });
  // Windows schedulerの通常のPS7検証に必要なOS道具だけを残す。
  // 製品CLIは先頭の専有fakeで固定し、利用者のPATH全体を混ぜない。
  const path = process.platform === 'win32'
    ? [bin, join(process.env.SystemRoot, 'System32'), dirname(resolveWindowsPowerShell7())].join(delimiter) : bin;
  return { root, config, env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'local'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), PATH: path } };
}
test('明示managed入口のv9 CLIは元wireと私有scan証拠を保存し、設定欠測を成功にしない', { skip: process.platform === 'win32' }, async (t) => {
  const box = await sandbox(t), output = join(box.root, 'report.json');
  const child = await execute(process.execPath, [join(ROOT, 'bin/factory-scan-v9.mjs'), '--config', box.config,
    '--output', output, '--cwd', box.root, '--caveat-managed-entry'], { env: box.env, timeout: 10000 });
  assert.equal(JSON.parse(child.stdout).binding_evidence_status, 'saved');
  const bytes = await readFile(output), report = JSON.parse(bytes); validateReportV9(report);
  assert.deepEqual(report.products.caveat.checks, [{ check_id: 'diagnostic_entry_binding', status: 'unverified', reason_code: 'registered_entry_unavailable' }]);
  const evidencePath = `${output}.caveat-binding.json`, evidence = JSON.parse(await readFile(evidencePath));
  assert.equal(evidence.report_id, report.report_id);
  assert.equal(evidence.scan_report_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(evidence.status, 'unconfirmed'); assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
});
test('補助binding証拠の保存失敗を明示し、生成済みreportの通常配送を止めない', { skip: process.platform === 'win32' }, async (t) => {
  const box = await sandbox(t), output = join(box.root, 'report.json');
  await mkdir(`${output}.caveat-binding.json`);
  const child = await execute(process.execPath, [join(ROOT, 'bin/factory-scan-v9.mjs'), '--config', box.config,
    '--output', output, '--cwd', box.root, '--caveat-managed-entry'], { env: box.env, timeout: 10000 });
  assert.match(child.stderr, /binding evidence write failed; report retained/u);
  assert.equal(JSON.parse(child.stdout).binding_evidence_status, 'failed');
  validateReportV9(JSON.parse(await readFile(output)));
});
test('v9通常schedule-runnerは明示flagをscanへ渡し、欠測診断もreportへ残す', { skip: process.platform === 'win32' }, async (t) => {
  const box = await sandbox(t);
  await execute(process.execPath, [join(ROOT, 'bin/factory-reporter-v9-schedule-runner.mjs'), '--config', box.config,
    '--caveat-managed-entry'], { env: box.env, timeout: 15000 });
  const output = join(box.root, 'state/dotagents/factory-reporter-v9/latest-report.json');
  const report = JSON.parse(await readFile(output)); validateReportV9(report);
  assert.equal(report.products.caveat.checks.at(-1).check_id, 'diagnostic_entry_binding');
  assert.equal(JSON.parse(await readFile(`${output}.caveat-binding.json`)).report_id, report.report_id);
});
test('3OSの通常scheduler dry-runは明示flagだけを加え、既定定義と実schedulerを変えない', async (t) => {
  const box = await sandbox(t);
  for (const [platform, profile] of [['linux', 'linux'], ['darwin', 'mac'], ['win32', 'windows-native']]) {
    await writeFile(box.config, JSON.stringify({ schema_version: '1.0', host: { id: 'fixture', profile },
      collection: { enabled: true }, reporting: { enabled: false } }));
    const args = [join(ROOT, 'bin/factory-reporter-scheduler.mjs'), 'install', '--dry-run', '--config', box.config,
      '--platform', platform, '--wire-major', 'v9'];
    const original = JSON.parse((await execute(process.execPath, args, { env: box.env })).stdout);
    const selected = JSON.parse((await execute(process.execPath, [...args, '--caveat-managed-entry'], { env: box.env })).stdout);
    assert.equal(selected.artifact_content.split('--caveat-managed-entry').length, 2);
    assert.equal(selected.artifact_content.replace(platform === 'darwin' ? '<string>--caveat-managed-entry</string>' : ' --caveat-managed-entry', ''), original.artifact_content);
    assert.equal(selected.dry_run, true);
  }
});
