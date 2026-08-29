import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { V4_PRODUCT_IDS } from '../../lib/factory/v4.mjs';
import { validateAcknowledgementBundleV4 } from '../../lib/factory/runtime-errors.mjs';

const EXPECTED = [
  'caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector',
  'aiterm-mcp', 'codex-sidecar', 'servermanager', 'claude-code', 'codex-cli', 'grok-build',
];

test('wire v4の製品集合はLatticeを含みCodegraphを含まない', () => {
  assert.deepEqual(V4_PRODUCT_IDS, EXPECTED);
  assert.equal(V4_PRODUCT_IDS.includes('codegraph'), false);
});

test('wire v4 acknowledgementはLatticeをtyped contractで受理する', () => {
  const bundle = {
    schema_version: '4.0',
    report_id: 'report-1',
    acknowledgements: [{
      product: 'lattice', cursor: 7, command: 'lattice',
      args: ['runtime-errors', 'ack', '7', '--json'],
    }],
  };
  assert.equal(validateAcknowledgementBundleV4(bundle, 'report-1'), bundle);
  assert.throws(() => validateAcknowledgementBundleV4({
    ...bundle,
    acknowledgements: [{ product: 'codegraph', cursor: 7, command: 'codegraph', args: ['ack'] }],
  }, 'report-1'));
});

test('wire v4のaiterm MCP transportはJSON-RPC 2.0を使う', async () => {
  const source = await readFile(new URL('../../lib/factory/v4.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function aiterm(');
  const end = source.indexOf('\nasync function gpt(', start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /jsonrpc: '2\.0'/u);
  assert.doesNotMatch(implementation, /jsonrpc: '4\.0'/u);
});

test('導入・更新契約はretired Codegraphを再導入しない', async () => {
  const updater = await readFile(new URL('../../bin/agents-update.sh', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('../../bin/verify-install.sh', import.meta.url), 'utf8');
  const scheduler = await readFile(new URL('../../bin/factory-reporter-v4-schedule-runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(updater, /@colbymchenry\/codegraph/u);
  assert.match(verifier, /retired Codegraph command remains on PATH/u);
  assert.doesNotMatch(scheduler.match(/const required = \[[^\]]+\]/u)?.[0] ?? '', /codegraph/u);
  const legacyScheduler = await readFile(new URL('../../bin/factory-reporter-v2-schedule-runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(legacyScheduler.match(/const required = \[[^\]]+\]/u)?.[0] ?? '', /codegraph/u);
  assert.match(scheduler.match(/const required = \[[^\]]+\]/u)?.[0] ?? '', /lattice/u);
});

test('生成された現行状態とhost matrixはLatticeを自作コアへ置き第三者製品と分離する', async () => {
  const read = async (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  const [readme, currentState, matrix] = await Promise.all([
    read('README.md'),
    read('docs/factory-current-state.md'),
    read('docs/factory-host-product-matrix.md'),
  ]);
  assert.doesNotMatch(readme, /工場コア[^\n]*Codegraph/u);
  assert.doesNotMatch(readme, /curated CLI[^\n]*Codegraph/u);
  assert.match(currentState, /^- 自作コア: [^\n]*`lattice`/mu);
  assert.doesNotMatch(currentState, /^- 自作コア: [^\n]*`markitdown`/mu);
  assert.match(currentState, /^- 第三者管理: `markitdown`$/mu);
  assert.match(readme, /\| 第三者管理製品 \| MarkItDown \| 自作コアではなく/u);
  assert.doesNotMatch(matrix, /^\| Codegraph \|/mu);
  assert.match(matrix, /^\| Lattice \| required \| required \| required \| required \| high \|$/mu);
});
