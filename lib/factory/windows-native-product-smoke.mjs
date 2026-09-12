import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CURRENT_WIRE_PRODUCT_IDS } from './deployment-contract.mjs';

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value;
}

export function assertWindowsNativeProductSmoke(report, runtimeArch = process.arch) {
  record(report, 'report');
  if (report.schema_version !== '8.0' || report.host_profile !== 'windows-native') throw new Error('report is not Windows native wire v8');
  if (!report.platform || report.platform.os !== 'windows' || report.platform.arch !== runtimeArch) throw new Error('report platform does not match this Windows runtime');
  const products = record(report.products, 'products');
  if ('observer' in products) throw new Error('observer must be absent from the wire v8 product set');
  const expected = [...CURRENT_WIRE_PRODUCT_IDS].sort();
  const actual = Object.keys(products).sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) throw new Error('wire v8 product set is incomplete or contains unknown products');

  return Object.freeze({
    schema: 'dotagents.windows-native-report-inventory.v1',
    status: 'passed',
    reported_products: expected.length,
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('windows-native-product-smoke is Windows-native only');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--report' || !args[1]) throw new Error('usage: windows-native-product-smoke --report <latest-report.json>');
  const report = JSON.parse(await readFile(args[1], 'utf8'));
  process.stdout.write(`${JSON.stringify(assertWindowsNativeProductSmoke(report))}\n`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`[windows-native-product-smoke] ${error.message}\n`);
    process.exitCode = 1;
  });
}
