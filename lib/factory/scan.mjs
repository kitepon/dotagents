import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';
import { parseCaveatDiagnostic } from './caveat-diagnostics.mjs';
import {
  acknowledgementBundle,
  collectRuntimeErrors,
  RUNTIME_ERROR_PRODUCTS,
} from './runtime-errors.mjs';

export const PRODUCTS = [
  'caveat', 'throughline', 'spotter', 'codegraph', 'markitdown',
  'oracle', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
];

const CLI = {
  caveat: 'caveat',
  throughline: 'throughline',
  spotter: 'spotter',
  markitdown: 'markitdown',
  oracle: 'oracle',
  'aiterm-mcp': 'aiterm-mcp',
  'codex-sidecar': 'codex-sidecar',
};
const OS_FOR_PROFILE = {
  mac: 'darwin',
  server: 'linux',
  linux: 'linux',
  wsl: 'linux',
  'windows-native': 'windows',
};
const THIRD_PARTY_VERSION_RANGES = {
  markitdown: { major: 0, minor: 1 },
  oracle: { major: 0, minor: 16 },
};
const THIRD_PARTY_CHECK_IDS = {
  markitdown: 'local_fixture',
  oracle: 'doctor',
};
const SERVERMANAGER_CHECK_IDS = ['database', 'schema', 'pull_poll', 'factory_ingest', 'factory_delivery', 'source_revision'];
const SERVERMANAGER_REASON_CODES = [
  'ready', 'database_unavailable', 'query_failed', 'version_mismatch', 'not_observed',
  'timestamp_invalid', 'source_status_invalid', 'source_failed', 'delivery_failed',
  'poll_failed', 'stale', 'disabled', 'not_configured', 'factory_state_unavailable',
  'state_invalid', 'delivered', 'not_needed',
  'revision_match', 'revision_missing', 'revision_invalid', 'revision_mismatch',
];
const SEMVER = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function emptyProduct() {
  return {
    presence_status: 'unverified',
    contract_version: '1.0',
    checks: [],
    runtime_errors: [],
    resolutions: [],
  };
}

function fixedFailureCheck(productId, reasonCode, observedAt) {
  const messageTemplate = `${productId} native diagnostics reported not ready`;
  return {
    check_id: 'native_diagnostics',
    status: 'fail',
    severity: 'high',
    fingerprint: createHash('sha256').update(`${productId}:${reasonCode}`).digest('hex'),
    message_template: messageTemplate,
    occurrence_count: 1,
    first_seen: observedAt,
    last_seen: observedAt,
    reason_code: reasonCode,
  };
}

function projectNativeStatus(product, productId, status, observedAt) {
  if (status === 'ready' || status === 'pass') {
    product.compatibility_status = 'compatible';
    product.checks.push({ check_id: 'native_diagnostics', status: 'pass' });
  } else if (status === 'not_ready' || status === 'fail') {
    product.compatibility_status = 'incompatible';
    product.checks.push(fixedFailureCheck(productId, 'native_not_ready', observedAt));
  } else if (status === 'not_applicable') {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'skipped', reason_code: 'not_applicable',
    });
  } else {
    product.compatibility_status = 'unverified';
    product.checks.push({ check_id: 'native_diagnostics', status: 'unverified' });
  }
}

async function nativeCli(productId, command, args, options, observedAt) {
  const result = await run(command, args, options);
  let diagnostic;
  try { diagnostic = JSON.parse(result.stdout); } catch { diagnostic = null; }
  if (productId === 'caveat') {
    return caveatNative(result, diagnostic, observedAt);
  }
  if (productId === 'codex-sidecar') {
    return codexSidecarNative(result, diagnostic, observedAt);
  }
  const product = emptyProduct();
  const valid = result.ok && diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic);
  if (!valid) {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  }
  if (productId === 'throughline' &&
    diagnostic.schema === 'throughline.native_factory_diagnostics.v1' &&
    typeof diagnostic.version === 'string' && typeof diagnostic.overall?.status === 'string') {
    product.presence_status = 'installed';
    product.installed_version = diagnostic.version;
    if (typeof diagnostic.databaseSchema?.schema === 'string') {
      product.state_schema_version = diagnostic.databaseSchema.schema;
      product.migration_status = diagnostic.databaseSchema.status === 'ready'
        ? 'current'
        : diagnostic.databaseSchema.status === 'not_ready' ? 'failed' : 'unverified';
    }
    projectNativeStatus(product, productId, diagnostic.overall.status, observedAt);
    return product;
  }
  if (productId === 'spotter' && diagnostic.schema_version === '1.0' &&
    diagnostic.product === 'spotter' && typeof diagnostic.version === 'string' &&
    typeof diagnostic.overall_status === 'string') {
    product.presence_status = 'installed';
    product.installed_version = diagnostic.version;
    if (typeof diagnostic.marker_schema_version === 'string') {
      product.state_schema_version = diagnostic.marker_schema_version;
    }
    projectNativeStatus(product, productId, diagnostic.overall_status, observedAt);
    return product;
  }
  product.checks.push({
    check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
  });
  return product;
}

function caveatNative(result, diagnostic, observedAt) {
  const product = emptyProduct();
  if (result?.reason === 'spawn' && result?.error?.code === 'ENOENT') {
    product.presence_status = 'missing';
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_unavailable',
    });
    return product;
  }
  let parsed;
  try {
    parsed = parseCaveatDiagnostic(diagnostic);
    if ((parsed.overall === 'ready') !== result.ok) throw new Error('native_exit_mismatch');
  } catch {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  }
  product.presence_status = 'installed';
  product.installed_version = parsed.version;
  if (parsed.state !== null) product.state_schema_version = parsed.state;
  product.migration_status = parsed.migration;
  projectNativeStatus(product, 'caveat', parsed.overall, observedAt);
  return product;
}

const LATTICE_CHECK_IDS = ['package_version', 'node_runtime', 'cli_surface', 'mcp_entry', 'sensor_attribution'];
// runtime-errors.mjsのFORBIDDEN_TEXTと同基準（module非公開のため複製）。detailへの秘密・絶対path混入を拒否する。
const LATTICE_FORBIDDEN_DETAIL = /(?:[\r\n\0]|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+|-----BEGIN [A-Z ]+-----|(?:^|[\s"'])\/[A-Za-z0-9._-]+\/|(?:^|[\s"'])[A-Za-z]:\\)/;

function latticeNative(result, diagnostic, observedAt) {
  const product = emptyProduct();
  if (result?.reason === 'spawn' && result?.error?.code === 'ENOENT') {
    product.presence_status = 'missing';
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_unavailable',
    });
    return product;
  }
  const invalid = () => {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
  const semver = (value) => typeof value === 'string' && new RegExp(`^${SEMVER}$`).test(value);
  const detail = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 256
    && !LATTICE_FORBIDDEN_DETAIL.test(value);
  if (!exact(diagnostic, ['schema', 'product', 'version', 'overall', 'checks'])
    || diagnostic.schema !== 'lattice.native_factory_diagnostics.v1' || diagnostic.product !== 'lattice'
    || !semver(diagnostic.version) || !['ok', 'failed'].includes(diagnostic.overall)
    || !Array.isArray(diagnostic.checks) || diagnostic.checks.length !== LATTICE_CHECK_IDS.length) return invalid();
  for (const [index, check] of diagnostic.checks.entries()) {
    if (!exact(check, ['id', 'status', 'detail']) || check.id !== LATTICE_CHECK_IDS[index]
      || !['ok', 'failed'].includes(check.status) || !detail(check.detail)) return invalid();
  }
  const expectedOverall = diagnostic.checks.every((check) => check.status === 'ok') ? 'ok' : 'failed';
  if (diagnostic.overall !== expectedOverall) return invalid();
  if ((diagnostic.overall === 'ok' && !result.ok) || (diagnostic.overall === 'failed' && result.ok)) return invalid();
  product.presence_status = 'installed';
  product.installed_version = diagnostic.version;
  projectNativeStatus(product, 'lattice', diagnostic.overall === 'ok' ? 'pass' : 'fail', observedAt);
  return product;
}

/**
 * Lattice native diagnosticsのread-only projection（編入中・L6）。
 * wire v3のreport product集合へは未enroll＝scanResultからは呼ばれない。enrollmentはwire v4（L7）。
 */
export async function latticeProduct({ runner = run, cwd, env } = {}, observedAt = new Date().toISOString()) {
  const result = await runner('lattice', ['factory-diagnostics', '--json'], { cwd, env });
  let diagnostic;
  try { diagnostic = JSON.parse(result.stdout); } catch { diagnostic = null; }
  return latticeNative(result, diagnostic, observedAt);
}

function aishellNative(result, diagnostic, observedAt) {
  const product = emptyProduct();
  if (result?.reason === 'spawn' && result?.error?.code === 'ENOENT') {
    product.presence_status = 'missing';
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'cli_unavailable',
    });
    return product;
  }
  const semver = (value) => typeof value === 'string' && new RegExp(`^${SEMVER}$`).test(value);
  const metadata = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  const privacyFields = [
    'exposesAllowedRootPaths', 'exposesOperationHistory', 'exposesFileContents', 'exposesProcessArguments',
  ];
  // 公開診断の識別子・結果・公開範囲を確認し、内部設定や管理UIの世代は製品に委ねる。
  if (!result.ok || diagnostic?.schemaVersion !== 'aishell.native_factory_diagnostics.v1'
    || diagnostic.product?.identifier !== 'aishell' || !semver(diagnostic.product.version)
    || typeof diagnostic.ready !== 'boolean'
    || !privacyFields.every((key) => diagnostic.privacy?.[key] === false)
    || !Array.isArray(diagnostic.issues) || !diagnostic.issues.every(metadata)) {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  }
  product.presence_status = 'installed';
  product.installed_version = diagnostic.product.version;
  if (metadata(diagnostic.runtime?.schemaVersion)) {
    product.state_schema_version = diagnostic.runtime.schemaVersion;
  }
  const migrations = new Map([['compatible_on_read', 'current'], ['blocked', 'failed'], ['not_required', 'not_applicable']]);
  product.migration_status = migrations.get(diagnostic.runtime?.migrationStatus) ?? 'unverified';
  projectNativeStatus(product, 'aishell', diagnostic.ready ? 'ready' : 'not_ready', observedAt);
  return product;
}

/** AIShell native diagnosticsのread-only projection。wire v2〜v4へはenrollしない。 */
export async function aishellProduct(
  { runner = run, cwd, env, profile = 'mac' } = {},
  observedAt = new Date().toISOString(),
) {
  if (profile !== 'mac') {
    const product = emptyProduct();
    product.presence_status = 'not_applicable';
    product.compatibility_status = 'unsupported';
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unsupported', reason_code: 'platform_unsupported',
    });
    return product;
  }
  const messages = [
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dotagents-factory', version: '1.0.0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'factory_diagnostics', arguments: {} } },
  ];
  // factory_diagnosticsは専用factory profileでだけ公開される。既定catalogでは未定義toolになる。
  const result = await runner('aishell-mcp', [], {
    cwd,
    env: { ...(env ?? process.env), AISHELL_TOOL_PROFILE: 'factory' },
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
  });
  let diagnostic;
  try {
    const response = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .find((entry) => entry.id === 2);
    diagnostic = response?.result?.structuredContent;
  } catch {
    diagnostic = null;
  }
  return aishellNative(result, diagnostic, observedAt);
}

function codexSidecarNative(result, diagnostic, observedAt) {
  const product = emptyProduct();
  const readiness = diagnostic?.factoryReadiness;
  const validVersion = (value) => typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
  const invalid = () => {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  };
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
    || readiness?.schemaVersion !== '1'
    || !['ready', 'not_ready', 'unverified'].includes(readiness?.overall)
    || !['ok', 'failed'].includes(diagnostic.status)
    || result.ok !== (diagnostic.status === 'ok')
    || (readiness.overall === 'ready' && diagnostic.status !== 'ok')
    || (readiness.overall !== 'ready' && diagnostic.status !== 'failed')) {
    return invalid();
  }
  if (readiness.overall === 'unverified') {
    projectNativeStatus(product, 'codex-sidecar', 'unverified', observedAt);
    return product;
  }

  const packageVersions = readiness.packageVersions;
  const packages = packageVersions?.packages;
  if (!packageVersions || (packageVersions.status !== 'ready' && packageVersions.status !== 'not_ready')
    || !packages || typeof packages !== 'object' || Array.isArray(packages)
    || !validVersion(packages.cli) || !validVersion(packages.core) || !validVersion(packages.mcp)) {
    return invalid();
  }
  const versionsAligned = packages.cli === packages.core && packages.core === packages.mcp;
  if ((readiness.overall === 'ready' && (packageVersions.status !== 'ready' || !versionsAligned))
    || (!versionsAligned && packageVersions.status !== 'not_ready')) {
    return invalid();
  }
  if (versionsAligned) {
    product.presence_status = 'installed';
    product.installed_version = packages.cli;
  }
  projectNativeStatus(product, 'codex-sidecar', readiness.overall, observedAt);
  return product;
}

async function aitermNative(options, observedAt) {
  const messages = [
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dotagents-factory', version: '1.0.0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnostics', arguments: {} } },
  ];
  const result = await run('aiterm-mcp', [], {
    ...options,
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
  });
  let diagnostic;
  try {
    const response = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .find((entry) => entry.id === 2);
    diagnostic = JSON.parse(response?.result?.content?.[0]?.text);
  } catch {
    diagnostic = null;
  }
  const product = emptyProduct();
  if (!result.ok || diagnostic?.diagnostic_schema !== 'aiterm-mcp.factory-diagnostics.v1' ||
    typeof diagnostic.version !== 'string' || typeof diagnostic.overall !== 'string') {
    product.checks.push({
      check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_schema_invalid',
    });
    return product;
  }
  product.presence_status = 'installed';
  product.installed_version = diagnostic.version;
  projectNativeStatus(product, 'aiterm-mcp', diagnostic.overall, observedAt);
  return product;
}

export function projectServerManagerProbe(result, diagnostic, observedAt) {
  const product = emptyProduct();
  const reasonCodes = new Set(SERVERMANAGER_REASON_CODES);
  const invalid = (reasonCode = 'external_probe_invalid') => {
    product.compatibility_status = 'unverified';
    product.checks.push({ check_id: 'external_readiness', status: 'unverified', reason_code: reasonCode });
    return product;
  };
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
    || Object.keys(diagnostic).length !== 6
    || !['schema_version', 'product_version', 'status', 'reason_code', 'source_revision', 'checks'].every((key) => key in diagnostic)
    || diagnostic.schema_version !== 'dotagents.bughub-external-probe.v1'
    || !['ready', 'not_ready', 'unverified'].includes(diagnostic.status)
    || !['ready', 'readiness_failed', 'unreachable', 'contract_invalid'].includes(diagnostic.reason_code)
    || (diagnostic.status === 'ready' && diagnostic.reason_code !== 'ready')
    || (diagnostic.status === 'not_ready' && diagnostic.reason_code !== 'readiness_failed')
    || (diagnostic.status === 'unverified' && !['unreachable', 'contract_invalid'].includes(diagnostic.reason_code))
    || (diagnostic.status === 'unverified'
      ? diagnostic.product_version !== null
      : typeof diagnostic.product_version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(diagnostic.product_version))
    || (diagnostic.status === 'unverified'
      ? diagnostic.source_revision !== null
      : diagnostic.source_revision !== null
        && (typeof diagnostic.source_revision !== 'string' || !/^[0-9a-f]{40,64}$/.test(diagnostic.source_revision)))
    || !Array.isArray(diagnostic.checks)
    || (diagnostic.status === 'ready') !== result.ok
    || (diagnostic.status === 'unverified' && diagnostic.checks.length !== 0)) {
    return invalid();
  }
  if (diagnostic.status === 'unverified') return invalid(diagnostic.reason_code);
  if (diagnostic.checks.length !== 6) return invalid();
  const expectedIds = SERVERMANAGER_CHECK_IDS;
  const validStatuses = new Set(['pass', 'fail', 'skipped']);
  for (const [index, check] of diagnostic.checks.entries()) {
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || Object.keys(check).length !== 3
      || !['id', 'status', 'reason_code'].every((key) => key in check)
      || check.id !== expectedIds[index] || !validStatuses.has(check.status)
      || typeof check.reason_code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(check.reason_code)
      || !reasonCodes.has(check.reason_code)) return invalid();
  }
  const revisionCheck = diagnostic.checks.at(-1);
  if ((typeof diagnostic.source_revision === 'string'
    && !((revisionCheck.status === 'pass' && revisionCheck.reason_code === 'revision_match')
      || (revisionCheck.status === 'fail'
        && ['revision_missing', 'revision_invalid', 'revision_mismatch'].includes(revisionCheck.reason_code))))
    || (diagnostic.source_revision === null
      && (revisionCheck.status !== 'fail'
        || !['revision_missing', 'revision_invalid'].includes(revisionCheck.reason_code)))) return invalid();
  const failed = diagnostic.checks.filter((check) => check.status === 'fail');
  if ((diagnostic.status === 'ready') !== (failed.length === 0)) return invalid();
  product.presence_status = 'installed';
  product.installed_version = diagnostic.product_version;
  if (typeof diagnostic.source_revision === 'string') product.source_revision = diagnostic.source_revision;
  product.compatibility_status = diagnostic.status === 'ready' ? 'compatible' : 'incompatible';
  for (const check of diagnostic.checks) {
    const checkId = `readiness_${check.id}`;
    if (check.status === 'fail') {
      product.checks.push({
        check_id: checkId,
        status: 'fail',
        severity: ['database', 'schema'].includes(check.id) ? 'fatal' : 'high',
        fingerprint: createHash('sha256').update(`servermanager:${check.id}:${check.reason_code}`).digest('hex'),
        message_template: `BugHub ${check.id} readiness check failed`,
        occurrence_count: 1,
        first_seen: observedAt,
        last_seen: observedAt,
        reason_code: check.reason_code,
      });
    } else {
      product.checks.push({ check_id: checkId, status: check.status, reason_code: check.reason_code });
    }
    for (const reasonCode of SERVERMANAGER_REASON_CODES) {
      if (check.status === 'fail' && reasonCode === check.reason_code) continue;
      product.resolutions.push({
        fingerprint: createHash('sha256').update(`servermanager:${check.id}:${reasonCode}`).digest('hex'),
        resolved_at: observedAt,
        reason_code: 'readiness_recovered',
      });
    }
  }
  return product;
}

export async function serverManagerNative(options, observedAt, runner = run) {
  const result = await runner('bughub-external-probe', ['--json'], { ...options, timeoutMs: 7_000 });
  let diagnostic;
  try { diagnostic = JSON.parse(result.stdout); } catch { diagnostic = null; }
  return projectServerManagerProbe(result, diagnostic, observedAt);
}

async function version(command, options) {
  const result = await run(command, ['--version'], options);
  if (!result.ok) return null;
  const match = result.stdout.trim().match(
    /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/,
  );
  return match?.[1] && match[1].length <= 128 ? match[1] : null;
}

function stableSemver(versionValue) {
  const match = versionValue?.match(
    new RegExp(`^${SEMVER}$`),
  );
  if (!match) return null;
  const prereleaseIndex = versionValue.indexOf('-');
  const buildIndex = versionValue.indexOf('+');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    prerelease: prereleaseIndex !== -1 && (buildIndex === -1 || prereleaseIndex < buildIndex),
  };
}

async function thirdPartyVersion(productId, options) {
  const result = await run(CLI[productId], ['--version'], options);
  if (!result.ok) return null;
  const output = result.stdout.trim();
  const match = output.match(new RegExp(`^(?:${productId}[\\t ]+)?v?(${SEMVER})$`));
  return match?.[1] && match[1].length <= 128 ? match[1] : null;
}

function thirdPartyVersionCheck(productId, installedVersion) {
  const parsed = stableSemver(installedVersion);
  if (!parsed) {
    return { check_id: THIRD_PARTY_CHECK_IDS[productId], status: 'unverified', reason_code: 'version_unverified' };
  }
  const supported = THIRD_PARTY_VERSION_RANGES[productId];
  if (parsed.prerelease || parsed.major !== supported.major || parsed.minor !== supported.minor) {
    return { check_id: THIRD_PARTY_CHECK_IDS[productId], status: 'unsupported', reason_code: 'upstream_version_unsupported' };
  }
  return null;
}

async function thirdParty(productId, options) {
  const product = emptyProduct();
  const installedVersion = await thirdPartyVersion(productId, options);
  const versionCheck = thirdPartyVersionCheck(productId, installedVersion);
  if (versionCheck) {
    if (installedVersion && versionCheck.status === 'unsupported') {
      product.presence_status = 'installed';
      product.installed_version = installedVersion;
    }
    product.checks.push(versionCheck);
    return product;
  }
  product.presence_status = 'installed';
  product.installed_version = installedVersion;

  if (productId === 'oracle') {
    const result = await run('oracle', ['doctor', '--providers', '--json'], options);
    let doctor;
    try { doctor = JSON.parse(result.stdout); } catch { doctor = null; }
    const machineReadable = doctor && typeof doctor === 'object' && !Array.isArray(doctor);
    product.checks.push(result.ok && machineReadable
      ? { check_id: 'doctor', status: 'pass' }
      : machineReadable
        ? { check_id: 'doctor', status: 'unverified', reason_code: 'provider_not_ready' }
        : { check_id: 'doctor', status: 'unverified' });
  }

  if (productId === 'markitdown') {
    const directory = await mkdtemp(join(tmpdir(), 'factory-markitdown-'));
    const fixture = join(directory, 'fixture.txt');
    try {
      await writeFile(fixture, 'factory fixture\n');
      const result = await run('markitdown', [fixture], options);
      product.checks.push({
        check_id: 'local_fixture',
        status: result.ok && Buffer.byteLength(result.stdout) > 0 ? 'pass' : 'unverified',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return product;
}

async function scanResult({ host, cwd, arch, platform, collectionEnabled = false, oracleRetired = false }) {
  const normalizedPlatform = platform === 'win32' ? 'windows' : platform;
  if (OS_FOR_PROFILE[host.profile] !== normalizedPlatform) {
    throw new Error('host.profileと実行platformが不一致です');
  }
  if (!['x64', 'arm64', 'arm', 'ia32'].includes(arch)) {
    throw new Error('実行archがreport schema対象外です');
  }

  const observedAt = new Date().toISOString();
  const options = { cwd };
  const products = Object.fromEntries(PRODUCTS.map((id) => [id, emptyProduct()]));
  // 旧wire上のCodegraph欄は履歴互換のnot_applicable固定。実行・再導入はしない。
  products.codegraph = { ...emptyProduct(), presence_status: 'not_applicable' };
  for (const id of ['markitdown']) {
    products[id] = await thirdParty(id, options);
  }
  products.oracle = oracleRetired
    ? { ...emptyProduct(), presence_status: 'not_applicable' }
    : await thirdParty('oracle', options);
  products.caveat = await nativeCli(
    'caveat', 'caveat', ['factory-diagnostics', '--json'], options, observedAt,
  );
  products.throughline = await nativeCli(
    'throughline', 'throughline', ['factory-diagnostics', '--json'], options, observedAt,
  );
  products.spotter = await nativeCli(
    'spotter', 'spotter', ['diagnostics', 'factory'], options, observedAt,
  );
  products['codex-sidecar'] = await nativeCli(
    'codex-sidecar', 'codex-sidecar', ['factory-diagnostics', '--project', cwd], options, observedAt,
  );
  products['aiterm-mcp'] = await aitermNative(options, observedAt);
  const acknowledgements = [];
  products.servermanager = host.profile === 'server'
    ? await serverManagerNative(options, observedAt)
    : { ...emptyProduct(), presence_status: 'not_applicable' };
  if (collectionEnabled) {
    // report未enroll製品（編入中のlattice等）はwire v3 reportへ混入させない
    for (const id of RUNTIME_ERROR_PRODUCTS.filter((id) => id !== 'servermanager' && Object.hasOwn(products, id))) {
      const projection = await collectRuntimeErrors(id, options);
      products[id].runtime_errors = projection.runtime_errors;
      products[id].resolutions = projection.resolutions;
      if (projection.acknowledgement) acknowledgements.push(projection.acknowledgement);
    }
    if (host.profile === 'server') {
      const projection = await collectRuntimeErrors('servermanager', options);
      const merged = mergeServerManagerExternal(products.servermanager, projection);
      products.servermanager = merged.product;
      if (merged.acknowledgement) acknowledgements.push(merged.acknowledgement);
    }
  }

  const revision = await run('git', ['-c', `safe.directory=${REPO_ROOT}`, 'rev-parse', '--short=7', 'HEAD'], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  const dotagentsRevision = revision.stdout.trim();
  if (!revision.ok || !/^[0-9a-f]{7,64}$/.test(dotagentsRevision)) {
    throw new Error('dotagents revisionを取得できません');
  }

  const createdCandidate = new Date().toISOString();
  const report = {
    schema_version: '1.0',
    report_id: randomUUID(),
    host_id: host.id,
    host_profile: host.profile,
    platform: { os: normalizedPlatform, arch },
    report_mode: 'full',
    observed_at: observedAt,
    created_at: createdCandidate < observedAt ? observedAt : createdCandidate,
    reporter: { version: '1.0.0', dotagents_revision: dotagentsRevision },
    products,
  };
  return { report, acknowledgements: acknowledgementBundle(report.report_id, acknowledgements) };
}

export function mergeServerManagerExternal(product, projection) {
  const active = new Set(product.checks.filter((check) => check.status === 'fail').map((check) => check.fingerprint));
  const externalOpen = new Set(projection.runtime_errors.map((record) => record.fingerprint));
  const resolutions = product.resolutions.filter((resolution) => !externalOpen.has(resolution.fingerprint));
  const runtimeErrors = projection.runtime_errors.filter((record) => !active.has(record.fingerprint));
  const existingResolutions = new Set(resolutions.map((resolution) => resolution.fingerprint));
  const blocked = projection.resolutions.some((resolution) => active.has(resolution.fingerprint));
  resolutions.push(...projection.resolutions.filter((resolution) => !active.has(resolution.fingerprint) && !existingResolutions.has(resolution.fingerprint)));
  return { product: { ...product, runtime_errors: runtimeErrors, resolutions }, acknowledgement: blocked ? null : projection.acknowledgement };
}

export async function scan(options) {
  return (await scanResult(options)).report;
}

export async function scanWithAcknowledgements(options) {
  return scanResult(options);
}
