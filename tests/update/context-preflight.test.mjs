import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextPreflightView, readRestorationSource } from '../../lib/factory/update-context-preflight.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = '/srv/bellteam/bots/bot-62c62f61/artifacts/2026-10-25-update-context-preflight/fixtures';
const source = await readRestorationSource(ROOT);
const registration = { uid: 1000, primary_gid: 1000, entry_realpath: '/fixture/setup-linux-factory.sh' };
const hash = 'a'.repeat(64);
const command = (path, version) => ({ path, realpath: path, version, sha256: hash });
function originals() {
  const stages = ['job_input', 'prefix_before', 'global_bin', 'global_after', 'public_core'];
  const records = Object.fromEntries(stages.map((stage, index) => [stage, {
    kind: 'fixture', evidence_ref: `fixture:${stage}`, observed_at_utc_ms: 1000 + index,
    uid: 1000, gid: 1000, ...(index ? { input_evidence_ref: `fixture:${stages[index - 1]}` } : {}),
  }]));
  Object.assign(records.job_input, { provenance: 'job_process', pid: 42, entry_realpath: registration.entry_realpath,
    cwd: '/fixture/cwd', restore_input_sha256: hash });
  Object.assign(records.prefix_before, { cwd: '/fixture/cwd', path_value: '/fixture/nvm/bin:/usr/bin',
    node: command('/fixture/nvm/bin/node', '1.0.0'), npm: command('/fixture/nvm/bin/npm', '3.0.0'),
    restoration_source_sha256: Object.fromEntries(source.fragments.map((value) => [value.stage, value.sha256])),
    nvm_effect_review_ref: 'fixture:environment-only-nvm' });
  Object.assign(records.global_bin, { prefix: '/fixture/global', bin_path: '/fixture/global/bin', exists: true,
    prefix_exit_code: 0, prefix_source_evidence_ref: 'fixture:prefix-stdout-original' });
  Object.assign(records.global_after, { cwd: '/fixture/cwd', path_value: '/fixture/global/bin:/fixture/nvm/bin:/usr/bin',
    node: command('/fixture/global/bin/node', '2.0.0'), npm: command('/fixture/global/bin/npm', '4.0.0'),
    root: '/fixture/independently-read-root', root_exit_code: 0, root_source_evidence_ref: 'fixture:root-stdout-original' });
  Object.assign(records.public_core, { cwd: records.global_after.cwd, path_value: records.global_after.path_value,
    node: structuredClone(records.global_after.node), npm: structuredClone(records.global_after.npm), root: records.global_after.root });
  return records;
}

test('current crontab principal alone cannot establish a job execution context', () => {
  const view = contextPreflightView({ registration });
  assert.equal(view.status, 'unknown');
  assert.equal(view.stopped_at, 'job_input');
  assert.deepEqual(view.observed, []);
  assert.equal(view.real_host_execution_authorized, false);
});

test('same UID in an SSH login does not replace actual job input provenance', () => {
  const records = originals(); records.job_input.provenance = 'ssh_login';
  const view = contextPreflightView({ registration, records, evidenceKind: 'fixture' });
  assert.equal(view.reason, 'actual_job_context_not_bound');
  assert.equal(view.observed.length, 0);
});

test('fixture stages retain different prefix-before and global-after commands and independent root', () => {
  const records = originals();
  const view = contextPreflightView({ registration, records, evidenceKind: 'fixture' });
  assert.equal(view.status, 'fixture_context_stages_only');
  assert.equal(view.observed[1].node.realpath, '/fixture/nvm/bin/node');
  assert.equal(view.observed[3].node.realpath, '/fixture/global/bin/node');
  assert.equal(view.observed[3].root, '/fixture/independently-read-root');
  assert.equal(view.observed[3].observed_at_utc_ms, 1003);
  assert.equal(view.reporting_allowed, false);
  assert.equal(view.resource_coverage, 'unknown');
  assert.equal(contextPreflightView({ registration, records }).status, 'unknown');
});

test('absent global bin blocks later originals without creating or inferring a directory', () => {
  const records = originals(); records.global_bin.exists = false;
  const view = contextPreflightView({ registration, records, evidenceKind: 'fixture' });
  assert.equal(view.reason, 'global_bin_missing_or_unknown');
  assert.equal(view.observed.length, 2);
  assert.deepEqual(view.observed.at(-1), records.prefix_before);
});

test('missing later npm is unknown rather than copied from the earlier stage', () => {
  const records = originals(); delete records.global_after.npm;
  const view = contextPreflightView({ registration, records, evidenceKind: 'fixture' });
  assert.equal(view.reason, 'stage_node_npm_not_observed');
  assert.equal(view.stopped_at, 'global_after');
});

test('core context mismatch and missing NVM-effect original both stop acceptance', () => {
  const records = originals(); records.public_core.cwd = '/fixture/other';
  assert.equal(contextPreflightView({ registration, records, evidenceKind: 'fixture' }).reason, 'public_core_context_mismatch');
  records.public_core.cwd = records.global_after.cwd;
  records.public_core.node.sha256 = 'b'.repeat(64);
  assert.equal(contextPreflightView({ registration, records, evidenceKind: 'fixture' }).reason, 'public_core_context_mismatch');
  delete records.prefix_before.nvm_effect_review_ref;
  assert.equal(contextPreflightView({ registration, records, evidenceKind: 'fixture' }).reason, 'restoration_source_or_effect_review_missing');
});

async function fixture() {
  await mkdir(FIXTURES, { recursive: true, mode: 0o700 });
  const root = join(FIXTURES, randomUUID()); await mkdir(root, { mode: 0o700 }); return root;
}
async function runRestorationFixture(globalExists) {
  const root = await fixture(); const home = join(root, 'home'); const nvm = join(home, '.nvm');
  await mkdir(nvm, { recursive: true, mode: 0o700 });
  const globalBin = join(root, 'global', 'bin');
  const bins = [join(nvm, 'stage-1', 'bin'), join(nvm, 'stage-2', 'bin'), ...(globalExists ? [globalBin] : [])];
  for (const bin of bins) {
    await mkdir(bin, { recursive: true, mode: 0o700 });
    for (const name of ['node', 'npm']) await writeFile(join(bin, name), '#!/bin/bash\nprintf invoked >> "$AUDIT_MARKER"\nexit 97\n', { mode: 0o700 });
  }
  await writeFile(join(nvm, 'nvm.sh'), 'fixture_nvm_count=$(( ${fixture_nvm_count:-0} + 1 ))\nexport fixture_nvm_count\nPATH="$NVM_DIR/stage-$fixture_nvm_count/bin:$PATH"\nexport PATH\n', { mode: 0o600 });
  const script = `set -euo pipefail\n${source.fragments.map((value) => value.content).join('\n')}
printf 'nvm_count=%s\\nnode_before=%s\\nnpm_before=%s\\n' "$fixture_nvm_count" "$(command -v node)" "$(command -v npm)"
npm_global_bin="$GLOBAL_BIN"
if [[ -d "$npm_global_bin" ]]; then
${source.global_bin_path_assignment}
printf 'node_after=%s\\nnpm_after=%s\\n' "$(command -v node)" "$(command -v npm)"
else printf 'global_bin_missing\\n'; fi
`;
  const stdout = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
    cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', NVM_DIR: nvm, GLOBAL_BIN: globalBin,
      AGENTS_UPDATE_PATH_PREFIX: join(root, 'configured-bin'), AUDIT_MARKER: join(root, 'forbidden-invocation') }, encoding: 'utf8',
  });
  await writeFile(join(root, 'fixture.stdout'), stdout, { mode: 0o600 });
  await assert.rejects(access(join(root, 'forbidden-invocation')));
  await assert.rejects(access(join(home, '.local', 'state', 'agents-update')));
  return { root, nvm, globalBin, stdout };
}

test('exact ordinary restoration slices run twice with fake NVM and resolve each PATH stage separately', async () => {
  const value = await runRestorationFixture(true);
  assert.match(value.stdout, /nvm_count=2/u);
  assert.ok(value.stdout.includes(`node_before=${value.nvm}/stage-2/bin/node`));
  assert.ok(value.stdout.includes(`npm_before=${value.nvm}/stage-2/bin/npm`));
  assert.ok(value.stdout.includes(`node_after=${value.globalBin}/node`));
  assert.ok(value.stdout.includes(`npm_after=${value.globalBin}/npm`));
});

test('isolated restoration does not create a missing prefix bin or invoke fake Node/npm', async () => {
  const value = await runRestorationFixture(false);
  assert.match(value.stdout, /global_bin_missing/u);
  await assert.rejects(access(value.globalBin));
  assert.doesNotMatch(value.stdout, /node_after=/u);
});

test('changed canonical writer source is refused before fragments can be executed', async () => {
  const root = await fixture(); await mkdir(join(root, 'bin'), { mode: 0o700 });
  const original = await readFile(join(ROOT, 'bin/setup-linux-common.sh'));
  await writeFile(join(root, 'bin/setup-linux-common.sh'), Buffer.concat([original, Buffer.from('\n# drift\n')]));
  await assert.rejects(readRestorationSource(root), /context_source_changed/u);
});
