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

test("実repoの共通契約とhost固有契約を交差させず保持する", async () => {
  const common = await readFile(join(ROOT, "shared/constitution.md"), "utf8");
  const claudeDelta = await readFile(join(ROOT, "claude/CLAUDE.delta.md"), "utf8");
  const codexDelta = await readFile(join(ROOT, "codex/AGENTS.delta.md"), "utf8");
  const grokDelta = await readFile(join(ROOT, "grok/AGENTS.delta.md"), "utf8");
  const cursorDelta = await readFile(join(ROOT, "cursor/AGENTS.delta.md"), "utf8");
  const claude = await readFile(join(ROOT, "claude/CLAUDE.md"), "utf8");
  const codex = await readFile(join(ROOT, "codex/AGENTS.md"), "utf8");
  const grok = await readFile(join(ROOT, "grok/AGENTS.md"), "utf8");
  const cursor = await readFile(join(ROOT, "cursor/AGENTS.md"), "utf8");
  const cursorMdc = await readFile(join(ROOT, "cursor/rules/factory.mdc"), "utf8");
  const unaiRule = "- unaiは、オーナーへのチャット応答と第三者向けの公開文章に適用する。";

  for (const heading of [
    "人格 — あなたはベル",
    "応対規範 — まず会話し、黙って進めない",
    "姿勢の原則（迷ったらここに戻る）",
    "調査と知識の置き場",
    "委譲とオーケストレーション",
    "ツールと権限",
    "git・ファイルの作法",
    "報告",
  ]) assert.match(common, new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  // 全hostで同じ判断は共通正本にだけ置く
  assert.match(common, /project側を優先する/);
  assert.match(common, /\*\*通常のpushを完了に含めるのは次のrepoだけ\*\*/);
  assert.match(common, /\*\*shellはhost標準のシェルを既定にする。\*\*/);
  assert.match(common, /02 runbook（各hostのrunbooksディレクトリの`02_models\.md`）/);
  assert.match(common, /公式`typesafe-ai` skill/);
  assert.match(common, /\*\*各製品は自身のソース・状態・schema・migration・正規診断を所有する。\*\*/);
  assert.match(common, /\*\*dotagentsの製品連携責務は/);
  // 規範は判断だけを持ち、出典・経緯・dotagents内相対パスを持たない
  assert.doesNotMatch(common, /オーナー裁定 20|実被弾|ADR \d|物理ゲート/);
  assert.doesNotMatch(common, /`docs\/02_models\.md`|shared\/orchestrate|orchestrate skill/);
  assert.doesNotMatch(common, /spawn_agent|agent_type|fork_turns/);

  // host deltaはhost固有の差分だけを持ち、共通契約を重複保持しない
  for (const [delta, heading] of [
    [claudeDelta, "Claude Code固有差分"],
    [codexDelta, "Codex固有差分"],
    [grokDelta, "Grok固有差分"],
    [cursorDelta, "Cursor固有差分"],
  ]) {
    assert.match(delta, new RegExp(`^# ${heading}$`, "m"));
    assert.doesNotMatch(delta, /unaiは|project側を優先|shellはhost標準|承認を要する操作の目的・影響・戻し方|typesafe\/api\.env/);
  }
  assert.match(codexDelta, /親が子の完了を待ってターンを終える委譲は、Aitermの`agent_launch`と自動完了配送を使う/);
  assert.match(codexDelta, /それ以外のCodex親からCodex子への委譲はnative sub-agentを既定/);
  assert.match(codex, /^## Codex固有差分$/m);
  assert.match(grok, /shared\/constitution\.md \+ grok\/AGENTS\.delta\.md/);
  assert.match(cursor, /shared\/constitution\.md \+ cursor\/AGENTS\.delta\.md/);
  assert.match(cursorMdc, /^---\n[\s\S]*alwaysApply: true\n---\n/);
  assert.doesNotMatch(cursorMdc, /^globs:/m);
  for (const output of [claude, codex, grok, cursor, cursorMdc]) {
    assert.equal(output.split(/\r?\n/u).filter((line) => line === unaiRule).length, 1);
    assert.doesNotMatch(output, /Claude Code固有差分|Grok固有差分|Cursor固有差分/);
  }
});
