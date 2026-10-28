// Leak check over scrubbed transcript fixtures (R0.7, transcript extension). Counts per category and
// file only; a matched value is never returned or printed. Called from fixture-leak-core.mjs.
//
//   1. text checks on every file: home paths in every form, email shapes, token patterns and long
//      runs, and the hook-mode literals (fixture-leak-literals.mjs) when raw/ exists
//   2. structure checks on every JSONL row and meta object (transcript-leak-structure.mjs)
//   3. with raw/transcripts: the account set the scrub sweeps (user, email, git and GitHub names,
//      host name, and their pieces of 5+ characters) and every folder name in raw cwd values and
//      paths must not appear anywhere. Without raw/ (CI) checks 1 and 2 still run.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { KNOWN_KEYS, TRANSCRIPT_KEYS } from "./fixture-keys.mjs";
import { EMAIL, HOME_SHAPES, TOKEN_IN_TEXT, tokenRuns } from "./fixture-leak-patterns.mjs";
import {
  checkTranscriptStructure,
  newContext,
  primeContext,
} from "./transcript-leak-structure.mjs";
import { countDenyHits } from "./transcript-deny-list.mjs";
import { countUnmappedMcpNames } from "./transcript-leak-mcp.mjs";
import { deriveRawSets } from "./transcript-leak-raw.mjs";
import { hasZone } from "./transcript-scrub-zone.mjs";
import { searchGroups } from "./transcript-leak-search.mjs";

/** Encoded forms the shared HOME_SHAPES do not cover: %5C or %2F between the folder names. */
const ENCODED_HOME = /(?:%5[Cc]|%2[Ff])(?:users|home)(?:%5[Cc]|%2[Ff])(?!<)/i;
/** A glob such as Users/* names no one; it is a permission rule shape, not a path to a person. */
const GLOB_HOME = /(?:users|home)[\\/]+[*]/gi;
const KEY_NAME = /"([A-Za-z_][A-Za-z0-9_-]{0,40})":/g;
const KNOWN_LOWER = new Set([...KNOWN_KEYS].map((k) => k.toLowerCase()));
/** Public words that are also folder names in the capture. */
const PUBLIC_WORDS = new Set(["sessiondeck", "workspace", "thread"]);
const MIN_NAME = 3;

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Blanks known key names so a literal that is also a schema word does not match every row. @param {string} text */
const withoutKnownKeys = (text) =>
  text.replace(KEY_NAME, (m, k) => (TRANSCRIPT_KEYS.has(k) ? '"":' : m));

/**
 * Builds the literal groups to search for.
 * @param {{ users: string[], projects: string[], segments: string[], names: string[] }} hook
 * @param {ReturnType<typeof deriveRawSets>} raw
 * @returns {{ category: string, mode: import("./transcript-leak-search.mjs").Mode, needles: string[] }[]}
 */
function buildGroups(hook, raw) {
  const keep = (/** @type {string[]} */ l) =>
    l.filter((n) => n.length >= MIN_NAME && !KNOWN_LOWER.has(n.toLowerCase()));
  const notPublic = (/** @type {string} */ n) => !PUBLIC_WORDS.has(n.toLowerCase());
  const hookNames = keep([...hook.projects, ...hook.names]).filter(notPublic);
  const hookSegments = keep(hook.segments)
    .filter(notPublic)
    .filter((n) => !/^[a-z]{1,4}$/.test(n));
  /** @type {{ category: string, mode: import("./transcript-leak-search.mjs").Mode, needles: string[] }[]} */
  const groups = [
    { category: "transcript-hook-literal", mode: "word", needles: hookNames },
    { category: "transcript-hook-literal", mode: "any", needles: hook.users },
    { category: "transcript-hook-literal", mode: "segment", needles: hookSegments },
    {
      category: "transcript-account-name",
      mode: "any",
      needles: [...raw.accounts.filter((a) => a.length >= 5), ...raw.fragments, ...raw.users],
    },
    {
      category: "transcript-account-name",
      mode: "word",
      needles: [...raw.accounts.filter((a) => a.length < 5), ...raw.emails],
    },
    { category: "transcript-folder-name", mode: "word", needles: raw.folders.filter(notPublic) },
    { category: "transcript-mcp-name", mode: "word", needles: raw.mcpServers },
  ];
  return groups.filter((g) => g.needles.length > 0);
}

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
 * @param {string} dir the fixtures transcripts/ directory
 * @param {{ hook?: { users: string[], projects: string[], segments: string[], names: string[] } | null, rawTranscripts?: string | null, vocabulary?: string, denyWords?: string[], git?: import("./transcript-scrub-literals.mjs").GitLookup }} [opts] denyWords: the local deny-list (raw/deny-words.txt), checked as case-insensitive substrings in every file
 * @returns {{ files: number, rows: number, byCategory: Record<string, number>, perFile: { file: string, category: string, count: number }[], literals: { accounts: number, fragments: number, folders: number, hook: number, deny: number, rawPresent: boolean, gitMissing: string[] } }}
 */
export function transcriptLeakCheck(dir, opts = {}) {
  const hook = opts.hook ?? { users: [], projects: [], segments: [], names: [] };
  const deny = opts.denyWords ?? [];
  const raw = deriveRawSets(opts.rawTranscripts ?? null, opts.vocabulary, opts.git);
  const groups = buildGroups(hook, raw);
  /** @type {Record<string, number>} */
  const byCategory = {};
  const perFile = [];
  let rows = 0;
  const files = listFiles(dir);
  for (const file of files) {
    const rel = relative(dir, file).split("\\").join("/");
    const text = readFileSync(file, "utf8");
    /** @type {Map<string, number>} */
    const counts = new Map();
    const hit = (/** @type {string} */ c, n = 1) => counts.set(c, (counts.get(c) ?? 0) + n);
    if (
      HOME_SHAPES.some((re) => re.test(text.replaceAll(GLOB_HOME, ""))) ||
      ENCODED_HOME.test(text)
    ) {
      hit("transcript-home-path-shape");
    }
    if (EMAIL.test(text.replace(/<EMAIL>/g, ""))) hit("transcript-email");
    if (hasZone(text)) hit("transcript-time-zone");
    if (TOKEN_IN_TEXT.test(text)) hit("transcript-token-prefix");
    const mcpNames = countUnmappedMcpNames(text);
    if (mcpNames > 0) hit("transcript-mcp-tool-name", mcpNames);
    const isJson = /\.jsonl?$/.test(file);
    // camelCase key names are long and mixed-case by nature; known ones are not token runs.
    const haystack = isJson ? withoutKnownKeys(text) : text;
    const runs = tokenRuns(haystack, true);
    if (runs > 0) hit("transcript-token-run", runs);
    if (!isJson && !file.endsWith(".md")) hit("transcript-unscanned-file");
    for (const [category, n] of searchGroups(haystack, groups)) hit(category, n);
    const denyHits = countDenyHits(text, deny);
    if (denyHits > 0) hit("transcript-deny-word", denyHits);
    if (isJson) {
      try {
        const docs = parseDocs(file, text);
        rows += docs.length;
        const ctx = newContext();
        primeContext(docs, ctx);
        for (const d of docs) checkTranscriptStructure(d, hit, ctx);
      } catch {
        hit("transcript-unparseable-json");
      }
    }
    for (const [category, count] of [...counts].sort()) {
      perFile.push({ file: rel, category, count });
      byCategory[category] = (byCategory[category] ?? 0) + count;
    }
  }
  return {
    files: files.length,
    rows,
    byCategory,
    perFile,
    literals: {
      accounts: raw.accounts.length + raw.users.length + raw.emails.length,
      fragments: raw.fragments.length,
      folders: raw.folders.length,
      hook: hook.users.length + hook.projects.length + hook.segments.length + hook.names.length,
      deny: deny.length,
      rawPresent: raw.present,
      gitMissing: raw.gitMissing,
    },
  };
}
