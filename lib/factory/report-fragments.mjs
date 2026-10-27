import { createHash, randomUUID } from 'node:crypto';

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_FRAGMENTS = 128;
const MAX_REPORT_BYTES = MAX_CHUNK_BYTES * MAX_FRAGMENTS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function fragmentEnvelope(report, bytes, manifest, index) {
  const chunk = bytes.subarray(index * manifest.chunk_bytes, (index + 1) * manifest.chunk_bytes);
  return {
    schema: 'bughub.factory-fragment.v1', host_id: report.host_id, report_id: report.report_id,
    fragment_id: manifest.fragment_ids[index], fragment_index: index, fragment_count: manifest.fragment_ids.length,
    report_sha256: manifest.report_sha256, report_bytes: bytes.length,
    observed_at: report.observed_at, created_at: report.created_at,
    fragment_sha256: digest(chunk), data_base64: chunk.toString('base64'),
  };
}

export function createFragmentManifest(report, bytes, limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || bytes.length < 1 || bytes.length > MAX_REPORT_BYTES) throw new Error('fragment_limits_invalid');
  const manifest = { schema: 'dotagents.factory-fragments.v1', report_sha256: digest(bytes), report_bytes: bytes.length,
    limit_bytes: limitBytes, chunk_bytes: 1, fragment_ids: [randomUUID()] };
  const sample = { ...fragmentEnvelope(report, Buffer.alloc(0), manifest, 0), report_bytes: bytes.length,
    fragment_index: 127, fragment_count: 128 };
  const overhead = Buffer.byteLength(JSON.stringify(sample));
  manifest.chunk_bytes = Math.min(MAX_CHUNK_BYTES, Math.floor((limitBytes - overhead) / 4) * 3);
  if (manifest.chunk_bytes < 1) throw new Error('fragment_envelope_exceeds_limit');
  const count = Math.ceil(bytes.length / manifest.chunk_bytes);
  if (count > MAX_FRAGMENTS) throw new Error('fragment_count_exceeds_limit');
  manifest.fragment_ids = Array.from({ length: count }, () => randomUUID());
  return manifest;
}

export function validateFragmentManifest(report, bytes, manifest) {
  const keys = ['schema', 'report_sha256', 'report_bytes', 'limit_bytes', 'chunk_bytes', 'fragment_ids'];
  if (!manifest || Object.keys(manifest).length !== keys.length || Object.keys(manifest).some(key => !keys.includes(key))
    || manifest.schema !== 'dotagents.factory-fragments.v1' || manifest.report_sha256 !== digest(bytes)
    || manifest.report_bytes !== bytes.length || bytes.length < 1 || bytes.length > MAX_REPORT_BYTES
    || !Number.isSafeInteger(manifest.limit_bytes) || manifest.limit_bytes < 1
    || !Number.isSafeInteger(manifest.chunk_bytes) || manifest.chunk_bytes < 1 || manifest.chunk_bytes > MAX_CHUNK_BYTES
    || !Array.isArray(manifest.fragment_ids) || manifest.fragment_ids.length < 1 || manifest.fragment_ids.length > MAX_FRAGMENTS
    || manifest.fragment_ids.length !== Math.ceil(bytes.length / manifest.chunk_bytes)
    || manifest.fragment_ids.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(manifest.fragment_ids).size !== manifest.fragment_ids.length) throw new Error('fragment_manifest_invalid');
  for (let index = 0; index < manifest.fragment_ids.length; index++) {
    if (Buffer.byteLength(JSON.stringify(fragmentEnvelope(report, bytes, manifest, index))) > manifest.limit_bytes) throw new Error('fragment_envelope_exceeds_limit');
  }
  return manifest;
}

export async function sendReportFragments(config, token, report, bytes, manifest) {
  const endpoint = new URL('/api/factory/v9/report-fragments', config.reporting.endpoint);
  for (let index = 0; index < manifest.fragment_ids.length; index++) {
    const envelope = fragmentEnvelope(report, bytes, manifest, index);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-factory-sent-at': new Date().toISOString() },
        body: JSON.stringify(envelope) });
      let body = null; try { body = await response.json(); } catch {}
      if (response.status === 200 && body?.accepted === true && body.complete === true
        && body.report_id === report.report_id && body.report_sha256 === manifest.report_sha256) return { accepted: true };
      if (response.status === 202 && body?.accepted === false && body.complete === false && body.fragment_accepted === true
        && body.report_id === report.report_id && body.fragment_id === envelope.fragment_id
        && body.fragment_count === manifest.fragment_ids.length && Number.isInteger(body.received_fragments)
        && body.received_fragments > 0 && body.received_fragments <= manifest.fragment_ids.length) continue;
      return { accepted: false, reason: `fragment-http-${response.status}` };
    } catch (error) {
      return { accepted: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally { clearTimeout(timeout); }
  }
  return { accepted: false, reason: 'fragment-completion-unconfirmed' };
}
