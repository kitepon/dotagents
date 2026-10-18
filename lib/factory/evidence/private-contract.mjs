import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseStrictJson } from './strict-json.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bad = (reason, status = 'unverified') => ({ ok: false, status, reason });
const good = () => ({ ok: true, status: 'validated', reason: 'validated' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONCE = /^[0-9a-f]{64}$/u;

// Product-owned schemas are injected by the caller. There is no file or capability discovery.
export function createPrivateValidator(schemas) {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false });
  const capability = ajv.compile(schemas.capability);
  const frame = ajv.compile(schemas.frame);
  const descriptor = ajv.compile(schemas.windowsChannel);

  function validateRequest(env) {
    if (env.CAVEAT_FACTORY_PRIVATE_EVIDENCE !== 'v1') return { ok: false, status: 'off', reason: 'off' };
    const collectionId = env.CAVEAT_FACTORY_PRIVATE_COLLECTION_ID;
    const nonce = env.CAVEAT_FACTORY_PRIVATE_NONCE;
    const channel = env.CAVEAT_FACTORY_PRIVATE_CHANNEL;
    if (typeof collectionId !== 'string' || !UUID.test(collectionId) || typeof nonce !== 'string'
      || !NONCE.test(nonce) || typeof channel !== 'string' || Buffer.byteLength(channel) > 16 * 1024) return bad('request_invalid');
    if (channel === 'fd:3') return { ...good(), collectionId, nonce, transport: 'posix-fd-v1' };
    try {
      if (descriptor(parseStrictJson(Buffer.from(channel)))) return { ...good(), collectionId, nonce, transport: 'windows-named-pipe-v1' };
    } catch { /* Fixed diagnostics only. */ }
    return bad('request_invalid');
  }

  function selectCapability(bytes, { platform, launchPath, packageVersion, adapterSupported }) {
    if (bytes == null) return bad('capability_absent', 'not_supported');
    let value;
    try { value = parseStrictJson(bytes); } catch { return bad('capability_invalid'); }
    if (!capability(value) || value.package_version !== packageVersion) return bad('capability_invalid');
    const match = value.transports.find((item) => item.platforms.includes(platform) && item.launch_paths.includes(launchPath));
    if (!match || adapterSupported !== true) return bad('transport_unavailable', 'not_supported');
    return { ...good(), transport: match.id, platform, packageVersion: value.package_version };
  }

  function checkWindowsDescriptor(bytes, observedServer) {
    try {
      const value = parseStrictJson(bytes);
      if (!descriptor(value)) return bad('descriptor_invalid');
      if (!observedServer || value.server_pid !== observedServer.pid
        || value.server_start_identity !== observedServer.startIdentity || value.owner_sid !== observedServer.sid) return bad('server_identity_mismatch');
      return good();
    } catch { return bad('descriptor_invalid'); }
  }

  function validateTranscript({ chunks, eof, request, selected, peer, publicBytes, publicComplete }) {
    if (selected?.ok !== true) return bad('capability_unverified', selected?.status === 'not_supported' ? 'not_supported' : 'unverified');
    if (!UUID.test(request?.collectionId ?? '') || !NONCE.test(request?.nonce ?? '')
      || request.transport !== selected.transport) return bad('request_invalid');
    if (!Array.isArray(chunks)) return bad('frame_invalid');
    let length = 0;
    for (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) return bad('frame_invalid');
      length += chunk.byteLength;
      if (length > 16 * 1024) return bad('channel_limit', 'partial');
    }
    if (eof !== true) return bad('eof_missing', 'partial');
    let frames;
    try {
      const bytes = Buffer.concat(chunks, length);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!text.endsWith('\n')) return bad('frame_termination', 'partial');
      const rows = text.slice(0, -1).split('\n');
      if (rows.length !== 2 || rows.some((line) => !line)) return bad('frame_order');
      frames = rows.map((line) => parseStrictJson(Buffer.from(line)));
    } catch { return bad('frame_invalid'); }
    const [hello, result] = frames;
    if (!frames.every((value) => frame(value)) || hello.type !== 'hello' || result.type !== 'diagnostic_result') return bad('frame_schema_invalid');
    for (const key of ['schema', 'collection_id', 'nonce', 'execution_id']) {
      if (hello[key] !== result[key]) return bad('execution_mismatch');
    }
    if (hello.collection_id !== request.collectionId || hello.nonce !== request.nonce) return bad('request_mismatch');
    if (hello.product_version !== selected.packageVersion || hello.process.package_version !== selected.packageVersion
      || hello.transport !== selected.transport || hello.public_diagnostic_schema !== 'caveat.native_factory_diagnostics.v1') return bad('capability_mismatch');
    const process = hello.process;
    const missing = [
      [process.parent_pid === null, 'parent_identity_unavailable'],
      [process.start_identity.value === null, 'start_identity_unavailable'],
      [process.identity.kind === 'unknown', 'actor_identity_unavailable'],
      [process.exec_path === null, 'exec_path_unavailable'],
      [process.entry_realpath === null, 'entry_path_unavailable'],
      [process.build_id === null, 'build_id_unavailable'],
    ];
    if (missing.some(([absent, reason]) => absent !== process.missing_reasons.includes(reason))) return bad('missing_reason_mismatch');
    // OS values must be supplied as independently observed identity, never from the frame.
    if (peer?.verified !== true || process.pid !== peer.pid || process.parent_pid !== peer.parentPid
      || process.start_identity.source !== peer.startIdentity?.source || process.start_identity.value !== peer.startIdentity?.value
      || ['kind', 'uid', 'gid', 'sid'].some((key) => process.identity[key] !== peer.identity?.[key])
      || process.exec_path !== peer.execPath || process.entry_realpath !== peer.entryRealpath
      || !process.start_identity.value || process.identity.kind === 'unknown') return bad('peer_identity_mismatch');
    if ((selected.transport === 'posix-fd-v1' && process.identity.kind !== 'uid_gid')
      || (selected.transport === 'windows-named-pipe-v1' && (process.identity.kind !== 'windows_sid'
        || process.start_identity.source !== 'windows_process_creation'))) return bad('peer_identity_mismatch');
    if (publicComplete !== true || !(publicBytes instanceof Uint8Array)) return bad('public_output_partial', 'partial');
    if (publicBytes.at(-1) !== 10 || publicBytes.subarray(0, -1).includes(10)) return bad('public_framing');
    if (result.public_output.bytes !== publicBytes.byteLength || result.public_output.sha256 !== hash(publicBytes)) return bad('public_output_mismatch');
    let diagnostic;
    try { diagnostic = parseStrictJson(publicBytes, 64 * 1024); } catch { return bad('public_output_invalid'); }
    if (diagnostic.schema !== result.public_result.schema || diagnostic.product !== 'caveat' || diagnostic.version !== hello.product_version
      || diagnostic.overall?.status !== result.public_result.overall_status
      || result.public_result.planned_exit_code !== (diagnostic.overall?.status === 'ready' ? 0 : 1)
      || diagnostic.sync?.status !== result.sync_observation.status
      || diagnostic.sync?.reason_code !== result.sync_observation.reason_code) return bad('public_result_mismatch');
    const observation = result.sync_observation;
    const both = observation.local_head.status === 'observed' && observation.remote_head.status === 'observed';
    const comparison = both ? observation.local_head.value === observation.remote_head.value ? 'equal' : 'different' : 'not_evaluated';
    if (observation.comparison !== comparison) return bad('head_comparison_mismatch');
    if (observation.repo_identity.status === 'available' && observation.repo_identity.reason !== 'origin_descriptor_observed') return bad('repo_reason_mismatch');
    if (observation.repo_identity.status === 'not_observed' && observation.repo_identity.reason !== 'origin_not_reached') return bad('repo_reason_mismatch');
    if (observation.repo_identity.status === 'unverified' && !['origin_capture_unverified', 'origin_syntax_unsupported', 'origin_semantics_ambiguous'].includes(observation.repo_identity.reason)) return bad('repo_reason_mismatch');
    return good();
  }
  return Object.freeze({ validateRequest, selectCapability, checkWindowsDescriptor, validateTranscript });
}

export const LOCAL_STATUSES = Object.freeze([
  'disabled_config', 'config_missing', 'config_invalid', 'config_unreadable', 'not_supported',
  'unverified', 'storage_denied', 'storage_unavailable', 'capacity_exceeded', 'pending', 'partial', 'complete', 'binding_conflict',
]);

export function localStatus(status) {
  return { evidence_save_status: LOCAL_STATUSES.includes(status) ? status : 'unverified' };
}

// An isolated orchestration seam, intentionally not imported by scan/scheduler/command.
// It never calls any storage/channel API. The callback is the existing public operation.
export async function simulateEvidenceCollection(options) {
  if (options.enabled !== true) return options.runNormal();
  const publicResult = await options.runNormal();
  let status = 'pending';
  try {
    if (options.osSnapshot?.safe !== true) status = 'storage_denied';
    else if (options.workerSnapshot?.ready !== true) status = 'storage_unavailable';
    else if (options.workerSnapshot.capacityAvailable !== true) status = 'capacity_exceeded';
    else {
      const checked = options.evaluate(publicResult);
      status = checked.ok === true ? 'pending' : checked.status;
    }
  } catch { status = 'unverified'; }
  return { publicResult, local: localStatus(status) };
}
