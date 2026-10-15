// Leak checks over scrubbed fixtures (R0.7 gate). Reports counts per category and file, never values.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { listEvents, readEvent } from "./fixture-files.mjs";
import { Mapper } from "./fixture-scrub-paths.mjs";
import { isToken } from "./fixture-scrub-core.mjs";

const MAX_STRING = 200;
const MIN_NAME = 3;
/** raw/ is the unscrubbed input; settings/ holds hand-written installer test inputs, not payloads. */
const EXCLUDED_TOP = new Set(["raw", "settings"]);
const PLACEHOLDER = /^<[A-Z_]+(?: \d+)?>$|^<HOME>|^<ROOT>/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]/;
const HOME_SHAPES = [
  /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+(?!<)/, // C:\Users\x, C:/Users/x, JSON-escaped
  /(?:^|[^A-Za-z])\/(?:Users|home)\/(?!<)[A-Za-z0-9._-]/,
  /[A-Za-z]--Users-[A-Za-z0-9._]/, // encoded project folder
];
const TOKEN_IN_TEXT =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|Bearer [A-Za-z0-9._-]{8,})/;
/** Key names whose value must be a placeholder, at any depth. */
const FREE_TEXT_KEYS = new Set([
  "prompt",
  "message",
  "last_assistant_message",
  "compact_summary",
  "error",
  "error_details",
  "description",
  "command",
  "content",
  "query",
  "plan",
  "stdout",
  "stderr",
  "summary",
  "label",
  "header",
  "question",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "originalFile",
  "task_subject",
  "task_description",
  "session_name",
  "reason",
  "custom_instructions",
]);
/** Free-text keys that legitimately carry a short enum word (error class, SessionEnd reason). */
const ENUM_OK = new Set(["error", "reason"]);
const ENUM_WORD = /^[a-z][a-z0-9_]{2,39}$/;
const UUID_OR_TOOLU =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolu_[A-Za-z0-9]+|agent-[0-9a-f]+/gi;

/** @param {string} dir @param {boolean} [top] @returns {string[]} */
export function listFixtureFiles(dir, top = true) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (top && EXCLUDED_TOP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFixtureFiles(p, false));
    else if (/\.jsonl?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Literals derived from the raw captures: user names and project directory names.
 * @param {string | null} rawRoot
 * @returns {{ users: string[], projects: string[] }}
 */
export function deriveLiterals(rawRoot) {
  if (rawRoot === null || !existsSync(rawRoot)) return { users: [], projects: [] };
  const paths = new Set();
  for (const ev of listEvents(rawRoot)) {
    for (const it of readEvent(rawRoot, ev).items) {
      for (const v of [
        it.payload.cwd,
        it.payload.transcript_path,
        it.payload.workspace?.project_dir,
      ]) {
        if (typeof v === "string") paths.add(v);
      }
    }
  }
  const users = new Set();
  for (const p of paths) {
    const m =
      /(?:^|[\\/])(?:Users|home)[\\/]+([^\\/]+)/.exec(p) ?? /^[A-Za-z]--Users-([^-]+)/.exec(p);
    if (m?.[1]) users.add(m[1]);
  }
  const mapper = new Mapper();
  mapper.seedProjects([...paths].sort());
  const projects = [...mapper.projects.keys()].filter((n) => !n.startsWith("enc:"));
  return { users: [...users].sort(), projects: projects.sort() };
}

/** @param {unknown} v @param {string} key @param {(c: string) => void} hit @param {string} parentKey */
function walk(v, key, hit, parentKey = "") {
  if (typeof v === "string") {
    if (v.length > MAX_STRING) hit("string-over-200");
    if (
      FREE_TEXT_KEYS.has(key) &&
      v !== "" &&
      !PLACEHOLDER.test(v) &&
      !(ENUM_OK.has(key) && ENUM_WORD.test(v))
    ) {
      hit("free-text-not-placeholder");
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const el of v) walk(el, key, hit, parentKey);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      if (k.length > MAX_STRING) hit("string-over-200");
      walk(child, k, hit, key);
    }
  }
}

/** @param {string} text */
function tokenRuns(text) {
  const stripped = text.replace(UUID_OR_TOOLU, "");
  let n = 0;
  for (const m of stripped.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) if (isToken(m[0])) n += 1;
  return n;
}

/**
 * @param {string} fixturesRoot
 * @param {{ rawRoot?: string | null }} [opts] raw capture dir to derive literals from; omit on CI
 * @returns {{ files: number, total: number, byCategory: Record<string, number>, perFile: { file: string, category: string, count: number }[], literals: { users: number, projects: number, skipped: number } }}
 */
export function leakCheck(fixturesRoot, opts = {}) {
  const lit = deriveLiterals(opts.rawRoot ?? null);
  const names = lit.projects.filter((n) => n.length >= MIN_NAME);
  const skipped = lit.projects.length - names.length;
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
    for (const u of lit.users) {
      const re = new RegExp(
        `(?:Users|home)(?:\\\\\\\\|\\\\|/|-)+${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
        "i",
      );
      if (re.test(text)) hit("user-name");
    }
    for (const n of names) {
      const re = new RegExp(
        `(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
        "i",
      );
      if (re.test(text)) hit("project-name");
    }
    if (EMAIL.test(text.replace(/<EMAIL>/g, ""))) hit("email");
    if (TOKEN_IN_TEXT.test(text)) hit("token-prefix");
    const runs = tokenRuns(text);
    if (runs > 0) hit("token-run", runs);
    try {
      const parsed = file.endsWith(".jsonl")
        ? text
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l))
        : [JSON.parse(text)];
      for (const doc of parsed) walk(doc, "", hit);
    } catch {
      hit("unparseable-json");
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
    literals: { users: lit.users.length, projects: names.length, skipped },
  };
}
