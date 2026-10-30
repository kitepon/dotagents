#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function updateSource(root) {
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout.trim();
  };
  let before = null;
  try {
    if (resolve(git('rev-parse', '--show-toplevel')) !== resolve(root)) throw new Error('checkout_root_mismatch');
    if (git('branch', '--show-current') !== 'main') throw new Error('branch_not_main');
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)kitepon\/dotagents(?:\.git)?$/u.test(git('config', '--get', 'remote.origin.url'))) throw new Error('unexpected_origin');
    if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('tracked_changes');
    before = git('rev-parse', 'HEAD');
    git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    // ff-only also protects files created locally that conflict with incoming paths.
    git('merge-base', '--is-ancestor', before, 'refs/remotes/origin/main');
    git('merge', '--ff-only', 'refs/remotes/origin/main');
    const after = git('rev-parse', 'HEAD');
    return { ok: true, before, after, reason: before === after ? 'already_current' : 'updated' };
  } catch (error) {
    return { ok: false, before, reason: error.message };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runner, log, bash, ...args] = process.argv.slice(2);
  if (!runner || !log || !bash) process.exit(2);
  const result = updateSource(dirname(dirname(runner)));
  appendFileSync(log, `${JSON.stringify({ step: 'dotagents-source', at: new Date().toISOString(), ...result })}\n`);
  // Reopen the updated Bash file only after git has finished replacing it.
  const child = spawnSync(bash, [runner, ...args], { stdio: 'inherit', env: {
    ...process.env, DOTAGENTS_SOURCE_UPDATED: '1', DOTAGENTS_SOURCE_UPDATE_FAILED: result.ok ? '0' : '1',
  } });
  if (child.error) process.stderr.write('agents-update restart failed\n');
  process.exit(child.status ?? 1);
}
