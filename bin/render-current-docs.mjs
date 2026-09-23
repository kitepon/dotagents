#!/usr/bin/env node
// 配備契約から工場の現行状態ページを生成し、現行文書のlocal link切れを検出する。
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString as markdownToString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment } from 'parse5';
import { parseSrcset } from 'srcset';

const FACTS_SOURCE = 'lib/factory/deployment-contract.mjs';
const GENERATED_PATH = 'docs/factory-current-state.md';
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdc']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
// 履歴・証跡は書かれた時点の記録なので、link切れを検査しない。
const HISTORY_PATHS = /^(?:docs\/(?:archive|adr|migration|evidence)\/|evidence\/|\.lattice\/|rag\/|docs\/handoff_|docs\/r2-|docs\/wire-v[1-7]-design\.md$|docs\/elastic-orchestrator-|docs\/codex-native-routing-repair\.md$|docs\/plan_)/u;

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

async function listDocuments(root) {
  const documents = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(`document symlinkは許可されません: ${normalizePath(relative(root, absolute))}`);
      }
      else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(extname(entry.name))) {
        documents.push(normalizePath(relative(root, absolute)));
      }
    }
  }
  await visit(root);
  return documents.sort();
}

function renderCurrentState(facts) {
  const managed = facts.MANAGED_PRODUCT_IDS;
  const core = facts.CORE_PRODUCT_IDS;
  const thirdParty = facts.THIRD_PARTY_PRODUCT_IDS;
  const wire = facts.CURRENT_WIRE_PRODUCT_IDS;
  const runners = facts.FACTORY_RUNNERS;
  const fullCiRunners = runners?.filter((runner) => runner.fullCi);
  for (const [name, value] of Object.entries({ managed, core, thirdParty, wire, runners })) {
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
  if (runners.some((runner) => typeof runner?.name !== 'string' || runner.name.length === 0 ||
    typeof runner?.label !== 'string' || runner.label.length === 0 || typeof runner?.fullCi !== 'boolean') ||
    new Set(runners.map((runner) => runner.name)).size !== runners.length ||
    new Set(runners.map((runner) => runner.label)).size !== runners.length || fullCiRunners.length === 0) {
    throw new Error('工場runner集合が不正です');
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
| self-hosted runner | ${runners.length}席 |
| full CI環境 | ${fullCiRunners.length}環境 |

## 製品集合

- 自作コア: ${core.map((id) => `\`${id}\``).join('、')}
- 第三者管理: ${thirdParty.map((id) => `\`${id}\``).join('、')}
- 現役wire: ${wire.map((id) => `\`${id}\``).join('、')}

## CI runner

| runner | host label | 利用面 |
|---|---|---|
${runners.map((runner) => `| \`${runner.name}\` | \`${runner.label}\` | ${runner.fullCi ? 'full CI' : '運用workflow'} |`).join('\n')}

full CIは\`full CI\`の3席だけで同じ試験を行う。main-serverは運用workflow専用とし、通常CIを実行しない。WSL2 runnerと\`wsl2\` labelは現役集合へ含めない。

## 更新方法

製品の追加・削除・区分変更、wire更新、runner変更では、\`lib/factory/deployment-contract.mjs\`を先に更新し、\`node bin/render-current-docs.mjs --write\`でこのページを再生成する。ほかの現行案内は数、wire番号、runner名を手入力せず、このページを参照する。
`;
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

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadFacts(root) {
  const url = pathToFileURL(join(root, FACTS_SOURCE));
  url.searchParams.set('render', `${Date.now()}-${process.pid}`);
  return import(url.href);
}

async function brokenLinks(root, documents, overrides) {
  const violations = [];
  for (const path of documents) {
    if (HISTORY_PATHS.test(path)) continue;
    const content = overrides.get(path) ?? await readFile(join(root, path), 'utf8');
    for (const link of localMarkdownTargets(content)) {
      const target = resolve(dirname(join(root, path)), link.target);
      if (!await pathExists(target)) violations.push(`${path}:${link.line}: local linkが切れています: ${link.target}`);
    }
  }
  return violations;
}

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  const expected = renderCurrentState(await loadFacts(root));
  const output = join(root, GENERATED_PATH);
  const actual = await pathExists(output) ? await readFile(output, 'utf8') : null;
  const drift = actual !== expected;
  const documents = await listDocuments(root);
  const violations = await brokenLinks(root, documents, new Map([[GENERATED_PATH, expected]]));
  if (drift && mode === 'check') {
    process.stderr.write(`FAIL: 生成物drift: ${GENERATED_PATH}\nnode bin/render-current-docs.mjs --write を実行してください\n`);
  }
  if (violations.length > 0) process.stderr.write(`FAIL: local link切れ\n${violations.join('\n')}\n`);
  if ((drift && mode === 'check') || violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (drift) await atomicWrite(output, expected);
  process.stdout.write(`render-current-docs: OK — mode=${mode} documents=${documents.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
