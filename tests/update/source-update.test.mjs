import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateSource } from '../../bin/agents-source-update.mjs';

const canonical = 'https://github.com/kitepon/dotagents.git';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dotagents-source-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const upstream = join(base, 'upstream'); const local = join(base, 'local');
  function git(root, ...args) {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  git(base, 'init', '-b', 'main', upstream);
  git(upstream, 'config', 'user.name', 'Test'); git(upstream, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(upstream, 'tracked'), 'old'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'initial');
  git(base, 'clone', upstream, local);
  git(local, 'remote', 'set-url', 'origin', canonical);
  git(local, 'config', `url.${upstream.replaceAll('\\', '/')}.insteadOf`, canonical);
  return { base, local, upstream, git };
}

test('source sync advances only clean main and preserves local files', (t) => {
  const { local, upstream, git } = fixture(t);
  // A local remote is deliberately rejected before fetch.
  git(local, 'remote', 'set-url', 'origin', upstream);
  assert.equal(updateSource(local).reason, 'unexpected_origin');
  git(local, 'remote', 'set-url', 'origin', canonical);
  writeFileSync(join(local, 'tracked'), 'work');
  assert.equal(updateSource(local).reason, 'tracked_changes');
  assert.equal(readFileSync(join(local, 'tracked'), 'utf8'), 'work');
  git(local, 'checkout', '-b', 'feature');
  assert.equal(updateSource(local).reason, 'branch_not_main');
});

test('fast forward uses new source and refuses divergent history or path collisions', (t) => {
  const { local, upstream, git } = fixture(t);
  const before = git(local, 'rev-parse', 'HEAD');
  writeFileSync(join(local, 'personal'), 'keep');
  writeFileSync(join(upstream, 'tracked'), 'new'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'update');
  const synced = updateSource(local);
  assert.equal(synced.ok, true); assert.equal(synced.before, before);
  assert.equal(readFileSync(join(local, 'tracked'), 'utf8'), 'new');
  assert.equal(readFileSync(join(local, 'personal'), 'utf8'), 'keep');
  assert.equal(updateSource(local).reason, 'already_current');
  writeFileSync(join(upstream, 'personal'), 'incoming'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'collision');
  assert.equal(updateSource(local).ok, false);
  assert.equal(readFileSync(join(local, 'personal'), 'utf8'), 'keep');
  assert.equal(git(local, 'rev-parse', 'HEAD'), synced.after);
  git(local, 'config', 'user.name', 'Test'); git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'commit', '--allow-empty', '-m', 'local only');
  const divergent = git(local, 'rev-parse', 'HEAD');
  assert.equal(updateSource(local).ok, false);
  assert.equal(git(local, 'rev-parse', 'HEAD'), divergent);
});

test('entry runs the new writer once and carries source failure to the existing report', (t) => {
  const { local, upstream, base, git } = fixture(t);
  mkdirSync(join(upstream, 'bin'));
  writeFileSync(join(upstream, 'bin', 'agents-update.sh'), 'printf "new:%s:%s" "$DOTAGENTS_SOURCE_UPDATED" "$DOTAGENTS_SOURCE_UPDATE_FAILED"');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'writer');
  const run = () => spawnSync(process.execPath, [resolve('bin/agents-source-update.mjs'), join(local, 'bin', 'agents-update.sh'), join(base, 'log'), 'bash'], { encoding: 'utf8' });
  const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'new:1:0');
  writeFileSync(join(local, 'tracked'), 'dirty');
  const failed = run(); assert.equal(failed.status, 0, failed.stderr); assert.equal(failed.stdout, 'new:1:1');
  const logs = readFileSync(join(base, 'log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs[0].reason, 'updated'); assert.equal(logs[1].reason, 'tracked_changes');
});

test('the same checkout through a directory alias is accepted', (t) => {
  const { local, base } = fixture(t);
  const alias = join(base, 'alias');
  symlinkSync(local, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = updateSource(alias);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.reason, 'already_current');
});
