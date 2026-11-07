import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Boundary checks for docs/feature-map/mac-node-runtime.md. The script refuses to run outside darwin-arm64.
// It is copied with a test pin for this CI Node, and fake runtimes are copies of this Node binary so that the
// owner is the test UID. curl is a failing stub: the real download is proven by the host staging run.
const supported = process.platform === 'darwin' && process.arch === 'arm64';
const source = fileURLToPath(new URL('../../lib/factory/mac-node-runtime.sh', import.meta.url));
const version = process.versions.node;
const sha = 'ab'.repeat(32);
const identity = `v${version}-${sha.slice(0, 16)}`;
const marker = `version=${version} sha256=${sha} uid=${process.getuid?.()}\n`;

async function fixture(t) {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-node-runtime-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const base = path.join(work, 'base');
  const stubs = path.join(work, 'stubs');
  await mkdir(base);
  await mkdir(stubs);
  await writeFile(path.join(stubs, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
  const script = path.join(work, 'factory-node-runtime.sh');
  const text = await readFile(source, 'utf8');
  const pinned = text.replace(/^ {2}"24\.22\.0 [0-9a-f]{64}"\) ;;$/mu, `  "${version} ${sha}") ;;`);
  assert.notEqual(pinned, text, 'pin line must be replaceable');
  await writeFile(script, pinned, { mode: 0o755 });
  const run = (args = [version, sha]) => {
    const output = path.join(work, 'github-output');
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, FACTORY_NODE_BASE: base, PATH: `${stubs}:${process.env.PATH}` },
    });
    return { ...result, output };
  };
  return { work, base, run };
}

async function generation(dir, { complete = true, markerText = marker, node = 'real' } = {}) {
  await mkdir(path.join(dir, 'bin'), { recursive: true, mode: 0o755 });
  const target = path.join(dir, 'bin', 'node');
  if (node === 'real') {
    await copyFile(process.execPath, target);
    // Homebrew Node loads @rpath/libnode from @loader_path/../lib; the official single binary ignores it.
    await symlink(path.join(path.dirname(await realpath(process.execPath)), '..', 'lib'), path.join(dir, 'lib'));
  }
  else await writeFile(target, '#!/bin/sh\necho 0.0.0\n');
  await chmod(target, 0o755);
  if (complete) await writeFile(path.join(dir, '.factory-complete'), markerText);
}

async function root(base, name = 'factory-node') {
  const dir = path.join(base, name);
  await mkdir(path.join(dir, identity), { recursive: true });
  await chmod(dir, 0o755);
  return path.join(dir, identity);
}

async function snapshot(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name)).sort();
}

const outputs = async (file) => Object.fromEntries((await readFile(file, 'utf8')).trim().split('\n').map((line) => line.split(/=(.*)/su).slice(0, 2)));

test('unpinned version or sha is refused before anything is created', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  for (const args of [[version, '0'.repeat(64)], ['0.0.1', sha]]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
  }
  assert.deepEqual(await readdir(base), []);
});

test('lattice-node namespace and squatted roots are skipped untouched; next sibling root is created', { skip: !supported }, async (t) => {
  const { work, base, run } = await fixture(t);
  const lattice = path.join(base, 'lattice-node', identity, 'g1');
  await generation(lattice);
  const elsewhere = path.join(work, 'elsewhere');
  await generation(path.join(elsewhere, identity, 'g1'));
  await symlink(elsewhere, path.join(base, 'factory-node'));
  const writable = path.join(base, 'factory-node.2');
  await generation(path.join(writable, identity, 'g1'));
  await chmod(writable, 0o777);
  const before = [await snapshot(path.join(base, 'lattice-node')), await snapshot(elsewhere), await snapshot(writable)];
  const result = run();
  assert.notEqual(result.status, 0, 'with no safe generation and no download the job must fail');
  assert.match(result.stderr, new RegExp(`reserved ${base}/factory-node\\.3/${identity}/g1`, 'u'));
  assert.ok((await lstat(path.join(base, 'factory-node'))).isSymbolicLink());
  assert.equal((await lstat(writable)).mode & 0o777, 0o777);
  assert.deepEqual([await snapshot(path.join(base, 'lattice-node')), await snapshot(elsewhere), await snapshot(writable)], before);
});

test('unpublished g1 is skipped untouched and complete g2 is reused with an exact receipt', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { complete: false });
  await generation(path.join(dir, 'g2'));
  const before = await snapshot(dir);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.generation, 'g2');
  assert.equal(receipt.identity, identity);
  assert.equal(receipt.sha256, sha);
  assert.equal(receipt.uid, process.getuid());
  assert.equal(receipt.mode, '755');
  assert.equal(receipt.marker, path.join(dir, 'g2', '.factory-complete'));
  assert.deepEqual(await outputs(result.output), { directory: path.join(dir, 'g2'), node: path.join(dir, 'g2', 'bin', 'node') });
  assert.deepEqual(await snapshot(dir), before);
});

test('complete generations with a mismatched marker or failed verify are skipped untouched', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { markerText: marker.replace(sha, '0'.repeat(64)) });
  await generation(path.join(dir, 'g2'), { node: 'wrong' });
  await generation(path.join(dir, 'g3'));
  const before = await snapshot(dir);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await outputs(result.output)).directory, path.join(dir, 'g3'));
  assert.deepEqual(await snapshot(dir), before);
});

test('build failure removes only its own reservation, numbered after the existing one', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { complete: false });
  const before = await snapshot(dir);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`reserved ${dir}/g2`, 'u'));
  assert.deepEqual(await snapshot(dir), before);
});
