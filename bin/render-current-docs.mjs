#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString as markdownToString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment } from 'parse5';
import { parseSrcset } from 'srcset';

const REGISTRY_PATH = 'docs/document-registry.json';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const KINDS = new Set(['generated', 'current', 'contract', 'history', 'evidence']);
const MANUAL_CURRENT_CLAIMS = [
  { id: 'product-count', regex: /\d+製品/gu },
  { id: 'current-wire', regex: /(?:現役(?:factory )?wire|現役は[^\n]{0,80}wire|本番BugHubの入口はwire)\s*v\d+/giu },
  { id: 'deployment-summary', regex: /managed \d+ IDとcurrent wire v\d+の\d+ ID/gu },
  { id: 'fresh-wire', regex: /\bfresh(?:\s+wire)?\s+v\d+\b/giu },
  { id: 'rollback-version', regex: /^(?=[^\n]*(?:host別rollback|\brollback(?:先|(?:\s+|は)[^\n]{0,40}(?:wire|major|scheduler|reporter|endpoint))))(?=[^\n]*\bv\d+\b)[^\n]+$/gimu },
];

function usage() {
  return 'usage: render-current-docs (--write|--check) [--root <path>]';
}

function parseArgs(argv) {
  let mode = null;
  let root = resolve(import.meta.dirname, '..');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write' || arg === '--check') {
      if (mode !== null) throw new Error(usage());
      mode = arg.slice(2);
    } else if (arg === '--root') {
      index += 1;
      if (index >= argv.length) throw new Error(usage());
      root = resolve(argv[index]);
    } else {
      throw new Error(usage());
    }
  }
  if (mode === null) throw new Error(usage());
  return { mode, root };
}

function normalizePath(path) {
  return path.split(sep).join('/');
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
      else if (entry.isFile() && extensions.has(extname(entry.name))) {
        documents.push(normalizePath(relative(root, absolute)));
      }
    }
  }
  await visit(root);
  return documents.sort();
}

function compileRegistry(registry) {
  if (registry?.schema !== 'dotagents.document-registry.v3') throw new Error('document registry schemaが不正です');
  if (!Array.isArray(registry.document_extensions) || registry.document_extensions.length === 0) {
    throw new Error('document_extensionsが不正です');
  }
  if (!Array.isArray(registry.rules) || registry.rules.length === 0) throw new Error('document registry rulesが不正です');
  const rules = registry.rules.map((rule) => {
    if (typeof rule.id !== 'string' || !KINDS.has(rule.kind) || typeof rule.path_regex !== 'string' ||
      rule.owner_scope !== 'dotagents' || !['integration', 'product-pointer', 'policy', 'generated', 'history', 'evidence'].includes(rule.role)) {
      throw new Error('document registry ruleが不正です');
    }
    return { ...rule, regex: new RegExp(rule.path_regex, 'u') };
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
  for (const relocation of registry.archive_relocations) {
    if (typeof relocation?.old_path !== 'string' || typeof relocation?.new_path !== 'string' ||
      typeof relocation?.preserve_old_path !== 'boolean' ||
      !['removed', 'compatibility-stub', 'current-replacement'].includes(relocation?.old_path_mode) ||
      !/^[0-9a-f]{64}$/u.test(relocation?.archive_sha256 ?? '')) {
      throw new Error('archive relocationが不正です');
    }
    if ((relocation.old_path_mode === 'removed') === relocation.preserve_old_path) {
      throw new Error('archive relocationのold_path_modeとpreserve_old_pathが不整合です');
    }
    if (relocation.old_path_mode === 'compatibility-stub' &&
      !/^[0-9a-f]{64}$/u.test(relocation?.old_path_sha256 ?? '')) {
      throw new Error('compatibility stubのdigestが不正です');
    }
  }
  if (!registry.archive_inventory || !Array.isArray(registry.archive_inventory.roots) ||
    !Number.isInteger(registry.archive_inventory.all_path_count) ||
    !/^[0-9a-f]{64}$/u.test(registry.archive_inventory.all_paths_sha256 ?? '') ||
    !Number.isInteger(registry.archive_inventory.legacy_path_count) ||
    !/^[0-9a-f]{64}$/u.test(registry.archive_inventory.legacy_paths_sha256 ?? '')) {
    throw new Error('archive inventoryが不正です');
  }
  if (!Array.isArray(registry.current_surface_policies) || registry.current_surface_policies.length === 0) {
    throw new Error('current surface policyが不正です');
  }
  const surfacePolicies = registry.current_surface_policies.map((policy) => {
    if (typeof policy?.id !== 'string' || typeof policy?.path_regex !== 'string' ||
      !Array.isArray(policy.required_regexes) || !Array.isArray(policy.forbidden_regexes) ||
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
  const fallback = rules.at(-1);
  if (fallback.kind !== 'current' || fallback.path_regex !== '.*\\.(?:md|mdc)$') {
    throw new Error('document registryの末尾は全documentをcurrentへ分類する規則でなければなりません');
  }
  return { ...registry, extensions: new Set(registry.document_extensions), rules, surfacePolicies };
}

function classify(path, rules) {
  return rules.find((rule) => rule.regex.test(path)) ?? null;
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
  return sha256(content.replace(/\r\n/gu, '\n'));
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
  for (const policy of policies) {
    const matches = classified.filter((item) => {
      policy.pathRegex.lastIndex = 0;
      return item.kind === 'current' && policy.pathRegex.test(item.path);
    });
    if (matches.length === 0) {
      violations.push(`${policy.id}: 対象current surfaceが存在しません`);
      continue;
    }
    for (const item of matches) {
      const content = await readFile(join(root, item.path), 'utf8');
      const surface = extractSurface(content, policy);
      if (surface === null || surface.length === 0) {
        violations.push(`${item.path}: ${policy.id}: 対象sectionまたは行が存在しません`);
        continue;
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

async function validateCurrentLinks(root, classified) {
  const violations = [];
  for (const item of classified) {
    if (item.kind === 'history' || item.kind === 'evidence') continue;
    const content = await readFile(join(root, item.path), 'utf8');
    for (const link of localMarkdownTargets(content)) {
      if (!await pathExists(resolve(dirname(join(root, item.path)), link.target))) {
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
      const originalRelative = normalizePath(relative(root, originalTarget));
      const mappedTarget = relocatedTargets.get(originalRelative);
      if (!await pathExists(originalTarget) &&
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

function validateArchiveInventory(documents, relocations, inventory) {
  const registered = new Set(relocations.map((relocation) => relocation.new_path));
  const archived = documents.filter((path) =>
    inventory.roots.some((root) => path.startsWith(`${root}/`)));
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
  const { mode, root } = parseArgs(process.argv.slice(2));
  const rawRegistry = JSON.parse(await readFile(join(root, REGISTRY_PATH), 'utf8'));
  const registry = compileRegistry(rawRegistry);
  const documents = await listDocuments(root, registry.extensions);
  const classified = documents.map((path) => {
    const rule = classify(path, registry.rules);
    if (rule === null) throw new Error(`未分類document: ${path}`);
    return { path, kind: rule.kind, role: rule.role, rule: rule.id };
  });

  const facts = await loadFacts(root, registry);
  const generatedPath = registry.generated_current_state;
  if (typeof generatedPath !== 'string') throw new Error('generated_current_stateが未指定です');
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
  if (actual !== expected) {
    if (mode === 'write') await atomicWrite(output, expected);
    else {
      process.stderr.write(`FAIL: 生成物drift: ${generatedPath}\n`);
      process.stderr.write('node bin/render-current-docs.mjs --write を実行してください\n');
      process.exitCode = 1;
      return;
    }
  }

  const violations = await validateCurrentClaims(root, classified);
  if (violations.length > 0) {
    process.stderr.write('FAIL: current文書へ変動する現行値を手入力しています。docs/factory-current-state.mdを参照してください\n');
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const ownershipViolations = await validateOwnership(root, classified, registry);
  const surfaceViolations = await validateCurrentSurfacePolicies(root, classified, registry.surfacePolicies);
  const currentLinkViolations = await validateCurrentLinks(root, classified);
  const relocationViolations = await validateArchiveRelocations(root, registry.archive_relocations);
  const archiveInventoryViolations = validateArchiveInventory(
    documents,
    registry.archive_relocations,
    registry.archive_inventory,
  );
  if (ownershipViolations.length > 0 || surfaceViolations.length > 0 ||
    currentLinkViolations.length > 0 || relocationViolations.length > 0 ||
    archiveInventoryViolations.length > 0) {
    process.stderr.write('FAIL: 文書の所有境界またはarchive移動契約が不正です\n');
    process.stderr.write(`${[
      ...ownershipViolations,
      ...surfaceViolations,
      ...currentLinkViolations,
      ...relocationViolations,
      ...archiveInventoryViolations,
    ].join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const counts = Object.fromEntries([...KINDS].map((kind) => [kind, classified.filter((item) => item.kind === kind).length]));
  process.stdout.write(`render-current-docs: OK — mode=${mode} documents=${documents.length} ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
