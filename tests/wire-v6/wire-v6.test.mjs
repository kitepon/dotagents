import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { validateReportV5, validateReportV6 } from '../../lib/factory/contract.mjs';
import { V5_PRODUCT_IDS } from '../../lib/factory/v5.mjs';
import { V6_PRODUCT_IDS } from '../../lib/factory/v6.mjs';

const EXPECTED = [...V5_PRODUCT_IDS];

test('v6正典はObserverをwire必須キーから外し、MarkItDownを第三者管理として固定する', async () => {
  const contracts = await readFile(resolve(import.meta.dirname, '../../docs/factory-product-contracts.md'), 'utf8');
  const matrix = await readFile(resolve(import.meta.dirname, '../../docs/factory-host-product-matrix.md'), 'utf8');
  assert.match(contracts, /^# 工場の製品統合契約台帳$/mu);
  assert.match(contracts, /## 第三者・基盤toolchain[\s\S]*### `markitdown`[\s\S]*第三者のblack-box adapter/u);
  assert.match(contracts, /### `observer`[\s\S]*wire v6\/v7を含む現役・rollback製品キーへ`products\.observer`を出さない/u);
  assert.doesNotMatch(matrix, /^\| Observer \|/mu);
  assert.match(matrix, /独立CodegraphとObserverは現役製品またはconnectorとして扱わない/u);
  assert.doesNotMatch(contracts, /Observerは予約枠のまま未編入/u);
});

test('agents-updateのpost-update gateはconfigのwire majorへ追従し、生成された現役v8で明示失敗させる', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../bin/agents-update.sh'), 'utf8');
  // hostの実configのendpointからmajorを解決する（host別段階cutover中のendpoint/runner食い違い対策）
  assert.match(source, /api\\\/factory\\\/\(v\[0-9\]\+\)\\\/reports/u);
  assert.match(source, /reporter_wire_major=v8/u);
  assert.match(source, /factory-reporter-\$\{reporter_wire_major\}-schedule-runner/u);
  assert.doesNotMatch(source, /FACTORY_REPORTER_RUNNER=.*factory-reporter-v4-schedule-runner/u);

  const runbook = await readFile(
    resolve(import.meta.dirname, '../../docs/factory-reporter-runbook.md'),
    'utf8',
  );
  const currentState = await readFile(
    resolve(import.meta.dirname, '../../docs/factory-current-state.md'),
    'utf8',
  );
  // 全hostのv8 cutover後も、実configのendpoint確認とv7/v6 rollback手順を維持する。
  // updaterのmajor解決は固定majorでなくconfigに追従するため、この両面を検証する。
  assert.match(currentState, /\| 現役wire \| v8（schema `8\.0`、15製品） \|/u);
  assert.match(currentState, /\| 本番BugHub endpoint \| `\/api\/factory\/v8\/reports` \|/u);
  assert.match(runbook, /本番BugHubの入口は\[工場の現行状態\]/u);
  assert.match(runbook, /`reporting\.endpoint`を同ページと照合する/u);
  assert.match(runbook, /--wire-major v6/u);
  assert.match(runbook, /schema_version="6\.0"/u);
  assert.doesNotMatch(runbook, /通常経路はpayload `schema_version="4\.0"`/u);
});

test('wire v6のCodex routing診断は正典のmulti_agent_v2を検査する', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../lib/factory/v5.mjs'), 'utf8');
  assert.match(source, /features\\\.multi_agent_v2/u);
  assert.doesNotMatch(source, /features\\\.multi_agent_v4/u);
});

test('Community overlay接続器は製品所有入口だけを呼ぶ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'community-overlay-entrypoint-'));
  try {
    const desktop = join(root, 'desktop');
    const afk = join(root, 'afk');
    const log = join(root, 'calls.log');
    const wrapper = resolve(import.meta.dirname, '../../bin/update-grok-community-overlay.sh');
    const source = await readFile(wrapper, 'utf8');

    assert.match(source, /scripts\/update-overlay\.sh/u);
    assert.doesNotMatch(source, /git -C|vitest|electron-builder|docker compose|force-with-lease/u);

    for (const [directory, name] of [[desktop, 'desktop'], [afk, 'afk']]) {
      await mkdir(join(directory, 'scripts'), { recursive: true });
      await writeFile(
        join(directory, 'scripts', 'update-overlay.sh'),
        `#!/bin/sh\nprintf '%s:%s\\n' '${name}' "$*" >> "$OVERLAY_CALL_LOG"\n`,
        { mode: 0o755 },
      );
    }

    const result = await runBash(wrapper, ['--push'], {
      GROK_COMMUNITY_DESKTOP: desktop,
      GROK_COMMUNITY_AFK: afk,
      OVERLAY_CALL_LOG: log,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(log, 'utf8'), 'desktop:--push\nafk:--push\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const product = (contractVersion = '6.0') => ({
  presence_status: 'installed',
  installed_version: '0.1.0',
  contract_version: contractVersion,
  checks: [],
  runtime_errors: [],
  resolutions: [],
});

function reportV6() {
  return {
    schema_version: '6.0',
    report_id: '019f57f0-6bb7-7bc1-b94a-18f648f2d901',
    host_id: 'mac-kite',
    host_profile: 'mac',
    platform: { os: 'darwin', arch: 'arm64' },
    report_mode: 'full',
    observed_at: '2026-07-25T00:00:00.000Z',
    created_at: '2026-07-25T00:00:00.000Z',
    reporter: { version: '6.0.0', dotagents_revision: 'abc1234' },
    products: Object.fromEntries(EXPECTED.map((id) => [id, product()])),
  };
}

test('v6はv5と同じ13製品でobserverキーを持たない', () => {
  assert.deepEqual(V6_PRODUCT_IDS, EXPECTED);
  assert.equal(new Set(V6_PRODUCT_IDS).size, 13);
  assert.equal(V6_PRODUCT_IDS.includes('observer'), false);
});

test('v6 validatorは固定13製品だけを受理し、v5を変更しない', () => {
  const report = reportV6();
  assert.doesNotThrow(() => validateReportV6(report));
  assert.equal('observer' in report.products, false);
  const withObserver = {
    ...report,
    products: { ...report.products, observer: product() },
  };
  assert.throws(() => validateReportV6(withObserver), /productsに未定義fieldがあります/);
  const v5 = {
    ...report,
    schema_version: '5.0',
    reporter: { ...report.reporter, version: '5.0.0' },
    products: Object.fromEntries(V5_PRODUCT_IDS.map((id) => [id, product('5.0')])),
  };
  assert.doesNotThrow(() => validateReportV5(v5));
});

function run(script, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({
      code,
      stdout,
      stderr,
      json: stdout ? JSON.parse(stdout) : null,
    }));
  });
}

function runBash(script, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('/bin/bash', [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('v6 reporterはv6 reportだけを受理し、v5とstateを共有しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v6-reporter-'));
  try {
    const reportPath = join(root, 'report.json');
    const configPath = join(root, 'config.json');
    const reporter = resolve(import.meta.dirname, '../../bin/factory-reporter-v6.mjs');
    await writeFile(reportPath, JSON.stringify(reportV6()));
    await writeFile(configPath, JSON.stringify({
      schema_version: '1.0',
      host: { id: 'mac-kite', profile: 'mac' },
      collection: { enabled: false },
      reporting: { enabled: false },
    }));
    const preview = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], {
      XDG_STATE_HOME: join(root, 'state'),
    });
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(preview.json.report.schema_version, '6.0');

    const v5 = reportV6();
    v5.schema_version = '5.0';
    v5.reporter.version = '5.0.0';
    for (const productValue of Object.values(v5.products)) productValue.contract_version = '5.0';
    await writeFile(reportPath, JSON.stringify(v5));
    const rejected = await run(reporter, ['preview', '--report', reportPath, '--config', configPath], {
      XDG_STATE_HOME: join(root, 'state'),
    });
    assert.equal(rejected.code, 1);
    assert.equal(rejected.json.code, 'FACTORY_REPORTER_V6_ERROR');

    const source = await readFile(reporter, 'utf8');
    assert.match(source, /factory-reporter-v5\.mjs/u, 'v5の検証済みtransport実装を共有する');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schedulerはv6 endpoint・runner・専用stateを同じmajorへ束縛する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-v6-scheduler-'));
  try {
    const configPath = join(root, 'config.json');
    const credentialPath = join(root, 'credential');
    const scheduler = resolve(import.meta.dirname, '../../bin/factory-reporter-scheduler.mjs');
    await writeFile(credentialPath, 'unit-test-token\n', { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({
      schema_version: '1.0',
      host: { id: 'mac-kite', profile: 'mac' },
      collection: { enabled: true },
      reporting: {
        enabled: true,
        endpoint: 'http://127.0.0.1:1/api/factory/v6/reports',
        credential_file: credentialPath,
      },
    }));
    const result = await run(scheduler, [
      'install', '--dry-run', '--platform', 'darwin', '--wire-major', 'v6', '--config', configPath,
    ], {
      HOME: root,
      XDG_STATE_HOME: join(root, 'state'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.wire_major, 'v6');
    assert.match(result.json.artifact_content, /factory-reporter-v6-schedule-runner/u);
    assert.match(result.json.state, /factory-reporter-v6$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
