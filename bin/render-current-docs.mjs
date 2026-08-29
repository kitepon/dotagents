#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const REGISTRY_PATH = 'docs/document-registry.json';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const KINDS = new Set(['generated', 'current', 'contract', 'history', 'evidence']);
const MANUAL_CURRENT_CLAIMS = [
  { id: 'managed-product-count', regex: /(?:工場(?:の)?現役管理対象は計|工場管理対象)\d+製品/gu },
  { id: 'core-product-count', regex: /自作コア\d+製品/gu },
  { id: 'current-wire', regex: /(?:現役(?:factory )?wire|現役は[^\n]{0,80}wire|本番BugHubの入口はwire)\s*v\d+/giu },
  { id: 'current-wire-set', regex: /現行必須集合は固定\d+製品/gu },
  { id: 'deployment-summary', regex: /managed \d+ IDとcurrent wire v\d+の\d+ ID/gu },
  { id: 'fresh-wire-set', regex: /固定\d+製品のfresh wire v\d+ report/gu },
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
  if (registry?.schema !== 'dotagents.document-registry.v1') throw new Error('document registry schemaが不正です');
  if (!Array.isArray(registry.document_extensions) || registry.document_extensions.length === 0) {
    throw new Error('document_extensionsが不正です');
  }
  if (!Array.isArray(registry.rules) || registry.rules.length === 0) throw new Error('document registry rulesが不正です');
  const rules = registry.rules.map((rule) => {
    if (typeof rule.id !== 'string' || !KINDS.has(rule.kind) || typeof rule.path_regex !== 'string') {
      throw new Error('document registry ruleが不正です');
    }
    return { ...rule, regex: new RegExp(rule.path_regex, 'u') };
  });
  const fallback = rules.at(-1);
  if (fallback.kind !== 'current' || fallback.path_regex !== '.*\\.(?:md|mdc)$') {
    throw new Error('document registryの末尾は全documentをcurrentへ分類する規則でなければなりません');
  }
  return { ...registry, extensions: new Set(registry.document_extensions), rules };
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

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  const rawRegistry = JSON.parse(await readFile(join(root, REGISTRY_PATH), 'utf8'));
  const registry = compileRegistry(rawRegistry);
  const documents = await listDocuments(root, registry.extensions);
  const classified = documents.map((path) => {
    const rule = classify(path, registry.rules);
    if (rule === null) throw new Error(`未分類document: ${path}`);
    return { path, kind: rule.kind, rule: rule.id };
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

  const counts = Object.fromEntries([...KINDS].map((kind) => [kind, classified.filter((item) => item.kind === kind).length]));
  process.stdout.write(`render-current-docs: OK — mode=${mode} documents=${documents.length} ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
