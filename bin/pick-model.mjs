#!/usr/bin/env node
// 使い方: pick-model "<任務>"
//         pick-model --closed <codex|claude-code|grok-build|cursor> --until <時刻>
import { join, resolve } from 'node:path';
import { loadTypeSafeKey } from '../lib/factory/typesafe-credentials.mjs';
import { closuresPath, codexUsage, pickModel, readClosures, recordClosure } from '../lib/pick-model.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'usage: pick-model "<任務>" | pick-model --closed <harness> --until <time>';

async function main(argv) {
  if (argv[0] === '--closed') {
    if (argv.length !== 4 || argv[2] !== '--until') throw new Error(USAGE);
    const closures = await recordClosure(closuresPath(), argv[1], argv[3]);
    process.stdout.write(`${JSON.stringify({ closed: closures })}\n`);
    return;
  }
  if (argv.length !== 1 || argv[0].startsWith('--')) throw new Error(USAGE);
  const result = await pickModel({
    task: argv[0],
    modelsPath: join(ROOT, 'shared', 'runbooks', '02_models.md'),
    closures: await readClosures(closuresPath()),
    codex: await codexUsage(),
    key: await loadTypeSafeKey(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`pick-model: ${error.message}\n`);
  process.exitCode = 2;
});
