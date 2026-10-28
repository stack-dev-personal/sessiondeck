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
import { checkTimeline } from "./fixture-leak-timeline.mjs";
import {
  EMAIL,
  HOME_SHAPES,
  TOKEN_IN_TEXT,
  literalRe,
  segmentPathRe,
  tokenRuns,
} from "./fixture-leak-patterns.mjs";
import { transcriptLeakCheck } from "./transcript-leak-core.mjs";
import { countDenyHits, loadDenyWords } from "./transcript-deny-list.mjs";

export { deriveLiterals };

const MIN_NAME = 3;
/** A relative path to a repository file in prose ("docs/sessions/some-note.md"). */
const REPO_FILE =
  /(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:md|mjs|ts|tsx|json|jsonl|ya?ml|txt)\b/g;
/** A commit named by its full hash in prose ("commit 2426..."); a bare 40-hex run still counts as a token. */
const COMMIT_HASH = /\b(commit|sha|rev|revision)\s+[0-9a-f]{40}\b/gi;
/** raw/ is the unscrubbed input and is never scanned; transcripts/ has its own checks (transcript-leak-core.mjs). */
const EXCLUDED_TOP = new Set(["raw", "transcripts"]);
/** Scanned with the text checks only: hand-written installer inputs are not payloads. */
const TEXT_ONLY_TOP = new Set(["settings"]);

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

const KNOWN_LOWER = new Set([...KNOWN_KEYS].map((k) => k.toLowerCase()));

/** Expected-result files next to the golden session: hand-written, so text checks plus a schema check. */
const TIMELINE_FILE = /^sessions\/[^/]+\.timeline\.json$/;

/** An expected-timeline file inside the fixtures dir (never an extra text file). */
const isTimeline = (/** @type {string} */ file, /** @type {string} */ rel) =>
  file.endsWith(".json") && TIMELINE_FILE.test(rel);

/** Raw-derived words that are public: only the extra text files carry any (keyed by entry, not label). */
const NO_WORDS = new Set();

/**
 * Vault mode: vault/ and vault-edge/ hold synthetic markdown captures and their expected JSON
 * goldens, not hook payloads. The hook-payload structure checks do not apply; every text and
 * pattern check still does. The goldens are checked against the ArchivePayload key set instead.
 */
const isVault = (/** @type {string} */ rel) => /^vault(?:-edge)?\//.test(rel);
const isVaultGolden = (/** @type {string} */ rel) => /^vault\/expected\/.+\.md\.json$/.test(rel);
/** The one placeholder home path allowed in vault files (nothing else under Users/ or home/). */
const VAULT_HOME = /C:\/Users\/dev(?![A-Za-z0-9_-])/g;
/** Non-data files that live next to the fixtures (forced -text rules for the byte-exact vault). */
const KNOWN_NON_DATA = new Set([".gitattributes"]);
/**
 * Keys of ArchivePayloadSchema (packages/contract/src/archive.ts), mirrored because this script is
 * plain .mjs; packages/contract/test/archive.test.ts asserts the mirror equals the schema's shape.
 * Goldens omit source.mtime_ms and source.size (they vary by checkout), so source keys are a subset.
 */
export const ARCHIVE_PAYLOAD_KEYS = [
  "source",
  "schema_version",
  "session_id",
  "collection",
  "title",
  "date",
  "started_at",
  "ended_at",
  "duration_s",
  "project_dir",
  "branch",
  "tools_used",
  "commits",
  "prs",
  "outcome",
  "outcome_truncated",
];
export const ARCHIVE_SOURCE_KEYS = ["root_label", "rel_path", "mtime_ms", "size"];
export const ARCHIVE_TOOL_KEYS = ["name", "count"];

/** @param {unknown} d @param {(c: string, n?: number) => void} hit */
function checkArchiveGolden(d, hit) {
  const isObj = (/** @type {unknown} */ v) =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(d)) return hit("golden-schema");
  const o = /** @type {Record<string, any>} */ (d);
  const extra = (/** @type {object} */ v, /** @type {string[]} */ keys) =>
    Object.keys(v).filter((k) => !keys.includes(k)).length;
  const missing = ARCHIVE_PAYLOAD_KEYS.filter((k) => k !== "source" && !(k in o)).length;
  if (extra(o, ARCHIVE_PAYLOAD_KEYS) + missing > 0) hit("golden-schema");
  if (isObj(o.source) && extra(o.source, ARCHIVE_SOURCE_KEYS) > 0) hit("golden-schema");
  if (Array.isArray(o.tools_used))
    for (const t of o.tools_used)
      if (!isObj(t) || extra(t, ARCHIVE_TOOL_KEYS) > 0) hit("golden-schema");
}

/** Whether the file is a captured or synthetic payload (as opposed to prose or installer input). */
const isPayload = (/** @type {string} */ file, /** @type {string} */ rel) =>
  /\.jsonl?$/.test(file) &&
  !TEXT_ONLY_TOP.has(rel.split("/")[0] ?? "") &&
  !TIMELINE_FILE.test(rel) &&
  !isVault(rel);

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
 * @returns {{ files: number, transcripts: ReturnType<typeof transcriptLeakCheck> | null, total: number, byCategory: Record<string, number>, perFile: { file: string, category: string, count: number }[], literals: { users: number, projects: number, segments: number, names: number, skipped: number, deny: number } }}
 */
export function leakCheck(fixturesRoot, opts = {}) {
  const lit = deriveLiterals(opts.rawRoot ?? null);
  const denyWords = loadDenyWords(opts.rawRoot);
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
      allowed: NO_WORDS,
      extra: false,
    })),
    ...(opts.textFiles ?? [])
      .filter((f) => existsSync(f.path))
      .map((f) => ({
        file: f.path,
        rel: f.label,
        extra: true,
        allowed: new Set((f.allow ?? []).map((a) => a.toLowerCase())),
      })),
  ];
  for (const { file, rel, allowed, extra } of files) {
    const text = readFileSync(file, "utf8");
    /** @type {Map<string, number>} */
    const counts = new Map();
    const hit = (/** @type {string} */ c, n = 1) => counts.set(c, (counts.get(c) ?? 0) + n);
    const vault = isVault(rel);
    const homeText = vault ? text.replace(VAULT_HOME, "") : text;
    if (HOME_SHAPES.some((re) => re.test(homeText))) hit("home-path-shape");
    if (userRes.some((re) => re.test(text))) hit("user-name");
    // Hand-written files (.md, settings/) can name the user without a Users/ prefix.
    if (!isPayload(file, rel) && userBareRes.some((re) => re.test(text))) hit("user-name");
    const dataRe = vault ? /\.(?:jsonl?|md|txt)$/ : /\.(?:jsonl?|md)$/;
    if (!dataRe.test(file) && !KNOWN_NON_DATA.has(rel)) hit("unscanned-file");
    for (const x of nameRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    for (const x of segPathRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    if (!isPayload(file, rel))
      for (const x of segBareRes) if (!allowed.has(x.n) && x.re.test(text)) hit("project-name");
    const denyHits = countDenyHits(text, denyWords);
    if (denyHits > 0) hit("deny-word", denyHits);
    if (EMAIL.test(text.replace(/<EMAIL>/g, ""))) hit("email");
    if (TOKEN_IN_TEXT.test(text)) hit("token-prefix");
    // Hand-written notes may cite a commit by its full 40-hex hash and name repository files by path.
    const runs = extra
      ? tokenRuns(text.replace(COMMIT_HASH, "$1 <SHA>").replace(REPO_FILE, "<FILE>"), true)
      : tokenRuns(text);
    if (runs > 0) hit("token-run", runs);
    if (file.endsWith(".json") || file.endsWith(".jsonl")) {
      try {
        const docs = parseDocs(file, text);
        if (isVaultGolden(rel)) for (const d of docs) checkArchiveGolden(d, hit);
        else if (isPayload(file, rel))
          for (const d of docs) checkStructure(d, hit, docAllowFor(rel));
        else if (!extra && isTimeline(file, rel)) for (const d of docs) checkTimeline(d, hit);
      } catch {
        hit("unparseable-json");
      }
    }
    for (const [category, count] of [...counts].sort()) {
      perFile.push({ file: rel, category, count });
      byCategory[category] = (byCategory[category] ?? 0) + count;
    }
  }
  // transcripts/ (R0.7, transcript extension): its own text, structure and account-literal checks.
  const tDir = join(fixturesRoot, "transcripts");
  let transcripts = null;
  if (existsSync(tDir)) {
    const rawT = opts.rawRoot ? join(opts.rawRoot, "transcripts") : null;
    transcripts = transcriptLeakCheck(tDir, {
      hook: lit,
      rawTranscripts: rawT !== null && existsSync(rawT) ? rawT : null,
      denyWords,
    });
    for (const f of transcripts.perFile) {
      perFile.push({ file: "transcripts/" + f.file, category: f.category, count: f.count });
      byCategory[f.category] = (byCategory[f.category] ?? 0) + f.count;
    }
  }
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  return {
    files: files.length + (transcripts?.files ?? 0),
    transcripts,
    total,
    byCategory,
    perFile,
    literals: {
      users: lit.users.length,
      projects: projects.length,
      segments: lit.segments.length,
      names: lit.names.length,
      skipped,
      deny: denyWords.length,
    },
  };
}
