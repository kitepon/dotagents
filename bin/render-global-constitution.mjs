#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const HOSTS = [
  { delta: "claude/CLAUDE.delta.md", output: "claude/CLAUDE.md" },
  { delta: "codex/AGENTS.delta.md", output: "codex/AGENTS.md" },
  { delta: "grok/AGENTS.delta.md", output: "grok/AGENTS.md" },
  { delta: "cursor/AGENTS.delta.md", output: "cursor/AGENTS.md" },
  {
    delta: "cursor/AGENTS.delta.md",
    output: "cursor/rules/factory.mdc",
    wrap: "cursor-mdc",
  },
];
const COMMON = "shared/constitution.md";
// Cursor 3.17.8 toCursorRule: alwaysApply:true → type=global で YAML globs を捨てる。
// getRulesForFiles は alwaysApply かつ globs 空を除外。home mdc へ globs を足しても無効果。
// alwaysApply を外すと overlay の getGlobalRules も死ぬ。配達は cursor-constitution-hook。
const CURSOR_MDC_FRONTMATTER = [
  "---",
  "description: Factory global constitution for the Cursor harness. Always apply.",
  "alwaysApply: true",
  "---",
  "",
].join("\n");

function usage() {
  return "usage: render-global-constitution (--write|--check) [--root <path>]";
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

function normalizeMarkdown(value) {
  return `${value.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

function normalizeDelta(value, source) {
  const normalized = normalizeMarkdown(value);
  if (!normalized.startsWith("# ")) throw new Error(`${source} must start with a level-1 heading`);
  return normalized
    .split("\n")
    .map((line) => (/^#{1,5} /.test(line) ? `#${line}` : line))
    .join("\n");
}

function render(common, delta, sources, wrap) {
  const header = [
    "<!-- GENERATED FILE: 直接編集禁止。 -->",
    `<!-- Sources: ${sources.join(" + ")} -->`,
    "<!-- Regenerate: node bin/render-global-constitution.mjs --write -->",
  ].join("\n");
  const normalizedDelta = normalizeDelta(delta, sources[1]);
  const deltaBody = normalizedDelta.split("\n").slice(1).join("\n").trim();
  const body = deltaBody === ""
    ? `${header}\n\n${normalizeMarkdown(common)}`
    : `${header}\n\n${normalizeMarkdown(common).trimEnd()}\n\n${normalizedDelta}`;
  if (wrap === "cursor-mdc") return `${CURSOR_MDC_FRONTMATTER}${body}`;
  return body;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
  await rename(temp, path);
}

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  const commonPath = join(root, COMMON);
  const common = await readFile(commonPath, "utf8");
  const drift = [];
  for (const host of HOSTS) {
    const deltaPath = join(root, host.delta);
    const outputPath = join(root, host.output);
    const expected = render(common, await readFile(deltaPath, "utf8"), [COMMON, host.delta], host.wrap);
    let actual = null;
    try {
      await access(outputPath, constants.F_OK);
      actual = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (actual === expected) continue;
    if (mode === "write") await atomicWrite(outputPath, expected);
    else drift.push(host.output);
  }
  if (drift.length > 0) {
    process.stderr.write(`FAIL: 生成物drift: ${drift.join(", ")}\n`);
    process.stderr.write("node bin/render-global-constitution.mjs --write を実行してください\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`render-global-constitution: OK — mode=${mode}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
