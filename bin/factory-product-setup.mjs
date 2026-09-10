#!/usr/bin/env node
import { runProductSetup } from '../lib/factory/product-setup.mjs';

if (process.argv.length !== 3) throw new Error('使い方: factory-product-setup.mjs <product>');
process.exitCode = await runProductSetup(process.argv[2]) === 'failed' ? 1 : 0;
