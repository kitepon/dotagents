import { createHash } from 'node:crypto';
import { run } from './command.mjs';
import { scanV6WithAcknowledgements, V6_PRODUCT_IDS } from './v6.mjs';

export const V7_PRODUCT_IDS = Object.freeze([...V6_PRODUCT_IDS, 'peertable']);

const PEERTABLE_CHECK_IDS = Object.freeze([
  'version_consistency', 'bin_integrity', 'node_runtime', 'skill_bundle', 'room_reachability',
]);

function empty() {
  return {
    presence_status: 'unverified',
    contract_version: '7.0',
    checks: [],
    runtime_errors: [],
    resolutions: [],
  };
}

function check(check_id, status, reason_code) {
  return { check_id, status, ...(reason_code ? { reason_code } : {}) };
}

function failure(checkId, reasonCode, now) {
  return {
    check_id: checkId,
    status: 'fail',
    severity: 'high',
    fingerprint: createHash('sha256').update(`peertable\0${checkId}\0${reasonCode}`).digest('hex'),
    message_template: `peertable ${checkId} failed`,
    occurrence_count: 1,
    first_seen: now,
    last_seen: now,
    reason_code: reasonCode,
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

// 決定45（peertable repo docs/plan.md）の契約: schema peertable.native_factory_diagnostics.v1、
// checks = version_consistency / bin_integrity / node_runtime / skill_bundle / room_reachability、
// 各checkはpass/fail/not_applicable/unverified、overallはready/not_ready/unverified。
function peertableDiagnostic(value) {
  if (!exact(value, ['schema', 'product', 'checks', 'overall'])
    || value.schema !== 'peertable.native_factory_diagnostics.v1'
    || !exact(value.product, ['name', 'version'])
    || value.product.name !== 'peertable'
    || !semver(value.product.version)
    || !exact(value.checks, PEERTABLE_CHECK_IDS)
    || !PEERTABLE_CHECK_IDS.every((id) => ['pass', 'fail', 'not_applicable', 'unverified'].includes(value.checks[id]))
    || !['ready', 'not_ready', 'unverified'].includes(value.overall)) {
    throw new Error('peertable_diagnostics_schema');
  }
  return value;
}

function peertableChecks(diagnostic, now) {
  return PEERTABLE_CHECK_IDS.map((id) => {
    const status = diagnostic.checks[id];
    if (status === 'pass') return check(id, 'pass');
    if (status === 'fail') return failure(id, `${id}_fail`, now);
    if (status === 'not_applicable') return check(id, 'skipped', `${id}_not_applicable`);
    return check(id, 'unverified', `${id}_unverified`);
  });
}

// 純粋関数として切り出し、CLIを起動せずfixtureで検証できるようにする
// （v5.mjs projectGptConnectorFactoryと同型）。
export function projectPeertableFactory(diagnostic, exitOk, now) {
  const value = peertableDiagnostic(diagnostic);
  if ((value.overall === 'ready') !== exitOk) throw new Error('peertable_exit_mismatch');
  return {
    installed_version: value.product.version,
    compatibility_status: value.overall === 'ready' ? 'compatible' : value.overall === 'not_ready' ? 'incompatible' : 'unverified',
    checks: peertableChecks(value, now),
  };
}

export async function peertableProduct({ cwd, now }) {
  // room_reachabilityはPEERTABLE_URL未設定時not_applicableになる（peertable決定45）。
  // 工場scanはLAN room到達性と製品健全性を結合させないため、常に空へ倒す
  // （不可侵原則: room server到達性はServerManagerのserver profileパターンを踏襲する）。
  const result = await run('peertable-client', ['diagnostics', '--json'], {
    cwd,
    env: { ...process.env, PEERTABLE_URL: '' },
  });
  try {
    const diagnostic = JSON.parse(result.stdout);
    const projected = projectPeertableFactory(diagnostic, result.ok, now);
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

export async function scanV7WithAcknowledgements(options) {
  const prior = await scanV6WithAcknowledgements(options);
  const products = Object.fromEntries(
    V6_PRODUCT_IDS.map((id) => [id, { ...prior.report.products[id], contract_version: '7.0' }]),
  );
  // reportの観測時刻より後のfailure timestampを作ると、正しい診断結果でも
  // wire contractが未来時刻として拒否する。追加製品もreport全体の観測時刻へ束縛する。
  products.peertable = await peertableProduct({ ...options, now: prior.report.observed_at });
  const report = {
    ...prior.report,
    schema_version: '7.0',
    reporter: { ...prior.report.reporter, version: '7.0.0' },
    products,
  };
  return {
    report,
    acknowledgements: {
      ...prior.acknowledgements,
      schema_version: '7.0',
    },
  };
}

export async function scanV7(options) {
  return (await scanV7WithAcknowledgements(options)).report;
}
