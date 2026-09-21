#!/usr/bin/env node
// Public entry. Reads one JSON task from stdin and writes one JSON result.
// It never launches a child harness and never changes the parent.
import { readFileSync } from "node:fs";

import { recommendHarness } from "../lib/orchestrate/recommend-harness.mjs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  input = null;
}
const result = await recommendHarness(input ?? {});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.status === "recommended" ? 0 : 1);
