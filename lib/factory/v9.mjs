import { homedir } from 'node:os';
import { run } from './command.mjs';
import { jevCheckout, jevSupported } from './jev-products.mjs';
import { scanV8WithAcknowledgements, V8_PRODUCT_IDS } from './v8.mjs';

export const V9_PRODUCT_IDS = Object.freeze([...V8_PRODUCT_IDS, 'jev-ultrafast', 'agent-desktop']);
const check = (check_id, status, reason_code) => ({ check_id, status, ...(reason_code ? { reason_code } : {}) });
const empty = () => ({ presence_status: 'unverified', compatibility_status: 'unverified', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] });

// package managerの公開versionとCLIの起動だけを観測する。GUIや接続用daemonは起動しない。
export async function jevProduct(id, { platform = process.platform, home = homedir(), runCommand = run } = {}) {
  if (!jevSupported(id, platform)) return { ...empty(), presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [check('platform', 'skipped', 'upstream_unsupported')] };
  const cwd = jevCheckout(id, home);
  const result = id === 'agent-desktop'
    ? await runCommand('agent-desktop', ['--version'])
    : await runCommand('uv', ['run', '--no-sync', '--offline', 'python', '-c', 'from importlib.metadata import version; print(version("jev-ultrafast"))'], { cwd });
  const version = result.ok && /^\s*(?:agent-desktop\s+)?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\s*$/u.exec(result.stdout)?.[1];
  if (!version) return { ...empty(), presence_status: result.reason === 'spawn' && result.error?.code === 'ENOENT' ? 'missing' : 'unverified', checks: [check('installation', 'unverified', 'version_unavailable')] };
  // npmバイナリとJevスクリプトのcheckoutは別の配布物なので、同じrevisionとは扱わない。
  const revision = id === 'jev-ultrafast' ? await runCommand('git', ['rev-parse', 'HEAD'], { cwd }) : null;
  const harness = id === 'jev-ultrafast' ? await runCommand('browser-harness', ['--version']) : null;
  const harnessCheck = harness && (/^\s*\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/u.test(harness.stdout ?? '')
    ? check('browser_harness_cli', 'pass') : check('browser_harness_cli', 'unverified', 'version_unavailable'));
  return {
    ...empty(), presence_status: 'installed', installed_version: version,
    ...(revision?.ok && /^[0-9a-f]{40,64}$/u.test(revision.stdout.trim()) ? { source_revision: revision.stdout.trim() } : {}),
    checks: [check('installation', 'pass'), ...(harnessCheck ? [harnessCheck] : []), check('gui_runtime', 'skipped', 'on_demand_only')],
  };
}

export async function scanV9WithAcknowledgements(options) {
  const prior = await scanV8WithAcknowledgements(options);
  const products = Object.fromEntries(V8_PRODUCT_IDS.map((id) => [id, { ...prior.report.products[id], contract_version: '9.0' }]));
  for (const id of ['jev-ultrafast', 'agent-desktop']) products[id] = await jevProduct(id, options);
  // codex-sidecarは工場の管理対象から外した。wire v9の固定集合には残すため、対象外として報告する。
  products['codex-sidecar'] = { ...empty(), presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [check('factory_management', 'skipped', 'retired_from_factory')] };
  const acknowledgements = (prior.acknowledgements.acknowledgements ?? []).filter((item) => item.product !== 'codex-sidecar');
  return { report: { ...prior.report, schema_version: '9.0', reporter: { ...prior.report.reporter, version: '9.0.0' }, products },
    acknowledgements: { ...prior.acknowledgements, schema_version: '9.0', acknowledgements } };
}
export async function scanV9(options) { return (await scanV9WithAcknowledgements(options)).report; }
