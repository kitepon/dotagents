// Factory-owned bounded DTO, not a trust/installed receipt or serialized token.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const PRELOAD = fileURLToPath(new URL('./update-context-product-preload.mjs', import.meta.url));
const fail = () => { throw new Error('core_preload_unconfirmed'); };
const digest = raw => createHash('sha256').update(raw).digest('hex');
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(); }
function absolute(path) { try { return typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && normalize(path) === path && realpathSync(path) === path; } catch { return false; } }
function file(value) {
  exact(value, ['path', 'sha256', 'bytes']);
  if (!absolute(value.path) || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes)
      || value.bytes < 1 || value.bytes > 1048576) fail();
  const info = lstatSync(value.path); if (!info.isFile() || info.isSymbolicLink() || info.size !== value.bytes) fail();
  const raw = readFileSync(value.path); if (raw.length !== value.bytes || digest(raw) !== value.sha256) fail();
}
export function validateCorePreloadRecord(supplied, { entry = process.argv[1], now = Date.now() } = {}) {
  const value = structuredClone(supplied);
  exact(value, ['schema', 'activation', 'expires_at', 'before_original', 'product_entry', 'registration', 'factory_preload']);
  if (value.schema !== 'dotagents.core-preload.v1' || !absolute(value.activation)
      || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 48 * 3600000) fail();
  const root = lstatSync(value.activation);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700) fail();
  exact(value.before_original, ['ref', 'sha256', 'bytes']);
  if (value.before_original.ref !== 'public_setup_before.json' || !/^[a-f0-9]{64}$/u.test(value.before_original.sha256)
      || !Number.isSafeInteger(value.before_original.bytes) || value.before_original.bytes < 1 || value.before_original.bytes > 131072) fail();
  for (const name of ['product_entry', 'registration', 'factory_preload']) file(value[name]);
  if (value.product_entry.path !== realpathSync(entry) || value.factory_preload.path !== PRELOAD
      || value.registration.path !== join(dirname(value.product_entry.path), 'update-ledger-core-registration.js')) fail();
  return Object.freeze(value);
}
/** The caller must obtain file subjects from adopted two-SH source verification.
 * This encoder measures/binds bytes only; it never verifies an issuer or receipt.
 */
export function encodeCorePreloadRecord(supplied) {
  const value = validateCorePreloadRecord(supplied, { entry: supplied.product_entry.path });
  const raw = Buffer.from(`${JSON.stringify(value)}\n`);
  if (raw.length > 16384) fail(); return raw;
}
export function decodeCorePreloadRecord(raw, options) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 16384) fail();
  try { return validateCorePreloadRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), options); }
  catch { fail(); }
}
