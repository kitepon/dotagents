#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import process from 'node:process';
import { assertConfigIdentity, readConfig, validateReportV8 } from '../lib/factory/contract.mjs';
import { scanV8WithAcknowledgements } from '../lib/factory/v8.mjs';

function parse(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!['--config', '--output', '--ack-output', '--cwd'].includes(key) || !argv[i + 1] || out[key]) throw new Error('使い方: factory-scan-v8 --config <file> --output <file> [--ack-output <file>] [--cwd <project>]'); out[key] = argv[++i]; } if (!out['--config'] || !out['--output']) throw new Error('--config と --output が必要です'); return out; }
async function atomic(path, value) { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temp, path); return path; }

try { const options = parse(process.argv.slice(2)); const config = await readConfig(options['--config']); const { report, acknowledgements } = await scanV8WithAcknowledgements({ host: config.host, collectionEnabled: config.collection.enabled, cwd: options['--cwd'] || process.cwd(), arch: arch(), platform: platform() }); validateReportV8(report); assertConfigIdentity(config, report); const output = await atomic(options['--output'], report); const acknowledgementOutput = options['--ack-output'] ? await atomic(options['--ack-output'], acknowledgements) : null; process.stdout.write(`${JSON.stringify({ ok: true, report_id: report.report_id, output, acknowledgement_output: acknowledgementOutput })}\n`); } catch (error) { process.stderr.write(`[factory-scan-v8] ${error?.message || '失敗'}\n`); process.exitCode = 1; }
