#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString as markdownToString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment } from 'parse5';
import { parseSrcset } from 'srcset';

const REGISTRY_PATH = 'docs/document-registry.json';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const KINDS = new Set(['generated', 'current', 'contract', 'history', 'evidence']);
const ROLES = new Set(['integration', 'product-pointer', 'factory-skill', 'policy', 'generated', 'history', 'evidence']);
const CLOSED_OWNERSHIP_ROLES = new Set(['integration', 'product-pointer', 'factory-skill']);
const BASELINE_SCHEMA = 'dotagents.document-immutability-baseline.v3';
const IMMUTABLE_EVIDENCE_ROOTS = ['docs/evidence', 'evidence', '.lattice/todo/evidence'];
const IMMUTABLE_EVIDENCE_PATHS = [/^rag\/.+\/raw\//u];
const INITIAL_V4_CLASSIFICATION_MIGRATIONS = new Map([
  ...[
    '.lattice/todo/evidence/product-document-autonomy/pda-003/0f83721d3b8a80cc041c9f919e2347caaf3d2a06472a96f0049c728864ed2225.md',
    '.lattice/todo/evidence/product-document-autonomy/pda-004/602ebd2f99f7ba3e1dde80a16133e2ddd998ec86eb7931076815c472d430301f.md',
    '.lattice/todo/evidence/product-document-autonomy/pda-005/62643ac5294dfb0032ba3b66b14f846b18f63496b5db6d307ab99e6dbd5392bf.md',
  ].map((path) => [path, {
    from: { kind: 'current', role: 'policy', rule: 'current-guidance' },
    to: { kind: 'evidence', role: 'evidence', rule: 'immutable-evidence' },
  }]),
  ...[
    'claude/skills/gpt-connector/SKILL.md',
    'codex/skills/gpt-connector/SKILL.md',
    'cursor/skills/gpt-connector/SKILL.md',
    'grok/skills/gpt-connector/SKILL.md',
  ].map((path) => [path, {
    from: { kind: 'current', role: 'policy', rule: 'current-guidance' },
    to: { kind: 'current', role: 'factory-skill', rule: 'factory-product-skills' },
  }]),
  ['shared/runbooks/factory-ci.md', {
    from: { kind: 'current', role: 'policy', rule: 'current-guidance' },
    to: { kind: 'current', role: 'integration', rule: 'factory-integration-contracts' },
  }],
]);
const V1_COMPATIBILITY_STUB_PATHS = [
  'docs/plan_callout-hooks.md',
  'docs/plan_elastic-orchestrator.md',
  'docs/plan_gpt56-rewiring.md',
  'docs/plan_observer-core-integration.md',
  'docs/plan_peertable-onboarding.md',
  'docs/plan_peertable-wire-v7-execution.md',
];
const MANUAL_CURRENT_CLAIMS = [
  { id: 'product-count', regex: /\d+製品/gu },
  { id: 'current-wire', regex: /(?:現役(?:factory )?wire|現役は[^\n]{0,80}wire|本番BugHubの入口はwire)\s*v\d+/giu },
  { id: 'deployment-summary', regex: /managed \d+ IDとcurrent wire v\d+の\d+ ID/gu },
  { id: 'fresh-wire', regex: /\bfresh(?:\s+wire)?\s+v\d+\b/giu },
  { id: 'rollback-version', regex: /^(?=[^\n]*(?:host別rollback|\brollback(?:先|(?:\s+|は)[^\n]{0,40}(?:wire|major|scheduler|reporter|endpoint))))(?=[^\n]*\bv\d+\b)[^\n]+$/gimu },
];

function usage() {
  return 'usage: render-current-docs (--write|--check) [--root <path>] [--base-ref <git-ref>|--base-manifest <path>]';
}

function parseArgs(argv) {
  let mode = null;
  let root = resolve(import.meta.dirname, '..');
  let baseRef = null;
  let baseManifest = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write' || arg === '--check') {
      if (mode !== null) throw new Error(usage());
      mode = arg.slice(2);
    } else if (arg === '--root') {
      index += 1;
      if (index >= argv.length) throw new Error(usage());
      root = resolve(argv[index]);
    } else if (arg === '--base-ref') {
      index += 1;
      if (index >= argv.length || baseRef !== null) throw new Error(usage());
      baseRef = argv[index];
    } else if (arg === '--base-manifest') {
      index += 1;
      if (index >= argv.length || baseManifest !== null) throw new Error(usage());
      baseManifest = resolve(argv[index]);
    } else {
      throw new Error(usage());
    }
  }
  if (mode === null) throw new Error(usage());
  baseRef ??= process.env.DOCUMENT_REGISTRY_BASE_REF?.trim() || null;
  if (baseRef !== null && baseManifest !== null) throw new Error(usage());
  if (process.env.GITHUB_ACTIONS === 'true' && baseManifest !== null) {
    throw new Error('GitHub Actionsではローカルfixture用--base-manifestを使用できません');
  }
  if (process.env.GITHUB_ACTIONS === 'true' && baseRef === null && baseManifest === null) {
    throw new Error('GitHub ActionsではDOCUMENT_REGISTRY_BASE_REFまたは--base-refが必須です');
  }
  return { mode, root, baseRef, baseManifest };
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

function isRepositoryRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
    !path.startsWith('/') && !path.includes('\0') &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'));
}

function pathIsWithinRoot(path, root) {
  return path.startsWith(`${root}/`);
}

function isImmutableEvidencePath(path) {
  return IMMUTABLE_EVIDENCE_ROOTS.some((root) => path.startsWith(`${root}/`)) ||
    IMMUTABLE_EVIDENCE_PATHS.some((pattern) => pattern.test(path));
}

async function assertRealPath(root, path, { allowMissing = false, expectedType = 'file' } = {}) {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`document rootは実directoryでなければなりません: ${root}`);
  }
  const segments = path.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return;
      if (error.code === 'ENOENT') throw new Error(`登録pathが存在しません: ${path}`);
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`登録pathのsymlinkは許可されません: ${path}`);
    }
    const isLast = index === segments.length - 1;
    if (!isLast && !stats.isDirectory()) {
      throw new Error(`登録pathのancestorがdirectoryではありません: ${path}`);
    }
    if (isLast && expectedType === 'file' && !stats.isFile()) {
      throw new Error(`登録pathは実fileでなければなりません: ${path}`);
    }
    if (isLast && expectedType === 'directory' && !stats.isDirectory()) {
      throw new Error(`登録pathは実directoryでなければなりません: ${path}`);
    }
  }
}

async function validateConfiguredPaths(root, registry) {
  const requiredFiles = new Set([
    ...Object.values(registry.fact_sources),
    ...registry.rules.flatMap((rule) => rule.paths ?? []),
    ...registry.current_surface_policies.flatMap((policy) => Object.keys(policy.exact_sha256_by_path)),
  ]);
  for (const path of requiredFiles) await assertRealPath(root, path);
  await assertRealPath(root, registry.generated_current_state, { allowMissing: true });
  for (const path of registry.archive_inventory.roots) {
    try {
      await assertRealPath(root, path, { expectedType: 'directory' });
    } catch (error) {
      throw new Error(`archive rootは実directoryでなければなりません: ${path}: ${error.message}`);
    }
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, path);
}

async function listDocuments(root, extensions) {
  const documents = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(`document symlinkは許可されません: ${normalizePath(relative(root, absolute))}`);
      }
      else if (entry.isFile() && extensions.has(extname(entry.name))) {
        documents.push(normalizePath(relative(root, absolute)));
      }
    }
  }
  await visit(root);
  return documents.sort();
}

async function listFilesUnderRoots(root, roots) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(`archive symlinkは許可されません: ${normalizePath(relative(root, absolute))}`);
      } else if (entry.isFile()) {
        files.push(normalizePath(relative(root, absolute)));
      }
    }
  }
  for (const archiveRoot of roots) {
    const archivePath = join(root, archiveRoot);
    const stats = await lstat(archivePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`archive rootは実directoryでなければなりません: ${archiveRoot}`);
    }
    await visit(archivePath);
  }
  return files.sort();
}

function compileRegistry(registry) {
  if (registry?.schema !== 'dotagents.document-registry.v4') throw new Error('document registry schemaが不正です');
  if (!Array.isArray(registry.document_extensions) || registry.document_extensions.length === 0) {
    throw new Error('document_extensionsが不正です');
  }
  const extensions = new Set(registry.document_extensions);
  if (typeof registry.fact_sources !== 'object' || registry.fact_sources === null ||
    Object.keys(registry.fact_sources).length === 0 ||
    Object.values(registry.fact_sources).some((path) => !isRepositoryRelativePath(path)) ||
    !isRepositoryRelativePath(registry.generated_current_state)) {
    throw new Error('document registryのfact sourceまたはgenerated pathが不正です');
  }
  if (!Array.isArray(registry.rules) || registry.rules.length === 0) throw new Error('document registry rulesが不正です');
  const rules = registry.rules.map((rule) => {
    const hasRegex = typeof rule.path_regex === 'string';
    const hasPaths = Array.isArray(rule.paths) && rule.paths.length > 0 &&
      rule.paths.every((path) => typeof path === 'string' && path.length > 0);
    if (typeof rule.id !== 'string' || !KINDS.has(rule.kind) || hasRegex === hasPaths ||
      rule.owner_scope !== 'dotagents' || !ROLES.has(rule.role)) {
      throw new Error('document registry ruleが不正です');
    }
    if (hasPaths && (rule.paths.some((path) => !isRepositoryRelativePath(path)) ||
      new Set(rule.paths).size !== rule.paths.length)) {
      throw new Error(`document registry ruleのpathsが重複しています: ${rule.id}`);
    }
    if (rule.kind === 'current' && !hasPaths) {
      throw new Error(`current document ruleはclosed pathsで登録してください: ${rule.id}`);
    }
    return {
      ...rule,
      regex: hasRegex ? new RegExp(rule.path_regex, 'u') : null,
      pathSet: hasPaths ? new Set(rule.paths) : null,
    };
  });
  const ownership = registry.ownership_policy;
  if (!ownership || !Array.isArray(ownership.dotagents_owns) || !Array.isArray(ownership.product_repo_owns) ||
    !Array.isArray(ownership.product_contract_allowed_fields) || !Array.isArray(ownership.product_contract_table_columns) ||
    typeof ownership.product_contract_column_fields !== 'object' || !Array.isArray(ownership.product_pointer_allowed_headings) ||
    !Array.isArray(ownership.product_pointer_forbidden_headings)) {
    throw new Error('document registry ownership policyが不正です');
  }
  const fieldsFromColumns = ownership.product_contract_table_columns.flatMap((column) =>
    ownership.product_contract_column_fields[column] ?? []);
  if (JSON.stringify(fieldsFromColumns) !== JSON.stringify(ownership.product_contract_allowed_fields)) {
    throw new Error('製品統合台帳のcolumnと許可fieldが不整合です');
  }
  if (!Array.isArray(registry.archive_relocations)) throw new Error('archive_relocationsが不正です');
  const oldPaths = new Set();
  const newPaths = new Set();
  for (const relocation of registry.archive_relocations) {
    if (!isRepositoryRelativePath(relocation?.old_path) || !isRepositoryRelativePath(relocation?.new_path) ||
      !extensions.has(extname(relocation.old_path)) || !extensions.has(extname(relocation.new_path)) ||
      typeof relocation?.preserve_old_path !== 'boolean' ||
      !['removed', 'compatibility-stub', 'current-replacement'].includes(relocation?.old_path_mode) ||
      !/^[0-9a-f]{64}$/u.test(relocation?.archive_sha256 ?? '')) {
      throw new Error('archive relocationが不正です');
    }
    if (relocation.old_path === relocation.new_path || oldPaths.has(relocation.old_path) || newPaths.has(relocation.new_path)) {
      throw new Error('archive relocationのold_pathまたはnew_pathが重複しています');
    }
    oldPaths.add(relocation.old_path);
    newPaths.add(relocation.new_path);
    if ((relocation.old_path_mode === 'removed') === relocation.preserve_old_path) {
      throw new Error('archive relocationのold_path_modeとpreserve_old_pathが不整合です');
    }
    if (relocation.old_path_mode === 'compatibility-stub' &&
      !/^[0-9a-f]{64}$/u.test(relocation?.old_path_sha256 ?? '')) {
      throw new Error('compatibility stubのdigestが不正です');
    }
  }
  if (!registry.archive_inventory || !Array.isArray(registry.archive_inventory.roots) ||
    registry.archive_inventory.roots.length === 0 ||
    registry.archive_inventory.roots.some((path) => !isRepositoryRelativePath(path)) ||
    new Set(registry.archive_inventory.roots).size !== registry.archive_inventory.roots.length ||
    !Number.isInteger(registry.archive_inventory.all_path_count) ||
    !/^[0-9a-f]{64}$/u.test(registry.archive_inventory.all_paths_sha256 ?? '') ||
    !Number.isInteger(registry.archive_inventory.legacy_path_count) ||
    !/^[0-9a-f]{64}$/u.test(registry.archive_inventory.legacy_paths_sha256 ?? '')) {
    throw new Error('archive inventoryが不正です');
  }
  for (const relocation of registry.archive_relocations) {
    if (!registry.archive_inventory.roots.some((root) => pathIsWithinRoot(relocation.new_path, root))) {
      throw new Error(`archive relocationのnew_pathはarchive root配下へ置いてください: ${relocation.new_path}`);
    }
  }
  if (!Array.isArray(registry.compatibility_stub_paths) ||
    registry.compatibility_stub_paths.some((path) => !isRepositoryRelativePath(path)) ||
    new Set(registry.compatibility_stub_paths).size !== registry.compatibility_stub_paths.length) {
    throw new Error('compatibility_stub_pathsが不正です');
  }
  for (const relocation of registry.archive_relocations) {
    if (relocation.old_path_mode === 'compatibility-stub' &&
      !registry.compatibility_stub_paths.includes(relocation.old_path)) {
      throw new Error(`compatibility stubを明示登録してください: ${relocation.old_path}`);
    }
  }
  if (!Array.isArray(registry.current_surface_policies) || registry.current_surface_policies.length === 0) {
    throw new Error('current surface policyが不正です');
  }
  const surfacePolicies = registry.current_surface_policies.map((policy) => {
    if (typeof policy?.id !== 'string' || typeof policy?.path_regex !== 'string' ||
      !ROLES.has(policy.expected_role) ||
      !Array.isArray(policy.required_regexes) || !Array.isArray(policy.forbidden_regexes) ||
      typeof policy.exact_sha256_by_path !== 'object' || policy.exact_sha256_by_path === null ||
      Object.keys(policy.exact_sha256_by_path).length === 0 ||
      Object.keys(policy.exact_sha256_by_path).some((path) => !isRepositoryRelativePath(path)) ||
      Object.values(policy.exact_sha256_by_path).some((digest) => !/^[0-9a-f]{64}$/u.test(digest)) ||
      (policy.section_heading_regex !== undefined && typeof policy.section_heading_regex !== 'string') ||
      (policy.line_contains_regex !== undefined && typeof policy.line_contains_regex !== 'string') ||
      (policy.section_heading_regex !== undefined && policy.line_contains_regex !== undefined)) {
      throw new Error('current surface policyが不正です');
    }
    return {
      ...policy,
      pathRegex: new RegExp(policy.path_regex, 'u'),
      requiredRegexes: policy.required_regexes.map((regex) => new RegExp(regex, 'iu')),
      forbiddenRegexes: policy.forbidden_regexes.map((regex) => new RegExp(regex, 'iu')),
      sectionHeadingRegex: policy.section_heading_regex === undefined
        ? null : new RegExp(policy.section_heading_regex, 'u'),
      lineContainsRegex: policy.line_contains_regex === undefined
        ? null : new RegExp(policy.line_contains_regex, 'u'),
    };
  });
  if (rules.some((rule) => rule.kind === 'current' && rule.path_regex === '.*\\.(?:md|mdc)$')) {
    throw new Error('current documentを暗黙にpolicyへ分類できません。pathsまたは限定regexでroleを明示してください');
  }
  return { ...registry, extensions, rules, surfacePolicies };
}

function classify(path, rules) {
  return rules.find((rule) => rule.pathSet?.has(path) || rule.regex?.test(path)) ?? null;
}

function validateRulePathRegistrations(documents, rules, compatibilityStubPaths) {
  const documentSet = new Set(documents);
  const violations = [];
  for (const rule of rules) {
    for (const path of rule.paths ?? []) {
      if (!documentSet.has(path)) {
        violations.push(`${rule.id}: role登録pathが存在しません: ${path}`);
        continue;
      }
      const matches = rules.filter((candidate) => candidate.pathSet?.has(path) || candidate.regex?.test(path));
      if (matches.length !== 1 || matches[0].id !== rule.id) {
        violations.push(`${rule.id}: role登録pathがshadowまたは重複しています: ${path}`);
      }
    }
  }
  for (const path of compatibilityStubPaths) {
    if (!documentSet.has(path)) {
      violations.push(`compatibility stubが存在しません: ${path}`);
    } else if (classify(path, rules)?.kind !== 'history') {
      violations.push(`compatibility stubはhistoryへ分類してください: ${path}`);
    }
  }
  return violations;
}

function renderCurrentState(facts) {
  const managed = facts.MANAGED_PRODUCT_IDS;
  const core = facts.CORE_PRODUCT_IDS;
  const thirdParty = facts.THIRD_PARTY_PRODUCT_IDS;
  const wire = facts.CURRENT_WIRE_PRODUCT_IDS;
  for (const [name, value] of Object.entries({ managed, core, thirdParty, wire })) {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${name}が不正です`);
  }
  if (!Number.isInteger(facts.CURRENT_WIRE_MAJOR) || !Number.isInteger(facts.ROLLBACK_WIRE_MAJOR)) {
    throw new Error('wire majorが不正です');
  }
  if (facts.CURRENT_WIRE_SCHEMA_VERSION !== `${facts.CURRENT_WIRE_MAJOR}.0`) {
    throw new Error('wire schema versionがmajorと不整合です');
  }
  if (facts.CURRENT_WIRE_ENDPOINT !== `/api/factory/v${facts.CURRENT_WIRE_MAJOR}/reports`) {
    throw new Error('wire endpointがmajorと不整合です');
  }
  if (core.length + thirdParty.length !== managed.length) throw new Error('管理製品区分が不整合です');
  if (new Set([...core, ...thirdParty]).size !== managed.length) throw new Error('管理製品区分が重複しています');
  if (managed.some((id) => !core.includes(id) && !thirdParty.includes(id))) throw new Error('未分類の管理製品があります');
  if (new Set(wire).size !== wire.length || managed.some((id) => !wire.includes(id))) {
    throw new Error('現役wire製品集合が管理製品集合と不整合です');
  }

  return `# 工場の現行状態

<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Source: lib/factory/deployment-contract.mjs -->
<!-- Regenerate: node bin/render-current-docs.mjs --write -->

このページは、変更で動く工場の現行値だけを機械可読な配備契約から生成する。恒久的な責務と禁止事項は[製品契約台帳](factory-product-contracts.md)、host差は[host matrix](factory-host-product-matrix.md)、wire各版の固定契約は\`wire-vN-design.md\`を読む。

| 項目 | 現在値 |
|---|---|
| 現役管理対象 | ${managed.length}製品 |
| 自作コア | ${core.length}製品 |
| 第三者管理 | ${thirdParty.length}製品 |
| 現役wire | v${facts.CURRENT_WIRE_MAJOR}（schema \`${facts.CURRENT_WIRE_SCHEMA_VERSION}\`、${wire.length}製品） |
| 本番BugHub endpoint | \`${facts.CURRENT_WIRE_ENDPOINT}\` |
| host別rollback先 | wire v${facts.ROLLBACK_WIRE_MAJOR} |

## 製品集合

- 自作コア: ${core.map((id) => `\`${id}\``).join('、')}
- 第三者管理: ${thirdParty.map((id) => `\`${id}\``).join('、')}
- 現役wire: ${wire.map((id) => `\`${id}\``).join('、')}

## 更新方法

製品の追加・削除・区分変更・wire更新では、\`lib/factory/deployment-contract.mjs\`を先に更新し、\`node bin/render-current-docs.mjs --write\`でこのページを再生成する。ほかの現行案内は数やwire番号を手入力せず、このページを参照する。
`;
}

async function loadFacts(root, registry) {
  const source = registry.fact_sources?.factory_current_state;
  if (typeof source !== 'string') throw new Error('factory current state sourceが未指定です');
  const url = pathToFileURL(join(root, source));
  url.searchParams.set('document-registry', `${Date.now()}-${process.pid}`);
  return import(url.href);
}

async function validateCurrentClaims(root, classified) {
  const violations = [];
  for (const item of classified) {
    if (item.kind !== 'current') continue;
    const content = await readFile(join(root, item.path), 'utf8');
    for (const claim of MANUAL_CURRENT_CLAIMS) {
      claim.regex.lastIndex = 0;
      for (const match of content.matchAll(claim.regex)) {
        const line = content.slice(0, match.index).split('\n').length;
        violations.push(`${item.path}:${line}: ${claim.id}: ${match[0]}`);
      }
    }
  }
  return violations;
}

function markdownHeadings(content) {
  return markdownNodes(parseMarkdown(content))
    .filter((node) => node.type === 'heading' && node.depth >= 2)
    .map((node) => markdownToString(node));
}

async function validateOwnership(root, classified, registry) {
  const violations = [];
  const ownership = registry.ownership_policy;
  for (const item of classified) {
    if (item.role !== 'product-pointer') continue;
    const content = await readFile(join(root, item.path), 'utf8');
    for (const heading of markdownHeadings(content)) {
      const lower = heading.toLocaleLowerCase('ja');
      const forbidden = ownership.product_pointer_forbidden_headings.find((term) => lower.includes(term.toLocaleLowerCase('ja')));
      if (forbidden !== undefined || !ownership.product_pointer_allowed_headings.includes(heading)) {
        violations.push(`${item.path}: product-pointerに製品制御headingを置けません: ${heading}`);
      }
    }
  }

  const contractPath = 'docs/factory-product-contracts.md';
  const contract = await readFile(join(root, contractPath), 'utf8');
  const header = contract.split('\n').find((line) => line.startsWith('| ID / repo |'));
  const columns = header?.split('|').slice(1, -1).map((column) => column.trim()) ?? [];
  if (JSON.stringify(columns) !== JSON.stringify(ownership.product_contract_table_columns)) {
    violations.push(`${contractPath}: 製品統合台帳のcolumnが許可fieldと不整合です`);
  }
  return violations;
}

function markdownNodes(tree) {
  const nodes = [];
  const pending = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    nodes.push(node);
    if (Array.isArray(node.children)) pending.push(...node.children.toReversed());
  }
  return nodes;
}

function parseMarkdown(content) {
  return fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

function htmlAttributeTargets(html, markdownStartLine) {
  const targets = [];
  const pending = [parseFragment(html, { sourceCodeLocationInfo: true })];
  while (pending.length > 0) {
    const node = pending.pop();
    for (const attribute of node.attrs ?? []) {
      if (!['href', 'src', 'srcset'].includes(attribute.name)) continue;
      const htmlLine = node.sourceCodeLocation?.attrs?.[attribute.name]?.startLine ?? 1;
      const line = markdownStartLine + htmlLine - 1;
      if (attribute.name === 'srcset') {
        targets.push(...parseSrcset(attribute.value).map((candidate) => ({ raw: candidate.url, line })));
      } else {
        targets.push({ raw: attribute.value, line });
      }
    }
    if (Array.isArray(node.childNodes)) pending.push(...node.childNodes.toReversed());
    if (node.content !== undefined) pending.push(node.content);
  }
  return targets;
}

function localMarkdownTargets(content) {
  const nodes = markdownNodes(parseMarkdown(content));
  const definitions = new Map();
  for (const node of nodes) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  }
  const candidates = [];
  for (const node of nodes) {
    const line = node.position?.start?.line ?? 1;
    if (node.type === 'link' || node.type === 'image') {
      candidates.push({ raw: node.url, line });
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      const target = definitions.get(node.identifier);
      if (target !== undefined) candidates.push({ raw: target, line });
    } else if (node.type === 'html') {
      candidates.push(...htmlAttributeTargets(node.value, line));
    }
  }

  const targets = [];
  for (const candidate of candidates) {
    let target = candidate.raw.trim();
    if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    try { target = decodeURIComponent(target); } catch { /* invalid encoding is checked as a missing path */ }
    targets.push({ target, line: candidate.line });
  }
  return targets;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function documentSha256(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return sha256(Buffer.from(bytes.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1'));
}

function compileHistoricalRegistry(registry) {
  const extensions = Array.isArray(registry?.document_extensions) && registry.document_extensions.length > 0
    ? new Set(registry.document_extensions)
    : new Set(['.md', '.mdc']);
  const rules = (Array.isArray(registry?.rules) ? registry.rules : []).map((rule) => ({
    id: rule.id ?? null,
    kind: rule.kind,
    role: rule.role ?? null,
    regex: typeof rule.path_regex === 'string' ? new RegExp(rule.path_regex, 'u') : null,
    pathSet: Array.isArray(rule.paths) ? new Set(rule.paths) : null,
  }));
  const archiveRoots = Array.isArray(registry?.archive_inventory?.roots) && registry.archive_inventory.roots.length > 0
    ? registry.archive_inventory.roots
    : ['docs/archive'];
  const compatibilityStubPaths = Array.isArray(registry?.compatibility_stub_paths)
    ? registry.compatibility_stub_paths
    : V1_COMPATIBILITY_STUB_PATHS;
  return {
    extensions,
    rules,
    archiveRoots,
    compatibilityStubPaths,
    relocations: Array.isArray(registry?.archive_relocations) ? registry.archive_relocations : [],
  };
}

function classificationMetadata(rule, fallbackType = null) {
  if (rule !== null) return { kind: rule.kind, role: rule.role, rule: rule.id };
  if (fallbackType === 'evidence') return { kind: 'evidence', role: 'evidence', rule: null };
  if (fallbackType === 'archive' || fallbackType === 'compatibility-stub') {
    return { kind: 'history', role: 'history', rule: null };
  }
  return { kind: null, role: null, rule: null };
}

function sameClassification(left, right) {
  return left?.kind === right?.kind && left?.role === right?.role && left?.rule === right?.rule;
}

function initialV4MigrationAllows(path, before, after, baselineRegistry, currentRegistry) {
  if (baselineRegistry.schema !== 'dotagents.document-registry.v3' ||
    currentRegistry.schema !== 'dotagents.document-registry.v4') return false;
  const migration = INITIAL_V4_CLASSIFICATION_MIGRATIONS.get(path);
  return migration !== undefined && sameClassification(before, migration.from) && sameClassification(after, migration.to);
}

function wholeDocumentExactPaths(registry) {
  const paths = new Set();
  for (const policy of Array.isArray(registry?.current_surface_policies) ? registry.current_surface_policies : []) {
    if (policy?.section_heading_regex !== undefined || policy?.line_contains_regex !== undefined ||
      typeof policy?.exact_sha256_by_path !== 'object' || policy.exact_sha256_by_path === null) continue;
    for (const path of Object.keys(policy.exact_sha256_by_path)) paths.add(path);
  }
  return [...paths].sort();
}

function runGit(root, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : (result.stderr ?? '');
    const detail = stderr.trim() || result.error?.message || `status=${result.status}`;
    throw new Error(`比較基準をgitから取得できません: git ${args.join(' ')}: ${detail}`);
  }
  return result.stdout;
}

function gitDocument(root, baseRef, path) {
  return runGit(root, ['show', '--no-ext-diff', '--no-textconv', `${baseRef}:${path}`]);
}

function gitBlob(root, baseRef, path) {
  return runGit(root, ['show', '--no-ext-diff', '--no-textconv', `${baseRef}:${path}`], null);
}

function gitRegularPaths(root, baseRef) {
  return runGit(root, ['ls-tree', '-r', '-z', '--format=%(objectmode) %(path)', baseRef])
    .split('\0').filter(Boolean).map((entry) => {
      const separator = entry.indexOf(' ');
      return { mode: entry.slice(0, separator), path: normalizePath(entry.slice(separator + 1)) };
    }).filter((entry) => entry.mode.startsWith('100')).map((entry) => entry.path);
}

function documentEntriesFromGit(root, baseRef, registry) {
  runGit(root, ['cat-file', '-e', `${baseRef}^{commit}`]);
  const historical = compileHistoricalRegistry(registry);
  const treePaths = gitRegularPaths(root, baseRef);
  return treePaths.filter((path) => historical.extensions.has(extname(path))).map((path) => {
    const metadata = classificationMetadata(classify(path, historical.rules));
    return { path, ...metadata, sha256: documentSha256(gitBlob(root, baseRef, path)) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function immutableDocumentEntries(root, baseRef, registry, documentEntries) {
  const historical = compileHistoricalRegistry(registry);
  const treePaths = gitRegularPaths(root, baseRef);
  const documentByPath = new Map(documentEntries.map((document) => [document.path, document]));
  const types = new Map();
  for (const path of treePaths) {
    if (historical.archiveRoots.some((archiveRoot) => path.startsWith(`${archiveRoot}/`))) {
      types.set(path, 'archive');
      continue;
    }
    if (isImmutableEvidencePath(path) ||
      classify(path, historical.rules)?.kind === 'evidence') types.set(path, 'evidence');
  }
  for (const relocation of historical.relocations) {
    if (relocation.old_path_mode === 'compatibility-stub') {
      types.set(relocation.old_path, 'compatibility-stub');
    }
  }
  for (const path of historical.compatibilityStubPaths) {
    if (treePaths.includes(path)) types.set(path, 'compatibility-stub');
  }
  return [...types].sort(([left], [right]) => left.localeCompare(right)).map(([path, type]) => {
    if (!treePaths.includes(path)) throw new Error(`比較基準のimmutable documentが存在しません: ${path}`);
    const registered = documentByPath.get(path);
    const metadata = registered === undefined
      ? classificationMetadata(classify(path, historical.rules), type)
      : { kind: registered.kind, role: registered.role, rule: registered.rule };
    return {
      path,
      type,
      ...metadata,
      sha256: registered?.sha256 ?? documentSha256(gitBlob(root, baseRef, path)),
    };
  });
}

function currentRoleEntries(documentEntries) {
  return documentEntries
    .filter((entry) => entry.kind === 'current')
    .map(({ path, role, rule, sha256 }) => ({ path, role, rule, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function baselineFromGit(root, baseRef) {
  const registry = JSON.parse(gitDocument(root, baseRef, REGISTRY_PATH));
  const historical = compileHistoricalRegistry(registry);
  const documentEntries = documentEntriesFromGit(root, baseRef, registry);
  return {
    schema: BASELINE_SCHEMA,
    registry,
    archive_roots: historical.archiveRoots,
    document_entries: documentEntries,
    immutable_documents: immutableDocumentEntries(root, baseRef, registry, documentEntries),
    current_documents: currentRoleEntries(documentEntries),
    exact_surface_paths: wholeDocumentExactPaths(registry),
  };
}

function validateBaselineManifest(manifest) {
  if (manifest?.schema !== BASELINE_SCHEMA || typeof manifest.registry !== 'object' || manifest.registry === null ||
    !Array.isArray(manifest.archive_roots) || manifest.archive_roots.some((path) => !isRepositoryRelativePath(path)) ||
    new Set(manifest.archive_roots).size !== manifest.archive_roots.length ||
    !Array.isArray(manifest.document_entries) ||
    !Array.isArray(manifest.immutable_documents) || !Array.isArray(manifest.current_documents) ||
    !Array.isArray(manifest.exact_surface_paths)) {
    throw new Error('document immutability baseline manifestが不正です');
  }
  const documentPaths = new Set();
  for (const document of manifest.document_entries) {
    if (!isRepositoryRelativePath(document?.path) || !/^[0-9a-f]{64}$/u.test(document?.sha256 ?? '') ||
      documentPaths.has(document.path) ||
      (document.kind !== null && !KINDS.has(document.kind)) ||
      (document.role !== null && !ROLES.has(document.role)) ||
      (document.rule !== null && typeof document.rule !== 'string')) {
      throw new Error('document immutability baseline manifestのbase documentが不正です');
    }
    documentPaths.add(document.path);
  }
  const extensions = new Set(manifest.registry.document_extensions ?? ['.md', '.mdc']);
  const documentByPath = new Map(manifest.document_entries.map((document) => [document.path, document]));
  const paths = new Set();
  for (const document of manifest.immutable_documents) {
    const isRegisteredDocument = extensions.has(extname(document?.path ?? ''));
    const registered = documentByPath.get(document?.path);
    if (!isRepositoryRelativePath(document?.path) ||
      !['archive', 'evidence', 'compatibility-stub'].includes(document?.type) ||
      !/^[0-9a-f]{64}$/u.test(document?.sha256 ?? '') || paths.has(document.path) ||
      !KINDS.has(document?.kind) || !ROLES.has(document?.role) ||
      (isRegisteredDocument && typeof document?.rule !== 'string') ||
      (!isRegisteredDocument && document?.rule !== null && typeof document?.rule !== 'string') ||
      (!isRegisteredDocument && document.type === 'evidence' &&
        (document.kind !== 'evidence' || document.role !== 'evidence')) ||
      (isRegisteredDocument && (registered === undefined || registered.sha256 !== document.sha256 ||
        !sameClassification(registered, document)))) {
      throw new Error('document immutability baseline manifestのdocumentが不正です');
    }
    paths.add(document.path);
  }
  const currentPaths = new Set();
  for (const document of manifest.current_documents) {
    const registered = documentByPath.get(document?.path);
    if (!isRepositoryRelativePath(document?.path) || !ROLES.has(document?.role) ||
      typeof document?.rule !== 'string' || !/^[0-9a-f]{64}$/u.test(document?.sha256 ?? '') ||
      currentPaths.has(document.path) || registered?.kind !== 'current' ||
      registered.role !== document.role || registered.rule !== document.rule || registered.sha256 !== document.sha256) {
      throw new Error('document immutability baseline manifestのcurrent documentが不正です');
    }
    currentPaths.add(document.path);
  }
  const exactSurfacePaths = new Set();
  for (const path of manifest.exact_surface_paths) {
    if (!isRepositoryRelativePath(path) || exactSurfacePaths.has(path)) {
      throw new Error('document immutability baseline manifestのexact surface pathが不正です');
    }
    exactSurfacePaths.add(path);
  }
  return manifest;
}

async function loadImmutabilityBaseline(root, baseRef, baseManifest) {
  if (baseManifest !== null) {
    return validateBaselineManifest(JSON.parse(await readFile(baseManifest, 'utf8')));
  }
  if (baseRef !== null) return validateBaselineManifest(baselineFromGit(root, baseRef));
  return null;
}

async function validateImmutabilityBaseline(root, registry, classified, baseline) {
  if (baseline === null) return [];
  const violations = [];
  const baselineRelocations = Array.isArray(baseline.registry.archive_relocations)
    ? baseline.registry.archive_relocations : [];
  for (let index = 0; index < baselineRelocations.length; index += 1) {
    if (!isDeepStrictEqual(registry.archive_relocations[index], baselineRelocations[index])) {
      violations.push(`archive_relocations[${index}]の既存entryを変更・削除できません`);
    }
  }
  for (const archiveRoot of baseline.archive_roots) {
    if (!registry.archive_inventory.roots.includes(archiveRoot)) {
      violations.push(`archive inventoryの既存rootを変更・削除できません: ${archiveRoot}`);
    }
  }
  const declaredCompatibilityStubs = new Set(registry.compatibility_stub_paths);
  const currentByPath = new Map(classified.map((item) => [item.path, item]));
  for (const document of baseline.immutable_documents) {
    const path = join(root, document.path);
    if (!await pathExists(path)) {
      violations.push(`${document.path}: 既存${document.type}を削除・移動できません`);
      continue;
    }
    try {
      await assertRealPath(root, document.path);
    } catch (error) {
      violations.push(`${document.path}: 既存${document.type}をsymlinkまたは非fileへ変更できません: ${error.message}`);
      continue;
    }
    const content = await readFile(path);
    if (documentSha256(content) !== document.sha256) {
      violations.push(`${document.path}: 既存${document.type}の本文を変更できません`);
    }
    const currentRule = classify(document.path, registry.rules);
    const currentClassification = classificationMetadata(currentRule, document.type);
    const baselineClassification = { kind: document.kind, role: document.role, rule: document.rule };
    const allowedMigration = initialV4MigrationAllows(
      document.path,
      baselineClassification,
      currentClassification,
      baseline.registry,
      registry,
    );
    const isRegisteredDocument = registry.extensions.has(extname(document.path));
    const classificationChanged = isRegisteredDocument
      ? !sameClassification(currentClassification, baselineClassification)
      : currentClassification.kind !== baselineClassification.kind ||
        currentClassification.role !== baselineClassification.role;
    if (classificationChanged && !allowedMigration) {
      if (document.type === 'evidence') {
        violations.push(`${document.path}: 既存evidenceの分類を変更できません（role・rule登録を含む）`);
      } else {
        violations.push(`${document.path}: 既存${document.type}のhistory分類を変更できません（role・rule登録を含む）`);
      }
    }
    if (document.type === 'compatibility-stub' && !declaredCompatibilityStubs.has(document.path)) {
      violations.push(`${document.path}: 既存compatibility stubの台帳登録を削除できません`);
    }
  }
  const newRelocations = registry.archive_relocations.slice(baselineRelocations.length);
  const baselineDocuments = new Map(baseline.document_entries.map((document) => [document.path, document]));
  for (const relocation of newRelocations) {
    const oldDocument = baselineDocuments.get(relocation.old_path);
    if (oldDocument === undefined) {
      violations.push(`${relocation.old_path}: archive relocationのold_pathが比較基準に存在しません`);
    } else if (oldDocument.sha256 !== relocation.archive_sha256) {
      violations.push(`${relocation.old_path}: archive relocationのdigestが比較基準のold_path本文と一致しません`);
    }
    if (baselineDocuments.has(relocation.new_path)) {
      violations.push(`${relocation.new_path}: archive relocationのnew_pathは比較基準に存在してはいけません`);
    }
  }
  const baselineImmutablePaths = new Set(baseline.immutable_documents.map((document) => document.path));
  const hasNewArchiveRelocation = (path) => newRelocations.some((relocation) =>
    relocation.old_path === path && !baselineImmutablePaths.has(relocation.new_path));
  const exactSurfacePaths = new Set(wholeDocumentExactPaths(registry));
  for (const document of baseline.current_documents) {
    const current = currentByPath.get(document.path);
    const relocated = hasNewArchiveRelocation(document.path);
    const before = { kind: 'current', role: document.role, rule: document.rule };
    const after = current === undefined
      ? { kind: null, role: null, rule: null }
      : { kind: current.kind, role: current.role, rule: current.rule };
    const allowedMigration = initialV4MigrationAllows(document.path, before, after, baseline.registry, registry);
    if (!sameClassification(after, before) && !allowedMigration && !relocated) {
      violations.push(`${document.path}: 既存current documentのroleを変更・削除するには新しいarchive relocationが必要です（rule・分類を含む）`);
    }
  }
  for (const path of baseline.exact_surface_paths) {
    const relocated = hasNewArchiveRelocation(path);
    if (!exactSurfacePaths.has(path) && !relocated) {
      violations.push(`${path}: 既存の全文exact保護対象を削除するには新しいarchive relocationが必要です`);
    }
  }
  return violations;
}

function extractSurface(content, policy) {
  if (policy.lineContainsRegex !== null) {
    return content.split('\n').filter((line) => {
      policy.lineContainsRegex.lastIndex = 0;
      return policy.lineContainsRegex.test(line);
    }).join('\n');
  }
  if (policy.sectionHeadingRegex === null) return content;
  const lines = content.split('\n');
  const start = lines.findIndex((line) => {
    policy.sectionHeadingRegex.lastIndex = 0;
    return policy.sectionHeadingRegex.test(line);
  });
  if (start === -1) return null;
  const level = lines[start].match(/^(#{1,6})\s/u)?.[1].length ?? 6;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLevel = lines[index].match(/^(#{1,6})\s/u)?.[1].length;
    if (nextLevel !== undefined && nextLevel <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

async function validateCurrentSurfacePolicies(root, classified, policies) {
  const violations = [];
  const wholeDocumentCoverage = new Set();
  for (const policy of policies) {
    const matches = classified.filter((item) => {
      policy.pathRegex.lastIndex = 0;
      return (item.kind === 'current' || item.kind === 'contract') && policy.pathRegex.test(item.path);
    });
    if (matches.length === 0) {
      violations.push(`${policy.id}: 対象current surfaceが存在しません`);
      continue;
    }
    const matchedPaths = new Set(matches.map((item) => item.path));
    for (const path of Object.keys(policy.exact_sha256_by_path)) {
      if (!matchedPaths.has(path)) violations.push(`${policy.id}: exact契約の対象documentが存在しません: ${path}`);
    }
    for (const item of matches) {
      if (item.role !== policy.expected_role) {
        violations.push(`${item.path}: ${policy.id}: roleが${policy.expected_role}ではありません: ${item.role}`);
      }
      const content = await readFile(join(root, item.path), 'utf8');
      const surface = extractSurface(content, policy);
      if (surface === null || surface.length === 0) {
        violations.push(`${item.path}: ${policy.id}: 対象sectionまたは行が存在しません`);
        continue;
      }
      const expectedDigest = policy.exact_sha256_by_path[item.path];
      if (expectedDigest === undefined) {
        violations.push(`${item.path}: ${policy.id}: exact契約へpathが登録されていません`);
      } else if (documentSha256(surface) !== expectedDigest) {
        violations.push(`${item.path}: ${policy.id}: 許可された本文のexact digestと一致しません`);
      }
      if (policy.sectionHeadingRegex === null && policy.lineContainsRegex === null &&
        item.role === policy.expected_role && expectedDigest !== undefined) {
        wholeDocumentCoverage.add(item.path);
      }
      for (const regex of policy.requiredRegexes) {
        regex.lastIndex = 0;
        if (!regex.test(surface)) violations.push(`${item.path}: ${policy.id}: 必須契約がありません: ${regex.source}`);
      }
      for (const regex of policy.forbiddenRegexes) {
        regex.lastIndex = 0;
        const match = regex.exec(surface);
        if (match !== null) violations.push(`${item.path}: ${policy.id}: 製品制御または履歴を置けません: ${match[0]}`);
      }
    }
  }
  for (const item of classified) {
    if ((item.kind === 'current' || item.kind === 'contract') &&
      CLOSED_OWNERSHIP_ROLES.has(item.role) && !wholeDocumentCoverage.has(item.path)) {
      violations.push(`${item.path}: ${item.role}は全文exact契約へ登録しなければなりません`);
    }
  }
  return violations;
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateCurrentLinks(root, classified, contentOverrides = new Map(), plannedPaths = new Set()) {
  const violations = [];
  for (const item of classified) {
    if (item.kind === 'history' || item.kind === 'evidence') continue;
    const content = contentOverrides.get(item.path) ?? await readFile(join(root, item.path), 'utf8');
    for (const link of localMarkdownTargets(content)) {
      const target = resolve(dirname(join(root, item.path)), link.target);
      if (!plannedPaths.has(target) && !await pathExists(target)) {
        violations.push(`${item.path}:${link.line}: current文書のlocal linkが切れています: ${link.target}`);
      }
    }
  }
  return violations;
}

async function validateArchiveRelocations(root, relocations) {
  const violations = [];
  const relocatedTargets = new Map(relocations.map((relocation) => [relocation.old_path, relocation.new_path]));
  for (const relocation of relocations) {
    const oldPath = join(root, relocation.old_path);
    const newPath = join(root, relocation.new_path);
    if (!await pathExists(newPath)) {
      violations.push(`${relocation.new_path}: archive移動先が存在しません`);
      continue;
    }
    try {
      await assertRealPath(root, relocation.new_path);
      if (await pathExists(oldPath)) await assertRealPath(root, relocation.old_path);
    } catch (error) {
      violations.push(`${relocation.new_path}: archive relocationにsymlinkまたは非fileを使用できません: ${error.message}`);
      continue;
    }
    const oldExists = await pathExists(oldPath);
    if (oldExists !== relocation.preserve_old_path) {
      violations.push(`${relocation.old_path}: preserve_old_path=${relocation.preserve_old_path}と実体が不一致です`);
    }
    const content = await readFile(newPath, 'utf8');
    if (documentSha256(content) !== relocation.archive_sha256) {
      violations.push(`${relocation.new_path}: 凍結本文のdigestが移動時から変わっています`);
    }
    for (const link of localMarkdownTargets(content)) {
      const originalTarget = resolve(dirname(oldPath), link.target);
      const archiveTarget = resolve(dirname(newPath), link.target);
      const originalRelative = normalizePath(relative(root, originalTarget));
      const mappedTarget = relocatedTargets.get(originalRelative);
      if (!await pathExists(originalTarget) && !await pathExists(archiveTarget) &&
        (mappedTarget === undefined || !await pathExists(join(root, mappedTarget)))) {
        violations.push(`${relocation.new_path}:${link.line}: 凍結本文の元path基準local linkが切れています: ${link.target}`);
      }
    }
    if (relocation.preserve_old_path) {
      const oldContent = await readFile(oldPath, 'utf8');
      const oldLinks = localMarkdownTargets(oldContent);
      const resolvedTargets = oldLinks.map((link) =>
        normalizePath(relative(root, resolve(dirname(oldPath), link.target))));
      if (!resolvedTargets.includes(relocation.new_path)) {
        violations.push(`${relocation.old_path}: 現行置換またはstubが凍結本文を指していません`);
      }
      if (relocation.old_path_mode === 'compatibility-stub') {
        if (documentSha256(oldContent) !== relocation.old_path_sha256) {
          violations.push(`${relocation.old_path}: compatibility stubのdigestが変わっています`);
        }
        for (const link of oldLinks) {
          const target = resolve(dirname(oldPath), link.target);
          const targetRelative = normalizePath(relative(root, target));
          const mappedTarget = relocatedTargets.get(targetRelative);
          if (!await pathExists(target) &&
            (mappedTarget === undefined || !await pathExists(join(root, mappedTarget)))) {
            violations.push(`${relocation.old_path}:${link.line}: compatibility stubのlocal linkが切れています: ${link.target}`);
          }
        }
      }
    }
  }
  return violations;
}

function archiveInventoryDigest(paths) {
  return sha256(`${paths.join('\n')}\n`);
}

function validateArchiveInventory(archived, relocations, inventory) {
  const registered = new Set(relocations.map((relocation) => relocation.new_path));
  const legacy = archived.filter((path) => !registered.has(path));
  const violations = [];
  if (archived.length !== inventory.all_path_count ||
    archiveInventoryDigest(archived) !== inventory.all_paths_sha256) {
    violations.push('archive全path集合に追加・移動・削除があります。archive inventoryを明示更新してください');
  }
  if (legacy.length !== inventory.legacy_path_count ||
    archiveInventoryDigest(legacy) !== inventory.legacy_paths_sha256) {
    violations.push('archive inventoryに未登録の追加・移動・削除があります。archive_relocationsへ明示してください');
  }
  return violations;
}

async function main() {
  const { mode, root, baseRef, baseManifest } = parseArgs(process.argv.slice(2));
  const rawRegistry = JSON.parse(await readFile(join(root, REGISTRY_PATH), 'utf8'));
  const registry = compileRegistry(rawRegistry);
  await validateConfiguredPaths(root, registry);
  const documents = await listDocuments(root, registry.extensions);
  const archiveFiles = await listFilesUnderRoots(root, registry.archive_inventory.roots);
  const generatedPath = registry.generated_current_state;
  const effectiveDocuments = documents.includes(generatedPath)
    ? documents : [...documents, generatedPath].sort();
  const classified = effectiveDocuments.map((path) => {
    const rule = classify(path, registry.rules);
    if (rule === null) throw new Error(`未分類document: ${path}`);
    return { path, kind: rule.kind, role: rule.role, rule: rule.id };
  });
  const registrationViolations = validateRulePathRegistrations(
    effectiveDocuments,
    registry.rules,
    registry.compatibility_stub_paths,
  );
  const baseline = await loadImmutabilityBaseline(root, baseRef, baseManifest);
  const immutabilityViolations = await validateImmutabilityBaseline(
    root,
    registry,
    classified,
    baseline,
  );

  const facts = await loadFacts(root, registry);
  const generatedRule = classify(generatedPath, registry.rules);
  if (generatedRule?.kind !== 'generated') throw new Error('現行状態ページがgeneratedへ分類されていません');
  const expected = renderCurrentState(facts);
  const output = join(root, generatedPath);
  let actual = null;
  try {
    await access(output, constants.F_OK);
    actual = await readFile(output, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generatedDrift = actual !== expected;

  const violations = await validateCurrentClaims(root, classified);
  const ownershipViolations = await validateOwnership(root, classified, registry);
  const surfaceViolations = await validateCurrentSurfacePolicies(root, classified, registry.surfacePolicies);
  const currentLinkViolations = await validateCurrentLinks(
    root,
    classified,
    new Map([[generatedPath, expected]]),
    mode === 'write' ? new Set([output]) : new Set(),
  );
  const relocationViolations = await validateArchiveRelocations(root, registry.archive_relocations);
  const archiveInventoryViolations = validateArchiveInventory(
    archiveFiles,
    registry.archive_relocations,
    registry.archive_inventory,
  );
  if (generatedDrift && mode === 'check') {
    process.stderr.write(`FAIL: 生成物drift: ${generatedPath}\n`);
    process.stderr.write('node bin/render-current-docs.mjs --write を実行してください\n');
  }
  if (violations.length > 0) {
    process.stderr.write('FAIL: current文書へ変動する現行値を手入力しています。docs/factory-current-state.mdを参照してください\n');
    process.stderr.write(`${violations.join('\n')}\n`);
  }
  if (registrationViolations.length > 0 || ownershipViolations.length > 0 || surfaceViolations.length > 0 ||
    currentLinkViolations.length > 0 || relocationViolations.length > 0 ||
    archiveInventoryViolations.length > 0 || immutabilityViolations.length > 0) {
    process.stderr.write('FAIL: 文書の所有境界またはarchive移動契約が不正です\n');
    process.stderr.write(`${[
      ...registrationViolations,
      ...ownershipViolations,
      ...surfaceViolations,
      ...currentLinkViolations,
      ...relocationViolations,
      ...archiveInventoryViolations,
      ...immutabilityViolations,
    ].join('\n')}\n`);
  }
  if ((generatedDrift && mode === 'check') || violations.length > 0 ||
    registrationViolations.length > 0 || ownershipViolations.length > 0 || surfaceViolations.length > 0 ||
    currentLinkViolations.length > 0 || relocationViolations.length > 0 ||
    archiveInventoryViolations.length > 0 || immutabilityViolations.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (generatedDrift) await atomicWrite(output, expected);

  const counts = Object.fromEntries([...KINDS].map((kind) => [kind, classified.filter((item) => item.kind === kind).length]));
  process.stdout.write(`render-current-docs: OK — mode=${mode} documents=${effectiveDocuments.length} ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
