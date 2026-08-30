import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { run } from './command.mjs';
import { scanV7WithAcknowledgements, V7_PRODUCT_IDS } from './v7.mjs';
import { runWindowsPowerShellScript } from './windows-powershell.mjs';

export const V8_PRODUCT_IDS = Object.freeze([...V7_PRODUCT_IDS, 'unai']);

const UNAI_CHECK_IDS = Object.freeze([
  'manifest_consistency', 'node_runtime', 'skill_bundle',
]);
const UNAI_PROJECTION_IDS = Object.freeze(['claude', 'codex', 'grok', 'cursor']);

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

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function semver(value) {
  return typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function unaiDiagnostic(value) {
  if (!exact(value, ['schema', 'product', 'checks', 'overall'])
    || value.schema !== 'unai.native_factory_diagnostics.v2'
    || !exact(value.product, ['name', 'version'])
    || value.product.name !== 'unai'
    || !semver(value.product.version)
    || !exact(value.checks, [...UNAI_CHECK_IDS, 'skill_projections'])
    || !UNAI_CHECK_IDS.every((id) => ['pass', 'fail'].includes(value.checks[id]))
    || !exact(value.checks.skill_projections, UNAI_PROJECTION_IDS)
    || !UNAI_PROJECTION_IDS.every((id) => ['ready', 'missing', 'stale', 'conflict']
      .includes(value.checks.skill_projections[id]))
    || !['ready', 'not_ready'].includes(value.overall)) {
    throw new Error('unai_diagnostics_schema');
  }
  const diagnosticsReady = UNAI_CHECK_IDS.every((id) => value.checks[id] === 'pass')
    && UNAI_PROJECTION_IDS.every((id) => value.checks.skill_projections[id] === 'ready');
  if ((value.overall === 'ready') !== diagnosticsReady) {
    throw new Error('unai_diagnostics_overall_mismatch');
  }
  return value;
}

export function projectUnaiFactory(diagnostic, exitOk, now) {
  const value = unaiDiagnostic(diagnostic);
  if ((value.overall === 'ready') !== exitOk) throw new Error('unai_exit_mismatch');
  return {
    installed_version: value.product.version,
    compatibility_status: value.overall === 'ready' ? 'compatible' : 'incompatible',
    checks: [
      ...UNAI_CHECK_IDS.map((id) => value.checks[id] === 'pass' ? check(id, 'pass') : failure(id, now)),
      ...UNAI_PROJECTION_IDS.map((id) => {
        const checkId = `skill_projection_${id}`;
        return value.checks.skill_projections[id] === 'ready'
          ? check(checkId, 'pass')
          : failure(checkId, now);
      }),
    ],
  };
}

export async function unaiProduct({
  cwd,
  now,
  platform = process.platform,
  home = homedir(),
  runCommand = run,
  runPowerShellScript = runWindowsPowerShellScript,
}) {
  const result = platform === 'win32'
    ? await runPowerShellScript(win32.join(home, '.local', 'bin', 'unai.ps1'), ['factory-diagnostics', '--json'], { cwd })
    : await runCommand('unai', ['factory-diagnostics', '--json'], { cwd });
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
