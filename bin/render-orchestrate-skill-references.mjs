#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const HOSTS = ["claude", "codex", "grok", "cursor"];
const OUTPUT_SUFFIX = "skills/orchestrate/references/shared-orchestrate";
const INCLUDED_SHARED_FILES = new Set([
  "aiterm-dispatch.md",
  "composition.md",
  "contract.md",
  "control-record.md",
  "delegation-contract.md",
  "recipes.md",
  "recipes/adversarial-audit.v1.json",
  "recipes/bulk-curation.v1.json",
]);
const GENERATED_HEADER = [
  "<!-- GENERATED FILE: 直接編集禁止。 -->",
  "<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->",
  "<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->",
  "",
].join("\n");

function usage() {
  return "usage: render-orchestrate-skill-references (--write|--check) [--root <path>]";
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
    } else {
      throw new Error(usage());
    }
  }
  if (mode === null) throw new Error(usage());
  return { mode, root };
}

function normalizeText(value) {
  return `${value.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

function renderMarkdown(value, source) {
  let rendered = normalizeText(value);
  if (source === "shared/orchestrate/aiterm-dispatch.md") {
    rendered = rendered.replaceAll("../../docs/02_models.md", "02_models.md");
  } else if (source === "shared/orchestrate/composition.md") {
    rendered = rendered.replaceAll("../../lib/orchestrate/lane-admission.mjs", "lane-admission.mjs");
  } else if (source === "shared/orchestrate/recipes.md") {
    rendered = rendered
      .replaceAll("../../claude/skills/orchestrate/references/workflow-templates.md", "workflow-templates.md")
      .replaceAll("../../codex/skills/orchestrate/SKILL.md", "../../SKILL.md");
  } else if (source === "claude/skills/orchestrate/references/workflow-templates.md") {
    rendered = rendered
      .replaceAll("../../../../shared/orchestrate/recipes.md", "recipes.md")
      .replaceAll("../../../../shared/orchestrate/recipes/", "recipes/")
      .replaceAll("shared-orchestrate/recipes.md", "recipes.md")
      .replaceAll("shared-orchestrate/recipes/", "recipes/");
  } else if (source === "docs/02_models.md") {
    rendered = rendered.replace(/\[([^\]]+)\]\((?!https?:\/\/|#)[^)]+\)/g, "$1");
  }
  return `${GENERATED_HEADER}${rendered}`;
}

async function collectFiles(root) {
  const files = new Map();
  const sourceRoot = join(root, "shared/orchestrate");

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const output = relative(sourceRoot, path).replaceAll("\\", "/");
        if (!INCLUDED_SHARED_FILES.has(output)) continue;
        const source = `shared/orchestrate/${output}`;
        const content = await readFile(path, "utf8");
        files.set(output, output.endsWith(".md") ? renderMarkdown(content, source) : normalizeText(content));
      }
    }
  }

  await walk(sourceRoot);
  const extras = [
    ["02_models.md", "docs/02_models.md"],
    ["lane-admission.mjs", "lib/orchestrate/lane-admission.mjs"],
    ["workflow-templates.md", "claude/skills/orchestrate/references/workflow-templates.md"],
  ];
  for (const [output, source] of extras) {
    const content = await readFile(join(root, source), "utf8");
    files.set(output, output.endsWith(".md") ? renderMarkdown(content, source) : `// GENERATED FILE: ${source} から生成。直接編集禁止。\n${normalizeText(content)}`);
  }
  return files;
}

async function actualFiles(directory) {
  const files = new Map();
  try {
    await access(directory, constants.F_OK);
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(relative(directory, path).replaceAll("\\", "/"), await readFile(path, "utf8"));
    }
  }
  await walk(directory);
  return files;
}

function differs(expected, actual) {
  if (expected.size !== actual.size) return true;
  for (const [path, content] of expected) {
    if (actual.get(path) !== content) return true;
  }
  return false;
}

async function writeBundle(directory, files) {
  await rm(directory, { recursive: true, force: true });
  for (const [path, content] of files) {
    const output = join(directory, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, { encoding: "utf8", mode: 0o644 });
  }
}

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  const expected = await collectFiles(root);
  const drift = [];
  for (const host of HOSTS) {
    const output = join(root, host, OUTPUT_SUFFIX);
    if (!differs(expected, await actualFiles(output))) continue;
    if (mode === "write") await writeBundle(output, expected);
    else drift.push(`${host}/${OUTPUT_SUFFIX}`);
  }
  if (drift.length > 0) {
    process.stderr.write(`FAIL: orchestrate skill参照生成物drift: ${drift.join(", ")}\n`);
    process.stderr.write("node bin/render-orchestrate-skill-references.mjs --write を実行してください\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`render-orchestrate-skill-references: OK — mode=${mode}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
