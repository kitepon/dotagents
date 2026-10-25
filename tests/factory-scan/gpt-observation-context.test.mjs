import assert from 'node:assert/strict';
import test from 'node:test';
import { projectGptConnectorFactory } from '../../lib/factory/v5.mjs';
import { readGptObservationContext, projectSameReportGptObservation, validateGptObservationReportV9 } from '../../lib/factory/gpt-observation-context.mjs';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';
const NOW = '2026-10-25T17:17:00.000Z';
const context = () => ({ gpt_obs_schema: 'v1', gpt_auth_session_http: '401', gpt_auth_session_user: 'uninspected',
  gpt_bridge_present: 'false', gpt_bridge_version: 'uninspected', gpt_bridge_build: 'uninspected', gpt_bridge_summary: 'uninspected' });
const diagnostic = () => ({ package_version: '0.16.4', overall: 'unverified', state: { schema: '1.0', migration: 'current' },
  checks: [{ id: 'auth', status: 'not_ready', reason: 'auth_required' }, { id: 'runtime_bridge', status: 'unverified', reason: 'bridge_not_initialized' }] });
function report(contexts = [context(), context()]) {
  const native = diagnostic(); native.checks.forEach((item, index) => { item.safe_context = contexts[index]; });
  return { schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904', host_id: 'rabbit', host_profile: 'linux',
    platform: { os: 'linux', arch: 'x64' }, report_mode: 'full', observed_at: NOW, created_at: NOW,
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(V9_PRODUCT_IDS.map(id => [id, id === 'gpt-connector'
      ? { presence_status: 'installed', contract_version: '9.0', ...projectGptConnectorFactory(native, false, NOW, { includeObservationContext: true }) }
      : { presence_status: 'unverified', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] }])) };
}

test('optional omission/empty group preserves old projection exactly', () => {
  const native = diagnostic(), old = projectGptConnectorFactory(native, false, NOW);
  native.checks.forEach(item => { item.safe_context = {}; });
  assert.deepEqual(projectGptConnectorFactory(native, false, NOW), old);
  assert.equal(readGptObservationContext(undefined), undefined); assert.equal(readGptObservationContext({}), undefined);
});
test('same-report context preserves status/reason/version/time and auth skipped', () => {
  const native = diagnostic(), old = projectGptConnectorFactory(native, false, NOW);
  native.checks.forEach(item => { item.safe_context = context(); });
  const next = projectGptConnectorFactory(native, false, NOW, { includeObservationContext: true });
  assert.deepEqual({ ...next, checks: next.checks.map(({ safe_context, ...rest }) => rest) }, old);
  assert.equal(next.checks[0].status, 'skipped'); assert.equal(next.checks[0].reason_code, 'auth_required');
  const wire = report(), before = structuredClone(wire);
  assert.equal(validateGptObservationReportV9(wire), wire); assert.deepEqual(wire, before);
  assert.deepEqual(projectSameReportGptObservation(wire), { report_id: wire.report_id, host_id: wire.host_id, observed_at: NOW,
    installed_version: '0.16.4', safe_context: context() });
});
test('nonempty context cannot enter default projector or current contract9', () => {
  const native = diagnostic(); native.checks[0].safe_context = context();
  assert.throws(() => projectGptConnectorFactory(native, false, NOW), /^Error: gpt_observation_context_not_enabled$/);
  assert.throws(() => validateReportV9(report()), /allowlist/);
});
test('partial/unknown/non-scalar/contradictory values reject without echo', () => {
  const bad = [{ gpt_obs_schema: 'v1' }, { ...context(), unknown_private_key: 'private-sentinel' },
    { ...context(), gpt_auth_session_http: 'private-sentinel' }, { ...context(), gpt_bridge_present: false },
    { ...context(), gpt_bridge_summary: null }, { ...context(), gpt_auth_session_user: 'absent' },
    { ...context(), gpt_bridge_version: 'true' }, { ...context(), gpt_bridge_summary: [] }];
  for (const value of bad) assert.throws(() => readGptObservationContext(value), /^Error: gpt_observation_context_invalid$/);
  let reads = 0; const getter = { ...context() }; Object.defineProperty(getter, 'gpt_obs_schema', { get() { reads++; throw new Error('private-sentinel'); } });
  assert.throws(() => readGptObservationContext(getter), /^Error: gpt_observation_context_invalid$/); assert.equal(reads, 0);
});
test('conflicting check groups withhold detail without changing report', () => {
  const other = { ...context(), gpt_auth_session_http: '403' }, wire = report([context(), other]);
  const before = structuredClone(wire); assert.equal(projectSameReportGptObservation(wire), null); assert.deepEqual(wire, before);
  assert.equal(projectSameReportGptObservation(report([{}, {}])), null);
});
test('base privacy and other-product allowlists stay enforced by candidate', () => {
  const wire = report(); wire.products.caveat.checks.push({ check_id: 'test', status: 'pass', safe_context: context() });
  assert.throws(() => validateGptObservationReportV9(wire), /allowlist/);
  const invalid = report(); invalid.products['gpt-connector'].checks[0].status = 'new_private_status';
  assert.throws(() => validateGptObservationReportV9(invalid));
});

test('runtime history context stays on its original record and is not mixed into current checks', () => {
  const wire = report([{}, {}]);
  wire.products['gpt-connector'].runtime_errors.push({ error_code: 'GPT.RUNTIME', component: 'runtime', status: 'open', severity: 'warn',
    fingerprint: 'a'.repeat(64), message_template: 'GPT runtime failure', occurrence_count: 1, first_seen: NOW, last_seen: NOW,
    state_schema_version: '1.0', safe_context: context() });
  const before = structuredClone(wire);
  assert.equal(validateGptObservationReportV9(wire), wire); assert.deepEqual(wire, before);
  assert.equal(projectSameReportGptObservation(wire), null);
});
