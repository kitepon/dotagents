import { createHash } from 'node:crypto';
import { validateReportV9 } from '../contract.mjs';
import { parseStrictJson } from './strict-json.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TOOLCHAINS = ['claude-code', 'codex-cli', 'grok-build'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function canonicalJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

function inspect(bytes) {
  const report = parseStrictJson(bytes, 1024 * 1024);
  validateReportV9(report);
  const normalized = structuredClone(report);
  for (const id of TOOLCHAINS) normalized.products[id].checks = normalized.products[id].checks.filter((item) => item.check_id !== 'last_update');
  return { report, body_bytes: bytes.byteLength, body_sha256: sha256(bytes),
    normalized_report_sha256: sha256(canonicalJson(normalized)),
    public_caveat_observation_sha256: sha256(canonicalJson(report.products.caveat)) };
}

function record(phase, collectionId, inspected, parent, now, status = 'bound') {
  return Object.freeze({ schema: 'dotagents.caveat_report_binding.v1', phase,
    collection_id: collectionId, host_id: inspected.report.host_id, report_id: inspected.report.report_id,
    wire_schema: '9.0', body_bytes: inspected.body_bytes, body_sha256: inspected.body_sha256,
    parent_prepared_sha256: parent?.body_sha256 ?? null,
    normalized_report_sha256: inspected.normalized_report_sha256,
    normalization: 'without-toolchain-last-update-sorted-keys-v1',
    public_caveat_observation_sha256: inspected.public_caveat_observation_sha256,
    binding_status: status, created_at: new Date(now).toISOString() });
}

export function prepareBinding(bytes, collectionId, now) {
  if (!UUID.test(collectionId)) throw new Error('collection_invalid');
  return record('prepared', collectionId, inspect(bytes), null, now);
}

// State is caller-owned, JSON-serializable metadata; no filesystem/index/outbox is opened.
export function createBindingState() { return { prepared: [], finalized: [], deliveries: [] }; }

export function addPrepared(state, binding) {
  if (binding.phase !== 'prepared' || binding.binding_status !== 'bound') return { state, status: 'binding_conflict' };
  const existing = state.prepared.find((item) => item.collection_id === binding.collection_id);
  if (existing) return { state, status: canonicalJson(existing) === canonicalJson(binding) ? 'reused' : 'binding_conflict' };
  return { state: { ...state, prepared: [...state.prepared, binding] }, status: 'prepared' };
}

export function finalizeBinding(state, bytes, now) {
  let inspected;
  try { inspected = inspect(bytes); } catch { return { state, status: 'unverified' }; }
  const parents = state.prepared.filter((item) => item.report_id === inspected.report.report_id && item.host_id === inspected.report.host_id);
  if (parents.length !== 1) return { state, status: parents.length ? 'binding_conflict' : 'finalized_unbound' };
  const parent = parents[0];
  if (parent.wire_schema !== '9.0' || parent.normalization !== 'without-toolchain-last-update-sorted-keys-v1'
    || parent.normalized_report_sha256 !== inspected.normalized_report_sha256
    || parent.public_caveat_observation_sha256 !== inspected.public_caveat_observation_sha256) return { state, status: 'binding_conflict' };
  const previous = state.finalized.find((item) => item.parent_prepared_sha256 === parent.body_sha256 && item.collection_id === parent.collection_id);
  if (previous) return { state, status: previous.body_sha256 === inspected.body_sha256 ? 'reused' : 'binding_conflict', binding: previous };
  const binding = record('finalized', parent.collection_id, inspected, parent, now);
  return { state: { ...state, finalized: [...state.finalized, binding] }, status: 'finalized', binding };
}

const DELIVERY_OUTCOMES = ['accepted', 'deferred', 'rejected', 'unreachable'];
export function recordDelivery(state, { eventId, reportId, bodySha256, outcome, now }) {
  if (!UUID.test(eventId) || !DELIVERY_OUTCOMES.includes(outcome)) return { state, status: 'unverified' };
  const parent = state.finalized.find((item) => item.report_id === reportId && item.body_sha256 === bodySha256);
  if (!parent) return { state, status: 'delivery_unbound' };
  const value = Object.freeze({ event_id: eventId, report_id: reportId, body_sha256: bodySha256,
    collection_id: parent.collection_id, outcome, created_at: new Date(now).toISOString() });
  const previous = state.deliveries.find((item) => item.event_id === eventId);
  if (previous) return { state, status: canonicalJson(previous) === canonicalJson(value) ? 'reused' : 'binding_conflict' };
  return { state: { ...state, deliveries: [...state.deliveries, value] }, status: 'delivery_recorded' };
}
