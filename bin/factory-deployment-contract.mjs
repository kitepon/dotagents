#!/usr/bin/env node
import process from 'node:process';
import { hostProjection, npmPackagesForHost } from '../lib/factory/deployment-contract.mjs';
import { caveatUpdateOwner } from '../lib/factory/caveat-update-owner.mjs';

function option(argv, name) { const index = argv.indexOf(name); if (index < 0 || !argv[index + 1] || argv.indexOf(name, index + 1) >= 0) throw new Error(`${name}が必要です`); return argv[index + 1]; }
try {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'caveat-update-owner') {
    process.stdout.write(`${caveatUpdateOwner()}\n`);
  } else if (command === 'npm-packages') {
    process.stdout.write(`${npmPackagesForHost({ os: option(argv, '--os'), arch: option(argv, '--arch') }).join('\n')}\n`);
  } else if (command === 'projection') {
    const macos = argv.includes('--macos-major') ? Number(option(argv, '--macos-major')) : null;
    process.stdout.write(`${JSON.stringify(hostProjection({ profile: option(argv, '--profile'), os: option(argv, '--os'), arch: option(argv, '--arch'), macosMajor: macos }))}\n`);
  } else if (command === 'required-products') {
    const macos = argv.includes('--macos-major') ? Number(option(argv, '--macos-major')) : null;
    process.stdout.write(`${hostProjection({ profile: option(argv, '--profile'), os: option(argv, '--os'), arch: option(argv, '--arch'), macosMajor: macos }).required.join('\n')}\n`);
  } else throw new Error('使い方: factory-deployment-contract npm-packages|projection');
} catch (error) {
  process.stderr.write(`[factory-deployment-contract] ${error.message}\n`);
  process.exitCode = 1;
}
