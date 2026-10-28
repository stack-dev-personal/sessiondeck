// Literals the transcript leak check searches for (R0.7, transcript extension), derived at run time
// from raw/transcripts when it exists. The set is the one the scrub sweeps (same discoverLiterals:
// user, email, git and GitHub names, host name, their pieces of 5+ characters, and raw folder names
// that are not public vocabulary), so the check and the scrub cannot disagree about what is
// personal. Values live in memory only; callers report counts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverLiterals } from "./transcript-scrub-literals.mjs";

/** @param {string} dir @returns {string[]} */
function listJson(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJson(p));
    else if (/\.(?:jsonl|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** @param {string} file @returns {unknown[]} */
function readRows(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }
  return [JSON.parse(text)];
}

/**
 * @param {string | null} rawDir raw/transcripts, or null (CI)
 * @param {string} [vocabulary] lower-cased public text; defaults to the repository's tracked files
 * @param {import("./transcript-scrub-literals.mjs").GitLookup} [lookup] git runner (tests)
 * @returns {{ present: boolean, users: string[], emails: string[], accounts: string[], fragments: string[], folders: string[], mcpServers: string[], gitMissing: string[] }}
 */
export function deriveRawSets(rawDir, vocabulary, lookup) {
  const none = {
    present: false,
    users: [],
    emails: [],
    accounts: [],
    fragments: [],
    folders: [],
    mcpServers: [],
    gitMissing: [],
  };
  if (rawDir === null || !existsSync(rawDir)) return none;
  const lit = discoverLiterals(listJson(rawDir).flatMap(readRows), vocabulary, lookup);
  return { present: true, ...lit };
}
