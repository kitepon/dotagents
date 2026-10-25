// Dedicated original-Node sender fixture. No real product setup/probe/issuer.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOriginalNodeAuthorityBroker } from '../../lib/factory/update-context-node-broker.mjs';
import { withCoreAuthoritySources } from '../../lib/factory/core-authority-sources.mjs';
import { canonicalDeployment as canonical } from '../../lib/factory/deployment-writer.mjs';
const [directory, expiresText, mode, bridgeSource] = process.argv.slice(2);
const expires = Number(expiresText), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = fileURLToPath(new URL('./core_bootstrap_product_fixture.mjs', import.meta.url));
const bootstrap = spawnSync('/usr/bin/python3', ['-I', '-S', fileURLToPath(new URL('./node_factory_bootstrap_fixture.py', import.meta.url)), directory,
  expiresText, fileURLToPath(import.meta.url), entry], { encoding: 'utf8', timeout: 2500 });
assert.equal(bootstrap.status, 0, bootstrap.stderr);
const original = JSON.parse(bootstrap.stdout); assert.equal(original.factory_pid, process.pid);
const held = { factory: false, product: false }, counts = { current: 0, subject: 0 };
function definition(name) {
  const bundle = JSON.parse(Buffer.from(original.subjects[name].source_original.bytes_base64, 'base64').toString());
  if (mode === 'incomplete' && name === 'factory') {
    const manifest = JSON.parse(Buffer.from(bundle.capture.manifest_bytes_base64, 'base64'));
    manifest.files = manifest.files.filter(row => row.role !== 'kernel_receiver');
    const raw = Buffer.from(JSON.stringify(manifest));
    bundle.capture.manifest_bytes_base64 = raw.toString('base64'); bundle.capture.manifest_sha256 = hash(raw);
  }
  const identity = { product_id: name, host_id: 'fixture', owner: { system: 'fixture', id: 'owner' } };
  const root = `/fixture/${name}`, resources = [root], generation = name === 'factory' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
  bundle.capture.execution_package_root = root;
  bundle.capture.artifact_or_tree_sha256 = name === 'factory' ? 'b'.repeat(64) : bundle.capture.artifact_sha256;
  bundle.provenance.subject.evidence_ref = `fixture:provenance:${name}`;
  const payload = { identity, execution_package_root: root, mutation_resources: resources, deployment_generation: generation,
    manifest_sha256: bundle.capture.manifest_sha256, artifact_or_tree_sha256: bundle.capture.artifact_or_tree_sha256,
    provenance_evidence_ref: bundle.provenance.subject.evidence_ref, adopted_targets_sha256: hash(canonical(bundle.adoption.subject)) };
  bundle.factory_payload_sha256 = hash(canonical(payload));
  const receipt = { payload, issuer_id: 'fixture:issuer', evidence_ref: `fixture:${name}`, proof: { fixture: true } };
  const input = { identity, execution_package_root: root, mutation_resources: resources, deadline: Date.now() + 60000 };
  const writer = { status: 'committed', generation, receipt };
  const ports = {
    async withReadLease(rows, actualGeneration, _deadline, fn) {
      held[name] = true;
      const lease = { mode: 'SH', resources: rows, generation: actualGeneration, signal: new AbortController().signal,
        async assertCurrent() { assert.equal(held[name], true); } };
      try { return await fn(lease); } finally { held[name] = false; }
    },
    store: { async load() { return { ...input, phase: 'committed', generation, receipt }; } },
    async verifyCurrent() { assert.equal(held[name], true); counts.current++; },
    async readSourceEvidence() { assert.equal(held[name], true); return bundle; },
    ...(mode === 'missing' ? {} : { async resolveTrustedIssuer() {
      assert.equal(held.factory && held.product, true);
      return { status: 'verified', issuer: 'fixture:issuer', trust_ref: 'fixture:root', subject_sha256: hash(canonical(payload)) };
    } }),
  };
  return { input, writer, ports };
}
let escaped;
const outcome = await withCoreAuthoritySources({ factory: definition('factory'), product: definition('product') }, async verify => {
  escaped = verify;
  const child = spawn(process.execPath, [entry, directory, expiresText, ...(bridgeSource ? [bridgeSource] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 6] });
  closeSync(6);
  const out = [], errors = [];
  child.stdout.on('data', value => out.push(value)); child.stderr.on('data', value => errors.push(value));
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  const broker = createOriginalNodeAuthorityBroker({ productPid: mode === 'wrong' ? process.pid : child.pid, productEntry: entry,
    activation: directory, expiresAt: expires, beforeRef: original.before_ref, evidenceKind: 'fixture',
    verifySubjects: async binding => { counts.subject++; assert.equal(held.factory && held.product, true); return await verify(binding); } });
  const statuses = [];
  try {
    statuses.push(await broker.serveOnce()); if (statuses[0] === 'verified') statuses.push(await broker.serveOnce());
  } catch { statuses.push('kernel_unconfirmed'); }
  const finish = await closed; assert.equal(finish.code, 0, Buffer.concat(errors).toString());
  return { statuses, result: JSON.parse(Buffer.concat(out)), factory_pid: process.pid };
});
closeSync(5);
assert.equal(held.factory || held.product, false);
await assert.rejects(escaped(), /core_authority_source_unconfirmed/);
process.stdout.write(JSON.stringify({ outcome, counts, leases_released: true, escaped_verifier_rejected: true }) + '\n');
