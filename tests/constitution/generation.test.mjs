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
  const commonLines = common.split(/\r?\n/u);
  const unaiRule = "- 文章・返答の文体はunai skillの規範に従う。";

  for (const heading of [
    "人格 — あなたはベル",
    "応対規範 — まず会話し、黙って進めない",
    "姿勢の原則（迷ったらここに戻る）",
    "調査と知識の置き場",
    "計画文書の作法",
    "作業レーンと統制",
    "ツールと権限",
    "git・shell・ファイルの作法（実被弾からの鉄則）",
    "報告",
    "出力衛生",
  ]) assert.match(common, new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(common, /repo内の変更はpush（push既定の判定はgit鉄則に従う）/);
  assert.equal(commonLines.filter((line) => line === unaiRule).length, 1);
  assert.match(common, /通常のpushを完遂に含めるのは、project正典または恒久裁定がpush既定を定めるrepoだけ/);
  assert.match(common, /^- push既定を認定できるのは、\(a\)適用中のrepo直下のAGENTS\.md／CLAUDE\.mdとそのhost展開import（直接・再帰の`@import`だけ。Markdownリンクは含まない）が通常pushを既定と明記している場合、\(b\)dotagents憲章が恒久裁定として既定を与える工場管理repo（dotagentsと製品契約台帳で自作コアに分類された製品の正規repo。第三者製品・基盤toolchainは含まない）である場合、\(c\)現在のrequest／campaignで未撤回の、対象repoと通常pushを既定とする旨を明記したユーザー指示がある場合、だけとする。一回限りのpush指示は既定でなく明示指示として扱い、認定できない・矛盾する時はpushしない。$/m);
  assert.match(common, /^- 本節の還流・正典反映の書込みは、書込みを含む依頼・進行中campaign・明示の知識還流Phaseだけで行い、read-only指定の依頼では提案として返す。$/m);
  assert.ok(commonLines.includes("本書の「<name> runbook」は `~/.claude/runbooks/<name>.md`（Codexは `~/.codex/runbooks/<name>.md`、Grokは `~/.grok/runbooks/<name>.md`、Cursorは `~/.cursor/runbooks/<name>.md`・実体はdotagents `shared/runbooks/`）を指す。"));
  assert.ok(commonLines.includes("- **調査と出力を還流させる**: 調べた外部仕様・文献は`rag/`へ、価値ある出力（回答・監査ダイジェスト・図解）は内容に応じて`rag/`または`docs/`へ還流して複利で育てる。保存手順（MarkItDown化・raw/コンパイル分離・出典/取得日/確度・INDEX追記）と月次衛生は knowledge-return runbook に従う。"));
  assert.ok(commonLines.includes("- **変動する現行値を散文へ複製しない**: 製品集合・現役version・endpointなど変更で動く値は、所有repoの構造化正本か、そこから作る生成物だけに置く。現行案内は生成物を参照し、履歴・証拠を現在の案内として使わない。文書分類・生成・drift検証を持つrepoでは、文書変更と同じcommitでそのgateを通す。"));
  assert.match(common, /判定後の運用（uninitializedの導入・Markdown正本の条件・散文の所有・cutover・archive）は lattice-workflow runbook に従う。/);
  assert.doesNotMatch(common, /還流の書込みを行うのは/);
  assert.match(common, /\*\*方針級の発見はその場で正典へ\*\*:/);
  assert.doesNotMatch(common, /全hostで既定として aiterm-mcp の永続PTY/);
  assert.match(common, /host native／aitermを使い/);

  // shell入口はhost delta。Claude/Codexは移設前と同じaiterm既定文、Grokはnative既定。
  assert.match(claudeDelta, /^# Claude Code固有差分$/m);
  assert.match(claudeDelta, /全hostで既定として aiterm-mcp の永続PTY/);
  assert.match(codexDelta, /^# Codex固有差分$/m);
  assert.match(codexDelta, /全hostで既定として aiterm-mcp の永続PTY/);
  assert.match(codexDelta, /Codex親がCodex子を呼ぶ時はnative sub-agentを既定/);
  assert.match(codexDelta, /aitermを永続shellとして使うことと、aitermからCodex子を起動することを混同しない/);
  assert.match(grokDelta, /^# Grok固有差分$/m);
  assert.match(grokDelta, /run_terminal_command/);
  assert.doesNotMatch(grokDelta, /全hostで既定として/);
  assert.doesNotMatch(grokDelta, /mcp__aiterm__pty_/);
  assert.match(cursorDelta, /^# Cursor固有差分$/m);
  assert.match(cursorDelta, /Cursor nativeの単発・背景コマンド/);
  assert.doesNotMatch(cursorDelta, /全hostで既定として/);
  assert.doesNotMatch(cursorDelta, /mcp__aiterm__pty_/);
  assert.match(claude, /全hostで既定として aiterm-mcp の永続PTY/);
  assert.match(codex, /全hostで既定として aiterm-mcp の永続PTY/);
  assert.match(codex, /^## Codex固有差分$/m);
  assert.match(codex, /Codex親がCodex子を呼ぶ時はnative sub-agentを既定/);
  assert.match(grok, /shared\/constitution\.md \+ grok\/AGENTS\.delta\.md/);
  assert.match(grok, /run_terminal_command/);
  assert.doesNotMatch(grok, /Claude Code固有差分/);
  assert.match(cursor, /shared\/constitution\.md \+ cursor\/AGENTS\.delta\.md/);
  assert.match(cursor, /Cursor nativeの単発・背景コマンド/);
  assert.doesNotMatch(cursor, /Claude Code固有差分/);
  assert.match(cursorMdc, /^---\n[\s\S]*alwaysApply: true\n---\n/);
  assert.doesNotMatch(cursorMdc, /^globs:/m);
  assert.match(cursorMdc, /Cursor nativeの単発・背景コマンド/);
  assert.doesNotMatch(common, /Codex親がCodex子を呼ぶ時はnative sub-agentを既定/);

  // 共通契約は共通正本にだけ存在し、hostへ依存する記述を含まない
  assert.match(common, /project側を優先する/);
  assert.match(common, /確信できない指摘は棄却する/);
  assert.doesNotMatch(common, /spawn_agent|agent_type|fork_turns|effortはlow|Bash ツール/);
  // Elastic統括正典（shared/orchestrate・docs/02）所有の契約を憲法へ複製しない
  assert.doesNotMatch(common, /execution-verified|installed（CLI存在）|gpt-connector-mcp|maintenance wave|characterization/);

  // host deltaは共通契約を重複保持しない
  for (const delta of [claudeDelta, codexDelta, grokDelta, cursorDelta]) {
    assert.doesNotMatch(delta, /文章・返答の文体はunai skillの規範に従う/);
    assert.doesNotMatch(delta, /project側を優先/);
    assert.doesNotMatch(delta, /委譲レーンは三つ|① native＝|external executionを積極利用/);
    assert.doesNotMatch(delta, /role定義（implementer／refuter／sorter等）をそのまま使う/);
    assert.doesNotMatch(delta, /利用可能性は4段階|installed（CLI存在）/);
    assert.doesNotMatch(delta, /外部実行の受入契約|外部セッションの回収契約|状態不明として扱い/);
    assert.doesNotMatch(delta, /gpt-connector-mcp|docs\/06_gpt-connector\.md|手動rollback/);
    assert.doesNotMatch(delta, /docs\/02_models\.md/);
    assert.doesNotMatch(delta, /実モデルの格下げ/);
    assert.doesNotMatch(delta, /確信が持てない指摘|棄却側に倒す/);
    assert.doesNotMatch(delta, /直接編集しない/);
  }

  for (const output of [claude, codex, grok, cursor, cursorMdc]) {
    assert.equal(output.split(/\r?\n/u).filter((line) => line === unaiRule).length, 1);
  }
});
