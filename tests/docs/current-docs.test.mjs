import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RENDER = join(ROOT, 'bin', 'render-current-docs.mjs');

const REGISTRY = {
  schema: 'dotagents.document-registry.v1',
  fact_sources: {
    factory_current_state: 'lib/factory/deployment-contract.mjs',
    global_policy: 'shared/constitution.md',
  },
  generated_current_state: 'docs/factory-current-state.md',
  document_extensions: ['.md', '.mdc'],
  rules: [
    { id: 'state', kind: 'generated', path_regex: '^docs/factory-current-state\\.md$' },
    { id: 'evidence', kind: 'evidence', path_regex: '^docs/evidence/' },
    { id: 'history', kind: 'history', path_regex: '^docs/(?:archive/|adr/|wire-v[1-7]-design\\.md$)' },
    { id: 'contract', kind: 'contract', path_regex: '^docs/wire-v[0-9]+-design\\.md$' },
    { id: 'current', kind: 'current', path_regex: '.*\\.(?:md|mdc)$' },
  ],
};

const CONTRACT = `
export const MANAGED_PRODUCT_IDS = Object.freeze(['alpha', 'third']);
export const CORE_PRODUCT_IDS = Object.freeze(['alpha']);
export const THIRD_PARTY_PRODUCT_IDS = Object.freeze(['third']);
export const CURRENT_WIRE_MAJOR = 8;
export const CURRENT_WIRE_SCHEMA_VERSION = '8.0';
export const CURRENT_WIRE_ENDPOINT = '/api/factory/v8/reports';
export const ROLLBACK_WIRE_MAJOR = 7;
export const CURRENT_WIRE_PRODUCT_IDS = Object.freeze(['alpha', 'third', 'tool']);
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'current-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'archive'), { recursive: true });
  await mkdir(join(root, 'docs', 'evidence'), { recursive: true });
  await mkdir(join(root, 'lib', 'factory'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(join(root, 'docs', 'document-registry.json'), `${JSON.stringify(REGISTRY, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'lib', 'factory', 'deployment-contract.mjs'), CONTRACT, 'utf8');
  await writeFile(join(root, 'shared', 'constitution.md'), '# 共通\n', 'utf8');
  await writeFile(join(root, 'README.md'), '# 案内\n\n現行状態は生成ページを参照する。\n', 'utf8');
  return root;
}

function run(root, mode) {
  return spawnSync(process.execPath, [RENDER, mode, '--root', root], { encoding: 'utf8' });
}

test('構造化正本から現行状態ページを冪等生成する', async (t) => {
  const root = await fixture(t);
  const first = run(root, '--write');
  assert.equal(first.status, 0, first.stderr);
  const state = await readFile(join(root, 'docs', 'factory-current-state.md'), 'utf8');
  assert.match(state, /現役管理対象 \| 2製品/);
  assert.match(state, /現役wire \| v8（schema `8\.0`、3製品）/);
  assert.match(state, /`\/api\/factory\/v8\/reports`/);
  assert.equal(run(root, '--check').status, 0);
  assert.equal(run(root, '--write').status, 0);
  assert.equal(await readFile(join(root, 'docs', 'factory-current-state.md'), 'utf8'), state);
});

test('checkは生成物driftを拒否する', async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, '--write').status, 0);
  await writeFile(join(root, 'docs', 'factory-current-state.md'), '手編集\n', 'utf8');
  const result = run(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /生成物drift: docs\/factory-current-state\.md/);
});

test('新しいcurrent文書も自動分類し、手書きの現行値を拒否する', async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, '--write').status, 0);
  await writeFile(join(root, 'docs', 'new-guide.md'), '# 案内\n\n現役wire v8を使う。\n', 'utf8');
  const result = run(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/new-guide\.md:3: current-wire/);
});

test('履歴と証拠の固定値はcurrent claimとして扱わない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'wire-v7-design.md'), '# v7\n\n現役wire v6から移行した。\n', 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), '# 履歴\n\n自作コア3製品だった。\n', 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'receipt.md'), '# 証拠\n\n工場管理対象2製品を確認した。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
});

test('管理製品の区分不整合は生成前に拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'lib', 'factory', 'deployment-contract.mjs'), CONTRACT.replace("['third']", "['alpha']"), 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /管理製品区分が重複/);
});

test('不正な引数は入力エラーとして拒否する', () => {
  const result = spawnSync(process.execPath, [RENDER, '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('実repoの生成物はWindows checkoutでもLF byte列を維持する', async () => {
  const attributes = await readFile(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^docs\/factory-current-state\.md text eol=lf$/m);
});
