import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { canonicalJson } from "../../lib/orchestrate/canonical-json.mjs";
import { ROOT } from "./helpers.mjs";

// 固定Recipe契約の投影一致gate（ADR 0115 Decision 5）: shared/orchestrate/recipes/ のcanonical JSONが
// 意味の正本で、Claude雛形内のschema literalはこれと機械的に一致しなければならない。
// これはCI上の静的検査であり、実行時にschemaを解釈・変換するrunnerではない。

const SHARED = join(ROOT, "shared", "orchestrate");
const TEMPLATE = join(ROOT, "claude", "skills", "orchestrate", "references", "workflow-templates.md");

const loadJson = async (name) => JSON.parse(await readFile(join(SHARED, "recipes", name), "utf8"));

// 雛形markdownのJSコードブロックから `const NAME = {...}` literalを抽出してsandbox評価する。
// 評価対象はobject literal式だけで、雛形の実行コード（agent/parallel呼出し）は評価しない。
async function extractLiteral(name) {
  const body = await readFile(TEMPLATE, "utf8");
  const start = body.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} literal is missing from workflow-templates.md`);
  const open = body.indexOf("{", start);
  let depth = 0; let end = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth += 1;
    else if (body[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `${name} literal is unbalanced`);
  const expression = body.slice(open, end + 1);
  return vm.runInNewContext(`(${expression})`, Object.create(null), { timeout: 1000 });
}

test("adversarial-auditのschema literalはshared canonical JSONと一致する", async () => {
  const shared = await loadJson("adversarial-audit.v1.json");
  assert.equal(shared.schema, "dotagents.recipe.adversarial-audit.v1");
  assert.deepEqual(shared.phases, ["Find", "Dedup", "Verify", "Critic"]);
  for (const [literalName, ioKey] of [["FINDINGS", "findings"], ["VERDICT", "verdict"], ["CRITIC", "critic"]]) {
    const literal = await extractLiteral(literalName);
    assert.equal(canonicalJson(literal), canonicalJson(shared.io[ioKey]), `${literalName} differs from shared io.${ioKey}`);
  }
  // 上限の二重定義はschema側と一致させる（maxItemsとlimitsのdrift防止）
  assert.equal(shared.io.findings.properties.findings.maxItems, shared.limits.max_findings_per_dimension);
  assert.equal(shared.io.critic.properties.blind_spots.maxItems, shared.limits.max_blind_spots);
  // 第2ラウンドは高々1回の静的展開（汎用loop化の芽をschemaで固定）
  assert.equal(shared.limits.max_second_rounds, 1);
});

test("bulk-curationのschema literalはshared canonical JSONと一致する", async () => {
  const shared = await loadJson("bulk-curation.v1.json");
  assert.equal(shared.schema, "dotagents.recipe.bulk-curation.v1");
  assert.deepEqual(shared.phases, ["Apply"]);
  const report = await extractLiteral("REPORT");
  assert.equal(canonicalJson(report), canonicalJson(shared.io.report), "REPORT differs from shared io.report");
  // Latticeなし同一repo writerの直列化はrecipe契約の一部（ADR 0113 Decision 4 / ADR 0115 Decision 4）
  assert.equal(shared.limits.same_repo_writer_parallelism_without_lattice, 1);
  // TARGETSのclosed形: repo identityとeffectを持つ（直列化判定の入力）
  assert.deepEqual(shared.io.target.required, ["target", "repo_root", "effect", "write_scope"]);
});

test("canonical fixtureは自身のschemaのrequired keyを満たす", async () => {
  // 依存を増やさない最小の形状検査（JSON Schema validatorは導入しない＝runner化しない）
  const requiredOf = (schema) => schema.required ?? [];
  const audit = await loadJson("adversarial-audit.v1.json");
  for (const key of ["findings", "verdict", "critic"]) {
    for (const req of requiredOf(audit.io[key])) assert.ok(req in audit.fixture[key], `audit fixture.${key} lacks ${req}`);
  }
  for (const item of audit.fixture.findings.findings) {
    for (const req of audit.io.findings.properties.findings.items.required) assert.ok(req in item, `finding fixture lacks ${req}`);
  }
  const bulk = await loadJson("bulk-curation.v1.json");
  for (const key of ["target", "report"]) {
    for (const req of requiredOf(bulk.io[key])) assert.ok(req in bulk.fixture[key], `bulk fixture.${key} lacks ${req}`);
  }
});

test("両host面と正本文書が相互参照で結ばれている（片面撤回の検出）", async () => {
  const recipes = await readFile(join(SHARED, "recipes.md"), "utf8");
  assert.ok(recipes.includes("](recipes/adversarial-audit.v1.json)"), "recipes.md must link the audit schema");
  assert.ok(recipes.includes("](recipes/bulk-curation.v1.json)"), "recipes.md must link the curation schema");
  const claude = await readFile(TEMPLATE, "utf8");
  assert.ok(claude.includes("shared-orchestrate/recipes.md"), "Claude projection must reference its bundled shared canon");
  const codex = await readFile(join(ROOT, "codex", "skills", "orchestrate", "SKILL.md"), "utf8");
  assert.ok(codex.includes("references/shared-orchestrate/recipes.md"), "Codex entry must reference its bundled shared canon");
  // 意味差の再発防止: 集約の3値とunknown回収規則は正本にだけ置く（本testは存在参照のみを縛る）
  assert.ok(recipes.includes("partial_failure"), "shared canon must own the aggregate semantics");
});
