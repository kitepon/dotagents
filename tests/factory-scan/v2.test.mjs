import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { projectGptConnectorFactory, scanV2, scanV2WithAcknowledgements, V2_PRODUCT_IDS } from '../../lib/factory/v2.mjs';
import { validateReportV2 } from '../../lib/factory/contract.mjs';
import { run as runCommand } from '../../lib/factory/command.mjs';
import { writeCommandFixture } from './command-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

async function assertRevisionCommand() {
  const result = await runCommand('git', ['-c', `safe.directory=${ROOT}`, 'rev-parse', '--short=7', 'HEAD'], { cwd: ROOT });
  assert.equal(result.ok, true, JSON.stringify({ reason: result.reason, code: result.code, error: result.error?.code, stderr: result.stderr }));
}

test('v2 product集合はOracleを含まず固定12製品', () => {
  assert.deepEqual(V2_PRODUCT_IDS, ['caveat', 'throughline', 'spotter', 'codegraph', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager', 'claude-code', 'codex-cli', 'grok-build']);
});
test('gpt connector adapterはexact schemaとprivacy allowlistを強制する', () => {
  const ids = ['version', 'state_schema', 'job_schema', 'migration', 'cdp', 'official_origin', 'auth', 'runtime_bridge', 'mcp_contract'];
  const diagnostics = { schema: 'gpt-connector.factory-diagnostics.v1', package_version: '0.2.0', overall: 'not_ready', diagnostic_schema: 'gpt-connector.diagnostics.v1', state: { schema: 'x', migration: 'none' }, job: { schema: 'x', migration: 'none' }, checks: ids.map((id) => ({ id, status: id === 'cdp' ? 'not_ready' : 'ready', reason: 'cdp_unavailable' })) };
  const observedAt = '2026-07-13T00:00:00.000Z';
  const projected = projectGptConnectorFactory(diagnostics, null, false, observedAt);
  assert.equal(projected.installed_version, '0.2.0');
  assert.equal(projected.checks.find((item) => item.status === 'fail').last_seen, observedAt);
  assert.throws(() => projectGptConnectorFactory({ ...diagnostics, prompt: 'secret' }, null));
  assert.throws(() => projectGptConnectorFactory(diagnostics, { schema: 'gpt-connector.runtime-errors.v1', product: 'gpt-connector', path: '/private' }));
});

function caveatDiagnostic(syncStatus = 'ready', overallStatus = syncStatus) {
  const status = (value) => ({ status: value, reason_code: value === 'ready' ? 'ready' : 'sync_failed' });
  return { schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '1.2.3', overall: { status: overallStatus }, database: { status: 'ready', reason_code: 'ready', schema_version: 3, supported_schema_version: 3, migration_status: 'current' }, sync: status(syncStatus), connectors: { claude: { status: 'ready', mcp: status('ready'), hooks: { user_prompt_submit: status('ready'), post_tool_use: status('ready'), post_tool_use_failure: status('ready'), stop: status('ready') } }, codex: { status: 'ready', hooks: { user_prompt_submit: status('ready'), post_tool_use: status('ready'), stop: status('ready') } } } };
}
function nativeFixtures() {
  const status = (value = 'ready') => ({ status: value, reason: value === 'ready' ? 'ready' : 'diagnostic_unverified' });
  return {
    throughline: { schema: 'throughline.native_factory_diagnostics.v1', version: '1.2.3', overall: { status: 'ready' }, databaseSchema: { schema: 'throughline.database.v8', status: 'ready', databaseSchemaVersion: 8, supportedDatabaseSchemaVersion: 8, reason: 'ready' }, hooks: { scope: 'codex', status: 'ready', reason: 'ready', events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' } }, readiness: { capture: status(), restore: status(), handoff: status() }, evidence: { restoreSmoke: status('unverified') }, connectors: { claude: status(), codex: status() } },
    spotter: { schema_version: '1.0', product: 'spotter', version: '1.2.3', overall_status: 'pass', marker_schema_version: '2', throughline_context: 'disabled', catalogs: { claude: 'available', codex: 'available' }, codex_hook_readiness: 'not-installed', runtime_error_store: { schema: 'spotter.runtime_error_status.v1', collection: 'disabled', store: 'not_accessed', records: 0, open: 0, resolved: 0, unacknowledged: 0, latest_sequence: 0, acknowledged_through: 0 }, checks: [{ check_id: 'project_activation', status: 'pass' }, { check_id: 'marker_schema', status: 'pass' }, { check_id: 'throughline_context', status: 'skipped', reason_code: 'context_disabled' }, { check_id: 'claude_catalog', status: 'pass' }, { check_id: 'codex_catalog', status: 'pass' }, { check_id: 'audit_catalog_readiness', status: 'pass' }, { check_id: 'codex_hooks', status: 'skipped', reason_code: 'not_installed' }] },
    aiterm: { diagnostic_schema: 'aiterm-mcp.factory-diagnostics.v1', version: '1.2.3', overall: 'ready', mcp: { transport: 'stdio', initialize: 'ready', tool_call: 'ready' }, pty_list: { access: 'read_only', status: 'ready', session_count: 0 }, runtime_error_store: { status: 'not_applicable', collection: 'disabled', record_count: 0, unacknowledged_count: 0 }, vendor_dependencies: { codex: { status: 'not_applicable', optional: true, required_for: ['codex_agent'] }, grok: { status: 'not_applicable', optional: true, required_for: ['grok_agent', 'composer_agent'] } } },
    sidecar: { status: 'ok', factoryReadiness: { schemaVersion: '1', overall: 'ready', packageVersions: { status: 'ready', packages: { cli: '1.2.3', core: '1.2.3', mcp: '1.2.3' } }, resultSchema: { status: 'ready' }, workflows: { status: 'ready', entries: { review: { status: 'ready' }, explore: { status: 'ready' }, work: { status: 'not_applicable' }, opinion: { status: 'ready' }, 'risk-check': { status: 'ready' }, auditor: { status: 'ready' }, generate: { status: 'ready' } } }, presets: { status: 'ready', configured: 1, ready: 1, notReady: 0, notApplicable: 0 }, modelPolicy: { status: 'ready', source: 'explicit', modelConfigured: true, modelReasoningEffortConfigured: true }, readOnlyDryRun: { status: 'ready', workflow: 'auditor' }, runtimeErrorStore: { status: 'not_applicable', schemaVersion: '2', collection: 'disabled', store: 'absent', pending: 0 } } },
  };
}

test('native v1の状態別shape・exit code・unknown fieldをfail closedで扱う', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-native-negative-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  for (const name of ['caveat', 'spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'claude', 'codex', 'npm', 'grok']) await script(name, 'exit 1');
  const fixtures = nativeFixtures(); const unverifiedAiterm = structuredClone(fixtures.aiterm); unverifiedAiterm.overall = 'unverified'; unverifiedAiterm.pty_list = { ...unverifiedAiterm.pty_list, status: 'unverified', session_count: null };
  await script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(unverifiedAiterm) }] } })}'`);
  await script('throughline', `echo '${JSON.stringify(fixtures.throughline)}'; exit 1`);
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.equal(report.products.throughline.checks[0].reason_code, 'native_exit_mismatch');
  assert.equal(report.products['aiterm-mcp'].compatibility_status, 'unverified');
  assert.doesNotThrow(() => validateReportV2(report));

  const malformedAiterm = structuredClone(fixtures.aiterm);
  malformedAiterm.overall = 'unverified';
  malformedAiterm.runtime_error_store = {
    status: 'unverified', collection: 'malformed', record_count: null, unacknowledged_count: null,
  };
  await script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(malformedAiterm) }] } })}'`);
  const malformedReport = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.equal(malformedReport.products['aiterm-mcp'].compatibility_status, 'unverified');
  assert.deepEqual(malformedReport.products['aiterm-mcp'].checks.find((item) => item.check_id === 'runtime_error_store'), {
    check_id: 'runtime_error_store', status: 'unverified', reason_code: 'diagnostic_unverified',
  });
  assert.doesNotThrow(() => validateReportV2(malformedReport));
});

test('native diagnosticsの製品別不変条件と非0 exitを個別に拒否する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-native-invariants-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  for (const name of ['caveat', 'gpt-connector', 'codegraph', 'markitdown', 'claude', 'codex', 'npm', 'grok']) await script(name, 'exit 1');
  const fixtures = nativeFixtures();
  const setJson = async (name, payload, exitCode = 0) => script(name, `echo '${JSON.stringify(payload)}'; exit ${exitCode}`);
  const setAiterm = async (payload, exitCode = 0) => script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}'; exit ${exitCode}`);
  const scan = () => scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: join(root, 'missing-toolchain-ledger.json') });
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  await setJson('spotter', fixtures.spotter); await setJson('codex-sidecar', fixtures.sidecar); await setAiterm(fixtures.aiterm);
  for (const mutate of [
    (value) => { value.databaseSchema.databaseSchemaVersion = 7; },
    (value) => { value.hooks.events.stop = 'unverified'; },
    (value) => { value.readiness.capture.reason = 'not_ready'; },
  ]) { const value = structuredClone(fixtures.throughline); mutate(value); await setJson('throughline', value); const report = await scan(); assert.equal(report.products.throughline.checks[0].reason_code, 'native_diagnostics_schema'); }
  await setJson('throughline', fixtures.throughline);
  const emptySpotter = structuredClone(fixtures.spotter); emptySpotter.checks = []; await setJson('spotter', emptySpotter); let report = await scan(); assert.equal(report.products.spotter.checks[0].reason_code, 'native_diagnostics_schema');
  await setJson('spotter', fixtures.spotter);
  const versionsDrift = structuredClone(fixtures.sidecar); versionsDrift.factoryReadiness.packageVersions.packages.mcp = '1.2.4'; await setJson('codex-sidecar', versionsDrift); report = await scan(); assert.equal(report.products['codex-sidecar'].checks[0].reason_code, 'native_diagnostics_schema');
  const presetDrift = structuredClone(fixtures.sidecar); presetDrift.factoryReadiness.presets.notReady = 1; await setJson('codex-sidecar', presetDrift); report = await scan(); assert.equal(report.products['codex-sidecar'].checks[0].reason_code, 'native_diagnostics_schema');
  const reviewMisroute = structuredClone(fixtures.sidecar); reviewMisroute.factoryReadiness.readOnlyDryRun.workflow = 'review'; await setJson('codex-sidecar', reviewMisroute); report = await scan(); assert.equal(report.products['codex-sidecar'].checks[0].reason_code, 'native_diagnostics_schema');
  const inheritedModel = structuredClone(fixtures.sidecar); inheritedModel.factoryReadiness.modelPolicy.source = 'inherited'; await setJson('codex-sidecar', inheritedModel); report = await scan(); assert.equal(report.products['codex-sidecar'].checks[0].reason_code, 'native_diagnostics_schema');
  await setJson('codex-sidecar', fixtures.sidecar); await setJson('spotter', fixtures.spotter, 1); report = await scan(); assert.equal(report.products.spotter.checks[0].reason_code, 'native_exit_mismatch');
  await setJson('spotter', fixtures.spotter); await setAiterm(fixtures.aiterm, 1); report = await scan(); assert.equal(report.products['aiterm-mcp'].checks[0].reason_code, 'native_exit_mismatch');
});

test('Caveat・Throughline・aitermの観測済みadapter契約だけを受理する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-adapter-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  const setJson = async (name, payload, exitCode = 0) => script(name, `echo '${JSON.stringify(payload)}'; exit ${exitCode}`);
  const setAiterm = async (payload) => script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}'`);
  for (const name of ['spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'claude', 'codex', 'npm', 'grok']) await script(name, 'exit 1');
  const fixtures = nativeFixtures();
  const scan = () => scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });

  await setJson('caveat', caveatDiagnostic('not_ready'), 1); await setJson('throughline', fixtures.throughline); await setAiterm(fixtures.aiterm);
  let report = await scan();
  assert.equal(report.products.caveat.compatibility_status, 'incompatible');
  assert.equal(report.products.caveat.checks[0].reason_code, 'native_not_ready');

  await setJson('caveat', caveatDiagnostic(), 1); report = await scan();
  assert.equal(report.products.caveat.checks[0].reason_code, 'native_exit_mismatch');

  const throughlineV9 = structuredClone(fixtures.throughline); throughlineV9.databaseSchema.databaseSchemaVersion = 9; throughlineV9.databaseSchema.supportedDatabaseSchemaVersion = 9;
  await setJson('throughline', throughlineV9); report = await scan();
  assert.equal(report.products.throughline.compatibility_status, 'compatible');
  const throughlineV9Canonical = structuredClone(throughlineV9); throughlineV9Canonical.databaseSchema.schema = 'throughline.database.v9';
  await setJson('throughline', throughlineV9Canonical); report = await scan();
  assert.equal(report.products.throughline.compatibility_status, 'compatible');
  const throughlineV9Fresh = structuredClone(throughlineV9Canonical);
  throughlineV9Fresh.overall.status = 'unverified';
  Object.assign(throughlineV9Fresh.databaseSchema, { status: 'not_applicable', databaseSchemaVersion: null, reason: 'not_applicable' });
  throughlineV9Fresh.readiness.restore = { status: 'not_applicable', reason: 'not_applicable' };
  throughlineV9Fresh.readiness.handoff = { status: 'unverified', reason: 'diagnostic_unverified' };
  await setJson('throughline', throughlineV9Fresh); report = await scan();
  assert.equal(report.products.throughline.presence_status, 'installed');
  assert.equal(report.products.throughline.checks.find((item) => item.check_id === 'database_schema').status, 'skipped');
  assert.equal(report.products.throughline.checks.find((item) => item.check_id === 'handoff').status, 'unverified');
  const throughlineV10 = structuredClone(throughlineV9); throughlineV10.databaseSchema.databaseSchemaVersion = 10; throughlineV10.databaseSchema.supportedDatabaseSchemaVersion = 10;
  await setJson('throughline', throughlineV10); report = await scan();
  assert.equal(report.products.throughline.checks[0].reason_code, 'native_diagnostics_schema');

  const aitermThreeVendors = structuredClone(fixtures.aiterm); aitermThreeVendors.vendor_dependencies.claude = { status: 'not_applicable', optional: true, required_for: ['claude_agent'] };
  await setAiterm(aitermThreeVendors); report = await scan();
  assert.equal(report.products['aiterm-mcp'].compatibility_status, 'compatible');
  const aitermUnknownVendor = structuredClone(aitermThreeVendors); aitermUnknownVendor.vendor_dependencies.unknown = { status: 'not_applicable', optional: true, required_for: [] };
  await setAiterm(aitermUnknownVendor); report = await scan();
  assert.equal(report.products['aiterm-mcp'].checks[0].reason_code, 'native_diagnostics_schema');
});

test('v2 scannerは公開CLIとnative diagnosticsだけで固定12製品をfull snapshotへ投影する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME; process.env.HOME = root; t.after(() => { process.env.HOME = previousHome; });
  await mkdir(join(root, '.claude'), { recursive: true }); await mkdir(join(root, '.codex'), { recursive: true });
  const claudeHook = (command, timeout) => ({ type: 'command', command, timeout });
  const claudeHooks = { hooks: { PreToolUse: [{ matcher: 'Agent|Task|Workflow|mcp__codex-sidecar__codex_.*|mcp__aiterm__(codex|grok|composer)_agent', hooks: [claudeHook('~/.local/bin/delegation-gate-hook', 5)] }], SessionStart: [{ hooks: [claudeHook('~/.local/bin/todo-gate-hook session-start', 10)] }], Stop: [{ hooks: [claudeHook('~/.local/bin/todo-gate-hook stop', 10)] }], UserPromptSubmit: [{ hooks: [claudeHook('~/.local/bin/onset-gate-hook', 5)] }], PostToolUse: [{ matcher: 'ExitPlanMode', hooks: [claudeHook('~/.local/bin/plan-gate-hook', 5)] }] } }; await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(claudeHooks));
  await writeFile(join(root, '.codex', 'config.toml'), '[features]\nhooks = true\n[features.multi_agent_v2]\nhide_spawn_agent_metadata = false\ntool_namespace = "agents"\n');
  const codexCommand = (subcommand) => process.platform === 'win32'
    ? `& "C:\\Python\\python.exe" "${join(root, '.local', 'bin', 'codex-callout-hook')}" "${subcommand}"`
    : `/usr/bin/env python3 ${join(root, '.local', 'bin', 'codex-callout-hook')} ${subcommand}`;
  const codexHook = (subcommand, timeout) => ({ type: 'command', command: codexCommand(subcommand), timeout, async: false, statusMessage: null }); const codexHooks = { hooks: { SessionStart: [{ hooks: [codexHook('session-start', 10)] }], PreToolUse: [{ hooks: [codexHook('pre-tool-use', 5)] }], UserPromptSubmit: [{ hooks: [codexHook('user-prompt-submit', 5)] }], Stop: [{ hooks: [codexHook('stop', 10)] }] } }; await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify(codexHooks));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  await script('caveat', `echo '${JSON.stringify(caveatDiagnostic())}'`);
  const fixtures = nativeFixtures();
  await script('throughline', `echo '${JSON.stringify(fixtures.throughline)}'`);
  await script('spotter', `echo '${JSON.stringify(fixtures.spotter)}'`);
  await script('codex-sidecar', `if [ "$1" != factory-diagnostics ] || [ "$2" != --project ] || [ "$4" != --preset ] || [ "$5" != auditor ]; then exit 64; fi; echo '${JSON.stringify(fixtures.sidecar)}'`);
  await script('gpt-connector', `if [ "$1" = factory-diagnostics ]; then echo '{"schema":"gpt-connector.factory-diagnostics.v1","package_version":"0.2.0","overall":"ready","diagnostic_schema":"gpt-connector.diagnostics.v1","state":{"schema":"1","migration":"current"},"job":{"schema":"1","migration":"current"},"checks":[{"id":"version","status":"ready","reason":"ready"},{"id":"state_schema","status":"ready","reason":"ready"},{"id":"job_schema","status":"ready","reason":"ready"},{"id":"migration","status":"ready","reason":"ready"},{"id":"cdp","status":"ready","reason":"ready"},{"id":"official_origin","status":"ready","reason":"ready"},{"id":"auth","status":"ready","reason":"ready"},{"id":"runtime_bridge","status":"ready","reason":"ready"},{"id":"mcp_contract","status":"ready","reason":"ready"}]}' ; elif [ "$1" = runtime-errors ]; then stamp=$(node -e 'process.stdout.write(new Date().toISOString())'); echo '{"schema":"gpt-connector.runtime-errors.v1","product":"gpt-connector","version":"0.2.0","state_schema_version":"1.0","cursor":{"high_watermark":1,"acknowledged_through":0,"next":1},"runtime_errors":[{"error_code":"CHAT_FAILED","component":"chat","status":"open","severity":"high","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","message_template":"GPT Connector chat failed","occurrence_count":1,"first_seen":"'"$stamp"'","last_seen":"'"$stamp"'","state_schema_version":"1.0"}],"resolutions":[],"diagnostics":{"collection":"enabled","status":"ready","total_count":1,"pending_count":1,"truncated":false}}'; fi`);
  await script('codegraph', `if [ "$1" = --version ]; then echo 'codegraph 1.4.0'; else echo '{"initialized":true}'; fi`);
  await script('markitdown', `if [ "$1" = --version ]; then echo 'markitdown 0.1.0'; else echo converted; fi`);
  await script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(fixtures.aiterm) }] } })}'`);
  await script('claude', "echo '2.1.0'"); await script('codex', "echo '0.144.3'");
  await script('npm', `if [ "$2" = @anthropic-ai/claude-code ]; then echo '"2.1.0"'; else echo '"0.144.3"'; fi`);
  await script('grok', "echo '{\"currentVersion\":\"0.2.99\",\"latestVersion\":\"0.2.99\",\"updateAvailable\":false,\"installer\":\"internal\",\"channel\":\"stable\",\"autoUpdate\":null,\"error\":null}'");
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  await assertRevisionCommand();
  const ledgerPath = join(root, 'toolchain-ledger.json'); const record = (version) => ({ before_version: version, latest_version: version, operation_status: 'skipped', after_version: version, post_gate_status: 'success', reason_code: 'already_current', observed_at: '2026-07-13T14:00:00.000Z' });
  await writeFile(ledgerPath, JSON.stringify({ schema_version: 'dotagents.toolchain-update.v1', products: { 'claude-code': record('2.1.0'), 'codex-cli': record('0.144.3'), 'grok-build': record('0.2.99') } }), { mode: 0o600 });
  const { report, acknowledgements } = await scanV2WithAcknowledgements({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, collectionEnabled: true, toolchainLedgerPath: ledgerPath });
  assert.doesNotThrow(() => validateReportV2(report));
  assert.deepEqual(Object.keys(report.products), V2_PRODUCT_IDS);
  assert.equal(report.products['claude-code'].installed_version, '2.1.0'); assert.equal(report.products['claude-code'].latest_version, '2.1.0');
  assert.equal(report.products['codex-cli'].installed_version, '0.144.3'); assert.equal(report.products['codex-cli'].latest_version, '0.144.3');
  assert.equal(report.products['grok-build'].checks[0].check_id, 'stable_update'); assert.equal(report.products['grok-build'].update_status, 'current');
  assert.equal(report.products['gpt-connector'].compatibility_status, 'compatible'); assert.equal(report.products.servermanager.presence_status, 'not_applicable');
  assert.equal(report.products.codegraph.presence_status, 'not_applicable');
  assert.deepEqual(report.products.codegraph.checks, []);
  assert.equal(report.products.caveat.compatibility_status, 'compatible');
  assert.deepEqual(report.products.throughline.checks.map((item) => item.check_id), ['database_schema', 'codex_hooks', 'capture', 'restore', 'handoff', 'evidence_restore_smoke', 'claude_connector']);
  assert.deepEqual(report.products.spotter.checks.map((item) => item.check_id), ['project_activation', 'marker_schema', 'throughline_context', 'claude_catalog', 'codex_catalog', 'audit_catalog_readiness', 'codex_hooks']);
  assert.deepEqual(report.products['aiterm-mcp'].checks.map((item) => item.check_id), ['mcp', 'pty_list', 'runtime_error_store']);
  assert.equal(report.products['codex-sidecar'].installed_version, '1.2.3');
  assert.equal(report.products['claude-code'].compatibility_status, 'compatible'); assert.equal(report.products['codex-cli'].compatibility_status, 'compatible');
  assert.equal(report.products['claude-code'].checks.at(-1).status, 'pass');
  assert.deepEqual(acknowledgements, { schema_version: '2.0', report_id: report.report_id, acknowledgements: [{ product: 'gpt-connector', cursor: 1, command: 'gpt-connector', args: ['runtime-errors', 'ack', '1', '--json'] }] });
  const malformedClaude = structuredClone(claudeHooks); malformedClaude.hooks.PreToolUse[0] = { matcher: 'never-match', hooks: [{ type: 'shell', command: 'prefix delegation-gate-hook suffix' }] }; await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(malformedClaude));
  const malformedCodex = structuredClone(codexHooks); malformedCodex.hooks.PreToolUse[0].matcher = 'never-match'; await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify(malformedCodex));
  const malformed = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: ledgerPath });
  assert.equal(malformed.products['claude-code'].compatibility_status, 'incompatible'); assert.equal(malformed.products['codex-cli'].compatibility_status, 'incompatible');
  await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(claudeHooks));
  const directCodex = structuredClone(codexHooks); directCodex.hooks.PreToolUse[0].hooks[0].command = `${join(root, '.local', 'bin', 'codex-callout-hook')} pre-tool-use`; await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify(directCodex));
  const direct = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: ledgerPath });
  assert.equal(direct.products['codex-cli'].compatibility_status, 'incompatible');
  const duplicateCodex = structuredClone(codexHooks); duplicateCodex.hooks.PreToolUse.push({ matcher: 'never-match', hooks: [codexHook('pre-tool-use', 5)] }); await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify(duplicateCodex));
  await writeFile(join(root, '.codex', 'config.toml'), 'hooks = true\n[features]\nhooks = false\n[foo]\nhooks = true\n[features.multi_agent_v2]\nhide_spawn_agent_metadata = false\ntool_namespace = "agents"\n');
  const misplaced = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: ledgerPath });
  assert.equal(misplaced.products['claude-code'].compatibility_status, 'compatible'); assert.equal(misplaced.products['codex-cli'].compatibility_status, 'incompatible');
  await rm(join(root, '.claude', 'settings.json')); await writeFile(join(root, '.codex', 'config.toml'), 'hooks = true\n');
  const drift = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: ledgerPath });
  assert.equal(drift.products['claude-code'].compatibility_status, 'incompatible'); assert.equal(drift.products['codex-cli'].compatibility_status, 'incompatible');
  assert.ok(drift.products['claude-code'].checks.some((item) => item.check_id === 'required_hooks' && item.status === 'fail')); assert.ok(drift.products['codex-cli'].checks.some((item) => item.check_id === 'native_routing' && item.status === 'fail'));
});

test('Caveat native diagnosticsのnested不整合をcompatibleへ偽装しない', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-caveat-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  await writeCommandFixture(bin, 'caveat', `echo '${JSON.stringify(caveatDiagnostic('not_ready', 'ready'))}'`);
  for (const name of ['throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'aiterm-mcp', 'claude', 'codex', 'npm', 'grok']) await writeCommandFixture(bin, name, 'exit 1');
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.deepEqual(report.products.caveat.checks, [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_diagnostics_schema' }]);
  assert.notEqual(report.products.caveat.compatibility_status, 'compatible');
});

test('Grokのalphaや文字列推測、CLI registry失敗をpassへ丸めない', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-grok-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  for (const command of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'aiterm-mcp', 'claude', 'codex']) await script(command, 'exit 1');
  await script('npm', 'exit 1'); await script('grok', "echo '{\"currentVersion\":\"0.2.0\",\"latestVersion\":\"0.2.1\",\"updateAvailable\":true,\"installer\":\"native\",\"channel\":\"alpha\",\"autoUpdate\":true,\"error\":null}'");
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, toolchainLedgerPath: join(root, 'missing-toolchain-ledger.json') });
  assert.doesNotThrow(() => validateReportV2(report));
  assert.deepEqual(report.products['grok-build'].checks[0], { check_id: 'stable_update', status: 'unverified', reason_code: 'grok_update_schema' });
  assert.deepEqual(report.products['grok-build'].checks[1], { check_id: 'last_update', status: 'unverified', reason_code: 'toolchain_ledger_unavailable' });
  assert.equal(report.products['claude-code'].checks[1].status, 'unverified');
});

test('Grokの旧snake_case JSONはstableでも契約違反として拒否する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-grok-snake-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  await writeCommandFixture(bin, 'grok', "echo '{\"channel\":\"stable\",\"current_version\":\"0.2.0\",\"latest_version\":\"0.2.0\",\"update_available\":false}'");
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.equal(report.products['grok-build'].checks[0].status, 'unverified');
});

test('optionalなGrok未導入は現行profileの非対象として報告する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-grok-optional-missing-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  await writeCommandFixture(bin, 'git', 'echo 0123456789abcdef0123456789abcdef01234567');
  const previous = process.env.PATH; process.env.PATH = bin; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: 'server' }, cwd: root, arch: 'x64', platform: 'linux', toolchainLedgerPath: join(root, 'missing-toolchain-ledger.json') });
  const product = report.products['grok-build'];
  assert.doesNotThrow(() => validateReportV2(report));
  assert.equal(product.presence_status, 'not_applicable');
  assert.equal(product.compatibility_status, undefined);
  assert.deepEqual(product.checks, [{ check_id: 'stable_update', status: 'skipped', reason_code: 'not_applicable' }]);
});

test('toolchain scannerはregistry schema drift・downgrade・Grok flag不整合をfail closedにする', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-toolchain-contract-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  for (const command of ['caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'codegraph', 'markitdown', 'aiterm-mcp']) await script(command, 'exit 1');
  await script('claude', "echo '2.2.0'"); await script('codex', "echo '0.144.3'");
  await script('npm', `if [ "$2" = @anthropic-ai/claude-code ]; then echo '"2.1.0"'; else echo '{"version":"0.144.3"}'; fi`);
  await script('grok', "echo '{\"currentVersion\":\"0.2.2\",\"latestVersion\":\"0.2.1\",\"updateAvailable\":false,\"installer\":\"internal\",\"channel\":\"stable\",\"autoUpdate\":null,\"error\":null}'");
  const previousPath = process.env.PATH; const previousHome = process.env.HOME; process.env.PATH = `${bin}${delimiter}${previousPath}`; process.env.HOME = root; t.after(() => { process.env.PATH = previousPath; process.env.HOME = previousHome; });
  await assertRevisionCommand();
  const first = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.equal(first.products['claude-code'].latest_version, '2.1.0');
  assert.equal(first.products['claude-code'].update_status, 'unverified');
  assert.deepEqual(first.products['claude-code'].checks[1], { check_id: 'npm_latest', status: 'unverified', reason_code: 'downgrade_refused' });
  assert.equal(first.products['codex-cli'].latest_version, undefined);
  assert.deepEqual(first.products['codex-cli'].checks[1], { check_id: 'npm_latest', status: 'unverified', reason_code: 'registry_unverified' });
  assert.deepEqual(first.products['grok-build'].checks[0], { check_id: 'stable_update', status: 'unverified', reason_code: 'downgrade_refused' });

  await script('grok', "echo '{\"currentVersion\":\"0.2.0\",\"latestVersion\":\"0.2.1\",\"updateAvailable\":false,\"installer\":\"internal\",\"channel\":\"stable\",\"autoUpdate\":null,\"error\":null}'");
  const second = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform });
  assert.deepEqual(second.products['grok-build'].checks[0], { check_id: 'stable_update', status: 'unverified', reason_code: 'grok_update_inconsistent' });
});

test('collection有効時のgpt runtime snapshot失敗をdisabledへ丸めない', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v2-gpt-runtime-')); const bin = join(root, 'bin'); await mkdir(bin); t.after(() => rm(root, { recursive: true, force: true }));
  const ids = ['version', 'state_schema', 'job_schema', 'migration', 'cdp', 'official_origin', 'auth', 'runtime_bridge', 'mcp_contract'];
  const diagnostic = { schema: 'gpt-connector.factory-diagnostics.v1', package_version: '0.2.0', overall: 'ready', diagnostic_schema: 'gpt-connector.diagnostics.v1', state: { schema: '1.0', migration: 'current' }, job: { schema: '1.0', migration: 'current' }, checks: ids.map((id) => ({ id, status: 'ready', reason: 'ready' })) };
  await writeCommandFixture(bin, 'gpt-connector', `if [ "$1" = factory-diagnostics ]; then echo '${JSON.stringify(diagnostic)}'; else exit 1; fi`);
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  const report = await scanV2({ host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'wsl' }, cwd: root, arch: 'x64', platform: process.platform, collectionEnabled: true });
  assert.ok(report.products['gpt-connector'].checks.some((item) => item.check_id === 'runtime_errors' && item.status === 'unverified' && item.reason_code === 'runtime_snapshot_unavailable'));
});

test('v2 ack bundleはgpt-connectorとservermanagerの2 entryまでを受理し、重複・未知productを拒否する', async () => {
  const { validateAcknowledgementBundleV2, acknowledgeRuntimeErrorsV2 } = await import('../../lib/factory/runtime-errors.mjs');
  const gpt = { product: 'gpt-connector', cursor: 1, command: 'gpt-connector', args: ['runtime-errors', 'ack', '1', '--json'] };
  const sm = { product: 'servermanager', cursor: 2, command: 'factory-external-event', args: ['ack', '--cursor', '2', '--json'] };
  const bundle = (acknowledgements) => ({ schema_version: '2.0', report_id: 'r', acknowledgements });
  assert.equal(validateAcknowledgementBundleV2(bundle([gpt, sm]), 'r').acknowledgements.length, 2);
  assert.equal(validateAcknowledgementBundleV2(bundle([sm]), 'r').acknowledgements.length, 1);
  assert.throws(() => validateAcknowledgementBundleV2(bundle([sm, sm]), 'r'), /ack_bundle_v2/);
  assert.throws(() => validateAcknowledgementBundleV2(bundle([{ ...sm, product: 'caveat', command: 'caveat' }]), 'r'), /ack_command_v2/);
  assert.throws(() => validateAcknowledgementBundleV2(bundle([{ ...sm, command: 'rm' }]), 'r'), /ack_command_v2/);
  const calls = [];
  const runner = async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: command === 'factory-external-event' ? '{"ok":true,"acknowledged_through":2}' : '{"status":"acknowledged","acknowledgedThrough":1}' }; };
  await acknowledgeRuntimeErrorsV2(bundle([gpt, sm]), { runner });
  assert.deepEqual(calls, [['gpt-connector', 'runtime-errors', 'ack', '1', '--json'], ['factory-external-event', 'ack', '--cursor', '2', '--json']]);
  const short = async () => ({ ok: true, stdout: '{"ok":true,"acknowledged_through":1}' });
  await assert.rejects(acknowledgeRuntimeErrorsV2(bundle([sm]), { runner: short }), /ack_response_v2/);
});
