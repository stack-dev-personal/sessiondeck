// Leak checks over scrubbed fixtures (R0.7 gate). Reports counts per category and file, never values.
//
// Three layers, so the gate is an independent check and not a rerun of the scrubber:
//   1. text patterns over every file (home paths, emails, tokens), including settings/ and .md
//   2. structure over every payload (fixture-leak-structure.mjs): key names and string values must
//      be allowlisted or placeholders, with no raw/ needed (this is what CI runs)
//   3. literals derived from raw/ when present (fixture-leak-literals.mjs): user, project, every
//      path segment and named-field values must not appear anywhere, as key or value, in any case
// Every file outside raw/ gets the text checks. A type other than .json, .jsonl and .md is also
// reported as unscanned-file, because the structure check cannot read it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveLiterals } from "./fixture-leak-literals.mjs";
import { KNOWN_KEYS } from "./fixture-keys.mjs";
import { docAllowFor } from "./fixture-synthetic-doc.mjs";
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
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:|\/(?:mnt\/)?[A-Za-z])?[\\/]+(?:users|home)[\\/]+[^\s<\\/"]/i,
  /[A-Za-z]--users-[^\s<-]/i,
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
    else out.push(p);
  }
  return out;
}

// A path piece that reads as a folder or file name: words joined by - _ or ., each word letters only
// (lower, UPPER or Capitalized) with optional trailing digits, or digits with an optional letter
// suffix. Random base64 ("aB3dE5gH7jK") has case switches and digits between letters, so it fails.
const NAME_WORD = /^(?:(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)[0-9]*|[0-9]+(?:[a-z]+|[A-Z]+)?)$/;

/** @param {string} piece */
const looksLikeName = (piece) => piece.split(/[-_.]/).every((w) => w === "" || NAME_WORD.test(w));

/** @param {string} text */
function tokenRuns(text) {
  const stripped = text.replace(UUID_OR_TOOLU, "");
  let n = 0;
  for (const m of stripped.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    // A long relative file path ("docs/research/2026-10-08-some-note.md") is not a secret, but a
    // key used as one of its folder or file names ("keys/<40 chars>.pem") still is: test each part,
    // and require every part to read as a name, so a base64 secret cut into short pieces by "/"
    // ("aB3dE5gH7jK9/mN1pQ3sT5vW7yZ9bC1d.pem") does not pass either.
    const after = stripped.slice((m.index ?? 0) + m[0].length);
    if (m[0].includes("/") && /^\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(after)) {
      if (m[0].split("/").some((part) => isToken(part) || !looksLikeName(part))) n += 1;
      continue;
    }
    if (isToken(m[0])) n += 1;
  }
  return n;
}

const KNOWN_LOWER = new Set([...KNOWN_KEYS].map((k) => k.toLowerCase()));

/** @param {string} s */
const literalRe = (s) =>
  new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");

/** A segment directly before or after a path separator (either slash, JSON-escaped included). */
const segmentPathRe = (/** @type {string} */ s) => {
  const e = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:[\\\\/]${e}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${e}[\\\\/])`, "i");
};

/** Expected-result files next to the golden session: hand-written, so text checks only. */
const TIMELINE_FILE = /^sessions\/[^/]+\.timeline\.json$/;

/** Whether the file is a captured or synthetic payload (as opposed to prose or installer input). */
const isPayload = (/** @type {string} */ file, /** @type {string} */ rel) =>
  /\.jsonl?$/.test(file) && !TEXT_ONLY_TOP.has(rel.split("/")[0] ?? "") && !TIMELINE_FILE.test(rel);

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
 * @param {{ rawRoot?: string | null, textFiles?: { path: string, label: string, allow?: string[] }[] }} [opts] rawRoot: raw capture dir to derive literals from, omit on CI; textFiles: extra hand-written files (outside the fixtures dir) that get the text checks only, reported under their label; allow: raw-derived words that are public in that file (the project's own name, ordinary English that is also a folder name in the capture)
 * @returns {{ files: number, total: number, byCategory: Record<string, number>, perFile: { file: string, category: string, count: number }[], literals: { users: number, projects: number, segments: number, names: number, skipped: number } }}
 */
export function leakCheck(fixturesRoot, opts = {}) {
  const lit = deriveLiterals(opts.rawRoot ?? null);
  const projects = lit.projects.filter((n) => n.length >= MIN_NAME);
  const skipped = lit.projects.length - projects.length;
  // A literal that is also a schema key word ("workspace", "text") would match every payload's key
  // names; the structural check already guarantees values under path and name keys are placeholders.
  const withRe = (/** @type {string[]} */ names, /** @type {(s: string) => RegExp} */ make) =>
    names.map((n) => ({ n: n.toLowerCase(), re: make(n) }));
  const nameRes = withRe(
    [...projects, ...lit.names].filter((n) => !KNOWN_LOWER.has(n.toLowerCase())),
    literalRe,
  );
  const segments = lit.segments.filter((n) => !KNOWN_LOWER.has(n.toLowerCase()));
  // Path segments: next to a path separator in any file; as a bare word only in prose (.md,
  // settings/) and only when it is not a short lowercase word, which would be ordinary English.
  const segPathRes = withRe(segments, segmentPathRe);
  const segBareRes = withRe(
    segments.filter((n) => !/^[a-z]{1,4}$/.test(n)),
    literalRe,
  );
  const allowByLabel = new Map(
    (opts.textFiles ?? []).map((f) => [
      f.label,
      new Set((f.allow ?? []).map((a) => a.toLowerCase())),
    ]),
  );
  const userRes = lit.users.map(
    (u) =>
      new RegExp(
        `(?:Users|home)(?:\\\\\\\\|\\\\|/|-)+${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
        "i",
      ),
  );
  const userBareRes = lit.users.map(literalRe);
  /** @type {Record<string, number>} */
  const byCategory = {};
  const perFile = [];
  const fixtureFiles = existsSync(fixturesRoot) ? listFixtureFiles(fixturesRoot) : [];
  const files = [
    ...fixtureFiles.map((file) => ({
      file,
      rel: relative(fixturesRoot, file).split("\\").join("/"),
    })),
    ...(opts.textFiles ?? [])
      .filter((f) => existsSync(f.path))
      .map((f) => ({ file: f.path, rel: f.label })),
  ];
  for (const { file, rel } of files) {
    const text = readFileSync(file, "utf8");
    const allowed = allowByLabel.get(rel) ?? new Set();
    /** @type {Map<string, number>} */
    const counts = new Map();
    const hit = (/** @type {string} */ c, n = 1) => counts.set(c, (counts.get(c) ?? 0) + n);
    if (HOME_SHAPES.some((re) => re.test(text))) hit("home-path-shape");
    if (userRes.some((re) => re.test(text))) hit("user-name");
    // Hand-written files (.md, settings/) can name the user without a Users/ prefix.
    if (!isPayload(file, rel) && userBareRes.some((re) => re.test(text))) hit("user-name");
    if (!/\.(?:jsonl?|md)$/.test(file)) hit("unscanned-file");
    for (const x of nameRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    for (const x of segPathRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    if (!isPayload(file, rel))
      for (const x of segBareRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    if (EMAIL.test(text.replace(/<EMAIL>/g, ""))) hit("email");
    if (TOKEN_IN_TEXT.test(text)) hit("token-prefix");
    const runs = tokenRuns(text);
    if (runs > 0) hit("token-run", runs);
    if (file.endsWith(".json") || file.endsWith(".jsonl")) {
      try {
        const docs = parseDocs(file, text);
        if (isPayload(file, rel)) for (const d of docs) checkStructure(d, hit, docAllowFor(rel));
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
      segments: lit.segments.length,
      names: lit.names.length,
      skipped,
    },
  };
}
