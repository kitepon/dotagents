import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RENDER = join(ROOT, 'bin', 'render-current-docs.mjs');
const FIXTURE_README = '# 案内\n\n現行状態は生成ページを参照する。\n';
const FIXTURE_POINTER = '# 接続\n\n## 製品側の正本\n\n製品repoを参照する。\n';
const FIXTURE_SKILL = '# factory skill\n\n公開MCPへ接続し、製品repoを参照する。\n';
const FIXTURE_PRODUCT_CONTRACT = '# 統合台帳\n\n| ID / repo |\n|---|\n| alpha |\n';
const FIXTURE_HOST_MATRIX = '# host matrix\n\n接続状態だけを記録する。\n';
const FIXTURE_FACTORY_RUNBOOK = '# 工場CI\n\n製品の公開gateだけを呼ぶ。\n';
const FIXTURE_CODEX_FRAGMENT = '# Codex断片\n\n## gpt-connector\n\n公開entryだけを登録する。\n';
const FIXTURE_ORCHESTRATE_ROUTING = '# orchestrate\n\n公開skillから製品正本へ辿る。\n';

const REGISTRY = {
  schema: 'dotagents.document-registry.v4',
  fact_sources: {
    factory_current_state: 'lib/factory/deployment-contract.mjs',
    global_policy: 'shared/constitution.md',
  },
  generated_current_state: 'docs/factory-current-state.md',
  ownership_policy: {
    dotagents_owns: ['integration', 'product-pointer', 'factory-skill', 'policy'],
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
  compatibility_stub_paths: [],
  current_surface_policies: [
    {
      id: 'integration-contracts',
      path_regex: '^(?:docs/(?:factory-product-contracts|factory-host-product-matrix)\\.md|shared/runbooks/factory-ci\\.md)$',
      expected_role: 'integration',
      exact_sha256_by_path: {
        'docs/factory-product-contracts.md': digest(FIXTURE_PRODUCT_CONTRACT),
        'docs/factory-host-product-matrix.md': digest(FIXTURE_HOST_MATRIX),
        'shared/runbooks/factory-ci.md': digest(FIXTURE_FACTORY_RUNBOOK),
      },
      required_regexes: [],
      forbidden_regexes: [],
    },
    {
      id: 'product-pointer-contract',
      path_regex: '^docs/06_gpt-connector\\.md$',
      expected_role: 'product-pointer',
      exact_sha256_by_path: {
        'docs/06_gpt-connector.md': digest(FIXTURE_POINTER),
      },
      required_regexes: [],
      forbidden_regexes: [],
    },
    {
      id: 'factory-skill-contract',
      path_regex: '^claude/skills/gpt-connector/SKILL\\.md$',
      expected_role: 'factory-skill',
      exact_sha256_by_path: {
        'claude/skills/gpt-connector/SKILL.md': digest(FIXTURE_SKILL),
      },
      required_regexes: [],
      forbidden_regexes: [],
    },
    {
      id: 'readme-contract',
      path_regex: '^README\\.md$',
      expected_role: 'policy',
      exact_sha256_by_path: {
        'README.md': digest(FIXTURE_README),
      },
      required_regexes: ['現行状態'],
      forbidden_regexes: ['製品内部手順'],
    },
    {
      id: 'codex-fragment-contract',
      path_regex: '^docs/05_codex-fragments\\.md$',
      expected_role: 'policy',
      exact_sha256_by_path: {
        'docs/05_codex-fragments.md': digest(FIXTURE_CODEX_FRAGMENT),
      },
      required_regexes: [],
      forbidden_regexes: [],
    },
    {
      id: 'orchestrate-routing-contract',
      path_regex: '^codex/skills/orchestrate/SKILL\\.md$',
      expected_role: 'policy',
      exact_sha256_by_path: {
        'codex/skills/orchestrate/SKILL.md': digest(FIXTURE_ORCHESTRATE_ROUTING),
      },
      required_regexes: [],
      forbidden_regexes: [],
    },
  ],
  document_extensions: ['.md', '.mdc'],
  rules: [
    { id: 'state', kind: 'generated', owner_scope: 'dotagents', role: 'generated', path_regex: '^docs/factory-current-state\\.md$' },
    { id: 'evidence', kind: 'evidence', owner_scope: 'dotagents', role: 'evidence', path_regex: '^(?:docs/evidence/|evidence/|\\.lattice/todo/evidence/)' },
    { id: 'history', kind: 'history', owner_scope: 'dotagents', role: 'history', path_regex: '^docs/(?:archive/|adr/|wire-v[1-7]-design\\.md$)' },
    { id: 'contract', kind: 'contract', owner_scope: 'dotagents', role: 'integration', path_regex: '^docs/wire-v[0-9]+-design\\.md$' },
    {
      id: 'integration',
      kind: 'current',
      owner_scope: 'dotagents',
      role: 'integration',
      paths: ['docs/factory-product-contracts.md', 'docs/factory-host-product-matrix.md', 'shared/runbooks/factory-ci.md'],
    },
    { id: 'product-pointer', kind: 'current', owner_scope: 'dotagents', role: 'product-pointer', paths: ['docs/06_gpt-connector.md'] },
    { id: 'factory-skill', kind: 'current', owner_scope: 'dotagents', role: 'factory-skill', paths: ['claude/skills/gpt-connector/SKILL.md'] },
    {
      id: 'current',
      kind: 'current',
      owner_scope: 'dotagents',
      role: 'policy',
      paths: [
        'README.md',
        'shared/constitution.md',
        'docs/new-guide.md',
        'docs/present.md',
        'docs/05_codex-fragments.md',
        'codex/skills/orchestrate/SKILL.md',
      ],
    },
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
export const FACTORY_RUNNERS = Object.freeze([
  Object.freeze({ name: 'factory-linux-test', label: 'linux-workstation', fullCi: true }),
  Object.freeze({ name: 'factory-linux-ops', label: 'linux-server', fullCi: false }),
]);
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'current-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'archive'), { recursive: true });
  await mkdir(join(root, 'docs', 'evidence'), { recursive: true });
  await mkdir(join(root, 'lib', 'factory'), { recursive: true });
  await mkdir(join(root, 'shared', 'runbooks'), { recursive: true });
  await mkdir(join(root, 'claude', 'skills', 'gpt-connector'), { recursive: true });
  await mkdir(join(root, 'codex', 'skills', 'orchestrate'), { recursive: true });
  await writeFile(join(root, 'docs', 'document-registry.json'), `${JSON.stringify(REGISTRY, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'lib', 'factory', 'deployment-contract.mjs'), CONTRACT, 'utf8');
  await writeFile(join(root, 'shared', 'constitution.md'), '# 共通\n', 'utf8');
  await writeFile(join(root, 'docs', 'factory-product-contracts.md'), FIXTURE_PRODUCT_CONTRACT, 'utf8');
  await writeFile(join(root, 'docs', 'factory-host-product-matrix.md'), FIXTURE_HOST_MATRIX, 'utf8');
  await writeFile(join(root, 'docs', '06_gpt-connector.md'), FIXTURE_POINTER, 'utf8');
  await writeFile(join(root, 'docs', 'new-guide.md'), '# 登録済み案内\n', 'utf8');
  await writeFile(join(root, 'docs', 'present.md'), '# 存在\n', 'utf8');
  await writeFile(join(root, 'docs', '05_codex-fragments.md'), FIXTURE_CODEX_FRAGMENT, 'utf8');
  await writeFile(join(root, 'shared', 'runbooks', 'factory-ci.md'), FIXTURE_FACTORY_RUNBOOK, 'utf8');
  await writeFile(join(root, 'claude', 'skills', 'gpt-connector', 'SKILL.md'), FIXTURE_SKILL, 'utf8');
  await writeFile(join(root, 'codex', 'skills', 'orchestrate', 'SKILL.md'), FIXTURE_ORCHESTRATE_ROUTING, 'utf8');
  await writeFile(join(root, 'README.md'), FIXTURE_README, 'utf8');
  return root;
}

function run(root, mode, { baseRef = null, baseManifest = null, env = {} } = {}) {
  const args = [RENDER, mode, '--root', root];
  if (baseRef !== null) args.push('--base-ref', baseRef);
  if (baseManifest !== null) args.push('--base-manifest', baseManifest);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      DOCUMENT_REGISTRY_BASE_REF: '',
      ...env,
    },
  });
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function setArchivePaths(registry, paths) {
  const sorted = paths.toSorted();
  registry.archive_inventory.all_path_count = sorted.length;
  registry.archive_inventory.all_paths_sha256 = digest(`${sorted.join('\n')}\n`);
}

async function writeBaselineManifest(root, registry, documents, currentDocuments = []) {
  const path = join(root, 'immutability-baseline.json');
  const extensions = new Set(registry.document_extensions);
  const documentEntries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && extensions.has(extname(entry.name))) {
        const relativePath = relative(root, absolute).split(sep).join('/');
        const rule = registry.rules.find((candidate) =>
          candidate.paths?.includes(relativePath) ||
          (typeof candidate.path_regex === 'string' && new RegExp(candidate.path_regex, 'u').test(relativePath)));
        documentEntries.push({
          path: relativePath,
          kind: rule?.kind ?? null,
          role: rule?.role ?? null,
          rule: rule?.id ?? null,
          sha256: digest(await readFile(absolute)),
        });
      }
    }
  }
  await visit(root);
  documentEntries.sort((left, right) => left.path.localeCompare(right.path));
  const documentByPath = new Map(documentEntries.map((document) => [document.path, document]));
  const manifest = {
    schema: 'dotagents.document-immutability-baseline.v3',
    registry: structuredClone(registry),
    archive_roots: [...registry.archive_inventory.roots],
    document_entries: documentEntries,
    immutable_documents: documents.map((document) => ({
      path: document.path,
      type: document.type,
      kind: documentByPath.get(document.path)?.kind ?? (document.type === 'evidence' ? 'evidence' : 'history'),
      role: documentByPath.get(document.path)?.role ?? (document.type === 'evidence' ? 'evidence' : 'history'),
      rule: documentByPath.get(document.path)?.rule ?? null,
      sha256: digest(document.content),
    })),
    current_documents: currentDocuments.map((document) => {
      const entry = documentByPath.get(document.path);
      assert.ok(entry, `baseline current documentが存在しません: ${document.path}`);
      return {
        path: document.path,
        role: document.role,
        rule: document.rule ?? entry.rule,
        sha256: entry.sha256,
      };
    }),
    exact_surface_paths: registry.current_surface_policies
      .filter((policy) => policy.section_heading_regex === undefined && policy.line_contains_regex === undefined)
      .flatMap((policy) => Object.keys(policy.exact_sha256_by_path))
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort(),
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
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

test('role登録済みcurrent文書の手書き現行値を拒否する', async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, '--write').status, 0);
  await writeFile(join(root, 'docs', 'new-guide.md'), '# 案内\n\n現役wire v8を使う。\n', 'utf8');
  const result = run(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/new-guide\.md:3: current-wire/);
});

test('未登録documentをcurrent policyへ暗黙分類しない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'unregistered-guide.md'), '# 製品更新\n\n製品内部の更新手順をここへ置く。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未分類document: docs\/unregistered-guide\.md/);
});

test('current roleはcatch-all regexへ戻せない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const current = registry.rules.find((rule) => rule.id === 'current');
  delete current.paths;
  current.path_regex = '.*\\.(?:md|mdc)$';
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /current document ruleはclosed pathsで登録してください/);
});

test('Markdown symlinkでdocument分類を迂回できない', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsのsymlink作成権限に依存するためUnixで検証する');
  const root = await fixture(t);
  await symlink('present.md', join(root, 'docs', 'symlink-guide.md'));
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /document symlinkは許可されません: docs\/symlink-guide\.md/);
});

test('directory symlinkの配下へdocumentを隠せない', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsのsymlink作成権限に依存するためUnixで検証する');
  const root = await fixture(t);
  const target = await mkdtemp(join(tmpdir(), 'current-docs-linked-directory-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, 'hidden.md'), '# 隠した文書\n', 'utf8');
  await symlink(target, join(root, 'docs', 'linked-directory'));
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /document symlinkは許可されません: docs\/linked-directory/);
});

test('fact sourceのancestor symlinkをimport前に拒否する', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsのsymlink作成権限に依存するためUnixで検証する');
  const root = await fixture(t);
  const target = await mkdtemp(join(tmpdir(), 'current-docs-fact-source-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const importSentinel = join(target, 'imported.txt');
  await writeFile(
    join(target, 'deployment-contract.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(importSentinel)}, 'imported');\n${CONTRACT}`,
    'utf8',
  );
  await rm(join(root, 'lib', 'factory'), { recursive: true });
  await symlink(target, join(root, 'lib', 'factory'));
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /登録pathのsymlinkは許可されません: lib\/factory\/deployment-contract\.mjs/);
  await assert.rejects(readFile(importSentinel), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'docs', 'factory-current-state.md')), { code: 'ENOENT' });
});

test('registryの実path fieldはrepo-relativeだけを受け入れる', async (t) => {
  const cases = [
    ['fact source', (registry) => { registry.fact_sources.factory_current_state = '../outside.mjs'; }],
    ['generated path', (registry) => { registry.generated_current_state = '/tmp/factory-current-state.md'; }],
    ['rule paths', (registry) => { registry.rules.find((rule) => rule.id === 'current').paths[0] = '../README.md'; }],
    ['exact map key', (registry) => {
      registry.current_surface_policies[0].exact_sha256_by_path['../outside.md'] = digest('outside');
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const root = await fixture(subtest);
      const registryPath = join(root, 'docs', 'document-registry.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8'));
      mutate(registry);
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      const result = run(root, '--write');
      assert.equal(result.status, 2);
      assert.match(result.stderr, /fact sourceまたはgenerated pathが不正|ruleのpaths|current surface policyが不正/);
      await assert.rejects(readFile(join(root, 'docs', 'factory-current-state.md')), { code: 'ENOENT' });
    });
  }
});

test('write modeでも全検証が成功するまで生成物を書かない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'new-guide.md'), '# 案内\n\n現役wire v8を使う。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/new-guide\.md:3: current-wire/);
  await assert.rejects(readFile(join(root, 'docs', 'factory-current-state.md')), { code: 'ENOENT' });
});

test('archive rootそのものをsymlinkへ置換できない', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsのsymlink作成権限に依存するためUnixで検証する');
  const root = await fixture(t);
  await rm(join(root, 'docs', 'archive'), { recursive: true });
  await mkdir(join(root, 'archive-target'));
  await symlink(join(root, 'archive-target'), join(root, 'docs', 'archive'));
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /archive rootは実directoryでなければなりません/);
});

test('closed pathsを先行ruleでshadowしてrole検査を迂回できない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.rules.unshift({
    id: 'shadow',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    path_regex: '^README\\.md$',
  });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /current: role登録pathがshadowまたは重複しています: README\.md/);
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

test('Latticeの完了証拠はcurrent claimとして扱わない', async (t) => {
  const root = await fixture(t);
  const evidence = join(root, '.lattice', 'todo', 'evidence', 'product-document-autonomy');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'done.md'), '# 完了証拠\n\n工場の自作コア11製品を確認した。\n', 'utf8');
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

test('archive relocationのold_pathとnew_pathは一意でなければならない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.archive_relocations = [
    {
      old_path: 'docs/old.md',
      new_path: 'docs/archive/first.md',
      preserve_old_path: false,
      old_path_mode: 'removed',
      archive_sha256: digest('first'),
    },
    {
      old_path: 'docs/old.md',
      new_path: 'docs/archive/second.md',
      preserve_old_path: false,
      old_path_mode: 'removed',
      archive_sha256: digest('second'),
    },
  ];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /archive relocationのold_pathまたはnew_pathが重複/);
});

test('archive relocationはrepo内のarchive root配下だけを移動先にできる', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: '../outside.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest('# 偽装移設\n'),
  }];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const traversal = run(root, '--write');
  assert.equal(traversal.status, 2);
  assert.match(traversal.stderr, /archive relocationが不正/);

  registry.archive_relocations[0].new_path = 'docs/not-archive.md';
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const outsideRoot = run(root, '--write');
  assert.equal(outsideRoot.status, 2);
  assert.match(outsideRoot.stderr, /new_pathはarchive root配下/);
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

test('product-pointerのH1へ製品手順を隠せない', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', '06_gpt-connector.md'), '# 製品の更新手順\n\n## 製品側の正本\n\n製品repoを参照する。\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory-product|product-pointer-contract: 許可された本文のexact digest/);
});

test('product-pointerの許可heading本文へ製品手順を足せない', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs', '06_gpt-connector.md'),
    `${FIXTURE_POINTER.trimEnd()}\n製品を更新するには内部CLIを実行する。\n`,
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /product-pointer-contract: 許可された本文のexact digest/);
});

test('工場skillへ別表現の製品操作本文を足せない', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'claude', 'skills', 'gpt-connector', 'SKILL.md'),
    `${FIXTURE_SKILL.trimEnd()}\n接続後に内部sessionを再起動する。\n`,
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory-skill-contract: 許可された本文のexact digest/);
});

test('別sectionへ工場接続の製品操作本文を複製できない', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs', '05_codex-fragments.md'),
    `${FIXTURE_CODEX_FRAGMENT.trimEnd()}\n\n## 別の接続案内\n\n内部sessionを再起動する。\n`,
    'utf8',
  );
  await writeFile(
    join(root, 'codex', 'skills', 'orchestrate', 'SKILL.md'),
    `${FIXTURE_ORCHESTRATE_ROUTING.trimEnd()}\n\n## 補足\n\n製品内部commandを実行する。\n`,
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex-fragment-contract: 許可された本文のexact digest/);
  assert.match(result.stderr, /orchestrate-routing-contract: 許可された本文のexact digest/);
});

test('integration runbookへ製品内部手順を戻せない', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'shared', 'runbooks', 'factory-ci.md'),
    `${FIXTURE_FACTORY_RUNBOOK.trimEnd()}\n製品repoで内部build commandを実行する。\n`,
    'utf8',
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /integration-contracts: 許可された本文のexact digest/);
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

test('非Markdownのarchive追加もall path inventoryで拒否する', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'archive', 'unregistered.yaml'), 'state: historical\n', 'utf8');
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive全path集合に追加・移動・削除/);
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

test('新規relocationのarchive本文は比較基準のold_path blobと同一でなければならない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const oldContent = '# 比較基準の本文\n';
  const archiveContent = '# 別の本文\n';
  registry.rules.find((rule) => rule.id === 'current').paths.push('docs/old.md');
  await writeFile(join(root, 'docs', 'old.md'), oldContent, 'utf8');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, []);

  registry.rules.find((rule) => rule.id === 'current').paths =
    registry.rules.find((rule) => rule.id === 'current').paths.filter((path) => path !== 'docs/old.md');
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/old.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(archiveContent),
  }];
  setArchivePaths(registry, ['docs/archive/old.md']);
  await rm(join(root, 'docs', 'old.md'));
  await writeFile(join(root, 'docs', 'archive', 'old.md'), archiveContent, 'utf8');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/old\.md: archive relocationのdigestが比較基準のold_path本文と一致しません/);
});

test('新規relocationのnew_pathは比較基準に存在したpathを再利用できない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const content = '# 同じ本文\n';
  registry.rules.find((rule) => rule.id === 'current').paths.push('docs/old.md');
  setArchivePaths(registry, ['docs/archive/existing.md']);
  registry.archive_inventory.legacy_path_count = 1;
  registry.archive_inventory.legacy_paths_sha256 = digest('docs/archive/existing.md\n');
  await writeFile(join(root, 'docs', 'old.md'), content, 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'existing.md'), content, 'utf8');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, []);

  registry.rules.find((rule) => rule.id === 'current').paths =
    registry.rules.find((rule) => rule.id === 'current').paths.filter((path) => path !== 'docs/old.md');
  registry.archive_relocations = [{
    old_path: 'docs/old.md',
    new_path: 'docs/archive/existing.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(content),
  }];
  registry.archive_inventory.legacy_path_count = 0;
  registry.archive_inventory.legacy_paths_sha256 = digest('\n');
  await rm(join(root, 'docs', 'old.md'));
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/archive\/existing\.md: archive relocationのnew_pathは比較基準に存在してはいけません/);
});

test('新規relocationのold_pathは比較基準に実在しなければならない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const baseline = await writeBaselineManifest(root, registry, []);
  const content = '# 後から作った本文\n';
  registry.archive_relocations = [{
    old_path: 'docs/missing-at-base.md',
    new_path: 'docs/archive/late.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(content),
  }];
  setArchivePaths(registry, ['docs/archive/late.md']);
  await writeFile(join(root, 'docs', 'archive', 'late.md'), content, 'utf8');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/missing-at-base\.md: archive relocationのold_pathが比較基準に存在しません/);
});

test('compatibility stubの書き換えをdigestで拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 元本文\n';
  const stub = '# 履歴stub\n\n[本文](archive/old.md)\n';
  registry.rules.splice(-1, 0, {
    id: 'stub-history',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    paths: ['docs/old.md'],
  });
  registry.compatibility_stub_paths = ['docs/old.md'];
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

test('base manifestはarchive・stub・evidenceと台帳の同時改竄を拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 元本文\n';
  const stub = '# 履歴stub\n\n[本文](archive/old.md)\n';
  const evidence = '{"result":"original"}\n';
  registry.rules.splice(-1, 0, {
    id: 'stub-history',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    paths: ['docs/old.md'],
  });
  registry.compatibility_stub_paths = ['docs/old.md'];
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
  await writeFile(join(root, 'docs', 'old.md'), stub, 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'receipt.json'), evidence, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/archive/old.md', type: 'archive', content: archived },
    { path: 'docs/old.md', type: 'compatibility-stub', content: stub },
    { path: 'docs/evidence/receipt.json', type: 'evidence', content: evidence },
  ]);
  const baselineResult = run(root, '--write', { baseManifest: baseline });
  assert.equal(baselineResult.status, 0, baselineResult.stderr);

  const changedArchive = '# 改竄本文\n';
  const changedStub = '# 履歴stub\n\n[本文](archive/old.md)\n\n改竄\n';
  registry.archive_relocations[0].archive_sha256 = digest(changedArchive);
  registry.archive_relocations[0].old_path_sha256 = digest(changedStub);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'docs', 'archive', 'old.md'), changedArchive, 'utf8');
  await writeFile(join(root, 'docs', 'old.md'), changedStub, 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'receipt.json'), '{"result":"changed"}\n', 'utf8');
  const selfConsistent = run(root, '--check');
  assert.equal(selfConsistent.status, 0, selfConsistent.stderr);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive_relocations\[0\]の既存entry/);
  assert.match(result.stderr, /docs\/archive\/old\.md: 既存archiveの本文/);
  assert.match(result.stderr, /docs\/old\.md: 既存compatibility-stubの本文/);
  assert.match(result.stderr, /docs\/evidence\/receipt\.json: 既存evidenceの本文/);
});

test('base manifestは台帳・本文・inventoryを揃えた同時削除を拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const archivePath = join(root, 'docs', 'archive', 'old.md');
  const evidencePath = join(root, 'docs', 'evidence', 'receipt.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 元本文\n';
  const evidence = '{"result":"original"}\n';
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
  await writeFile(evidencePath, evidence, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/archive/old.md', type: 'archive', content: archived },
    { path: 'docs/evidence/receipt.json', type: 'evidence', content: evidence },
  ]);
  assert.equal(run(root, '--write', { baseManifest: baseline }).status, 0);

  registry.archive_relocations = [];
  setArchivePaths(registry, []);
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  await rm(archivePath);
  await rm(evidencePath);
  assert.equal(run(root, '--check').status, 0);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive_relocations\[0\]の既存entry/);
  assert.match(result.stderr, /docs\/archive\/old\.md: 既存archiveを削除・移動/);
  assert.match(result.stderr, /docs\/evidence\/receipt\.json: 既存evidenceを削除・移動/);
});

test('base manifestは非Markdown evidenceのsymlink置換を拒否する', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsのsymlink作成権限に依存するためUnixで検証する');
  const root = await fixture(t);
  const registry = JSON.parse(await readFile(join(root, 'docs', 'document-registry.json'), 'utf8'));
  const evidencePath = join(root, 'docs', 'evidence', 'receipt.json');
  const targetPath = join(root, 'receipt-target.json');
  const evidence = '{"result":"original"}\n';
  await writeFile(evidencePath, evidence, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/evidence/receipt.json', type: 'evidence', content: evidence },
  ]);
  assert.equal(run(root, '--write', { baseManifest: baseline }).status, 0);

  await writeFile(targetPath, evidence, 'utf8');
  await rm(evidencePath);
  await symlink(targetPath, evidencePath);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /document symlinkは許可されません: docs\/evidence\/receipt\.json/);
});

test('base manifestはcurrent本文・role登録・exact契約の同時削除を拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const baseline = await writeBaselineManifest(root, registry, [], [
    { path: 'README.md', role: 'policy' },
  ]);
  const generated = run(root, '--write', { baseManifest: baseline });
  assert.equal(generated.status, 0, generated.stderr);

  const currentRule = registry.rules.find((rule) => rule.id === 'current');
  currentRule.paths = currentRule.paths.filter((path) => path !== 'README.md');
  registry.current_surface_policies = registry.current_surface_policies
    .filter((policy) => policy.id !== 'readme-contract');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rm(join(root, 'README.md'));
  const selfConsistent = run(root, '--check');
  assert.equal(selfConsistent.status, 0, selfConsistent.stderr);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: 既存current documentのroleを変更・削除するには新しいarchive relocation/);
});

test('既存archiveへの新規relocation偽装ではcurrent削除を正当化できない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const archivePath = join(root, 'docs', 'archive', 'unrelated.md');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const archived = '# 無関係な既存履歴\n';
  const archivePaths = ['docs/archive/unrelated.md'];
  setArchivePaths(registry, archivePaths);
  registry.archive_inventory.legacy_path_count = 1;
  registry.archive_inventory.legacy_paths_sha256 = digest(`${archivePaths.join('\n')}\n`);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(archivePath, archived, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/archive/unrelated.md', type: 'archive', content: archived },
  ], [
    { path: 'README.md', role: 'policy' },
  ]);
  assert.equal(run(root, '--write', { baseManifest: baseline }).status, 0);

  const currentRule = registry.rules.find((rule) => rule.id === 'current');
  currentRule.paths = currentRule.paths.filter((path) => path !== 'README.md');
  registry.current_surface_policies = registry.current_surface_policies
    .filter((policy) => policy.id !== 'readme-contract');
  registry.archive_relocations = [{
    old_path: 'README.md',
    new_path: 'docs/archive/unrelated.md',
    preserve_old_path: false,
    old_path_mode: 'removed',
    archive_sha256: digest(archived),
  }];
  registry.archive_inventory.legacy_path_count = 0;
  registry.archive_inventory.legacy_paths_sha256 = digest('\n');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rm(join(root, 'README.md'));
  const selfConsistent = run(root, '--check');
  assert.equal(selfConsistent.status, 0, selfConsistent.stderr);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: 既存current documentのroleを変更・削除するには新しいarchive relocation/);
  assert.match(result.stderr, /README\.md: 既存の全文exact保護対象を削除するには新しいarchive relocation/);
});

test('base manifestはpolicy roleの全文exact保護だけを削除する迂回を拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const baseline = await writeBaselineManifest(root, registry, []);
  assert.equal(run(root, '--write', { baseManifest: baseline }).status, 0);

  registry.current_surface_policies = registry.current_surface_policies
    .filter((policy) => policy.id !== 'codex-fragment-contract');
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const selfConsistent = run(root, '--check');
  assert.equal(selfConsistent.status, 0, selfConsistent.stderr);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/05_codex-fragments\.md: 既存の全文exact保護対象を削除/);
});

test('base manifestはcompatibility stubのcurrent再分類を拒否する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const stub = '# 互換stub\n';
  registry.rules.splice(-1, 0, {
    id: 'stub-history',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    paths: ['docs/old.md'],
  });
  registry.compatibility_stub_paths = ['docs/old.md'];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'docs', 'old.md'), stub, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/old.md', type: 'compatibility-stub', content: stub },
  ]);
  assert.equal(run(root, '--write', { baseManifest: baseline }).status, 0);

  const stubRule = registry.rules.find((rule) => rule.id === 'stub-history');
  stubRule.kind = 'current';
  stubRule.role = 'policy';
  registry.compatibility_stub_paths = [];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const selfConsistent = run(root, '--check');
  assert.equal(selfConsistent.status, 0, selfConsistent.stderr);
  const result = run(root, '--check', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/old\.md: 既存compatibility-stubのhistory分類を変更できません/);
  assert.match(result.stderr, /docs\/old\.md: 既存compatibility stubの台帳登録を削除できません/);
});

test('v3からv4への初回移行は明示8件だけを分類変更として許可する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const v4 = JSON.parse(await readFile(registryPath, 'utf8'));
  v4.rules.find((rule) => rule.id === 'integration').id = 'factory-integration-contracts';
  v4.rules.find((rule) => rule.id === 'factory-skill').id = 'factory-product-skills';
  v4.rules.find((rule) => rule.id === 'current').id = 'current-guidance';
  await writeFile(registryPath, `${JSON.stringify(v4, null, 2)}\n`, 'utf8');
  assert.equal(run(root, '--write').status, 0);

  const v3 = structuredClone(v4);
  v3.schema = 'dotagents.document-registry.v3';
  const integration = v3.rules.find((rule) => rule.id === 'factory-integration-contracts');
  delete integration.paths;
  integration.path_regex = '^docs/(?:factory-product-contracts|factory-host-product-matrix)\\.md$';
  v3.rules = v3.rules.filter((rule) => rule.id !== 'factory-product-skills');
  const current = v3.rules.find((rule) => rule.id === 'current-guidance');
  delete current.paths;
  current.path_regex = '.*\\.(?:md|mdc)$';
  await writeFile(registryPath, `${JSON.stringify(v3, null, 2)}\n`, 'utf8');
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'v3 baseline'],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  await writeFile(registryPath, `${JSON.stringify(v4, null, 2)}\n`, 'utf8');
  const allowed = run(root, '--check', { baseRef: 'HEAD' });
  assert.equal(allowed.status, 0, allowed.stderr);

  const unauthorized = structuredClone(v4);
  const currentRule = unauthorized.rules.find((rule) => rule.id === 'current-guidance');
  currentRule.paths = currentRule.paths.filter((path) => path !== 'docs/present.md');
  unauthorized.rules.splice(unauthorized.rules.indexOf(currentRule), 0, {
    id: 'unauthorized-policy-registration',
    kind: 'current',
    owner_scope: 'dotagents',
    role: 'policy',
    paths: ['docs/present.md'],
  });
  await writeFile(registryPath, `${JSON.stringify(unauthorized, null, 2)}\n`, 'utf8');
  const rejected = run(root, '--check', { baseRef: 'HEAD' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /docs\/present\.md: 既存current documentのroleを変更・削除/);
});

test('immutable Markdownはrule id・role・登録を基準から変更できない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const content = '# 固定証拠\n';
  await writeFile(join(root, 'docs', 'evidence', 'receipt.md'), content, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/evidence/receipt.md', type: 'evidence', content },
  ]);
  registry.rules.find((rule) => rule.id === 'evidence').id = 'renamed-evidence-rule';
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/evidence\/receipt\.md: 既存evidenceの分類を変更できません/);
});

test('非Markdown evidenceもevidence roleから再分類できない', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const content = '{"result":"fixed"}\n';
  await writeFile(join(root, 'docs', 'evidence', 'receipt.json'), content, 'utf8');
  const baseline = await writeBaselineManifest(root, registry, [
    { path: 'docs/evidence/receipt.json', type: 'evidence', content },
  ]);
  registry.rules.unshift({
    id: 'json-history-override',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    path_regex: '^docs/evidence/.*\\.json$',
  });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const result = run(root, '--write', { baseManifest: baseline });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/evidence\/receipt\.json: 既存evidenceの分類を変更できません/);
});

test('git base refからJSON evidenceも含むimmutable baselineを復元する', async (t) => {
  const root = await fixture(t);
  const evidencePath = join(root, 'docs', 'evidence', 'receipt.json');
  await writeFile(evidencePath, '{"result":"original"}\n', 'utf8');
  assert.equal(run(root, '--write').status, 0);
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(evidencePath, '{"result":"changed"}\n', 'utf8');
  const result = run(root, '--check', { baseRef: 'HEAD' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/evidence\/receipt\.json: 既存evidenceの本文/);
});

test('v4 git baseでも明示compatibility stubの保護を次回以降へ継続する', async (t) => {
  const root = await fixture(t);
  const registryPath = join(root, 'docs', 'document-registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const stubPath = join(root, 'docs', 'old.md');
  registry.compatibility_stub_paths = ['docs/old.md'];
  registry.rules.splice(-1, 0, {
    id: 'stub-history',
    kind: 'history',
    owner_scope: 'dotagents',
    role: 'history',
    paths: ['docs/old.md'],
  });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(stubPath, '# 互換stub\n', 'utf8');
  assert.equal(run(root, '--write').status, 0);
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  registry.compatibility_stub_paths = [];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(stubPath, '# 改変した互換stub\n', 'utf8');
  const result = run(root, '--check', { baseRef: 'HEAD' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/old\.md: 既存compatibility-stubの本文/);
  assert.match(result.stderr, /docs\/old\.md: 既存compatibility stubの台帳登録を削除/);
});

test('GitHub Actionsで比較基準が欠落したらfail loudにする', async (t) => {
  const root = await fixture(t);
  const result = run(root, '--check', {
    env: { GITHUB_ACTIONS: 'true', DOCUMENT_REGISTRY_BASE_REF: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GitHub ActionsではDOCUMENT_REGISTRY_BASE_REFまたは--base-refが必須/);
});

test('GitHub Actionsではローカルfixture用base manifestを比較基準にできない', async (t) => {
  const root = await fixture(t);
  const registry = JSON.parse(await readFile(join(root, 'docs', 'document-registry.json'), 'utf8'));
  const baseline = await writeBaselineManifest(root, registry, []);
  const result = run(root, '--check', {
    baseManifest: baseline,
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GitHub Actionsではローカルfixture用--base-manifestを使用できません/);
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
  registry.compatibility_stub_paths = ['docs/old.md'];
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
  assert.equal(registry.schema, 'dotagents.document-registry.v4');
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
  assert.equal(registry.rules.some((rule) => rule.path_regex === '.*\\.(?:md|mdc)$'), false);
  const factorySkill = registry.rules.find((rule) => rule.id === 'factory-product-skills');
  assert.equal(factorySkill?.role, 'factory-skill');
  assert.deepEqual(registry.compatibility_stub_paths, [
    'docs/plan_callout-hooks.md',
    'docs/plan_canon-zerobase-audit.md',
    'docs/plan_elastic-orchestrator.md',
    'docs/plan_factory-master.md',
    'docs/plan_gpt56-rewiring.md',
    'docs/plan_lattice-session-context-hook.md',
    'docs/plan_observer-core-integration.md',
    'docs/plan_peertable-onboarding.md',
    'docs/plan_peertable-wire-v7-execution.md',
  ]);
  const latticeEvidencePath = '.lattice/todo/evidence/product-document-autonomy/done.md';
  const latticeEvidenceRule = registry.rules.find((rule) => new RegExp(rule.path_regex, 'u').test(latticeEvidencePath));
  assert.equal(latticeEvidenceRule?.id, 'immutable-evidence');
  assert.equal(latticeEvidenceRule?.kind, 'evidence');
  const fixedHistory = registry.rules.find((rule) => rule.id === 'fixed-path-history-and-stubs');
  const regex = new RegExp(fixedHistory.path_regex, 'u');
  for (const path of [
    'docs/plan_elastic-orchestrator.md',
    'docs/codex-native-routing-repair.md',
    'docs/elastic-orchestrator-writer-packet-admission.md',
  ]) assert.match(path, regex);
  assert.match('docs/plan_factory-master.md', regex);
});

test('工場CIはevent別の比較基準を全document checkへ渡す', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'factory-full-ci.yml'), 'utf8');
  assert.match(workflow, /runs-on: \[self-hosted, factory, linux-workstation\]/);
  assert.match(workflow, /\["macos-native","linux-workstation","windows-native"\]/);
  assert.doesNotMatch(workflow, /linux-server/);
  assert.equal(workflow.match(/fetch-depth: 0/g)?.length, 2);
  assert.match(workflow, /EVENT_NAME" == pull_request[\s\S]{0,120}base="\$BASE_SHA"/);
  assert.match(workflow, /EVENT_NAME" == push[\s\S]{0,120}base="\$BEFORE_SHA"/);
  assert.match(workflow, /EVENT_NAME" == workflow_dispatch[\s\S]{0,180}base="\$DISPATCH_BASE"/);
  assert.ok(workflow.indexOf('GITHUB_REF" == refs/tags/*') < workflow.indexOf('EVENT_NAME" == push'));
  assert.match(workflow, /base=\$\(git rev-parse --verify "\$base\^\{commit\}"\)/);
  assert.match(workflow, /git merge-base --is-ancestor "\$base" "\$GITHUB_SHA"/);
  assert.match(workflow, /base" == "\$GITHUB_SHA"/);
  assert.match(workflow, /comparison_base: \$\{\{ steps\.changes\.outputs\.comparison_base \}\}/);
  assert.match(workflow, /DOCUMENT_REGISTRY_BASE_REF: \$\{\{ steps\.changes\.outputs\.comparison_base \}\}/);
  assert.match(workflow, /DOCUMENT_REGISTRY_BASE_REF: \$\{\{ needs\.classify\.outputs\.comparison_base \}\}/);
  assert.match(workflow, /CI comparison base is required and must resolve to a commit/);
  const entry = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(entry, /^\s+- linux-server$/m);
  assert.match(entry, /comparison_base:[\s\S]{0,160}required: true/);
  assert.match(entry, /comparison_base: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.comparison_base \|\| '' \}\}/);
  const makefile = await readFile(join(ROOT, 'Makefile'), 'utf8');
  assert.match(makefile, /GITHUB_ACTIONS" = "true"[\s\S]{0,120}DOCUMENT_REGISTRY_BASE_REF/);
  assert.match(makefile, /render-current-docs\.mjs --check --base-ref "\$\$\{DOCUMENT_REGISTRY_BASE_REF:-HEAD\}"/);
  const missingBase = spawnSync('make', ['lint-current-docs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      DOCUMENT_REGISTRY_BASE_REF: '',
    },
  });
  assert.equal(missingBase.status, 2);
  assert.match(missingBase.stderr, /DOCUMENT_REGISTRY_BASE_REF is required in GitHub Actions/);
});

test('一般policyは製品内部のSpotter契約とLattice schema版を再掲しない', async () => {
  const policyPaths = [
    'README.md',
    'docs/01_project-layout.md',
    'docs/03_settings-fragments.md',
    'docs/05_codex-fragments.md',
  ];
  const policy = new Map(await Promise.all(policyPaths.map(async (path) => [
    path,
    await readFile(join(ROOT, path), 'utf8'),
  ])));
  const spotterPolicy = [...policy.values()].join('\n');

  assert.doesNotMatch(spotterPolicy, /auditor[ -]context(?:が|を)既定ON/u);
  assert.doesNotMatch(spotterPolicy, /Spotter marker v2|Spotter 3 hook|Claude 5 hook/u);
  assert.doesNotMatch(spotterPolicy, /user-level Codex hook 3本|spotter\.hook_event\.v1/u);
  assert.doesNotMatch(spotterPolicy, /installed \/ compatible \/ canonical|configured-unverified/u);
  for (const [path, content] of policy) {
    assert.match(content, /https:\/\/github\.com\/kitepon\/Spotter#install/u, `${path} がSpotter製品正本を参照していません`);
  }

  const latticePolicy = `${policy.get('docs/03_settings-fragments.md')}\n${policy.get('docs/05_codex-fragments.md')}`;
  assert.doesNotMatch(latticePolicy, /lattice\.todo_status_result\.v[0-9]+/u);
  assert.equal((latticePolicy.match(/lib\/lattice-hook\.py/g) ?? []).length >= 2, true);
});

test('一般policyはLattice hookの対応hostと内部契約を再掲しない', async () => {
  const paths = ['README.md', 'docs/03_settings-fragments.md'];
  for (const path of paths) {
    const content = await readFile(join(ROOT, path), 'utf8');
    assert.match(content, /github\.com\/kitepon\/Lattice\/blob\/main\/docs\/01_integration-package\.md#L116-L121/u);
    assert.doesNotMatch(content, /lattice hooks install --host claude\|codex|Lattice 0\.40\.0\+|Cursor hostも増やさない/u);
  }
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^lattice hooks install --host cursor$/mu);
  assert.match(readme, /Caveat \/ Spotterの公開diagnostics、Latticeの公開hook status/u);
  assert.match(readme, /fresh factory reporterとdelivery/u);
  assert.doesNotMatch(readme, /各製品の公開diagnosticsが示す配線結果/u);
  assert.match(readme, /上記4つの工場設定applierの `--apply`/u);
});

test('一般policyはCaveatとThroughlineの製品内部手順を再掲しない', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  const settings = await readFile(join(ROOT, 'docs', '03_settings-fragments.md'), 'utf8');
  const grok = await readFile(join(ROOT, 'docs', '07_grok-fragments.md'), 'utf8');
  const contracts = await readFile(join(ROOT, 'docs', 'factory-product-contracts.md'), 'utf8');
  const installer = await readFile(join(ROOT, 'install.sh'), 'utf8');
  const caveatInternals = /Caveat-(?:Private|Public)|caveat (?:sync|publish|codex-hook install)|~\/\.caveat\/own|gh auth (?:switch|setup-git)|\*\.private\.md/u;
  const throughlineOutputs = /~\/\.grok\/hooks\/throughline\.json|throughline\.mjs|絶対 node|sc-detail|tl-trim|~\/\.codex\/skills\/throughline/u;

  assert.doesNotMatch(readme, caveatInternals);
  assert.match(readme, /`caveat mcp-server` と `caveat factory-diagnostics --json` の公開面だけを呼ぶ/u);
  assert.match(readme, /https:\/\/github\.com\/kitepon\/Caveat#readme/u);
  assert.match(readme, /^caveat init --sync --yes <\/dev\/null$/mu);
  assert.doesNotMatch(readme, /罠DBは v0\.15\+/u);
  assert.doesNotMatch(settings, /caveat の UserPromptSubmit \/ Stop hook/u);
  assert.match(settings, /https:\/\/github\.com\/kitepon\/Caveat#readme/u);
  assert.doesNotMatch(installer, /pre-v0\.15|Caveat-(?:Private|Public)|~\/\.caveat\/own/u);
  assert.match(installer, /Caveat product setup owns current state/u);

  assert.doesNotMatch(readme, throughlineOutputs);
  assert.doesNotMatch(grok, throughlineOutputs);
  assert.match(readme, /^throughline install$/mu);
  assert.match(readme, /https:\/\/github\.com\/kitepon\/Throughline#in-30-seconds/u);
  assert.match(grok, /https:\/\/github\.com\/kitepon\/Throughline#in-30-seconds/u);

  assert.match(contracts, /dotagentsが製品publishを実行する場合/u);
  assert.match(contracts, /工場側の共通git安全条件/u);
  assert.match(contracts, /製品release gateの定義ではない/u);
});
