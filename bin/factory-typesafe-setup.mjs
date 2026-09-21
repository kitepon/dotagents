#!/usr/bin/env node
import { setupTypeSafe } from '../lib/factory/typesafe-setup.mjs';

try {
  if (process.argv.length !== 2) throw new Error('使い方: node bin/factory-typesafe-setup.mjs');
  const result = await setupTypeSafe();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`[TypeSafe] 失敗: ${error.message}`);
  process.exitCode = 1;
}
