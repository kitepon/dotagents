#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ALL_ENVIRONMENTS = Object.freeze([
  "macos-native",
  "linux-workstation",
  "windows-native",
]);

// push／pull requestの既定はLinux 1環境。実測（2026-09-02）ではWindows runnerが毎回critical pathを
// 5〜6分占める。他OSはそのOS固有pathを触った変更、定期健康診断、手動実行だけ（factory-ci runbook）。
export const PUSH_ENVIRONMENTS = Object.freeze(["linux-workstation"]);

const HOST_PATH_RULES = Object.freeze([
  Object.freeze({
    environment: "macos-native",
    patterns: Object.freeze([
      /^bin\/setup-macos-factory\.sh$/u,
      /^tests\/install\/setup-macos-factory\.sh$/u,
    ]),
  }),
  Object.freeze({
    environment: "linux-workstation",
    patterns: Object.freeze([
      /^bin\/setup-linux(?:-[^/]+)?\.sh$/u,
      /^tests\/install\/setup-linux(?:-[^/]+)?\.sh$/u,
    ]),
  }),
  Object.freeze({
    environment: "windows-native",
    patterns: Object.freeze([
      /^bin\/setup-windows-native-factory\.ps1$/u,
      /^examples\/factory-reporter\/windows-workstation\.json$/u,
      /^lib\/factory\/windows-/u,
      /^tests\/factory-reporter\/windows-/u,
      /^tests\/factory-scan\/claude-hooks-windows\.test\.mjs$/u,
    ]),
  }),
]);

export function classifyPaths(paths) {
  const normalizedPaths = [...new Set(paths)].toSorted();
  if (normalizedPaths.length === 0) return fullPlan(normalizedPaths, "差分なしをLinux全検査へ分類");
  if (normalizedPaths.length > 0 && normalizedPaths.every(isDocumentationPath)) {
    return Object.freeze({
      schema: "dotagents.ci-plan.v1",
      productChange: false,
      environments: Object.freeze(["linux-workstation"]),
      reason: "文書だけの変更",
      changedPaths: Object.freeze(normalizedPaths),
    });
  }

  const selected = new Set(["linux-workstation"]);
  for (const path of normalizedPaths) {
    if (isDocumentationPath(path)) continue;
    const matchedRules = HOST_PATH_RULES.filter((rule) =>
      rule.patterns.some((pattern) => pattern.test(path)));
    for (const rule of matchedRules) selected.add(rule.environment);
  }

  return Object.freeze({
    schema: "dotagents.ci-plan.v1",
    productChange: true,
    environments: Object.freeze(ALL_ENVIRONMENTS.filter((environment) => selected.has(environment))),
    reason: selected.size > 1 ? "共通検査と変更したhostの検査" : "Linux全検査",
    changedPaths: Object.freeze(normalizedPaths),
  });
}

export function verifyResults({ classifyResult, fullResult, productChange }) {
  if (classifyResult !== "success") {
    throw new Error(`変更分類jobが成功していません: ${classifyResult || "結果なし"}`);
  }
  if (productChange === "true" && fullResult === "success") return;
  if (productChange === "false" && fullResult === "skipped") return;
  if (productChange !== "true" && productChange !== "false") {
    throw new Error(`変更分類の出力が不正です: ${productChange || "出力なし"}`);
  }
  throw new Error(
    `選択計画と実行結果が一致しません: product_change=${productChange}, full=${fullResult || "結果なし"}`,
  );
}

function isDocumentationPath(path) {
  return /\.(?:md|mdc)$/u.test(path);
}

function fullPlan(paths, reason, environments = PUSH_ENVIRONMENTS) {
  return Object.freeze({
    schema: "dotagents.ci-plan.v1",
    productChange: true,
    environments,
    reason,
    changedPaths: Object.freeze(paths),
  });
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: options.encoding ?? "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveCommit(revision) {
  try {
    return git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
  } catch (error) {
    throw new Error(
      `CI comparison baseをcommitとして解決できません: ${revision} (${error.stderr?.trim() || error.message})`,
    );
  }
}

function comparisonBase(environment) {
  const eventName = environment.EVENT_NAME;
  if (environment.GITHUB_REF?.startsWith("refs/tags/")) return environment.DISPATCH_BASE;
  if (eventName === "pull_request") return environment.BASE_SHA;
  if (eventName === "push") return environment.BEFORE_SHA;
  if (eventName === "workflow_dispatch") return environment.DISPATCH_BASE;
  throw new Error(`未対応のGitHub Actions eventです: ${eventName || "未指定"}`);
}

function requestedEnvironments(requested) {
  if (requested === "all") return ALL_ENVIRONMENTS;
  if (ALL_ENVIRONMENTS.includes(requested)) return Object.freeze([requested]);
  throw new Error(`未対応の工場環境です: ${requested || "未指定"}`);
}

function createPlan(environment) {
  if (environment.EVENT_NAME === "schedule") {
    return {
      ...fullPlan([], "定期健康診断", ALL_ENVIRONMENTS),
      comparisonBase: resolveCommit(environment.GITHUB_SHA),
    };
  }
  const baseInput = comparisonBase(environment);
  if (!baseInput || /^0+$/u.test(baseInput)) {
    throw new Error(
      `CI comparison baseが必要です: event=${environment.EVENT_NAME || "未指定"}, base=${baseInput || "未指定"}`,
    );
  }
  const base = resolveCommit(baseInput);
  const head = resolveCommit(environment.GITHUB_SHA);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
    stdio: "ignore",
  });
  if (base === head || ancestry.status !== 0) {
    throw new Error(`CI comparison baseはHEADより前のancestorでなければなりません: base=${base}, head=${head}`);
  }

  if (environment.GITHUB_REF?.startsWith("refs/tags/") || environment.EVENT_NAME === "workflow_dispatch") {
    return {
      ...fullPlan(
        [],
        environment.GITHUB_REF?.startsWith("refs/tags/") ? "tag" : "手動実行",
        requestedEnvironments(environment.REQUESTED_ENVIRONMENT),
      ),
      comparisonBase: base,
    };
  }

  const raw = git(["diff", "--no-renames", "--name-only", "-z", base, head], { encoding: "buffer" });
  const paths = raw.toString("utf8").split("\0").filter((path) => path.length > 0);
  return { ...classifyPaths(paths), comparisonBase: base };
}

function writeGithubOutputs(plan, outputPath) {
  appendFileSync(outputPath, [
    `product_change=${plan.productChange}`,
    `comparison_base=${plan.comparisonBase}`,
    `environments=${JSON.stringify(plan.environments)}`,
    "",
  ].join("\n"), "utf8");
}

function main() {
  const mode = process.argv[2];
  if (mode === "plan") {
    const plan = createPlan(process.env);
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUTがありません");
    writeGithubOutputs(plan, process.env.GITHUB_OUTPUT);
    process.stdout.write(`CI plan: ${plan.reason}; environments=${plan.environments.join(",")}\n`);
    return;
  }
  if (mode === "verify") {
    verifyResults({
      classifyResult: process.env.CLASSIFY_RESULT,
      fullResult: process.env.FULL_RESULT,
      productChange: process.env.PRODUCT_CHANGE,
    });
    process.stdout.write("CI result: 選択計画と実行結果が一致しました\n");
    return;
  }
  throw new Error("usage: dotagents-ci-plan.mjs <plan|verify>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
