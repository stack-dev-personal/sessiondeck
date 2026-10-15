#!/usr/bin/env node
/**
 * Fixture leak gate (R0.7). Scans packages/contract/fixtures (raw/ excluded) and exits 1 with
 * counts per category and file when it finds a leak. It never prints a matched value.
 *
 *   node scripts/fixture-leak-check.mjs [fixturesDir] [--raw <dir>]
 *
 * With raw/ present the user name and project directory names are derived from it at run time;
 * without raw/ (CI) only the pattern checks run.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_ROOT, RAW_ROOT } from "./lib/fixture-files.mjs";
import { leakCheck } from "./lib/fixture-leak-core.mjs";

const args = process.argv.slice(2);
const rawIdx = args.indexOf("--raw");
const rawArg = rawIdx >= 0 ? args[rawIdx + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && !(rawIdx >= 0 && i === rawIdx + 1));
const root = resolve(positional[0] ?? FIXTURES_ROOT);
const raw = resolve(rawArg ?? RAW_ROOT);
const rawPresent = existsSync(raw);

if (!existsSync(root)) {
  console.error("fixture-leak-check: fixtures directory not found");
  process.exit(2);
}
const r = leakCheck(root, { rawRoot: rawPresent ? raw : null });
console.log(`mode: ${rawPresent ? "raw-derived literals + patterns" : "patterns only (no raw/)"}`);
console.log(`files scanned: ${r.files}`);
console.log(
  `derived literals: users=${r.literals.users} projects=${r.literals.projects} (skipped short=${r.literals.skipped})`,
);
for (const [c, n] of Object.entries(r.byCategory).sort()) console.log(`  ${c}: ${n}`);
for (const f of r.perFile.slice(0, 50)) console.log(`  ${f.file}: ${f.category} x${f.count}`);
console.log(r.total === 0 ? "PASS: no leaks found" : `FAIL: ${r.total} finding(s)`);
process.exit(r.total === 0 ? 0 : 1);
