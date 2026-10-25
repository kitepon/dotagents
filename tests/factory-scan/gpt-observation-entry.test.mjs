import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGptObservationEntry, DEFAULT_GPT_OBSERVATION_ENTRY } from '../../lib/factory/gpt-observation-entry.mjs';
import { gptObservationProduct } from '../../lib/factory/v5.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';
const keys = ['central_release', 'validator_adoption', 'product_cli_adoption', 'factory_entry_adoption'];
const ready = () => ({ schema: 'dotagents.gpt-observation-path.v1', ...Object.fromEntries(keys.map(key => [key,
  { status: key === 'central_release' ? 'released' : 'adopted', ref: `fixture:${key}` }])) });
const context = { gpt_obs_schema: 'v1', gpt_auth_session_http: '401', gpt_auth_session_user: 'uninspected',
  gpt_bridge_present: 'false', gpt_bridge_version: 'uninspected', gpt_bridge_build: 'uninspected', gpt_bridge_summary: 'uninspected' };
const native = withContext => ({ package_version: '0.16.4', overall: 'unverified', state: { schema: '1.0', migration: 'current' },
  checks: [{ id: 'auth', status: 'not_ready', reason: 'auth_required', ...(withContext ? { safe_context: context } : {}) }] });
const now = '2026-10-25T17:17:00.000Z';
const report = product => ({ schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904', host_id: 'rabbit', host_profile: 'linux',
  platform: { os: 'linux', arch: 'x64' }, report_mode: 'full', observed_at: now, created_at: now,
  reporter: { version: '9.0.0', dotagents_revision: 'abc1234' }, products: Object.fromEntries(V9_PRODUCT_IDS.map(id => [id,
    id === 'gpt-connector' ? { ...product, contract_version: '9.0' } : { presence_status: 'unverified', contract_version: '9.0', checks: [], runtime_errors: [], resolutions: [] }])) });

test('each missing readiness fact keeps the original one argv and default projection', async () => {
  for (const missing of [...keys, 'default']) {
    const facts = ready(); if (missing !== 'default') delete facts[missing];
    const entry = missing === 'default' ? DEFAULT_GPT_OBSERVATION_ENTRY : createGptObservationEntry(facts);
    let count = 0;
    const product = await gptObservationProduct('/fixture', now, async (command, args) => {
      count++; assert.equal(command, 'gpt-connector'); assert.deepEqual(args, ['factory-diagnostics', '--json']);
      return { ok: false, stdout: JSON.stringify(native(false)) };
    }, entry);
    assert.equal(count, 1); assert.equal(entry.enabled, false); assert.equal(product.checks[0].status, 'skipped');
    assert.equal('safe_context' in product.checks[0], false); entry.validateReport(report(product));
  }
});
test('complete fixture gate selects one opt-in argv and corresponding same-report validator', async () => {
  const entry = createGptObservationEntry(ready()); let count = 0;
  const product = await gptObservationProduct('/fixture', now, async (command, args) => {
    count++; assert.equal(command, 'gpt-connector'); assert.deepEqual(args, ['factory-diagnostics', '--json', '--include-observation-context']);
    return { ok: false, stdout: JSON.stringify(native(true)) };
  }, entry);
  assert.equal(count, 1); assert.equal(entry.enabled, true); assert.equal(product.checks[0].status, 'skipped');
  assert.deepEqual(product.checks[0].safe_context, context);
  const wire = report(product); const original = structuredClone(wire); entry.validateReport(wire); assert.deepEqual(wire, original);
  assert.throws(() => DEFAULT_GPT_OBSERVATION_ENTRY.validateReport(wire), /allowlist/);
});
test('report-file read gate rejects nonempty before outbox when ordinary path is closed', async () => {
  const enabled = createGptObservationEntry(ready());
  const product = await gptObservationProduct('/fixture', now, async () => ({ ok: false, stdout: JSON.stringify(native(true)) }), enabled);
  const directory = await mkdtemp(join(tmpdir(), 'gpt-entry-'));
  try {
    const file = join(directory, 'report.json'); const bytes = Buffer.from(`${JSON.stringify(report(product))}\n`); await writeFile(file, bytes);
    await assert.rejects(DEFAULT_GPT_OBSERVATION_ENTRY.readReport(file), /allowlist/);
    const accepted = await enabled.readReport(file); assert.deepEqual(accepted.bytes, bytes); assert.equal(accepted.report.observed_at, now);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('source gate is immutable and never interprets boolean/env values as readiness', () => {
  const facts = ready(), entry = createGptObservationEntry(facts); delete facts.central_release;
  assert.equal(entry.enabled, true); assert.equal(Object.isFrozen(entry.nativeArgs), true);
  assert.equal(createGptObservationEntry({ central_release: true }).enabled, false);
  assert.equal(DEFAULT_GPT_OBSERVATION_ENTRY.enabled, false);
});
