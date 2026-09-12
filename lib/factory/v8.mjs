import { createHash } from 'node:crypto';
import { run } from './command.mjs';
import { scanV7WithAcknowledgements, V7_PRODUCT_IDS } from './v7.mjs';

export const V8_PRODUCT_IDS = Object.freeze([...V7_PRODUCT_IDS, 'unai']);

function empty() {
  return {
    presence_status: 'unverified',
    contract_version: '8.0',
    checks: [],
    runtime_errors: [],
    resolutions: [],
  };
}

function check(check_id, status, reason_code) {
  return { check_id, status, ...(reason_code ? { reason_code } : {}) };
}

function failure(checkId, now) {
  return {
    check_id: checkId,
    status: 'fail',
    severity: 'high',
    fingerprint: createHash('sha256').update(`unai\0${checkId}\0${checkId}_fail`).digest('hex'),
    message_template: `unai ${checkId} failed`,
    occurrence_count: 1,
    first_seen: now,
    last_seen: now,
    reason_code: `${checkId}_fail`,
  };
}

function semver(value) {
  return typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

export function projectUnaiFactory(diagnostic, exitOk, now) {
  if (!semver(diagnostic?.product?.version) || !['ready', 'not_ready'].includes(diagnostic.overall)
    || !diagnostic.checks || typeof diagnostic.checks !== 'object' || Array.isArray(diagnostic.checks)) {
    throw new Error('unai_diagnostics_schema');
  }
  if ((diagnostic.overall === 'ready') !== exitOk) throw new Error('unai_exit_mismatch');
  const checks = [];
  for (const [id, value] of Object.entries(diagnostic.checks)) {
    if (id === 'skill_projections') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unai_diagnostics_schema');
      for (const [host, status] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(host) || !['ready', 'missing', 'stale', 'conflict'].includes(status)) throw new Error('unai_diagnostics_schema');
        const checkId = `skill_projection_${host}`;
        checks.push(status === 'ready' ? check(checkId, 'pass') : failure(checkId, now));
      }
    } else {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(id) || !['pass', 'fail'].includes(value)) throw new Error('unai_diagnostics_schema');
      checks.push(value === 'pass' ? check(id, 'pass') : failure(id, now));
    }
  }
  return {
    installed_version: diagnostic.product.version,
    compatibility_status: diagnostic.overall === 'ready' ? 'compatible' : 'incompatible',
    checks,
  };
}

export async function unaiProduct({
  cwd,
  now,
  runCommand = run,
}) {
  const result = await runCommand('unai', ['factory-diagnostics', '--json'], { cwd });
  try {
    const diagnostic = JSON.parse(result.stdout);
    const projected = projectUnaiFactory(diagnostic, result.ok, now);
    return { ...empty(), presence_status: 'installed', ...projected };
  } catch {
    return {
      ...empty(),
      presence_status: result.reason === 'spawn' && result.error?.code === 'ENOENT' ? 'missing' : 'unverified',
      compatibility_status: 'unverified',
      checks: [check('native_diagnostics', 'unverified', 'native_schema_invalid')],
    };
  }
}

export async function scanV8WithAcknowledgements(options) {
  const prior = await scanV7WithAcknowledgements(options);
  const products = Object.fromEntries(
    V7_PRODUCT_IDS.map((id) => [id, { ...prior.report.products[id], contract_version: '8.0' }]),
  );
  products.unai = await unaiProduct({ ...options, now: prior.report.observed_at });
  const report = {
    ...prior.report,
    schema_version: '8.0',
    reporter: { ...prior.report.reporter, version: '8.0.0' },
    products,
  };
  return {
    report,
    acknowledgements: { ...prior.acknowledgements, schema_version: '8.0' },
  };
}

export async function scanV8(options) {
  return (await scanV8WithAcknowledgements(options)).report;
}
