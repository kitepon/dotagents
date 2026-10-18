import { canonicalJson } from './report-binding.mjs';

export const LIMITS = Object.freeze({ days: 7, collections: 256, bytes: 32 * 1024 * 1024,
  runBytes: 256 * 1024, concurrent: 4, workerBytes: 1024 * 1024, staleHours: 24 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const identityKey = (value) => canonicalJson(value);
const validOwner = (value) => value && Number.isSafeInteger(value.pid) && value.pid > 0
  && ['bootId', 'creationId', 'nonce'].every((key) => typeof value[key] === 'string' && value[key].length > 0);

export function createRetentionState() { return { records: [], reservations: [], managedBytes: 0 }; }
function totalBytes(state) { return state.managedBytes + state.records.reduce((n, r) => n + r.bytes, 0) + state.reservations.reduce((n, r) => n + r.bytes, 0); }
function validState(state) {
  if (!state || !Array.isArray(state.records) || !Array.isArray(state.reservations)
    || state.records.length > LIMITS.collections || state.reservations.length > LIMITS.concurrent
    || !Number.isSafeInteger(state.managedBytes) || state.managedBytes < 0) return false;
  const all = [...state.records, ...state.reservations];
  return all.length <= LIMITS.collections && all.every((r) => r && UUID.test(r.id) && validOwner(r.owner) && Number.isSafeInteger(r.bytes)
    && r.bytes >= 0 && r.bytes <= LIMITS.runBytes && Number.isFinite(r.startedAt))
    && state.records.every((r) => ['complete', 'partial', 'tombstone'].includes(r.phase))
    && new Set(all.map((r) => r.id)).size === all.length;
}

export function reserveCapacity(state, { id, owner, bytes = LIMITS.runBytes, now, lockVerified, inventoryVerified }) {
  if (!validState(state) || lockVerified !== true || inventoryVerified !== true || !validOwner(owner)) return { state, status: 'storage_unavailable' };
  if (!UUID.test(id) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > LIMITS.runBytes
    || !Number.isFinite(now)) return { state, status: 'unverified' };
  if (state.records.some((r) => r.id === id) || state.reservations.some((r) => r.id === id)) return { state, status: 'binding_conflict' };
  if (state.records.length + state.reservations.length >= LIMITS.collections
    || state.reservations.length >= LIMITS.concurrent || totalBytes(state) + bytes > LIMITS.bytes
    || state.reservations.reduce((n, r) => n + r.bytes, 0) + bytes > LIMITS.workerBytes) return { state, status: 'capacity_exceeded' };
  const reservation = Object.freeze({ id, owner: { ...owner }, bytes, startedAt: now });
  return { state: { ...state, reservations: [...state.reservations, reservation] }, status: 'reserved' };
}

export function settleReservation(state, { id, owner, bytes, now, complete = false }) {
  if (!validState(state)) return { state, status: 'storage_unavailable' };
  const reserved = state.reservations.find((r) => r.id === id);
  if (!reserved || identityKey(reserved.owner) !== identityKey(owner)) return { state, status: 'unverified' };
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > reserved.bytes || !Number.isFinite(now)) return { state, status: 'capacity_exceeded' };
  const record = Object.freeze({ id, owner: { ...owner }, bytes, startedAt: reserved.startedAt,
    finishedAt: complete === true ? now : null, phase: complete === true ? 'complete' : 'partial' });
  return { state: { ...state, reservations: state.reservations.filter((r) => r.id !== id), records: [...state.records, record] }, status: complete === true ? 'complete' : 'partial' };
}

// Unknown liveness/owner means retain. The injected observations come from a fake OS adapter.
export function planRetention(state, { now, lockVerified, inventoryVerified, observations, requiredBytes = 0 }) {
  if (!validState(state) || lockVerified !== true || inventoryVerified !== true || !Number.isFinite(now)
    || !Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > LIMITS.runBytes) return { state, status: 'storage_unavailable', tombstones: [] };
  const inventory = [...state.records, ...state.reservations.map((r) => ({ ...r, phase: 'reserved' }))];
  const candidates = inventory.filter((r) => {
    const seen = observations?.[r.id];
    if (seen?.ownershipVerified !== true || seen.identityVerified !== true || !validOwner(r.owner)
      || identityKey(r.owner) !== identityKey(seen.owner) || seen.alive !== false) return false;
    return r.phase === 'complete' || r.phase === 'tombstone'
      || (['partial', 'reserved'].includes(r.phase) && now - r.startedAt >= LIMITS.staleHours * 3600000);
  }).sort((a, b) => {
    const expired = (r) => now - r.startedAt >= LIMITS.days * 86400000;
    return Number(expired(b)) - Number(expired(a)) || a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  });
  const selected = new Set();
  let potentialBytes = totalBytes(state);
  let potentialCount = state.records.length + state.reservations.length;
  for (const r of candidates) {
    const expired = now - r.startedAt >= LIMITS.days * 86400000;
    if (r.phase === 'tombstone' || r.phase === 'reserved' || expired || potentialBytes + requiredBytes > LIMITS.bytes
      || potentialCount + (requiredBytes > 0 ? 1 : 0) > LIMITS.collections) {
      selected.add(r.id); potentialBytes -= r.bytes; potentialCount -= 1;
    }
  }
  const records = state.records.map((r) => selected.has(r.id) ? { ...r, phase: 'tombstone' } : r);
  for (const r of state.reservations) if (selected.has(r.id)) records.push({ ...r, phase: 'tombstone', finishedAt: null });
  // Tombstones remain charged until a verified deletion acknowledgement arrives.
  return { state: { ...state, records, reservations: state.reservations.filter((r) => !selected.has(r.id)) }, status: selected.size ? 'cleanup_planned' : 'retained', tombstones: [...selected] };
}

export function acknowledgeDeletion(state, { id, owner, deletionVerified }) {
  if (!validState(state)) return { state, status: 'storage_unavailable' };
  const record = state.records.find((r) => r.id === id);
  if (!record || record.phase !== 'tombstone' || deletionVerified !== true
    || identityKey(record.owner) !== identityKey(owner)) return { state, status: 'unverified' };
  return { state: { ...state, records: state.records.filter((r) => r.id !== id) }, status: 'deleted' };
}
