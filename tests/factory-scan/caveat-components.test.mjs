import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CAVEAT_COMPONENTS, parseCaveatComponents } from '../../lib/factory/caveat-diagnostics.mjs';
import { validateReportV9 } from '../../lib/factory/contract.mjs';
import { caveatChecks } from '../../lib/factory/v5.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';

const NOW = '2026-10-10T04:17:00.000Z';
const LEGACY_FINGERPRINT = '962a1eee74670a4a030c364b0d6b178783f2ab89bec9470d45c2633d2dd8f22f';
const IDS = [
  'database', 'sync', 'claude_mcp',
  'claude_hook_user_prompt_submit', 'claude_hook_post_tool_use', 'claude_hook_post_tool_use_failure', 'claude_hook_stop',
  'codex_hook_user_prompt_submit', 'codex_hook_post_tool_use', 'codex_hook_stop',
  'cursor_hook_before_submit_prompt', 'cursor_hook_post_tool_use', 'cursor_hook_post_tool_use_failure', 'cursor_hook_stop',
  'grok_mcp',
];
// 4ハーネスそれぞれの部品。Grokは製品仕様でMCP登録だけ（専用hookは無い）。
const HARNESS_PARTS = {
  claude: ['claude_mcp', 'claude_hook_user_prompt_submit', 'claude_hook_post_tool_use', 'claude_hook_post_tool_use_failure', 'claude_hook_stop'],
  codex: ['codex_hook_user_prompt_submit', 'codex_hook_post_tool_use', 'codex_hook_stop'],
  cursor: ['cursor_hook_before_submit_prompt', 'cursor_hook_post_tool_use', 'cursor_hook_post_tool_use_failure', 'cursor_hook_stop'],
  grok: ['grok_mcp'],
};

function diagnostic({ grok = true } = {}) {
  const ready = () => ({ status: 'ready', reason_code: 'ready' });
  const hooks = (names) => Object.fromEntries(names.map((name) => [name, ready()]));
  return {
    schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '0.20.3',
    overall: { status: 'ready' },
    database: { ...ready(), schema_version: 3, supported_schema_version: 3, migration_status: 'current' },
    sync: ready(),
    connectors: {
      claude: { status: 'ready', mcp: ready(), hooks: hooks(['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop']) },
      codex: { status: 'ready', hooks: hooks(['user_prompt_submit', 'post_tool_use', 'stop']) },
      cursor: { compatibility_status: 'ready', hooks: hooks(['before_submit_prompt', 'post_tool_use', 'post_tool_use_failure', 'stop']) },
      ...(grok ? { grok: { status: 'ready', mcp: ready() } } : {}),
    },
  };
}
// check_idから、出力の中のその部品を取り出す。
function part(value, id) {
  if (id === 'database' || id === 'sync') return value[id];
  if (id.endsWith('_mcp')) return value.connectors[id.slice(0, -4)].mcp;
  const [host, name] = id.split('_hook_');
  return value.connectors[host].hooks[name];
}
function withPart(id, status, reason, overall) {
  const value = diagnostic();
  Object.assign(part(value, id), { status, reason_code: reason });
  value.overall.status = overall;
  return value;
}
const byId = (checks) => Object.fromEntries(checks.map((item) => [item.check_id, item]));
const fingerprint = (id) => createHash('sha256').update(`caveat\0${id}`).digest('hex');

function assertWire(checks) {
  const product = (id) => ({
    presence_status: 'installed', installed_version: '0.20.3', contract_version: '9.0',
    checks: id === 'caveat' ? checks : [], runtime_errors: [], resolutions: [],
  });
  assert.doesNotThrow(() => validateReportV9({
    schema_version: '9.0', report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d904',
    host_id: 'mac-kite', host_profile: 'mac', platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full', observed_at: NOW, created_at: NOW,
    reporter: { version: '9.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(V9_PRODUCT_IDS.map((id) => [id, product(id)])),
  }));
}

test('部品の一覧は15個で固定し、v1に無い部品を作らない', () => {
  assert.deepEqual(CAVEAT_COMPONENTS.map(([id]) => id), IDS);
  assert.deepEqual(Object.values(HARNESS_PARTS).flat().sort(), IDS.filter((id) => !['database', 'sync'].includes(id)).sort());
  assert.ok(!IDS.some((id) => id.startsWith('grok_hook_') || id === 'codex_mcp' || id === 'cursor_mcp'));
});

test('4ハーネスともreadyの回は、旧checkのpassと部品15個のpassを出す', () => {
  const checks = caveatChecks(diagnostic(), 'ready', NOW);
  assert.deepEqual(checks.map((item) => item.check_id), ['native_diagnostics', ...IDS]);
  assert.ok(checks.every((item) => item.status === 'pass' && !('reason_code' in item) && !('severity' in item)));
  assertWire(checks);
});

test('どの部品の不足も、製品の理由のままwarnで運び、旧checkを出さない', () => {
  for (const id of IDS) {
    const checks = caveatChecks(withPart(id, 'not_ready', 'not_installed', 'not_ready'), 'not_ready', NOW);
    const found = byId(checks);
    assert.deepEqual(checks.map((item) => item.check_id), IDS, id);
    assert.deepEqual(found[id], {
      check_id: id, status: 'fail', severity: 'warn', fingerprint: fingerprint(id), message_template: `caveat ${id} failed`,
      occurrence_count: 1, first_seen: NOW, last_seen: NOW, reason_code: 'not_installed',
    });
    assert.ok(checks.filter((item) => item.check_id !== id).every((item) => item.status === 'pass'), id);
    // 不足の回に旧issueを閉じない。旧fingerprintを新しい重大度で出さない。
    assert.ok(!('native_diagnostics' in found), id);
    assert.ok(!JSON.stringify(checks).includes(LEGACY_FINGERPRINT), id);
    assertWire(checks);
  }
});

test('製品が未確認とした部品は未確認のまま運び、failにも旧checkのpassにもしない', () => {
  for (const id of IDS) {
    const checks = caveatChecks(withPart(id, 'unverified', 'config_unreadable', 'unverified'), 'unverified', NOW);
    const found = byId(checks);
    assert.deepEqual(found[id], { check_id: id, status: 'unverified', reason_code: 'config_unreadable' }, id);
    assert.ok(!('native_diagnostics' in found), id);
    assert.ok(checks.every((item) => item.status !== 'fail'), id);
    assertWire(checks);
  }
});

test('ハーネスごとに、そのハーネスの部品だけが不足・未確認になる', () => {
  for (const [harness, ids] of Object.entries(HARNESS_PARTS)) {
    for (const [status, wire, reason] of [['not_ready', 'fail', 'not_registered'], ['unverified', 'unverified', 'config_unreadable']]) {
      const value = diagnostic();
      for (const id of ids) Object.assign(part(value, id), { status, reason_code: reason });
      value.overall.status = status;
      const checks = caveatChecks(value, status, NOW);
      assert.deepEqual(checks.filter((item) => item.status === wire).map((item) => item.check_id), ids, `${harness}:${status}`);
      assert.ok(checks.filter((item) => !ids.includes(item.check_id)).every((item) => item.status === 'pass'), `${harness}:${status}`);
      assert.ok(!checks.some((item) => item.check_id === 'native_diagnostics'), `${harness}:${status}`);
      assertWire(checks);
    }
  }
});

test('同じ部品で理由が変わっても、identityは変わらない', () => {
  const reasons = ['not_git_worktree', 'origin_missing', 'upstream_not_origin', 'worktree_dirty', 'remote_mismatch', 'behind', 'ahead', 'diverged'];
  const seen = reasons.map((reason) => byId(caveatChecks(withPart('sync', 'not_ready', reason, 'not_ready'), 'not_ready', NOW)).sync);
  assert.deepEqual(seen.map((item) => item.reason_code), reasons);
  assert.deepEqual([...new Set(seen.map((item) => item.fingerprint))], [fingerprint('sync')]);
  // 部品が違えばissueも違う。
  assert.equal(new Set(IDS.map(fingerprint)).size, IDS.length);
});

test('Grokの出力が無い古い形は、Grokの部品を作らず、ほかの3ハーネスをそのまま運ぶ', () => {
  const checks = caveatChecks(diagnostic({ grok: false }), 'ready', NOW);
  assert.deepEqual(checks.map((item) => item.check_id), ['native_diagnostics', ...IDS.filter((id) => id !== 'grok_mcp')]);
  assert.ok(checks.every((item) => item.status === 'pass'));
  assert.deepEqual(parseCaveatComponents({}), []);
});

test('overallの不足・未確認を部品へ帰せない回は、旧checkで理由を分けて残す', () => {
  const unattributed = caveatChecks(diagnostic(), 'not_ready', NOW);
  assert.deepEqual(unattributed[0], {
    check_id: 'native_diagnostics', status: 'fail', severity: 'warn',
    fingerprint: createHash('sha256').update('caveat\0native_diagnostics\0native_not_ready_unattributed').digest('hex'),
    message_template: 'caveat native_diagnostics failed', occurrence_count: 1, first_seen: NOW, last_seen: NOW,
    reason_code: 'native_not_ready_unattributed',
  });
  assert.notEqual(unattributed[0].fingerprint, LEGACY_FINGERPRINT);
  assertWire(unattributed);
  // 部品の細目を持たない古い出力でも、不足を黙って消さない。
  assert.deepEqual(caveatChecks({}, 'not_ready', NOW).map((item) => [item.check_id, item.reason_code]), [['native_diagnostics', 'native_not_ready_unattributed']]);
  assert.deepEqual(caveatChecks(diagnostic(), 'unverified', NOW)[0], { check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_unverified' });
  assert.deepEqual(caveatChecks({}, 'unverified', NOW), [{ check_id: 'native_diagnostics', status: 'unverified', reason_code: 'native_unverified' }]);
});

test('形式から外れた理由と状態は運ばず、その部品だけを未確認にする', () => {
  const secret = 'sk_live_0123456789abcdef';
  for (const mutate of [
    (item) => { item.reason_code = '/Users/kite/private'; },
    (item) => { item.reason_code = 'C:\\Users\\kite\\private'; },
    (item) => { item.reason_code = secret; },
    (item) => { item.reason_code = 'Remote Mismatch'; },
    (item) => { item.reason_code = 'x'.repeat(65); },
    (item) => { item.reason_code = 7; },
    (item) => { delete item.reason_code; },
    (item) => { item.status = 'unknown'; },
  ]) {
    const value = diagnostic();
    mutate(value.sync);
    value.sync.status ??= 'not_ready';
    const text = JSON.stringify(value.sync);
    const checks = caveatChecks(value, 'ready', NOW);
    assert.deepEqual(byId(checks).sync, { check_id: 'sync', status: 'unverified', reason_code: 'detail_schema_invalid' }, text);
    for (const leaked of ['/Users/', 'C:\\\\Users', secret, 'Remote Mismatch', 'unknown']) assert.ok(!JSON.stringify(checks).includes(leaked), text);
    assert.equal(checks.filter((item) => item.status === 'pass').length, 15, text);
    assertWire(checks);
  }
  for (const broken of [null, 'ready', ['ready']]) {
    const value = diagnostic();
    value.connectors.grok.mcp = broken;
    assert.deepEqual(byId(caveatChecks(value, 'ready', NOW)).grok_mcp, { check_id: 'grok_mcp', status: 'unverified', reason_code: 'detail_schema_invalid' });
  }
});

test('出力の余分なfieldと、部品でない値は読まない・運ばない', () => {
  const value = diagnostic();
  value.sync.remote_url = 'https://example.invalid/private.git';
  value.connectors.claude.mcp.path = '/Users/kite/private';
  value.connectors.grok.mcp.command = '/home/kite/bin/node';
  value.private_path = '/home/kite/private';
  const text = JSON.stringify(caveatChecks(value, 'ready', NOW));
  for (const leaked of ['example.invalid', '/Users/', '/home/']) assert.ok(!text.includes(leaked));
});
