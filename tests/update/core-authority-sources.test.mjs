import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalDeployment as canonical } from '../../lib/factory/deployment-writer.mjs';
import { withCoreAuthoritySources } from '../../lib/factory/core-authority-sources.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const held = { factory: false, product: false }, trace = [], values = {};
  for (const [name, generation] of [['factory', '11111111-1111-4111-8111-111111111111'], ['product', '22222222-2222-4222-8222-222222222222']]) {
    const identity = { product_id: name, host_id: 'fixture', owner: { system: 'fixture', id: 'owner' } };
    const root = `/fixture/${name}`, resources = [root], adoption = { targets: ['fixture'], extra: name }, provenance = { evidence_ref: `fixture:provenance:${name}`, extra: { retained: true } };
    const payload = { identity, execution_package_root: root, mutation_resources: resources, deployment_generation: generation,
      manifest_sha256: 'a'.repeat(64), artifact_or_tree_sha256: 'b'.repeat(64), provenance_evidence_ref: provenance.evidence_ref,
      adopted_targets_sha256: hash(canonical(adoption)) };
    const receipt = { payload, issuer_id: 'fixture:issuer', evidence_ref: `fixture:${name}`, proof: { fixture: true } };
    const input = { identity, execution_package_root: root, mutation_resources: resources, deadline: Date.now() + 60000 };
    const state = structuredClone({ ...input, phase: 'committed', generation, receipt });
    const bundle = { schema: 'factory.deployment-sources.v1', factory_payload_sha256: hash(canonical(payload)), capture: {
      execution_package_root: root, manifest_sha256: payload.manifest_sha256, artifact_or_tree_sha256: payload.artifact_or_tree_sha256,
      artifact_or_tree_kind: name === 'factory' ? 'tree' : 'artifact', artifact_sha256: name === 'product' ? 'b'.repeat(64) : null },
      provenance: { subject: provenance }, adoption: { subject: adoption } };
    const ports = { async withReadLease(rows, expected, _deadline, fn) {
      held[name] = true; trace.push(`acquire:${name}`);
      const lease = { mode: 'SH', resources: rows, generation: expected, signal: new AbortController().signal, async assertCurrent() { assert.equal(held[name], true); } };
      try { return await fn(lease); } finally { trace.push(`release:${name}`); held[name] = false; }
    }, store: { async load() { return structuredClone(state); } }, async verifyCurrent() { assert.equal(held[name], true); trace.push(`current:${name}`); },
    async readSourceEvidence() { assert.equal(held.factory && held.product, true); trace.push(`source:${name}`); return structuredClone(bundle); },
    async resolveTrustedIssuer() { return { status: 'verified', issuer: receipt.issuer_id, trust_ref: 'fixture:trust', subject_sha256: hash(canonical(payload)) }; } };
    values[name] = { input, writer: { status: 'committed', generation, receipt }, ports };
  }
  return { values, held, trace };
}
test('exact writer subjects survive and a captured verifier cannot be used after SH release', async () => {
  const f = fixture(); let escaped;
  const result = await withCoreAuthoritySources(f.values, async verify => {
    escaped = verify; const subjects = await verify();
    const bundle = JSON.parse(Buffer.from(subjects.product.source_original.bytes_base64, 'base64'));
    const checks = JSON.parse(Buffer.from(subjects.product.verification_original.bytes_base64, 'base64'));
    assert.deepEqual(checks.provenance, bundle.provenance.subject); assert.deepEqual(checks.adoption, bundle.adoption.subject);
    assert.equal(checks.provenance.extra.retained, true); return 'done';
  });
  assert.equal(result.status, 'completed'); assert.equal(result.normal_result, 'done');
  assert.deepEqual(f.held, { factory: false, product: false }); await assert.rejects(escaped(), /core_authority_source_unconfirmed/);
});
test('caller mutation cannot replace the captured input, receipt or issuer resolver', async () => {
  const f = fixture(); const original = f.values.factory.ports.withReadLease;
  f.values.factory.ports.withReadLease = async (...args) => {
    f.values.product.input.execution_package_root = '/fixture/changed';
    f.values.product.writer.generation = '33333333-3333-4333-8333-333333333333';
    f.values.product.ports.resolveTrustedIssuer = async () => { throw new Error('replacement'); };
    return await original(...args);
  };
  const result = await withCoreAuthoritySources(f.values, async verify => { await verify(); return 'original'; });
  assert.equal(result.status, 'completed'); assert.equal(result.normal_result, 'original');
});
test('detached verifier I/O settles before either original SH lease is released', async () => {
  const f = fixture(); const original = f.values.factory.ports.readSourceEvidence;
  f.values.factory.ports.readSourceEvidence = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.held.factory && f.held.product, true); f.trace.push('detached_io_settled');
    return await original(...args);
  };
  const result = await withCoreAuthoritySources(f.values, verify => { void verify(); return 'callback_returned'; });
  assert.equal(result.status, 'completed'); assert.equal(result.normal_result, 'callback_returned');
  assert.ok(f.trace.indexOf('detached_io_settled') < f.trace.indexOf('release:product'));
  assert.ok(f.trace.indexOf('detached_io_settled') < f.trace.indexOf('release:factory'));
});
