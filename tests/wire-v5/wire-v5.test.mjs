import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { V5_PRODUCT_IDS } from '../../lib/factory/v5.mjs';
import { V4_PRODUCT_IDS } from '../../lib/factory/v4.mjs';
import { validateReportV4, validateReportV5 } from '../../lib/factory/contract.mjs';

const EXPECTED = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector',
  'aiterm-mcp', 'codex-sidecar', 'servermanager', 'claude-code', 'codex-cli', 'grok-build',
  'aishell',
];

const product = () => ({
  presence_status: 'installed', installed_version: '1.0.0', contract_version: '5.0',
  checks: [], runtime_errors: [], resolutions: [],
});

function reportV5(overrides = {}) {
  return {
    schema_version: '5.0',
    report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d900',
    host_id: 'mac-kite',
    host_profile: 'mac',
    platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full',
    observed_at: '2026-07-25T00:00:00.000Z',
    created_at: '2026-07-25T00:00:00.000Z',
    reporter: { version: '5.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(EXPECTED.map((id) => [id, product()])),
    ...overrides,
  };
}

test('wire v5の固定集合はv4の12製品を順序ごと保持しaishellを加える', () => {
  assert.deepEqual(V5_PRODUCT_IDS, EXPECTED);
  assert.deepEqual(V5_PRODUCT_IDS.slice(0, 12), [...V4_PRODUCT_IDS], 'v4の集合と順序を変えない');
  assert.equal(V5_PRODUCT_IDS.includes('codegraph'), false, '退役済みcodegraphを含めない');
  assert.equal(V5_PRODUCT_IDS.includes('observer'), false, 'Observerはv5で扱わない');
});

test('v5 validatorは13製品を要求し、欠落と未知productを拒否する', () => {
  assert.doesNotThrow(() => validateReportV5(reportV5()));

  const missing = reportV5();
  delete missing.products.aishell;
  assert.throws(() => validateReportV5(missing), /aishell|固定13製品/u);

  const unknown = reportV5();
  unknown.products.observer = product();
  assert.throws(() => validateReportV5(unknown), /未定義field/u);
});

test('v5 validatorはv4のschema_versionとproduct集合を受理しない', () => {
  const v4ish = reportV5({ schema_version: '4.0' });
  assert.throws(() => validateReportV5(v4ish), /schema/u);

  const v4set = reportV5();
  delete v4set.products.aishell;
  assert.throws(() => validateReportV5(v4set));
});

test('v4 validatorはv5の13製品を拒否し、v4の受理は非回帰', () => {
  const v5 = reportV5();
  assert.throws(() => validateReportV4({ ...v5, schema_version: '4.0' }), /未定義field/u,
    'v4はaishellキーを拒否し続ける');

  const v4 = reportV5({ schema_version: '4.0' });
  delete v4.products.aishell;
  v4.reporter = { version: '4.0.0', dotagents_revision: 'abc1234' };
  for (const id of Object.keys(v4.products)) v4.products[id].contract_version = '4.0';
  assert.doesNotThrow(() => validateReportV4(v4), 'v4の受理を壊さない');
});

test('v5 clientのprivacy gateはAIShellの許可pathを拒否する', () => {
  const value = reportV5();
  value.products.aishell.checks.push({
    check_id: 'native_diagnostics', status: 'pass',
    safe_context: { working_directory: '/Users/kite/Developer/aishell' },
  });
  assert.throws(() => validateReportV5(value), /privacy|safe_context|禁止/u,
    'clientのprivacy gateをserverより弱くしない');
});

test('v5 scanはAIShellを非対応profileで構造的not_applicableにする', async () => {
  const source = await readFile(new URL('../../lib/factory/v5.mjs', import.meta.url), 'utf8');
  assert.match(source, /aishellProduct\(\{ cwd, profile: host\.profile\b/u,
    'host profileをaishellProductへ渡し、非対応hostでnot_applicableを返させる');
  // 言及ではなく実際の起動を見る。commentに書いた禁止事項でtestを緑にしない。
  assert.doesNotMatch(source, /run\('(?:osascript|\/bin\/sh|\/bin\/bash|sh|bash)'/u,
    'shell / AppleScriptを直接起動する暗黙fallbackを足さない');

  const adapter = await readFile(new URL('../../lib/factory/scan.mjs', import.meta.url), 'utf8');
  const start = adapter.indexOf('export async function aishellProduct(');
  const body = adapter.slice(start, start + 900);
  assert.match(body, /profile !== 'mac'/u, '非対応profileを構造的に分岐する');
  assert.match(body, /not_applicable/u, '非対応profileはnot_applicableを返す');
});

test('v5 reporterはv5専用のendpoint・outbox・stateだけを使う', async () => {
  const reporter = await readFile(new URL('../../bin/factory-reporter-v5.mjs', import.meta.url), 'utf8');
  assert.match(reporter, /\/api\/factory\/v5\/reports/u);
  assert.doesNotMatch(reporter, /\/api\/factory\/v4\/reports/u, 'v4 endpointを参照しない');
  assert.match(reporter, /dotagents\.factory-outbox\.v5/u);
  assert.match(reporter, /state: 'factory-reporter-v5'/u);
  assert.doesNotMatch(reporter, /'dotagents', 'factory-reporter-v4'/u, 'v4のoutboxを列挙しない');
});

test('v5のcontract_versionは全製品でwire contract版を指す', async () => {
  const source = await readFile(new URL('../../lib/factory/v5.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function scanV5WithAcknowledgements');
  const body = source.slice(start);
  // scan.mjs由来の製品はemptyProduct()のv1期の値'1.0'を持つため、wire版で上書きする。
  for (const [id, needle] of [
    ['lattice', "products.lattice = { ...empty(), ...(await latticeProduct({ cwd }, now)), contract_version: '5.0' }"],
    ['aishell', "contract_version: '5.0'"],
    ['servermanager', "contract_version: '5.0'"],
  ]) {
    const at = body.indexOf(`products.${id} =`);
    assert.notEqual(at, -1, `${id}の組み立てがscanV5に存在する`);
    assert.ok(body.slice(at, at + 400).includes("contract_version: '5.0'"),
      `${id}のcontract_versionをwire版へ上書きする（${needle.slice(0, 20)}…）`);
  }
});
