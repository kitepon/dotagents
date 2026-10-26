// Reuse the accepted canonical deployment reader and its original SH leases.
import { createHash } from 'node:crypto';
import { canonicalDeployment as canonical, readDeployment } from './deployment-writer.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packet = value => { const raw = Buffer.from(canonical(value)); return { bytes_base64: raw.toString('base64'), sha256: hash(raw), bytes: raw.length }; };
const fail = () => { throw new Error('core_authority_source_unconfirmed'); };
async function current(definition, lease, receipt) {
  const { input, writer, ports } = definition;
  const now = ports.clock ?? Date.now;
  const check = () => {
    if (lease.mode !== 'SH' || lease.generation !== writer.generation || lease.signal.aborted
      || canonical(lease.resources) !== canonical(input.mutation_resources) || now() >= input.deadline) fail();
  };
  check(); await lease.assertCurrent(); check();
  const context = { ...structuredClone(input), signal: lease.signal };
  // verifyProvenance/verifyAdoption produced the exact writer bundle under EX;
  // the existing verifyCurrent independently verifies originals and current
  // installation under this still-held SH. Do not run a writer/setup again.
  await ports.verifyCurrent(structuredClone(receipt), context);
  await lease.assertCurrent(); check();
  return { context, check };
}
async function readSubject(name, definition, lease, receipt) {
  const { context, check } = await current(definition, lease, receipt);
  const { ports } = definition;
  if (typeof ports.readSourceEvidence !== 'function' || typeof ports.resolveTrustedIssuer !== 'function') fail();
  const bundle = structuredClone(await ports.readSourceEvidence(receipt.evidence_ref, context));
  check();
  if (bundle?.schema !== 'factory.deployment-sources.v1' || bundle.factory_payload_sha256 !== hash(canonical(receipt.payload))
    || bundle.capture?.manifest_sha256 !== receipt.payload.manifest_sha256
    || bundle.capture?.artifact_or_tree_sha256 !== receipt.payload.artifact_or_tree_sha256
    || bundle.capture?.execution_package_root !== receipt.payload.execution_package_root
    || bundle.provenance?.subject?.evidence_ref !== receipt.payload.provenance_evidence_ref
    || hash(canonical(bundle.adoption?.subject)) !== receipt.payload.adopted_targets_sha256
    || (name === 'product' && (bundle.capture.artifact_or_tree_kind !== 'artifact' || !bundle.capture.artifact_sha256))) fail();
  const issuer = structuredClone(await ports.resolveTrustedIssuer(receipt.issuer_id, structuredClone(receipt), context));
  await lease.assertCurrent(); check();
  if (issuer?.status !== 'verified' || issuer.issuer !== receipt.issuer_id || typeof issuer.trust_ref !== 'string'
    || !issuer.trust_ref.length || issuer.trust_ref.length > 4096 || issuer.subject_sha256 !== hash(canonical(receipt.payload))) fail();
  const sourceOriginal = packet(bundle), receiptOriginal = packet(receipt);
  const checks = { status: 'verified', issuer: issuer.issuer, trust_ref: issuer.trust_ref,
    source_original_sha256: sourceOriginal.sha256, receipt_original_sha256: receiptOriginal.sha256,
    current_receipt_sha256: receiptOriginal.sha256, factory_payload_sha256: bundle.factory_payload_sha256,
    manifest_sha256: bundle.capture.manifest_sha256, provenance: bundle.provenance.subject,
    adoption: bundle.adoption.subject, evidence_ref: receipt.evidence_ref, verified_at_utc_ms: Date.now() };
  return { subject: name, source_original: sourceOriginal, receipt_original: receiptOriginal, verification_original: packet(checks) };
}

function snapshot(definition) {
  const ports = definition.ports;
  const fixed = {};
  for (const name of ['withReadLease', 'verifyCurrent', 'readSourceEvidence', 'resolveTrustedIssuer', 'clock']) {
    if (typeof ports[name] === 'function') fixed[name] = ports[name].bind(ports);
  }
  fixed.store = { load: ports.store.load.bind(ports.store) };
  return { input: structuredClone(definition.input), writer: structuredClone(definition.writer), ports: fixed };
}

/** No issuer/store/lease defaults. Supplies a private verifier only while both
 * existing readDeployment callbacks are held. Missing trust stays unknown.
 * Packets use the existing writer's canonical JSON contract, not store-file
 * whitespace/OS-byte claims. Original verification return fields are retained.
 */
export async function withCoreAuthoritySources(supplied, run) {
  const definitions = { factory: snapshot(supplied.factory), product: snapshot(supplied.product) };
  const outer = await readDeployment(definitions.factory.input, definitions.factory.writer, definitions.factory.ports, async (factoryLease, factoryReceipt) => {
    const inner = await readDeployment(definitions.product.input, definitions.product.writer, definitions.product.ports, async (productLease, productReceipt) => {
      let held = true;
      const pending = new Set();
      const verifySubjects = () => {
        if (!held) return Promise.reject(new Error('core_authority_source_unconfirmed'));
        const reservation = Promise.withResolvers();
        pending.add(reservation.promise); // Reserve before any external adapter.
        void reservation.promise.catch(() => {}); // Cleanup also observes detached failures.
        void (async () => {
          const factory = await readSubject('factory', definitions.factory, factoryLease, factoryReceipt);
          if (!held) fail();
          const product = await readSubject('product', definitions.product, productLease, productReceipt);
          if (!held) fail();
          return { factory, product };
        })().then(reservation.resolve, reservation.reject).finally(() => pending.delete(reservation.promise));
        return reservation.promise;
      };
      try { return await run(verifySubjects); }
      finally {
        held = false;
        await Promise.allSettled([...pending]); // Original SH callbacks stay held until adapters settle.
      }
    });
    if (inner.status !== 'completed') fail();
    return inner.normal_result;
  });
  return outer;
}
