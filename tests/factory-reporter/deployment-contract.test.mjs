import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORE_PRODUCT_IDS,
  CURRENT_WIRE_ENDPOINT,
  CURRENT_WIRE_MAJOR,
  CURRENT_WIRE_PRODUCT_IDS,
  CURRENT_WIRE_SCHEMA_VERSION,
  MANAGED_PRODUCT_IDS,
  ROLLBACK_WIRE_MAJOR,
  THIRD_PARTY_PRODUCT_IDS,
  hostProjection,
  postUpdateFailures,
} from '../../lib/factory/deployment-contract.mjs';
import { V8_PRODUCT_IDS } from '../../lib/factory/v8.mjs';

test('deployment contractは管理12製品とv8 wire 15 IDを固定する', () => {
  assert.deepEqual(MANAGED_PRODUCT_IDS, [
    'caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector',
    'aiterm-mcp', 'codex-sidecar', 'aishell', 'servermanager', 'peertable', 'unai',
  ]);
  assert.deepEqual(CORE_PRODUCT_IDS, MANAGED_PRODUCT_IDS.filter((id) => id !== 'markitdown'));
  assert.deepEqual(THIRD_PARTY_PRODUCT_IDS, ['markitdown']);
  assert.equal(CURRENT_WIRE_MAJOR, 8);
  assert.equal(CURRENT_WIRE_SCHEMA_VERSION, '8.0');
  assert.equal(CURRENT_WIRE_ENDPOINT, '/api/factory/v8/reports');
  assert.equal(ROLLBACK_WIRE_MAJOR, 7);
  assert.deepEqual(CURRENT_WIRE_PRODUCT_IDS, V8_PRODUCT_IDS);
  assert.deepEqual(hostProjection({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 }).required, ['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'aishell', 'peertable', 'unai']);
  assert.deepEqual(hostProjection({ profile: 'server', os: 'linux', arch: 'arm64' }).required, ['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager', 'peertable', 'unai']);
  assert.deepEqual(hostProjection({ profile: 'linux', os: 'linux', arch: 'x64' }).required, ['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'peertable', 'unai']);
});

test('host projectionはprofile/OS/arch/macOS majorの未知値と不整合をfail-closedにする', () => {
  assert.throws(() => hostProjection({ profile: 'mac', os: 'linux', arch: 'arm64', macosMajor: 15 }), /不整合/u);
  assert.throws(() => hostProjection({ profile: 'mac', os: 'darwin', arch: 'mips64', macosMajor: 15 }), /arch/u);
  assert.throws(() => hostProjection({ profile: 'mac', os: 'darwin', arch: 'arm64' }), /macOS major/u);
  assert.throws(() => hostProjection({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 14.5 }), /macOS major/u);
  assert.deepEqual(hostProjection({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 14 }).expected.aishell, 'unsupported');
});

test('host別required集合はmatrix全行と完全一致する', () => {
  const required = (facts) => hostProjection(facts).required;
  assert.deepEqual(required({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 }), ['caveat','throughline','spotter','lattice','markitdown','gpt-connector','aiterm-mcp','codex-sidecar','aishell','peertable','unai']);
  assert.deepEqual(required({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 14 }), ['caveat','throughline','spotter','lattice','markitdown','gpt-connector','aiterm-mcp','codex-sidecar','peertable','unai']);
  assert.deepEqual(required({ profile: 'server', os: 'linux', arch: 'arm64' }), ['caveat','throughline','spotter','lattice','markitdown','gpt-connector','aiterm-mcp','codex-sidecar','servermanager','peertable','unai']);
  assert.deepEqual(required({ profile: 'linux', os: 'linux', arch: 'x64' }), ['caveat','throughline','spotter','lattice','markitdown','gpt-connector','aiterm-mcp','codex-sidecar','peertable','unai']);
  assert.throws(() => required({ profile: 'wsl', os: 'linux', arch: 'x64' }), /profile/u);
  assert.deepEqual(required({ profile: 'windows-native', os: 'win32', arch: 'x64' }), ['caveat','throughline','spotter','lattice','markitdown','gpt-connector','aiterm-mcp','codex-sidecar','peertable','unai']);
});

test('post-update gateは対応hostのAIShell・peertable・unai欠落を拒否し、非対応を要求しない', () => {
  const mac = hostProjection({ profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 });
  const products = Object.fromEntries([...mac.required, 'claude-code', 'codex-cli'].map((id) => [id, { presence_status: 'installed', compatibility_status: 'compatible', checks: [] }]));
  const report = { products };
  assert.deepEqual(postUpdateFailures(report, { profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 }), []);
  for (const id of ['aishell', 'peertable', 'unai']) {
    const broken = structuredClone(report); delete broken.products[id];
    assert.deepEqual(postUpdateFailures(broken, { profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 }), [`${id}:presence`]);
    for (const status of ['fail', 'unverified']) { const invalid = structuredClone(report); invalid.products[id].checks = [{ check_id: 'diagnostic', status, reason_code: 'diagnostic_failed' }]; assert.deepEqual(postUpdateFailures(invalid, { profile: 'mac', os: 'darwin', arch: 'arm64', macosMajor: 15 }), [`${id}:diagnostic`]); }
  }
  const windows = { products: Object.fromEntries(['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'peertable', 'unai'].map((id) => [id, { presence_status: 'installed', compatibility_status: 'compatible', checks: [] }])) };
  assert.deepEqual(postUpdateFailures(windows, { profile: 'windows-native', os: 'win32', arch: 'x64' }), []);
});

test('server post-update gateは自己report前のingest staleだけをdelivery後readinessへ委ねる', () => {
  const facts = { profile: 'server', os: 'linux', arch: 'x64' };
  const required = [...hostProjection(facts).required, 'claude-code', 'codex-cli'];
  const report = { products: Object.fromEntries(required.map((id) => [id, {
    presence_status: 'installed', compatibility_status: 'compatible', checks: [],
  }])) };
  report.products.servermanager = {
    presence_status: 'installed', compatibility_status: 'incompatible', checks: [
      { check_id: 'readiness_factory_ingest', status: 'fail', reason_code: 'stale' },
      { check_id: 'readiness_database', status: 'pass', reason_code: 'ready' },
    ],
  };
  assert.deepEqual(postUpdateFailures(report, facts), []);
  assert.deepEqual(postUpdateFailures(report, facts, { postUpdate: false }), [
    'servermanager:compatibility', 'servermanager:readiness_factory_ingest',
  ]);
  report.products.servermanager.checks.push({
    check_id: 'readiness_schema', status: 'fail', reason_code: 'mismatch',
  });
  assert.deepEqual(postUpdateFailures(report, facts), [
    'servermanager:compatibility', 'servermanager:readiness_factory_ingest', 'servermanager:readiness_schema',
  ]);
});
