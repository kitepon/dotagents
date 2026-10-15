#!/usr/bin/env node
import { readRunnerProfile } from '../lib/factory/runner-profile.mjs';

try {
  if (process.argv.length !== 2) throw new Error('factory-runner-profile does not accept arguments');
  console.log(JSON.stringify(readRunnerProfile()));
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
