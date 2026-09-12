import assert from 'node:assert/strict';
import test from 'node:test';
import { aishellProduct } from '../../lib/factory/scan.mjs';

const valid = (overrides = {}) => ({
  schemaVersion: 'aishell.native_factory_diagnostics.v1',
  product: { identifier: 'aishell', version: '0.2.1' },
  platform: { operatingSystem: 'macos', architecture: 'arm64', minimumOperatingSystem: '15.0', supported: true },
  runtime: {
    schemaVersion: 'aishell.runtime_configuration.v2', configurationState: 'valid',
    migrationStatus: 'compatible_on_read', operationReadiness: 'ready', isPaused: false,
    configuredRootCount: 3, automaticGitWorktreeCount: 2, effectiveRootCount: 5,
  },
  mcp: { transport: 'stdio', protocolVersion: '2025-11-25', ready: true },
  manager: { applicationBundleState: 'available', ready: true },
  privacy: {
    exposesAllowedRootPaths: false, exposesOperationHistory: false,
    exposesFileContents: false, exposesProcessArguments: false,
  },
  ready: true,
  issues: [],
  ...overrides,
});

const runnerFor = (diagnostic, ok = true) => async (command, args, options) => {
  assert.equal(command, 'aishell-mcp');
  assert.deepEqual(args, []);
  assert.match(options.input, /factory_diagnostics/);
  // factory_diagnosticsは専用profileでだけ公開される。既定catalogで起動すると未定義toolになる。
  assert.equal(options.env?.AISHELL_TOOL_PROFILE, 'factory');
  return {
    ok, stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: diagnostic } })}\n`,
  };
};

test('AIShell native diagnosticsをpath非露出の製品状態へ射影する', async () => {
  const product = await aishellProduct({ runner: runnerFor(valid()) }, '2026-07-19T00:00:00.000Z');
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '0.2.1');
  assert.equal(product.state_schema_version, 'aishell.runtime_configuration.v2');
  assert.equal(product.migration_status, 'current');
  assert.equal(product.compatibility_status, 'compatible');
  assert.deepEqual(product.checks, [{ check_id: 'native_diagnostics', status: 'pass' }]);
});

test('非対応hostはprocessを起動せずnot_applicableにする', async () => {
  let called = false;
  const product = await aishellProduct({ profile: 'server', runner: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(product.presence_status, 'not_applicable');
  assert.equal(product.compatibility_status, 'unsupported');
  assert.deepEqual(product.checks, [{
    check_id: 'native_diagnostics', status: 'unsupported', reason_code: 'platform_unsupported',
  }]);
});

test('not readyは固定fingerprintのfailureへ射影する', async () => {
  const diagnostic = valid({
    runtime: { ...valid().runtime, configurationState: 'invalid', migrationStatus: 'blocked', operationReadiness: 'invalid_configuration', isPaused: null, configuredRootCount: null, automaticGitWorktreeCount: null, effectiveRootCount: null },
    ready: false, issues: ['runtime.invalid_configuration'],
  });
  const product = await aishellProduct({ runner: runnerFor(diagnostic) }, '2026-07-19T00:00:00.000Z');
  assert.equal(product.compatibility_status, 'incompatible');
  assert.equal(product.checks[0].status, 'fail');
  assert.match(product.checks[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('未使用のschema・privacy・issuesを検査せず転送もしない', async () => {
  for (const diagnostic of [
    valid({ schemaVersion: 'aishell.native_factory_diagnostics.v2' }),
    valid({ privacy: { ...valid().privacy, exposesAllowedRootPaths: true } }),
    valid({ issues: ['/Users/kite/secret'], ready: false }),
  ]) {
    const product = await aishellProduct({ runner: runnerFor(diagnostic) });
    assert.equal(product.compatibility_status, diagnostic.ready ? 'compatible' : 'incompatible');
    assert.ok(!JSON.stringify(product).includes('/Users/kite/secret'));
  }
  const invalid = await aishellProduct({ runner: runnerFor(valid({ product: { version: 'dev' } })) });
  assert.equal(invalid.checks[0].reason_code, 'native_schema_invalid');
});

test('CLI不在はmissing、transport失敗はunverifiedを維持する', async () => {
  const missing = await aishellProduct({ runner: async () => ({
    ok: false, reason: 'spawn', error: { code: 'ENOENT' }, stdout: '',
  }) });
  assert.equal(missing.presence_status, 'missing');
  const failed = await aishellProduct({ runner: runnerFor(valid(), false) });
  assert.equal(failed.presence_status, 'unverified');
  assert.equal(failed.checks[0].reason_code, 'native_schema_invalid');
});

test('AIShellの内部世代を限定せず、総合readyの失敗を保持する', async () => {
  const diagnostic = valid({
    product: { identifier: 'aishell', version: '0.7.3' },
    runtime: {
      schemaVersion: 'aishell.runtime_configuration.v3', configurationState: 'not_required',
      migrationStatus: 'not_required', operationReadiness: 'ready', isPaused: false,
      configuredRootCount: 0, automaticGitWorktreeCount: 0, effectiveRootCount: 0,
    },
    manager: { applicationBundleState: 'not_required', ready: true },
  });
  const product = await aishellProduct({ runner: runnerFor(diagnostic) });
  assert.equal(product.presence_status, 'installed');
  assert.equal(product.installed_version, '0.7.3');
  assert.equal(product.state_schema_version, 'aishell.runtime_configuration.v3');
  assert.equal(product.migration_status, 'not_applicable');
  assert.equal(product.compatibility_status, 'compatible');
  assert.deepEqual(product.checks, [{ check_id: 'native_diagnostics', status: 'pass' }]);

  for (const failed of [
    { ...diagnostic, ready: false, mcp: { ...diagnostic.mcp, ready: false } },
    { ...diagnostic, ready: false, platform: { ...diagnostic.platform, supported: false }, issues: ['platform.unsupported'] },
  ]) {
    const result = await aishellProduct({ runner: runnerFor(failed) });
    assert.equal(result.compatibility_status, 'incompatible');
    assert.equal(result.checks[0].status, 'fail');
  }
  for (const schemaVersion of ['aishell.runtime_configuration.v2', 'aishell.runtime_configuration.v4', 'aishell.runtime_configuration.v99']) {
    const result = await aishellProduct({ runner: runnerFor({
      ...diagnostic, runtime: { ...diagnostic.runtime, schemaVersion, configurationState: 'future_state' },
      manager: { applicationBundleState: 'future_manager' },
    }) });
    assert.equal(result.compatibility_status, 'compatible');
    assert.equal(result.state_schema_version, schemaVersion);
  }
});
