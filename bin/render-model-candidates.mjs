#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "../lib/orchestrate/canonical-json.mjs";
import {
  SOURCE_MARK_END, SOURCE_MARK_START, TABLE_MARK_END, TABLE_MARK_START,
  expandCatalog, extractRecommendationSource, renderCandidateTable, replaceMarked,
} from "../lib/orchestrate/recommendation-contract.mjs";

const SOURCE_DOC = "docs/02_models.md";
const OUTPUT_DOC = "lib/orchestrate/model-candidates.json";

function usage() {
  return "usage: render-model-candidates (--write|--check) [--root <path>]";
}

function parseArgs(argv) {
  let mode = null;
  let root = resolve(import.meta.dirname, "..");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write" || arg === "--check") {
      if (mode !== null) throw new Error(usage());
      mode = arg.slice(2);
    } else if (arg === "--root") {
      index += 1;
      if (index >= argv.length) throw new Error(usage());
      root = resolve(argv[index]);
    } else throw new Error(usage());
  }
  if (mode === null) throw new Error(usage());
  return { mode, root };
}

function pretty(catalog) {
  return `${JSON.stringify(JSON.parse(canonicalJson(catalog)), null, 2)}\n`;
}

const { mode, root } = parseArgs(process.argv.slice(2));
const sourcePath = resolve(root, SOURCE_DOC);
const outputPath = resolve(root, OUTPUT_DOC);
const markdown = await readFile(sourcePath, "utf8");
const source = extractRecommendationSource(markdown);
const catalog = expandCatalog(source);
const table = renderCandidateTable(catalog);
const nextMarkdown = replaceMarked(markdown, TABLE_MARK_START, TABLE_MARK_END, table);
const nextJson = pretty(catalog);

if (mode === "check") {
  const currentJson = await readFile(outputPath, "utf8");
  if (currentJson !== nextJson) {
    process.stderr.write("model-candidates.json が 02 の機械可読正本と一致しません\n");
    process.exit(1);
  }
  if (!markdown.includes(SOURCE_MARK_START) || !markdown.includes(SOURCE_MARK_END)) {
    process.stderr.write("recommendation-source の範囲がありません\n");
    process.exit(1);
  }
  if (markdown !== nextMarkdown) {
    process.stderr.write("02 の候補表が機械可読正本と一致しません\n");
    process.exit(1);
  }
  process.stdout.write(`${catalog.candidates.length} candidates ${catalog.source_digest}\n`);
} else {
  await writeFile(outputPath, nextJson);
  await writeFile(sourcePath, nextMarkdown);
  process.stdout.write(`${catalog.candidates.length} candidates ${catalog.source_digest}\n`);
}
