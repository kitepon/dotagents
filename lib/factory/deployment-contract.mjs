// dotagents が所有する配備契約。wire の履歴集合とは分け、現役の導入・更新後判定だけをここで決める。
export const MANAGED_PRODUCT_IDS = Object.freeze([
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector',
  'aiterm-mcp', 'codex-sidecar', 'aishell', 'servermanager', 'peertable', 'unai',
]);
export const CURRENT_WIRE_PRODUCT_IDS = Object.freeze([
  ...MANAGED_PRODUCT_IDS.slice(0, 8), 'servermanager', 'claude-code', 'codex-cli', 'grok-build', 'aishell', 'peertable', 'unai',
]);
export const BASE_NPM_PACKAGES = Object.freeze([
  '@anthropic-ai/claude-code', '@openai/codex', 'gpt-connector', '@anthropic-ai/sdk',
  'aiterm-mcp', 'caveat-cli', 'claude-spotter', 'codex-sidecar-cli', 'codex-sidecar-core',
  'codex-sidecar-mcp', '@quolu/lattice', 'peertable', 'pnpm', 'throughline',
]);

const BASE_REQUIRED = Object.freeze(['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'peertable', 'unai']);
const PROFILES = new Set(['mac', 'server', 'wsl', 'windows-native']);
const TOOLCHAINS = Object.freeze(['claude-code', 'codex-cli']);
const PROFILE_OS = Object.freeze({ mac: 'darwin', server: 'linux', wsl: 'linux', 'windows-native': 'win32' });
const ARCHES = new Set(['x64', 'arm64', 'arm', 'ia32']);
export const ALLOWED_UNVERIFIED = new Set([
  'spotter\0codex_hooks\0trust_not_machine_verifiable',
  'throughline\0evidence_restore_smoke\0diagnostic_unverified',
  'throughline\0claude_connector\0diagnostic_unverified',
  'aiterm-mcp\0pty_list\0pty_list_unverified',
  'claude-code\0last_update\0post_gate_failed', 'codex-cli\0last_update\0post_gate_failed',
  'gpt-connector\0cdp\0chrome_idle', 'gpt-connector\0official_origin\0cdp_not_inspected',
  'gpt-connector\0auth\0cdp_not_inspected', 'gpt-connector\0runtime_bridge\0cdp_not_inspected',
]);

function fact(value, name) { if (typeof value !== 'string' || !value) throw new Error(`${name}が不正です`); return value; }

function canonicalNpmOs(os) {
  if (os === 'Darwin' || os === 'darwin') return 'darwin';
  if (os === 'Linux' || os === 'linux') return 'linux';
  if (os === 'Windows_NT' || os === 'win32' || /^(?:MINGW|MSYS|CYGWIN)/u.test(os)) return 'win32';
  throw new Error('OSが不正です');
}

function canonicalArch(arch) {
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'arm' || /^armv[5-8]l$/u.test(arch)) return 'arm';
  if (arch === 'ia32' || /^(?:i[3-6]86|x86)$/u.test(arch)) return 'ia32';
  throw new Error('archが不正です');
}

export function hostProjection({ profile, os, arch, macosMajor = null }) {
  fact(profile, 'profile'); fact(os, 'os'); fact(arch, 'arch');
  if (!PROFILES.has(profile)) throw new Error('host profileが不正です');
  if (os !== PROFILE_OS[profile]) throw new Error('host profileとOSが不整合です');
  if (!ARCHES.has(arch)) throw new Error('archが不正です');
  if (profile === 'mac' && (!Number.isInteger(macosMajor) || macosMajor < 1)) throw new Error('macOS majorが不正です');
  if (profile !== 'mac' && macosMajor !== null) throw new Error('macOS majorはmac profileだけに指定できます');
  const expected = Object.fromEntries(MANAGED_PRODUCT_IDS.map((id) => [id, 'unsupported']));
  for (const id of BASE_REQUIRED) expected[id] = 'required';
  expected.servermanager = profile === 'server' ? 'required' : 'not_applicable';
  const supportsAishell = profile === 'mac' && arch === 'arm64' && macosMajor >= 15;
  expected.aishell = supportsAishell ? 'required' : 'unsupported';
  return Object.freeze({ profile, os, arch, expected: Object.freeze(expected), required: Object.freeze(MANAGED_PRODUCT_IDS.filter((id) => expected[id] === 'required')) });
}

export function npmPackagesForHost({ os, arch }) {
  fact(os, 'os'); fact(arch, 'arch');
  const canonicalOs = canonicalNpmOs(os);
  const canonicalArchitecture = canonicalArch(arch);
  // aiterm-mcp の win32 一時除外（2026-08-16〜2026-08-19）は戻し済み: native psmux 移行は
  // aiterm-mcp 0.27.0 として release され、この端末の global install も registry 版へ復帰した。
  const packages = [...BASE_NPM_PACKAGES];
  if (canonicalOs === 'darwin' && canonicalArchitecture === 'arm64') packages.push('@quolu/aishell');
  return Object.freeze(packages);
}

export function postUpdateFailures(report, facts, { postUpdate = true } = {}) {
  const projection = hostProjection(facts);
  const required = [...projection.required, ...(projection.profile === 'windows-native' ? [] : TOOLCHAINS)];
  const failures = [];
  for (const id of required) {
    const product = report?.products?.[id];
    if (!product || product.presence_status !== 'installed') { failures.push(`${id}:presence`); continue; }
    const serverSelfIngestStale = postUpdate && projection.profile === 'server' && id === 'servermanager'
      && product.checks?.some((item) => item.check_id === 'readiness_factory_ingest'
        && item.status === 'fail' && item.reason_code === 'stale')
      && product.checks.every((item) => item.status !== 'fail' || item.check_id === 'readiness_factory_ingest');
    if (!serverSelfIngestStale
      && ((TOOLCHAINS.includes(id) && product.compatibility_status !== 'compatible') || product.compatibility_status === 'incompatible')) failures.push(`${id}:compatibility`);
    for (const item of product.checks || []) {
      if (serverSelfIngestStale && item.check_id === 'readiness_factory_ingest') continue;
      if (postUpdate && item.check_id === 'last_update' && item.status === 'unverified' && item.reason_code === 'post_gate_pending') continue;
      if (item.status === 'fail' || (item.status === 'unverified' && !ALLOWED_UNVERIFIED.has(`${id}\0${item.check_id}\0${item.reason_code}`))) failures.push(`${id}:${item.check_id}`);
    }
  }
  return failures;
}
