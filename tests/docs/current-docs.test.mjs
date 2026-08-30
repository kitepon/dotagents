import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RENDER = join(ROOT, 'bin', 'render-current-docs.mjs');

const REGISTRY = {
  schema: 'dotagents.document-registry.v3',
  fact_sources: {
    factory_current_state: 'lib/factory/deployment-contract.mjs',
    global_policy: 'shared/constitution.md',
  },
  generated_current_state: 'docs/factory-current-state.md',
  ownership_policy: {
    dotagents_owns: ['integration'],
    product_repo_owns: ['install'],
    product_contract_allowed_fields: ['id'],
    product_contract_table_columns: ['ID / repo'],
    product_contract_column_fields: {
      'ID / repo': ['id'],
    },
    product_pointer_allowed_headings: ['製品側の正本'],
    product_pointer_forbidden_headings: ['更新'],
  },
  archive_inventory: {
    roots: ['docs/archive'],
    all_path_count: 0,
    all_paths_sha256: '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
    legacy_path_count: 0,
    legacy_paths_sha256: '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
  },
  archive_relocations: [],
  current_surface_policies: [{
    id: 'readme-contract',
    path_regex: '^README\\.md$',
    required_regexes: ['現行状態'],
    forbidden_regexes: ['製品内部手順'],
  }],
  document_extensions: ['.md', '.mdc'],
  rules: [
    { id: 'state', kind: 'generated', owner_scope: 'dotagents', role: 'generated', path_regex: '^docs/factory-current-state\\.md$' },
    { id: 'evidence', kind: 'evidence', owner_scope: 'dotagents', role: 'evidence', path_regex: '^(?:docs/evidence/|evidence/)' },
    { id: 'history', kind: 'history', owner_scope: 'dotagents', role: 'history', path_regex: '^docs/(?:archive/|adr/|wire-v[1-7]-design\\.md$)' },
    { id: 'contract', kind: 'contract', owner_scope: 'dotagents', role: 'integration', path_regex: '^docs/wire-v[0-9]+-design\\.md$' },
    { id: 'product-pointer', kind: 'current', owner_scope: 'dotagents', role: 'product-pointer', path_regex: '^docs/06_gpt-connector\\.md$' },
    { id: 'current', kind: 'current', owner_scope: 'dotagents', role: 'policy', path_regex: '.*\\.(?:md|mdc)$' },
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
  await writeFile(join(root, 'docs', 'factory-product-contracts.md'), '# 統合台帳\n\n| ID / repo |\n|---|\n| alpha |\n', 'utf8');
  await writeFile(join(root, 'docs', 'factory-host-product-matrix.md'), '# host matrix\n', 'utf8');
  await writeFile(join(root, 'README.md'), '# 案内\n\n現行状態は生成ページを参照する。\n', 'utf8');
  return root;
}

function run(root, mode) {
  return spawnSync(process.execPath, [RENDER, mode, '--root', root], { encoding: 'utf8' });
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function setArchivePaths(registry, paths) {
  const sorted = paths.toSorted();
  registry.archive_inventory.all_path_count = sorted.length;
  registry.archive_inventory.all_paths_sha256 = digest(`${sorted.join('\n')}\n`);
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

test('current文書の単純な製品数・fresh wire・rollback versionを拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs', 'new-guide.md'),
    '# 案内\n\n管理対象12製品。\nfresh v8 delivery。\nhost別rollback majorはv7へ戻す。\n',
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/new-guide\.md:3: product-count: 12製品/);
  assert.match(result.stderr, /docs\/new-guide\.md:4: fresh-wire: fresh v8/);
  assert.match(result.stderr, /docs\/new-guide\.md:5: rollback-version: host別rollback majorはv7へ戻す/);
});

test('current文書は可変値をN表記に抽象化できる', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs', 'new-guide.md'),
    '# 案内\n\n管理対象N製品。\nfresh vN delivery。\nrollbackはvNへ戻す。\n',
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
});

test('履歴と証拠の固定値はcurrent claimとして扱わない', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs', 'adr'), { recursive: true });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(join(root, 'docs', 'wire-v7-design.md'), '# v7\n\n現役wire v6から移行した。\n', 'utf8');
  await writeFile(join(root, 'docs', 'adr', 'old.md'), '# 履歴\n\n自作コア3製品だった。\n', 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'receipt.md'), '# 証拠\n\n工場管理対象2製品を確認した。\n', 'utf8');
  await writeFile(join(root, 'evidence', 'legacy-receipt.md'), '# 旧証拠\n\n工場管理対象12製品を確認した。\n', 'utf8');
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

test('product-pointerのSetext headingへ製品の更新手順を書けない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', '06_gpt-connector.md'), '# 接続\n\n更新\n----\n\nここで更新する。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /product-pointerに製品制御headingを置けません: 更新/);
});

test('product-pointerの3-space ATX headingへ製品の更新手順を書けない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', '06_gpt-connector.md'), '# 接続\n\n   ## 更新\n\nここで更新する。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /product-pointerに製品制御headingを置けません: 更新/);
});

test('current surfaceへ製品内部手順を戻せない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'README.md'), '# 案内\n\n現行状態。製品内部手順をここへ複製する。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /readme-contract: 製品制御または履歴を置けません: 製品内部手順/);
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

test('未登録のarchive追加をinventoryで拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'archive', 'unregistered.md'), '# 履歴\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive inventoryに未登録の追加・移動・削除/);
});

test('archive移動後の切れたlocal linkを拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 履歴\n\n[切れた参照](missing.md)\n';
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(archived),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), archived, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /凍結本文の元path基準local linkが切れています: missing\.md/);
});

test('archive本文の書き換えをdigestで拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest('# 元本文\n'),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), '# 書き換え本文\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /凍結本文のdigestが移動時から変わっています/);
});

test('compatibility stubの書き換えをdigestで拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 元本文\n';
  const stub = '# 履歴stub\n\n[本文](archive/old.md)\n';
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: true,
    old_path_mode: 'compatibility-stub',
    archive_sha256: digest(archived),
    old_path_sha256: digest(stub),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), archived, 'utf8');
  await writeFile(join(root, 'docs', 'old.md'), `${stub}\n余分な制御\n`, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compatibility stubのdigestが変わっています/);
});

test('relocation entryとarchive本文の同時削除を全path inventoryで拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const archivePath = join(root, 'docs', 'archive', 'old.md');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 元本文\n';
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(archived),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  await writeFile(archivePath, archived, 'utf8');
  assert.equal(run(root, '--write').status, 0);

  registry.archive_relocations = [];
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  await rm(archivePath);
  const result = run(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive全path集合に追加・移動・削除/);
});

test('compatibility stubのarchive導線以外のbroken local linkも拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.rules.splice(-1, 0, {
    id: 'stub-history',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    path_regex: '^docs/old\\.md$',
  });
  const archived = '# 元本文\n';
  const stub = '# 履歴stub\n\n[本文](archive/old.md)\n[補足](missing.md)\n';
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: true,
    old_path_mode: 'compatibility-stub',
    archive_sha256: digest(archived),
    old_path_sha256: digest(stub),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), archived, 'utf8');
  await writeFile(join(root, 'docs', 'old.md'), stub, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compatibility stubのlocal linkが切れています: missing\.md/);
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

test('実repoの文書台帳は製品制御を製品repo所有として固定する', async () => {
  const registry = JSON.parse(await readFile(join(ROOT, 'docs', 'document-registry.json'), 'utf8'));
  assert.deepEqual(registry.ownership_policy.product_repo_owns, [
    'install',
    'configuration',
    'state',
    'schema',
    'migration',
    'diagnostic-semantics',
    'recovery',
    'update',
    'ci',
    'release',
  ]);
  for (const rule of registry.rules) {
    assert.equal(rule.owner_scope, 'dotagents');
    assert.ok(rule.role, rule.id);
  }
  const fixedHistory = registry.rules.find((rule) => rule.id === 'fixed-path-history-and-stubs');
  const regex = new RegExp(fixedHistory.path_regex, 'u');
  for (const path of [
    'docs/plan_elastic-orchestrator.md',
    'docs/codex-native-routing-repair.md',
    'docs/elastic-orchestrator-writer-packet-admission.md',
  ]) assert.match(path, regex);
  assert.match('docs/plan_factory-master.md', regex);
});
