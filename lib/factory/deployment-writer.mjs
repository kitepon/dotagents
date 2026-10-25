import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';

// Source composition only. No default OS lock, credential, trust root or store.
const digest = value => createHash('sha256').update(value).digest('hex');
export function canonicalDeployment(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDeployment).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalDeployment(value[key])}`).join(',')}}`;
  throw new Error('deployment_noncanonical_value');
}
const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
function path(value) {
  if (!text(value)) return false;
  const parser = /^[A-Za-z]:\\|^\\\\/u.test(value) ? win32 : posix;
  return parser.isAbsolute(value) && parser.normalize(value) === value;
}
function requestCopy(input) {
  const value = structuredClone(input);
  if (!value || !text(value.identity?.product_id) || !text(value.identity?.host_id) ||
      !text(value.identity?.owner?.system) || !text(value.identity?.owner?.id) ||
      !path(value.execution_package_root) || !Array.isArray(value.mutation_resources) ||
      !value.mutation_resources.length || value.mutation_resources.some(item => !path(item)) ||
      new Set(value.mutation_resources).size !== value.mutation_resources.length ||
      value.mutation_resources.some((item, index, rows) => index > 0 && rows[index - 1] >= item) ||
      !Number.isFinite(value.deadline)) fail('deployment_request_invalid');
  // Native canonicalization, aliases/case, overlap and all-writer participation
  // remain adapter preconditions; lexical checks do not prove those properties.
  canonicalDeployment(value.identity);
  return value;
}
function functions(ports, names) {
  for (const name of names) if (typeof ports?.[name] !== 'function') fail('deployment_port_missing');
}
function check(lease, request, clock, expectedGeneration) {
  if (!lease?.signal || typeof lease.signal.aborted !== 'boolean' || typeof lease.assertCurrent !== 'function') fail('deployment_lease_invalid');
  if (lease.signal.aborted || clock() >= request.deadline) fail('deployment_lease_inactive');
  if (expectedGeneration !== undefined && (lease.mode !== 'SH' || !Array.isArray(lease.resources) ||
      canonicalDeployment(lease.resources) !== canonicalDeployment(request.mutation_resources) ||
      lease.generation !== expectedGeneration)) fail('deployment_lease_metadata_mismatch');
}
async function guard(lease, request, clock, expectedGeneration) {
  check(lease, request, clock, expectedGeneration);
  await lease.assertCurrent();
  check(lease, request, clock, expectedGeneration);
}
function originalPacket(value) {
  if (!value || value.payload == null || value.provenance == null) return false;
  canonicalDeployment(value);
  return true;
}
const context = (request, lease) => ({ ...structuredClone(request), signal: lease.signal });
const safeReasons = new Set(['deployment_lease_invalid', 'deployment_lease_inactive', 'deployment_recovery_required',
  'deployment_generation_invalid', 'deployment_retired_failed', 'deployment_install_failed', 'deployment_capture_invalid',
  'deployment_provenance_mismatch', 'deployment_adoption_invalid', 'deployment_receipt_invalid', 'deployment_generation_changed',
  'deployment_actual_changed', 'deployment_store_conflict', 'deployment_resources_unaccepted', 'deployment_trust_unaccepted',
  'deployment_lease_metadata_mismatch', 'deployment_source_evidence_missing', 'deployment_source_evidence_mismatch']);
const publicReason = error => error instanceof Error && safeReasons.has(error.message) ? error.message : 'deployment_port_failed';
function sameScope(state, request) {
  return canonicalDeployment(state.identity) === canonicalDeployment(request.identity) &&
    state.execution_package_root === request.execution_package_root &&
    canonicalDeployment(state.mutation_resources) === canonicalDeployment(request.mutation_resources);
}

/**
 * store.replace is an atomic durable full-state replacement with generation
 * CAS, including removal of the old active receipt. Adapters must be supplied.
 * Async adapters must settle after cancellation before their lease is released;
 * racing a still-running installer against a timer would break exclusivity.
 */
export async function writeDeployment(input, ports, operations) {
  const request = requestCopy(input), clock = ports.clock ?? Date.now;
  if (request.provenance == null || request.target_adoption == null) fail('deployment_source_evidence_missing');
  canonicalDeployment(request.provenance);
  canonicalDeployment(request.target_adoption);
  functions(ports, ['withWriteLease', 'assertResources', 'capture', 'verifyProvenance', 'verifyAdoption', 'issueReceipt', 'readSourceEvidence']);
  functions(ports.store, ['load', 'replace']);
  functions(operations, ['retire', 'install']);
  let result = { status: 'blocked', reason: 'deployment_not_started', package_result: null };
  try {
    return await ports.withWriteLease([...request.mutation_resources], request.deadline, async lease => {
      await guard(lease, request, clock);
      await ports.assertResources(context(request, lease));
      await guard(lease, request, clock);
      const old = await ports.store.load(structuredClone(request.identity));
      await guard(lease, request, clock);
      if (old && (!sameScope(old, request) || old.phase !== 'committed')) fail('deployment_recovery_required');
      const generation = (ports.uuid ?? randomUUID)();
      if (!uuid(generation) || generation === old?.generation) fail('deployment_generation_invalid');
      const base = { schema: 'factory.deployment-state.v1', identity: request.identity,
        execution_package_root: request.execution_package_root, mutation_resources: request.mutation_resources, generation };
      let expectedGeneration = old?.generation ?? null;
      const save = async record => {
        await ports.store.replace(structuredClone(record), { expectedGeneration });
        expectedGeneration = generation;
      };
      let started = false, stage = 'state', packageResult = null;
      try {
        // If this write fails, no prefix-changing operation is permitted.
        await save({ ...base, phase: 'mutating', receipt: null });
        started = true;
        await guard(lease, request, clock);
        stage = 'retired_before';
        if ((await operations.retire('before', context(request, lease)))?.ok !== true) fail('deployment_retired_failed');
        await guard(lease, request, clock);
        stage = 'package';
        packageResult = await operations.install(context(request, lease));
        if (packageResult?.ok !== true) fail('deployment_install_failed');
        await guard(lease, request, clock);
        stage = 'retired_after';
        if ((await operations.retire('after', context(request, lease)))?.ok !== true) fail('deployment_retired_failed');
        await guard(lease, request, clock);
        stage = 'evidence';
        const rawCapture = await ports.capture(context(request, lease));
        const rawManifest = rawCapture?.manifest_bytes;
        const manifestBytes = Buffer.isBuffer(rawManifest) ? Buffer.from(rawManifest) : rawManifest;
        const captured = structuredClone(rawCapture);
        await guard(lease, request, clock);
        if (captured?.execution_package_root !== request.execution_package_root ||
            !(Buffer.isBuffer(manifestBytes) || typeof manifestBytes === 'string') ||
            !['tree', 'artifact'].includes(captured.artifact_or_tree_kind) ||
            !sha(captured.tree_sha256) || !originalPacket(captured.tree_original) ||
            !(captured.artifact_sha256 === null || sha(captured.artifact_sha256)) ||
            !sha(captured.artifact_or_tree_sha256) ||
            captured.artifact_or_tree_sha256 !== (captured.artifact_or_tree_kind === 'tree' ? captured.tree_sha256 : captured.artifact_sha256)) fail('deployment_capture_invalid');
        const measured = { execution_package_root: request.execution_package_root,
          manifest_sha256: digest(manifestBytes), artifact_or_tree_sha256: captured.artifact_or_tree_sha256,
          artifact_or_tree_kind: captured.artifact_or_tree_kind, tree_sha256: captured.tree_sha256,
          tree_original: captured.tree_original, artifact_sha256: captured.artifact_sha256 };
        // These ports consume original trust/adoption records, never engines,
        // a desired package version or an arbitrary Git checkout as proof.
        const provenance = structuredClone(await ports.verifyProvenance(structuredClone(request.provenance), structuredClone(measured), context(request, lease)));
        await guard(lease, request, clock);
        if (!text(provenance?.deployment_revision) || !text(provenance?.evidence_ref) ||
            provenance?.artifact_or_tree_sha256 !== measured.artifact_or_tree_sha256 ||
            provenance.artifact_or_tree_kind !== measured.artifact_or_tree_kind || provenance.tree_sha256 !== measured.tree_sha256 ||
            canonicalDeployment(provenance.tree_original) !== canonicalDeployment(measured.tree_original) ||
            provenance.artifact_sha256 !== measured.artifact_sha256 ||
            !originalPacket(provenance.artifact_source_original) || !sha(provenance.artifact_source_sha256) ||
            digest(canonicalDeployment(provenance.artifact_source_original.payload)) !== provenance.artifact_source_sha256) fail('deployment_provenance_mismatch');
        const adoption = structuredClone(await ports.verifyAdoption(structuredClone(request.target_adoption), context(request, lease)));
        await guard(lease, request, clock);
        if (!text(adoption?.evidence_ref) || !Array.isArray(adoption?.targets) || !adoption.targets.length ||
            adoption.targets.some(row => !text(row?.adoption_ref) || !text(row?.target?.kind) || !text(row?.target?.series))) fail('deployment_adoption_invalid');
        const payload = { schema: 'factory.deployment-receipt.v1', identity: request.identity,
          execution_package_root: request.execution_package_root, mutation_resources: request.mutation_resources,
          deployment_generation: generation, manifest_sha256: measured.manifest_sha256,
          artifact_or_tree_sha256: measured.artifact_or_tree_sha256, deployment_revision: provenance.deployment_revision,
          provenance_evidence_ref: provenance.evidence_ref, adopted_targets_sha256: digest(canonicalDeployment(adoption)),
          issued_at: new Date(clock()).toISOString() };
        stage = 'receipt';
        const sourceEvidence = { schema: 'factory.deployment-sources.v1', factory_payload_sha256: digest(canonicalDeployment(payload)),
          capture: { ...measured, manifest_bytes_base64: Buffer.from(manifestBytes).toString('base64') },
          provenance: { input: structuredClone(request.provenance), subject: provenance },
          adoption: { input: structuredClone(request.target_adoption), subject: adoption } };
        const sourceCanonical = canonicalDeployment(sourceEvidence);
        const issued = structuredClone(await ports.issueReceipt(canonicalDeployment(payload), {
          ...context(request, lease), source_evidence: structuredClone(sourceEvidence),
        }));
        await guard(lease, request, clock);
        if (!text(issued?.issuer_id) || !text(issued?.evidence_ref) || issued?.proof == null ||
            issued.payload_canonical !== canonicalDeployment(payload)) fail('deployment_receipt_invalid');
        canonicalDeployment(issued.proof);
        const receipt = { payload, issuer_id: issued.issuer_id, evidence_ref: issued.evidence_ref, proof: issued.proof };
        stage = 'source_evidence';
        const retained = await ports.readSourceEvidence(issued.evidence_ref, context(request, lease));
        await guard(lease, request, clock);
        if (retained == null) fail('deployment_source_evidence_missing');
        if (canonicalDeployment(retained) !== sourceCanonical) fail('deployment_source_evidence_mismatch');
        stage = 'commit';
        await save({ ...base, phase: 'committed', receipt });
        await guard(lease, request, clock);
        result = { status: 'committed', generation, receipt, package_result: packageResult };
        return result;
      } catch (error) {
        let persistence = 'unknown';
        if (started) {
          try {
            // Must remain under the still-held writer lease, even on abort.
            await save({ ...base, phase: 'incomplete', receipt: null, failed_stage: stage });
            persistence = 'saved';
          } catch { /* No durability claim and no reader entry on store failure. */ }
        }
        result = { status: 'incomplete', generation, reason: publicReason(error), failed_stage: stage, persistence, package_result: packageResult };
        return result;
      }
    });
  } catch (error) {
    // Includes acquire/release failures. A committed callback is insufficient
    // for handoff if the adapter has not completed its exclusive release.
    return { ...result, status: 'blocked', reason: publicReason(error) };
  }
}

/** Reader/provider callback owns setup, same-run acceptance and optional send. */
export async function readDeployment(input, writer, ports, read) {
  const request = requestCopy(input), clock = ports.clock ?? Date.now;
  functions(ports, ['withReadLease', 'verifyCurrent']);
  functions(ports.store, ['load']);
  if (writer?.status !== 'committed' || !uuid(writer.generation) || !writer.receipt || typeof read !== 'function') fail('deployment_handoff_invalid');
  let normalResult;
  try {
    return await ports.withReadLease([...request.mutation_resources], writer.generation, request.deadline, async lease => {
      await guard(lease, request, clock, writer.generation);
      const state = await ports.store.load(structuredClone(request.identity));
      await guard(lease, request, clock, writer.generation);
      if (!state || !sameScope(state, request) || state.phase !== 'committed' || state.generation !== writer.generation ||
          canonicalDeployment(state.receipt) !== canonicalDeployment(writer.receipt)) fail('deployment_generation_changed');
      await ports.verifyCurrent(structuredClone(state.receipt), context(request, lease));
      await guard(lease, request, clock, writer.generation);
      normalResult = await read(lease, structuredClone(state.receipt));
      await guard(lease, request, clock, writer.generation);
      return { status: 'completed', generation: writer.generation, normal_result: normalResult };
    });
  } catch (error) {
    return { status: 'blocked', reason: publicReason(error), ...(normalResult === undefined ? {} : { normal_result: normalResult }) };
  }
}
