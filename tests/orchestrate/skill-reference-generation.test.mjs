import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RENDER = join(ROOT, "bin", "render-orchestrate-skill-references.mjs");

function run(root, mode) {
  return spawnSync(process.execPath, [RENDER, mode, "--root", root], { encoding: "utf8" });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "orchestrate-skill-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const host of ["claude", "codex", "grok", "cursor"]) {
    await mkdir(join(root, host, "skills/orchestrate/references"), { recursive: true });
  }
  await mkdir(join(root, "shared"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "lib/orchestrate"), { recursive: true });
  await cp(join(ROOT, "shared/orchestrate"), join(root, "shared/orchestrate"), { recursive: true });
  await cp(join(ROOT, "docs/02_models.md"), join(root, "docs/02_models.md"));
  await cp(join(ROOT, "lib/orchestrate/lane-admission.mjs"), join(root, "lib/orchestrate/lane-admission.mjs"));
  await cp(
    join(ROOT, "claude/skills/orchestrate/references/workflow-templates.md"),
    join(root, "claude/skills/orchestrate/references/workflow-templates.md"),
  );
  return root;
}

test("共通正本から全hostの自己完結したskill参照を生成する", async (t) => {
  const root = await fixture(t);
  const write = run(root, "--write");
  assert.equal(write.status, 0, write.stderr);
  for (const host of ["claude", "codex", "grok", "cursor"]) {
    const base = join(root, host, "skills/orchestrate/references/shared-orchestrate");
    const contract = await readFile(join(base, "contract.md"), "utf8");
    const dispatch = await readFile(join(base, "aiterm-dispatch.md"), "utf8");
    const recipes = await readFile(join(base, "recipes.md"), "utf8");
    assert.match(contract, /GENERATED FILE: 直接編集禁止/);
    assert.match(dispatch, /\]\(02_models\.md\)/);
    assert.match(recipes, /\]\(workflow-templates\.md\)/);
    assert.doesNotMatch(contract + dispatch + recipes, /\.\.\/\.\.\/(?:\.\.\/)*shared\/orchestrate/);
  }
  assert.equal(run(root, "--check").status, 0);
});

test("checkは参照生成物のdriftを拒否する", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, "--write").status, 0);
  const target = join(root, "codex/skills/orchestrate/references/shared-orchestrate/contract.md");
  await writeFile(target, "手編集\n", "utf8");
  const result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex\/skills\/orchestrate\/references\/shared-orchestrate/);
});
