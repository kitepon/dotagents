import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RENDER = join(ROOT, "bin", "render-global-constitution.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "constitution-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["shared", "claude", "codex", "grok", "cursor"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "shared/constitution.md"), "# 共通\n\n共通本文\n", "utf8");
  await writeFile(join(root, "claude/CLAUDE.delta.md"), "# Claude差分\n\n- Claude行\n", "utf8");
  await writeFile(join(root, "codex/AGENTS.delta.md"), "# Codex差分\n\n- Codex行\n", "utf8");
  await writeFile(join(root, "grok/AGENTS.delta.md"), "# Grok差分\n\n- Grok行\n", "utf8");
  await writeFile(join(root, "cursor/AGENTS.delta.md"), "# Cursor差分\n\n- Cursor行\n", "utf8");
  return root;
}

function run(root, mode) {
  return spawnSync(process.execPath, [RENDER, mode, "--root", root], { encoding: "utf8" });
}

test("共通正本とhost deltaから完全な生成物を冪等生成する", async (t) => {
  const root = await fixture(t);
  const first = run(root, "--write");
  assert.equal(first.status, 0, first.stderr);
  const claude = await readFile(join(root, "claude/CLAUDE.md"), "utf8");
  const codex = await readFile(join(root, "codex/AGENTS.md"), "utf8");
  const grok = await readFile(join(root, "grok/AGENTS.md"), "utf8");
  const cursor = await readFile(join(root, "cursor/AGENTS.md"), "utf8");
  const cursorMdc = await readFile(join(root, "cursor/rules/factory.mdc"), "utf8");
  assert.match(claude, /GENERATED FILE: 直接編集禁止/);
  assert.match(claude, /shared\/constitution\.md \+ claude\/CLAUDE\.delta\.md/);
  assert.match(claude, /共通本文[\s\S]*Claude差分/);
  assert.match(codex, /共通本文[\s\S]*Codex差分/);
  assert.match(grok, /shared\/constitution\.md \+ grok\/AGENTS\.delta\.md/);
  assert.match(grok, /共通本文[\s\S]*Grok差分/);
  assert.match(cursor, /shared\/constitution\.md \+ cursor\/AGENTS\.delta\.md/);
  assert.match(cursor, /共通本文[\s\S]*Cursor差分/);
  assert.match(cursorMdc, /^---\n[\s\S]*alwaysApply: true\n---\n/);
  assert.doesNotMatch(cursorMdc, /^globs:/m);
  assert.match(cursorMdc, /共通本文[\s\S]*Cursor差分/);
  execFileSync(process.execPath, [RENDER, "--write", "--root", root]);
  assert.equal(await readFile(join(root, "claude/CLAUDE.md"), "utf8"), claude);
  assert.equal(await readFile(join(root, "codex/AGENTS.md"), "utf8"), codex);
  assert.equal(await readFile(join(root, "grok/AGENTS.md"), "utf8"), grok);
  assert.equal(await readFile(join(root, "cursor/AGENTS.md"), "utf8"), cursor);
  assert.equal(await readFile(join(root, "cursor/rules/factory.mdc"), "utf8"), cursorMdc);
});

test("見出しだけの空deltaは固有差分節を出力しない", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "claude/CLAUDE.delta.md"), "# Claude差分\n", "utf8");
  assert.equal(run(root, "--write").status, 0, "write should succeed");
  const claude = await readFile(join(root, "claude/CLAUDE.md"), "utf8");
  const codex = await readFile(join(root, "codex/AGENTS.md"), "utf8");
  const grok = await readFile(join(root, "grok/AGENTS.md"), "utf8");
  const cursor = await readFile(join(root, "cursor/AGENTS.md"), "utf8");
  assert.doesNotMatch(claude, /Claude差分/);
  assert.match(claude, /共通本文\n$/);
  assert.match(codex, /Codex差分[\s\S]*Codex行/);
  assert.match(grok, /Grok差分[\s\S]*Grok行/);
  assert.match(cursor, /Cursor差分[\s\S]*Cursor行/);
  assert.equal(run(root, "--check").status, 0);
});

test("checkは生成物driftを拒否し、再生成後だけ通す", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, "--write").status, 0);
  await writeFile(join(root, "codex/AGENTS.md"), "手編集\n", "utf8");
  const drift = run(root, "--check");
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /生成物drift: codex\/AGENTS\.md/);
  assert.equal(run(root, "--write").status, 0);
  await writeFile(join(root, "grok/AGENTS.md"), "手編集\n", "utf8");
  const grokDrift = run(root, "--check");
  assert.equal(grokDrift.status, 1);
  assert.match(grokDrift.stderr, /生成物drift: grok\/AGENTS\.md/);
  assert.equal(run(root, "--write").status, 0);
  await writeFile(join(root, "cursor/AGENTS.md"), "手編集\n", "utf8");
  const cursorDrift = run(root, "--check");
  assert.equal(cursorDrift.status, 1);
  assert.match(cursorDrift.stderr, /生成物drift: cursor\/AGENTS\.md/);
  assert.equal(run(root, "--write").status, 0);
  assert.equal(run(root, "--check").status, 0);
});

test("不正な引数は入力エラーとして拒否する", () => {
  const result = spawnSync(process.execPath, [RENDER, "--unknown"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test("全host生成物はWindows checkoutでもLF byte列を維持する", async () => {
  const attributes = await readFile(join(ROOT, ".gitattributes"), "utf8");
  for (const output of ["claude/CLAUDE.md", "codex/AGENTS.md", "grok/AGENTS.md", "cursor/AGENTS.md", "cursor/rules/factory.mdc"]) {
    assert.match(attributes, new RegExp(`^${output.replace(".", "\\.")} text eol=lf$`, "m"));
  }
});
