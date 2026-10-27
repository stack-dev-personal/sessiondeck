#!/usr/bin/env node
/**
 * Fixture leak gate (R0.7). Scans packages/contract/fixtures (raw/ excluded) and exits 1 with
 * counts per category and file when it finds a leak. It never prints a matched value.
 *
 *   node scripts/fixture-leak-check.mjs [fixturesDir] [--raw <dir>]
 *
 * transcripts/ gets its own text, structure and account-literal checks (lib/transcript-leak-*.mjs).
 * To prove the CI path locally, point --raw at a directory that does not exist; raw/ is never moved.
 *
 * The default run also scans docs/CONTRACT.md with the text checks (not the payload structure check).
 *
 * With raw/ present the user name and project directory names are derived from it at run time;
 * without raw/ (CI) only the pattern and structure checks run (CI)
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXTURES_ROOT, RAW_ROOT } from "./lib/fixture-files.mjs";
import { leakCheck } from "./lib/fixture-leak-core.mjs";

const args = process.argv.slice(2);
const rawIdx = args.indexOf("--raw");
const rawArg = rawIdx >= 0 ? args[rawIdx + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && !(rawIdx >= 0 && i === rawIdx + 1));
const root = resolve(positional[0] ?? FIXTURES_ROOT);
const raw = resolve(rawArg ?? RAW_ROOT);
const rawPresent = existsSync(raw);
// With the default fixtures dir, docs/CONTRACT.md (hand-written notes about the captures) also gets
// the text checks. Not with an explicit dir: that is a test or one-off scan of something else.
// allow: the project's own name and ordinary words that are also folder names in the capture.
const DOCS_FILES = [
  {
    path: join(FIXTURES_ROOT, "..", "..", "..", "docs", "CONTRACT.md"),
    label: "docs/CONTRACT.md",
    allow: ["sessiondeck", "workspace", "thread"],
  },
];
const textFiles = positional[0] === undefined ? DOCS_FILES : [];

if (!existsSync(root)) {
  console.error("fixture-leak-check: fixtures directory not found");
  process.exit(2);
}
const r = leakCheck(root, { rawRoot: rawPresent ? raw : null, textFiles });
console.log(`mode: ${rawPresent ? "raw-derived literals + patterns" : "patterns only (no raw/)"}`);
console.log(`files scanned: ${r.files}`);
console.log(
  `derived literals: users=${r.literals.users} projects=${r.literals.projects} names=${r.literals.names} (skipped short=${r.literals.skipped})`,
);
if (r.transcripts) {
  const t = r.transcripts;
  console.log(
    `transcripts: files=${t.files} rows=${t.rows} raw=${t.literals.rawPresent ? "yes" : "no"} account-literals=${t.literals.accounts} fragments=${t.literals.fragments} folders=${t.literals.folders} hook-literals=${t.literals.hook}`,
  );
  const tc = Object.entries(t.byCategory).sort();
  console.log(
    `  transcript findings: ${tc.length === 0 ? "0" : tc.map(([c, n]) => `${c}=${n}`).join(" ")}`,
  );
}
for (const [c, n] of Object.entries(r.byCategory).sort()) console.log(`  ${c}: ${n}`);
for (const f of r.perFile.slice(0, 50)) console.log(`  ${f.file}: ${f.category} x${f.count}`);
console.log(r.total === 0 ? "PASS: no leaks found" : `FAIL: ${r.total} finding(s)`);
process.exit(r.total === 0 ? 0 : 1);
