#!/usr/bin/env node
/**
 * Transcript inventory (R0.7 tooling): structure of Claude Code session transcripts. Counts and
 * key names only, never values. Read-only on sources.
 *
 *   node scripts/transcript-inventory.mjs --dir <projectDir>... [--exclude <sessionId>]...
 *       [--skip-recent-min 30] [--per-file] [--copy-to <gitignoredDir>]
 *
 * Each --dir holds <id>.jsonl files (and <id>/subagents/ beside them). Candidates are labelled
 * c01, c02, ... in the output; ids and folder names are never printed. --copy-to copies the five
 * selected transcripts (session.jsonl plus subagents/) after `git check-ignore` confirms the
 * target is ignored.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import {
  analyzeCandidate,
  featuresOf,
  formatStats,
  mergeStats,
  newStats,
  selectCandidates,
} from "./lib/transcript-inventory-core.mjs";

const args = process.argv.slice(2);
/** @param {string} flag @returns {string[]} */
const values = (flag) =>
  args.flatMap((a, i) => (a === flag && args[i + 1] ? [/** @type {string} */ (args[i + 1])] : []));
const dirs = values("--dir");
const exclude = new Set(values("--exclude"));
const skipMin = Number(values("--skip-recent-min")[0] ?? 30);
const copyTo = values("--copy-to")[0];
if (dirs.length === 0) {
  console.error("usage: transcript-inventory --dir <projectDir>... [--exclude id] [--copy-to dir]");
  process.exit(2);
}

const cutoff = Date.now() - skipMin * 60_000;
const found = [];
let skippedRecent = 0;
let skippedExcluded = 0;
for (const dir of dirs) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    if (exclude.has(basename(name, ".jsonl"))) skippedExcluded += 1;
    else if (statSync(file).mtimeMs > cutoff) skippedRecent += 1;
    else found.push(file);
  }
}

const cands = found.map((f) => analyzeCandidate(f));
const label = (/** @type {any} */ c) => `c${String(cands.indexOf(c) + 1).padStart(2, "0")}`;
const out = [];
out.push(
  `candidates ${cands.length}, skipped (modified in last ${skipMin} min) ${skippedRecent}, excluded ${skippedExcluded}`,
  "",
  "# per file: label, main bytes, rows, subagent files, subagent bytes",
);
for (const c of cands) {
  out.push(`${label(c)}\t${c.mainBytes}\t${c.mainRows}\t${c.subFiles.length}\t${c.stats.subBytes}`);
}

if (args.includes("--per-file")) {
  for (const c of cands) out.push("", `# ${label(c)}`, formatStats(c.stats));
}

const total = newStats();
for (const c of cands) mergeStats(total, c.stats);
out.push("", "# AGGREGATE (all candidates)", formatStats(total));

const { chosen, notes } = selectCandidates(cands, 5);
const all = new Set(cands.flatMap((c) => [...featuresOf(c.stats)]));
const coveredBy = (/** @type {string} */ f) =>
  chosen.filter((c) => featuresOf(c.stats).has(f)).map(label);
out.push("# SELECTION", ...notes.map((n) => `note: ${n}`));
for (const c of chosen) {
  out.push(
    `${label(c)}\t${c.mainBytes + c.stats.subBytes} bytes\tsubagent files ${c.subFiles.length}`,
  );
}
out.push("", "# COVERAGE (feature -> chosen)");
const uncovered = [];
for (const f of [...all].filter((x) => !x.startsWith("keyset:")).sort()) {
  const by = coveredBy(f);
  out.push(`${f}\t${by.join(",") || "NONE"}`);
  if (by.length === 0) {
    const have = cands.filter((c) => featuresOf(c.stats).has(f)).map(label);
    uncovered.push(`${f}\toffered by ${have.join(",")}`);
  }
}
const ksAll = [...all].filter((x) => x.startsWith("keyset:"));
const ksCovered = ksAll.filter((f) => coveredBy(f).length > 0);
out.push(`key sets covered ${ksCovered.length}/${ksAll.length}`);
out.push("", "# UNCOVERED", ...(uncovered.length ? uncovered : ["(none)"]));
for (const f of ksAll.filter((x) => coveredBy(x).length === 0)) out.push(`${f}`);

process.stdout.write(`${out.join("\n")}\n`);

if (copyTo !== undefined) {
  try {
    execFileSync("git", ["check-ignore", "-q", join(copyTo, "x")], { stdio: "ignore" });
  } catch {
    console.error("transcript-inventory: copy target is not gitignored; nothing copied");
    process.exit(3);
  }
  chosen.forEach((c, i) => {
    const feats = featuresOf(c.stats);
    const words = [];
    if (c.subFiles.length > 0) words.push("subagents");
    if (feats.has("flag:compact_boundary")) words.push("compaction");
    if (feats.has("command:/clear")) words.push("clear");
    if (feats.has("flag:sessionId!=filename")) words.push("resume");
    const slug = `${String(i + 1).padStart(2, "0")}-${words.join("-") || "baseline"}`;
    const base = join(copyTo, slug);
    mkdirSync(join(base, "subagents"), { recursive: true });
    copyFileSync(c.file, join(base, "session.jsonl"));
    for (const n of [...c.subFiles, ...c.metaFiles])
      copyFileSync(join(c.subDir, n), join(base, "subagents", n));
    console.log(`copied ${label(c)} -> ${slug} (${existsSync(base) ? "ok" : "missing"})`);
  });
}
