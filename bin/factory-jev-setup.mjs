#!/usr/bin/env node
import { setupJevProduct } from '../lib/factory/jev-setup.mjs';

try {
  const ids = process.argv.length === 2 ? ['jev-ultrafast', 'agent-desktop'] : [process.argv[2]];
  if (process.argv.length > 3 || !ids.every((id) => ['jev-ultrafast', 'agent-desktop'].includes(id))) {
    throw new Error('使い方: factory-jev-setup.mjs [jev-ultrafast|agent-desktop]');
  }
  let failed = false;
  for (const id of ids) {
    try { process.stdout.write(`${JSON.stringify(await setupJevProduct(id))}\n`); }
    catch (error) { failed = true; process.stderr.write(`${error.message}\n`); }
  }
  if (failed) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
