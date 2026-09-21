#!/usr/bin/env node
import { setupJevProduct } from '../lib/factory/jev-setup.mjs';

try {
  if (process.argv.length !== 2) throw new Error('使い方: factory-jev-setup.mjs');
  let failed = false;
  for (const id of ['jev-ultrafast', 'agent-desktop']) {
    try { process.stdout.write(`${JSON.stringify(await setupJevProduct(id))}\n`); }
    catch (error) { failed = true; process.stderr.write(`${error.message}\n`); }
  }
  if (failed) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
