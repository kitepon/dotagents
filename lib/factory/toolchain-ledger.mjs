import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultToolchainLedgerPath(targetPlatform) {
  return targetPlatform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Local'), 'dotagents', 'agents-update', 'toolchain-ledger.json')
    : join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), '.local', 'state'), 'agents-update', 'toolchain-ledger.json');
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('toolchain_ledger_schema');
  }
}

function semver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function utc(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function validateLedger(value) {
  exact(value, ['schema_version', 'products']);
  if (value.schema_version !== 'dotagents.toolchain-update.v1' || !value.products
    || typeof value.products !== 'object' || Array.isArray(value.products)) throw new Error('toolchain_ledger_schema');
  const allowed = ['claude-code', 'codex-cli', 'grok-build'];
  const reasons = ['npm_unavailable', 'install_failed', 'registry_unavailable', 'downgrade_refused', 'post_version_unavailable', 'version_mismatch', 'updated', 'already_current', 'optional_missing', 'check_failed', 'check_schema_invalid', 'update_failed', 'post_contract_failed', 'not_observed'];
  for (const [id, record] of Object.entries(value.products)) {
    if (!allowed.includes(id)) throw new Error('toolchain_ledger_schema');
    exact(record, ['before_version', 'latest_version', 'operation_status', 'after_version', 'post_gate_status', 'reason_code', 'observed_at']);
    if (![record.before_version, record.latest_version, record.after_version].every((item) => item === null || semver(item))
      || !['success', 'failed', 'skipped', 'pending'].includes(record.operation_status)
      || !['success', 'failed', 'skipped', 'pending'].includes(record.post_gate_status)
      || !reasons.includes(record.reason_code) || !utc(record.observed_at)) throw new Error('toolchain_ledger_schema');
  }
}

export async function readToolchainLedger(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('toolchain_ledger_permissions');
    const value = JSON.parse(await readFile(path, 'utf8'));
    validateLedger(value);
    return { value, error: null };
  } catch {
    return { value: null, error: 'toolchain_ledger_unavailable' };
  }
}
