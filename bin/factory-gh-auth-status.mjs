#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function githubAuthStatus(args = [], run = spawnSync) {
  const help = run('gh', ['auth', 'status', '--help'], { encoding: 'utf8' });
  // Unknown capabilities must not fall back to a potentially refreshing status.
  if (help.error || help.status !== 0) return 2;
  const flags = /(?:^|\s)--no-refresh(?:\s|$)/u.test(help.stdout) ? ['--no-refresh'] : [];
  const result = run('gh', ['auth', 'status', ...flags, ...args], { stdio: 'ignore' });
  if (result.error || result.signal) return 2;
  return result.status === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = githubAuthStatus(process.argv.slice(2));
  if (process.exitCode === 2) console.error('FAIL: GitHub CLIの状態を資格更新なしで確認できない');
}
