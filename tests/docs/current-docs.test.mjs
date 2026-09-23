import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const RENDER = join(ROOT, 'bin', 'render-current-docs.mjs');

const CONTRACT = `
export const MANAGED_PRODUCT_IDS = Object.freeze(['alpha', 'third']);
export const CORE_PRODUCT_IDS = Object.freeze(['alpha']);
export const THIRD_PARTY_PRODUCT_IDS = Object.freeze(['third']);
export const CURRENT_WIRE_MAJOR = 8;
export const CURRENT_WIRE_SCHEMA_VERSION = '8.0';
export const CURRENT_WIRE_ENDPOINT = '/api/factory/v8/reports';
export const ROLLBACK_WIRE_MAJOR = 7;
export const CURRENT_WIRE_PRODUCT_IDS = Object.freeze(['alpha', 'third', 'tool']);
export const FACTORY_RUNNERS = Object.freeze([
  Object.freeze({ name: 'factory-linux-test', label: 'linux-workstation', fullCi: true }),
  Object.freeze({ name: 'factory-linux-ops', label: 'linux-server', fullCi: false }),
]);
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'current-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'archive'), { recursive: true });
  await mkdir(join(root, 'lib', 'factory'), { recursive: true });
  await writeFile(join(root, 'lib', 'factory', 'deployment-contract.mjs'), CONTRACT, 'utf8');
  await writeFile(join(root, 'docs', 'new-guide.md'), '# 案内\n', 'utf8');
  await writeFile(join(root, 'docs', 'present.md'), '# 存在\n', 'utf8');
  await writeFile(join(root, 'docs', 'factory-product-contracts.md'), '# 製品契約\n', 'utf8');
  await writeFile(join(root, 'docs', 'factory-host-product-matrix.md'), '# host matrix\n', 'utf8');
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
  assert.match(state, /self-hosted runner \| 2席/);
  assert.match(state, /full CI環境 \| 1環境/);
  assert.match(state, /`factory-linux-test` \| `linux-workstation` \| full CI/);
  assert.match(state, /`factory-linux-ops` \| `linux-server` \| 運用workflow/);
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

test('管理製品の区分不整合は生成前に拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'lib', 'factory', 'deployment-contract.mjs'), CONTRACT.replace("['third']", "['alpha']"), 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /管理製品区分が重複/);
});

test('CommonMark/GFM構文木でreference linkとnested outer linkの切れを拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'present.png'), 'fixture', 'utf8');
  await writeFile(
    join(root, 'docs', 'new-guide.md'),
    '# 案内\n\n[参照][missing]\n\n[missing]: missing-reference.md\n\n[![存在する画像](present.png)](missing-outer.md)\n',
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-reference\.md/);
  assert.match(result.stderr, /missing-outer\.md/);
  assert.doesNotMatch(result.stderr, /present\.png/);
});

test('duplicate reference definitionはCommonMarkどおり最初の定義を使う', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'present.md'), '# 存在\n', 'utf8');
  const guide = join(root, 'docs', 'new-guide.md');
  await writeFile(
    guide,
    '# 案内\n\n[参照][same]\n\n[same]: present.md\n[same]: missing-second.md\n',
    'utf8',
  );
  assert.equal(run(root, '--write').status, 0);
  await writeFile(
    guide,
    '# 案内\n\n[参照][same]\n\n[same]: missing-first.md\n[same]: present.md\n',
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-first\.md/);
  assert.doesNotMatch(result.stderr, /present\.md/);
});

test('HTML parserとsrcset grammarでhref・src・srcsetの切れを拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'present.png'), 'fixture', 'utf8');
  await writeFile(
    join(root, 'docs', 'new-guide.md'),
    [
      '# 案内',
      '',
      '<a href=missing-html.md>HTML</a>',
      '<img src="missing-src.png" srcset="present.png 1x, missing-srcset.png 2x">',
      '<source srcset="missing-source.png 480w">',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-html\.md/);
  assert.match(result.stderr, /missing-src\.png/);
  assert.match(result.stderr, /missing-srcset\.png/);
  assert.match(result.stderr, /missing-source\.png/);
  assert.doesNotMatch(result.stderr, /present\.png/);
});

test('inline codeとfenced code内のMarkdown・HTML参照を検査対象にしない', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs', 'new-guide.md'),
    [
      '# 案内',
      '',
      '`[inline](missing-inline.md)`',
      '',
      '```markdown',
      '[fenced](missing-fenced.md)',
      '<img src="missing-code-src.png" srcset="missing-code-srcset.png 2x">',
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
});

test('履歴文書のlink切れは検査しない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'archive', 'old.md'), '# 履歴\n\n[消えた参照](missing.md)\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
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
