// Leak checks over scrubbed fixtures (R0.7 gate). Reports counts per category and file, never values.
//
// Three layers, so the gate is an independent check and not a rerun of the scrubber:
//   1. text patterns over every file (home paths, emails, tokens), including settings/ and .md
//   2. structure over every payload (fixture-leak-structure.mjs): key names and string values must
//      be allowlisted or placeholders, with no raw/ needed (this is what CI runs)
//   3. literals derived from raw/ when present (fixture-leak-literals.mjs): user, project and
//      named-field values must not appear anywhere, as key or value, in any case
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveLiterals } from "./fixture-leak-literals.mjs";
import { KNOWN_KEYS } from "./fixture-keys.mjs";
import { checkStructure } from "./fixture-leak-structure.mjs";
import { isToken } from "./fixture-scrub-core.mjs";

export { deriveLiterals };

const MIN_NAME = 3;
/** raw/ is the unscrubbed input and is never scanned. */
const EXCLUDED_TOP = new Set(["raw"]);
/** Scanned with the text checks only: hand-written installer inputs are not payloads. */
const TEXT_ONLY_TOP = new Set(["settings"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]/;
// Home paths in every written form, any case: C:\Users\x, c:/users/x, JSON-escaped backslashes,
// MSYS (/c/Users/x), WSL (/mnt/c/Users/x), /home/x, /Users/x, and the encoded project folder.
const HOME_SHAPES = [
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:|\/(?:mnt\/)?[A-Za-z])?[\\/]+(?:users|home)[\\/]+(?![<\\/])[A-Za-z0-9._-]/i,
  /[A-Za-z]--users-[A-Za-z0-9._]/i,
];
const TOKEN_IN_TEXT =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|Bearer [A-Za-z0-9._-]{8,})/;
const UUID_OR_TOOLU =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolu_[A-Za-z0-9]+|agent-[0-9a-f]+/gi;

/** @param {string} dir @param {boolean} [top] @returns {string[]} */
export function listFixtureFiles(dir, top = true) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (top && EXCLUDED_TOP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFixtureFiles(p, false));
    else if (/\.(?:jsonl?|md)$/.test(name)) out.push(p);
  }
  return out;
}

/** @param {string} text */
function tokenRuns(text) {
  const stripped = text.replace(UUID_OR_TOOLU, "");
  let n = 0;
  for (const m of stripped.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) if (isToken(m[0])) n += 1;
  return n;
}

const KNOWN_LOWER = new Set([...KNOWN_KEYS].map((k) => k.toLowerCase()));

/** @param {string} s */
const literalRe = (s) =>
  new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");

/** @param {string} file @param {string} text @returns {unknown[]} */
function parseDocs(file, text) {
  return file.endsWith(".jsonl")
    ? text
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : [JSON.parse(text)];
}

/**
 * @param {string} fixturesRoot
 * @param {{ rawRoot?: string | null }} [opts] raw capture dir to derive literals from; omit on CI
 * @returns {{ files: number, total: number, byCategory: Record<string, number>, perFile: { file: string, category: string, count: number }[], literals: { users: number, projects: number, names: number, skipped: number } }}
 */
export function leakCheck(fixturesRoot, opts = {}) {
  const lit = deriveLiterals(opts.rawRoot ?? null);
  const projects = lit.projects.filter((n) => n.length >= MIN_NAME);
  const skipped = lit.projects.length - projects.length;
  // A literal that is also a schema key word ("workspace", "text") would match every payload's key
  // names; the structural check already guarantees values under path and name keys are placeholders.
  const nameRes = [...projects, ...lit.names]
    .filter((n) => !KNOWN_LOWER.has(n.toLowerCase()))
    .map(literalRe);
  const userRes = lit.users.map(
    (u) =>
      new RegExp(
        `(?:Users|home)(?:\\\\\\\\|\\\\|/|-)+${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
        "i",
      ),
  );
  /** @type {Record<string, number>} */
  const byCategory = {};
  const perFile = [];
  const files = existsSync(fixturesRoot) ? listFixtureFiles(fixturesRoot) : [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(fixturesRoot, file).split("\\").join("/");
    /** @type {Map<string, number>} */
    const counts = new Map();
    const hit = (/** @type {string} */ c, n = 1) => counts.set(c, (counts.get(c) ?? 0) + n);
    if (HOME_SHAPES.some((re) => re.test(text))) hit("home-path-shape");
    if (userRes.some((re) => re.test(text))) hit("user-name");
    for (const re of nameRes) if (re.test(text)) hit("project-name");
    if (EMAIL.test(text.replace(/<EMAIL>/g, ""))) hit("email");
    if (TOKEN_IN_TEXT.test(text)) hit("token-prefix");
    const runs = tokenRuns(text);
    if (runs > 0) hit("token-run", runs);
    if (file.endsWith(".json") || file.endsWith(".jsonl")) {
      try {
        const docs = parseDocs(file, text);
        if (!TEXT_ONLY_TOP.has(rel.split("/")[0] ?? ""))
          for (const d of docs) checkStructure(d, hit);
      } catch {
        hit("unparseable-json");
      }
    }
    for (const [category, count] of [...counts].sort()) {
      perFile.push({ file: rel, category, count });
      byCategory[category] = (byCategory[category] ?? 0) + count;
    }
  }
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  return {
    files: files.length,
    total,
    byCategory,
    perFile,
    literals: {
      users: lit.users.length,
      projects: projects.length,
      names: lit.names.length,
      skipped,
    },
  };
}
