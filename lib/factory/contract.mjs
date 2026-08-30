import { readFile } from 'node:fs/promises';

const PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'codegraph', 'markitdown',
  'oracle', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
];
const V2_PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'codegraph', 'markitdown',
  'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
  'claude-code', 'codex-cli', 'grok-build',
];
const V4_PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown',
  'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
  'claude-code', 'codex-cli', 'grok-build',
];
const V5_PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown',
  'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
  'claude-code', 'codex-cli', 'grok-build', 'aishell',
];
const V6_PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown',
  'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
  'claude-code', 'codex-cli', 'grok-build', 'aishell',
];
const V7_PRODUCT_IDS = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown',
  'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager',
  'claude-code', 'codex-cli', 'grok-build', 'aishell', 'peertable',
];
const V8_PRODUCT_IDS = [...V7_PRODUCT_IDS, 'unai'];
const UUID_V7ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const FORBIDDEN_KEY = /(?:token|secret|credential|authorization|cookie|password|prompt|input|stdout|stderr|stack|(?:^|_)path|email|username|env)/i;
// ServerManager/BugHubの受理側より弱いprivacy gateにしない。
// clientで通したreportがserverで拒否されると、秘密値をoutboxへ残したまま再送し続けるため。
const FORBIDDEN_VALUE = /(?:\bBearer\s+\S+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:ghp|github_pat)_[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|-----BEGIN [A-Z ]+-----|(?:^|[\s"'])\/(?:Users|home|var|etc|tmp)\/|\b[A-Za-z]:\\|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i;
const SAFE_CONTEXT_ALLOWLIST = Object.freeze(
  Object.fromEntries([...new Set([...PRODUCT_IDS, ...V2_PRODUCT_IDS, ...V4_PRODUCT_IDS, ...V5_PRODUCT_IDS, ...V6_PRODUCT_IDS, ...V7_PRODUCT_IDS, ...V8_PRODUCT_IDS])].map((id) => [id, new Set()])),
);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, path) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${path}に未定義fieldがあります`);
  }
}

function stableId(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !STABLE_ID.test(value)) {
    throw new Error(`${path}が不正です`);
  }
}

function version(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new Error(`${path}が不正です`);
  }
}

function fingerprint(value, path) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${path}が不正です`);
  }
}

function messageTemplate(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw new Error(`${path}が不正です`);
  }
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${path}が不正です`);
}

function validUtc(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function utcAt(value, path) {
  if (!validUtc(value)) throw new Error(`${path}がUTC ISO8601でありません`);
  return Date.parse(value);
}

function safeContext(value, path, productId) {
  exactKeys(value, Object.keys(value || {}), path);
  if (Object.keys(value).length > 16) throw new Error(`${path}が多すぎます`);
  for (const [key, item] of Object.entries(value)) {
    const type = typeof item;
    if (!SAFE_CONTEXT_ALLOWLIST[productId]?.has(key)) throw new Error(`${path}.${key}はallowlist外です`);
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)
      || !['string', 'number', 'boolean'].includes(type)
      || (type === 'string' && item.length > 256)
      || (type === 'number' && !Number.isFinite(item))) {
      throw new Error(`${path}.${key}が不正です`);
    }
  }
}

function inspectPrivacy(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPrivacy(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
      throw new Error(`privacy禁止pattern (${path})`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`privacy禁止key (${path}.${key})`);
    inspectPrivacy(child, `${path}.${key}`);
  }
}

export async function readConfig(configPath) {
  let bytes;
  try {
    bytes = await readFile(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { collection: { enabled: false }, reporting: { enabled: false }, source: 'missing' };
    }
    throw new Error(`設定を読めません (${error.code || error.message})`);
  }
  let config;
  try {
    config = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('設定JSONが不正です');
  }
  validateConfig(config);
  return { ...config, source: 'file' };
}

export function validateConfig(config) {
  if (!isObject(config)
    || Object.keys(config).some((key) => !['schema_version', 'host', 'collection', 'reporting'].includes(key))) {
    throw new Error('設定shapeが不正です');
  }
  if (config.schema_version !== '1.0') throw new Error('設定schema_versionは1.0でなければなりません');
  if (!isObject(config.host)) throw new Error('hostが必要です');
  exactKeys(config.host, ['id', 'profile'], 'host');
  stableId(config.host.id, 'host.id');
  if (!['server', 'mac', 'linux', 'wsl', 'windows-native'].includes(config.host.profile)) {
    throw new Error('host.profileが不正です');
  }
  for (const section of ['collection', 'reporting']) {
    if (!isObject(config[section]) || typeof config[section].enabled !== 'boolean') {
      throw new Error(`${section}.enabledはboolean必須です`);
    }
  }
  if (Object.keys(config.collection).some((key) => key !== 'enabled')) {
    throw new Error('collectionに未定義fieldがあります');
  }
  if (Object.keys(config.reporting).some((key) => !['enabled', 'endpoint', 'credential_file'].includes(key))) {
    throw new Error('reportingに未定義fieldがあります');
  }
  const { endpoint, credential_file: credentialFile } = config.reporting;
  if ('endpoint' in config.reporting) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new Error('reporting.endpointが不正です');
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('reporting.endpointが不正です'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('reporting.endpointが不正です');
  }
  if ('credential_file' in config.reporting
    && (typeof credentialFile !== 'string' || credentialFile.length < 1 || credentialFile.length > 4096)) {
    throw new Error('reporting.credential_fileが不正です');
  }
  if (config.reporting.enabled && (!('endpoint' in config.reporting) || !('credential_file' in config.reporting))) {
    throw new Error('reporting.enabled時にendpoint/credential_fileが必要です');
  }
}

function validateCheck(item, path, observedAt, productId) {
  exactKeys(item, [
    'check_id', 'status', 'severity', 'fingerprint', 'message_template',
    'occurrence_count', 'first_seen', 'last_seen', 'reason_code', 'safe_context',
  ], path);
  stableId(item.check_id, `${path}.check_id`);
  if (!['pass', 'fail', 'unsupported', 'unverified', 'skipped'].includes(item.status)) {
    throw new Error(`${path}.statusが不正です`);
  }
  if ('safe_context' in item) safeContext(item.safe_context, `${path}.safe_context`, productId);
  const failureFields = [
    'severity', 'fingerprint', 'message_template', 'occurrence_count', 'first_seen', 'last_seen',
  ];
  if (item.status === 'fail') {
    for (const key of failureFields) if (!(key in item)) throw new Error(`${path}.${key}が必要です`);
    if (!['fatal', 'high', 'warn', 'info'].includes(item.severity)) throw new Error(`${path}.severityが不正です`);
    fingerprint(item.fingerprint, `${path}.fingerprint`);
    messageTemplate(item.message_template, `${path}.message_template`);
    positiveInteger(item.occurrence_count, `${path}.occurrence_count`);
    const first = utcAt(item.first_seen, `${path}.first_seen`);
    const last = utcAt(item.last_seen, `${path}.last_seen`);
    if (first > last || last > observedAt) throw new Error(`${path}のtimestamp順序が不正です`);
    return item.fingerprint;
  }
  for (const key of failureFields) if (key in item) throw new Error(`${path}.${key}はfail以外に不正です`);
  if (item.status === 'skipped' && !('reason_code' in item)) throw new Error(`${path}.reason_codeが必要です`);
  if ('reason_code' in item) stableId(item.reason_code, `${path}.reason_code`);
  return null;
}

function validateRuntimeError(item, path, observedAt, productId) {
  exactKeys(item, [
    'error_code', 'component', 'status', 'severity', 'fingerprint', 'message_template',
    'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version', 'safe_context',
  ], path);
  if (typeof item.error_code !== 'string' || item.error_code.length < 3 || item.error_code.length > 96
    || !/^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/.test(item.error_code)) {
    throw new Error(`${path}.error_codeが不正です`);
  }
  stableId(item.component, `${path}.component`);
  if (!['open', 'resolved'].includes(item.status) || !['fatal', 'high', 'warn', 'info'].includes(item.severity)) {
    throw new Error(`${path}のstatus/severityが不正です`);
  }
  fingerprint(item.fingerprint, `${path}.fingerprint`);
  messageTemplate(item.message_template, `${path}.message_template`);
  positiveInteger(item.occurrence_count, `${path}.occurrence_count`);
  const first = utcAt(item.first_seen, `${path}.first_seen`);
  const last = utcAt(item.last_seen, `${path}.last_seen`);
  if (first > last || last > observedAt) throw new Error(`${path}のtimestamp順序が不正です`);
  if ('state_schema_version' in item) version(item.state_schema_version, `${path}.state_schema_version`);
  if ('safe_context' in item) safeContext(item.safe_context, `${path}.safe_context`, productId);
  return { fp: item.fingerprint, status: item.status };
}

function validateResolution(item, path, observedAt) {
  exactKeys(item, ['fingerprint', 'resolved_at', 'reason_code'], path);
  fingerprint(item.fingerprint, `${path}.fingerprint`);
  if (utcAt(item.resolved_at, `${path}.resolved_at`) > observedAt) {
    throw new Error(`${path}.resolved_atがobserved_atより未来です`);
  }
  stableId(item.reason_code, `${path}.reason_code`);
  return item.fingerprint;
}

function validateProduct(product, path, observedAt, productId) {
  const keys = [
    'presence_status', 'installed_version', 'latest_version', 'source_revision',
    'contract_version', 'state_schema_version', 'migration_status', 'update_status',
    'compatibility_status', 'checks', 'runtime_errors', 'resolutions',
  ];
  exactKeys(product, keys, path);
  if (!['installed', 'missing', 'not_applicable', 'unverified'].includes(product.presence_status)) {
    throw new Error(`${path}.presence_statusが不正です`);
  }
  if (!('contract_version' in product)) throw new Error(`${path}.contract_versionが必要です`);
  for (const key of ['contract_version', 'installed_version', 'latest_version', 'state_schema_version']) {
    if (key in product) version(product[key], `${path}.${key}`);
  }
  if (product.presence_status === 'installed' && !('installed_version' in product)) {
    throw new Error(`${path}.installed_versionが必要です`);
  }
  if ('source_revision' in product
    && (typeof product.source_revision !== 'string' || !/^[0-9a-f]{7,64}$/.test(product.source_revision))) {
    throw new Error(`${path}.source_revisionが不正です`);
  }
  if ('migration_status' in product
    && !['not_applicable', 'current', 'pending', 'failed', 'unverified'].includes(product.migration_status)) {
    throw new Error(`${path}.migration_statusが不正です`);
  }
  if ('update_status' in product
    && !['current', 'outdated', 'failed', 'unsupported', 'unverified'].includes(product.update_status)) {
    throw new Error(`${path}.update_statusが不正です`);
  }
  if ('compatibility_status' in product
    && !['compatible', 'incompatible', 'unsupported', 'unverified'].includes(product.compatibility_status)) {
    throw new Error(`${path}.compatibility_statusが不正です`);
  }
  for (const key of ['checks', 'runtime_errors', 'resolutions']) {
    if (!Array.isArray(product[key])) throw new Error(`${path}.${key}がarrayでありません`);
  }
  if (product.checks.length > 128 || product.runtime_errors.length > 256 || product.resolutions.length > 256) {
    throw new Error(`${path}の配列が多すぎます`);
  }
  const seen = new Set();
  const open = new Set();
  const resolved = new Set();
  for (const [index, item] of product.checks.entries()) {
    const fp = validateCheck(item, `${path}.checks[${index}]`, observedAt, productId);
    if (!fp) continue;
    if (seen.has(fp)) throw new Error(`${path}のfingerprintが重複しています`);
    seen.add(fp); open.add(fp);
  }
  for (const [index, item] of product.runtime_errors.entries()) {
    const { fp, status } = validateRuntimeError(item, `${path}.runtime_errors[${index}]`, observedAt, productId);
    if (seen.has(fp)) throw new Error(`${path}のfingerprintが重複しています`);
    seen.add(fp); (status === 'open' ? open : resolved).add(fp);
  }
  for (const [index, item] of product.resolutions.entries()) {
    const fp = validateResolution(item, `${path}.resolutions[${index}]`, observedAt);
    if (seen.has(fp)) throw new Error(`${path}のfingerprintが重複しています`);
    seen.add(fp); resolved.add(fp);
  }
  for (const fp of open) {
    if (resolved.has(fp)) throw new Error(`${path}でopen/resolved fingerprintが衝突しています`);
  }
}

function validateReportVersion(report, schemaVersion, productIds) {
  exactKeys(report, [
    'schema_version', 'report_id', 'host_id', 'host_profile', 'platform', 'report_mode',
    'observed_at', 'created_at', 'reporter', 'products',
  ], 'report');
  const required = [
    'schema_version', 'report_id', 'host_id', 'host_profile', 'platform', 'report_mode',
    'observed_at', 'created_at', 'reporter', 'products',
  ];
  for (const key of required) if (!(key in report)) throw new Error(`report.${key}が必要です`);
  if (report.schema_version !== schemaVersion || report.report_mode !== 'full') {
    throw new Error('未対応のreport schema/modeです');
  }
  if (typeof report.report_id !== 'string' || !UUID_V7ISH.test(report.report_id)) {
    throw new Error('report_idが不正です');
  }
  stableId(report.host_id, 'host_id');
  if (!['server', 'mac', 'linux', 'wsl', 'windows-native'].includes(report.host_profile)) {
    throw new Error('host_profileが不正です');
  }
  exactKeys(report.platform, ['os', 'arch'], 'platform');
  if (!['darwin', 'linux', 'windows'].includes(report.platform.os)
    || !['x64', 'arm64', 'arm', 'ia32'].includes(report.platform.arch)) {
    throw new Error('platformが不正です');
  }
  if ({ mac: 'darwin', server: 'linux', linux: 'linux', wsl: 'linux', 'windows-native': 'windows' }[report.host_profile]
    !== report.platform.os) {
    throw new Error('host_profileとplatform.osが不整合です');
  }
  const observedAt = utcAt(report.observed_at, 'observed_at');
  const createdAt = utcAt(report.created_at, 'created_at');
  if (observedAt > createdAt) throw new Error('observed_atはcreated_at以前でなければなりません');
  exactKeys(report.reporter, ['version', 'dotagents_revision'], 'reporter');
  version(report.reporter.version, 'reporter.version');
  if (typeof report.reporter.dotagents_revision !== 'string'
    || !/^[0-9a-f]{7,64}$/.test(report.reporter.dotagents_revision)) {
    throw new Error('reporter.dotagents_revisionが不正です');
  }
  exactKeys(report.products, productIds, 'products');
  if (!productIds.every((id) => isObject(report.products[id]))) {
    throw new Error(`productsはschema ${schemaVersion}の固定${productIds.length}製品をすべて含む必要があります`);
  }
  for (const [id, product] of Object.entries(report.products)) {
    validateProduct(product, `products.${id}`, observedAt, id);
  }
  inspectPrivacy(report);
}

export function validateReport(report) {
  validateReportVersion(report, '1.0', PRODUCT_IDS);
}

export function validateReportV2(report) {
  validateReportVersion(report, '2.0', V2_PRODUCT_IDS);
}

export function validateReportV4(report) {
  validateReportVersion(report, '4.0', V4_PRODUCT_IDS);
}

// v5はv4と同じvalidateReportVersionを共有する。client privacy gateをserverより弱くしない。
export function validateReportV5(report) {
  validateReportVersion(report, '5.0', V5_PRODUCT_IDS);
}

export function validateReportV6(report) {
  validateReportVersion(report, '6.0', V6_PRODUCT_IDS);
}

export function validateReportV7(report) {
  validateReportVersion(report, '7.0', V7_PRODUCT_IDS);
}

export function validateReportV8(report) {
  validateReportVersion(report, '8.0', V8_PRODUCT_IDS);
}

export function assertConfigIdentity(config, report) {
  if (config.host && (config.host.id !== report.host_id || config.host.profile !== report.host_profile)) {
    throw new Error('report host identityとconfig.hostが一致しません');
  }
}

export async function readAndValidateReport(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReport(report);
  return { bytes, report };
}

export async function readAndValidateReportV2(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV2(report);
  return { bytes, report };
}

export async function readAndValidateReportV4(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV4(report);
  return { bytes, report };
}
export async function readAndValidateReportV5(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV5(report);
  return { bytes, report };
}

export async function readAndValidateReportV6(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV6(report);
  return { bytes, report };
}

export async function readAndValidateReportV7(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV7(report);
  return { bytes, report };
}

export async function readAndValidateReportV8(reportPath) {
  const bytes = await readFile(reportPath);
  let report;
  try {
    report = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error('report JSONが不正です');
  }
  validateReportV8(report);
  return { bytes, report };
}
