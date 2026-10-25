#!/usr/bin/env node
import { RABBIT_OBSERVATION_ONCE } from '../lib/factory/rabbit-observation-once.mjs';
import { DEFAULT_GPT_OBSERVATION_ENTRY } from '../lib/factory/gpt-observation-entry.mjs';
import { rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, platform } from 'node:os';
import process from 'node:process';
import { assertConfigIdentity, readConfig } from '../lib/factory/contract.mjs';
import { scanV9WithAcknowledgements } from '../lib/factory/v9.mjs';
import { createCaveatDiagnosticPort } from '../lib/factory/caveat-entry.mjs';

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (['--caveat-managed-entry', '--rabbit-observation-once'].includes(key) && !out[key]) { out[key] = true; continue; }
    if (!['--config', '--output', '--ack-output', '--cwd'].includes(key) || !argv[i + 1] || out[key]) throw new Error('使い方: factory-scan-v9 --config <file> --output <file> [--ack-output <file>] [--cwd <project>] [--caveat-managed-entry] [--rabbit-observation-once]');
    out[key] = argv[++i];
  }
  if (!out['--config'] || !out['--output']) throw new Error('--config と --output が必要です');
  return out;
}
async function atomic(path, value, bytes) { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, bytes ?? `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temp, path); return path; }

try {
  const options = parse(process.argv.slice(2));
  const config = await readConfig(options['--config']);
  const capture = options['--rabbit-observation-once'] && config.collection.enabled ? RABBIT_OBSERVATION_ONCE.begin(config.host.id) : null;
  const port = options['--caveat-managed-entry'] ? createCaveatDiagnosticPort() : undefined;
  const { report, acknowledgements } = await scanV9WithAcknowledgements({ host: config.host, collectionEnabled: config.collection.enabled,
    cwd: options['--cwd'] || process.cwd(), arch: arch(), platform: platform(), caveatDiagnosticPort: port, gptObservationEntry: capture?.entry ?? DEFAULT_GPT_OBSERVATION_ENTRY, reportId: capture?.reportId });
  assertConfigIdentity(config, report);
  const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
  if (capture) RABBIT_OBSERVATION_ONCE.finish(report, reportBytes);
  RABBIT_OBSERVATION_ONCE.validateReport(report, reportBytes);
  const output = await atomic(options['--output'], report, reportBytes);
  const acknowledgementOutput = options['--ack-output'] ? await atomic(options['--ack-output'], acknowledgements) : null;
  let bindingEvidenceStatus = null;
  if (port) {
    try {
      await atomic(`${output}.caveat-binding.json`, { report_id: report.report_id,
        scan_report_sha256: createHash('sha256').update(reportBytes).digest('hex'), ...port.evidence() });
      bindingEvidenceStatus = 'saved';
    } catch {
      // 私有補助原本の保存失敗で、生成済みreportの通常受付・登録を止めない。
      // 失敗は明示し、補助原本が保存できた扱いにはしない。
      bindingEvidenceStatus = 'failed';
      process.stderr.write('[factory-scan-v9] caveat binding evidence write failed; report retained\n');
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, report_id: report.report_id, output,
    acknowledgement_output: acknowledgementOutput, ...(port ? { binding_evidence_status: bindingEvidenceStatus } : {}) })}\n`);
} catch (error) { process.stderr.write(`[factory-scan-v9] ${error?.message || '失敗'}\n`); process.exitCode = 1; }
