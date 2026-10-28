// Folder names from the raw cwd values and paths that must not survive in free text (R0.7, fix A
// companion). The scrub maps them inside paths; this module finds the ones that also appear in
// prose (a worktree name in a git command, a client folder in an error message).
//
// A name that already occurs in the repository's own tracked files is public vocabulary (this repo
// is public) and is left alone, as are layout words such as "src". Everything else is swept.
// The same list feeds the leak check, so the scrub and the gate agree. Values stay in memory.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STRUCT } from "./fixture-scrub-paths.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIN_FOLDER = 3;
const MAX_FOLDER = 80;
const CWD_KEYS = new Set(["cwd", "workingDirectory", "additionalWorkingDirectories"]);
const PATH_SHAPED = /^(?:[A-Za-z]:\/|\/)[^\n\r\t"<>|*?]{1,399}$/;
const ID_NAME =
  /^(?:agent-[0-9a-f]{8,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BINARY = /\.(?:png|jpe?g|gif|ico|gz|zip|woff2?|lock|pdf)$/i;

/** Path words that say nothing about a person. Lowercase. */
const LAYOUT = new Set(
  (
    "projects users home mnt usr opt lib var etc bin tmp temp src dist build docs doc scripts " +
    "packages test tests node claude agents skills hooks plans commands plugins settings state " +
    "output outputs public global local common memory sprint cache desktop documents downloads " +
    "appdata roaming worktrees scratchpad code data config logs log app apps web work repos " +
    "source capture fixtures shell raw decisions planning handoffs research phases sessions infra " +
    "subagents transcripts tool-results node_modules"
  ).split(" "),
);

/** @type {string | null} */
let cachedVocabulary = null;

/**
 * Lower-cased text of every tracked file in the repository (names and contents).
 * @param {string} [root] repository root
 * @returns {string}
 */
export function repoVocabulary(root = REPO_ROOT) {
  if (root === REPO_ROOT && cachedVocabulary !== null) return cachedVocabulary;
  let listed = "";
  try {
    listed = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
  } catch {
    listed = "";
  }
  const parts = [listed];
  for (const f of listed.split("\n")) {
    if (f === "" || BINARY.test(f)) continue;
    try {
      parts.push(readFileSync(join(root, f), "utf8"));
    } catch {
      // a listed file that is gone or unreadable simply adds nothing
    }
  }
  const text = parts.join("\n").toLowerCase();
  if (root === REPO_ROOT) cachedVocabulary = text;
  return text;
}

/**
 * @param {unknown} v @param {string} key
 * @param {Set<string>} acc
 */
function collect(v, key, acc) {
  if (typeof v === "string") {
    if (CWD_KEYS.has(key) || PATH_SHAPED.test(v)) acc.add(v);
  } else if (Array.isArray(v)) {
    for (const el of v) collect(el, key, acc);
  } else if (v !== null && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) collect(child, k, acc);
  }
}

/**
 * Folder and file-stem names found in the path-valued strings of the raw rows.
 * @param {Iterable<unknown>} rows
 * @param {Iterable<string>} known account literals (lowercase handled here), never repeated
 * @param {string} [vocabulary] lower-cased public text; defaults to the repository's tracked files
 * @returns {string[]} sorted
 */
export function deriveFolders(rows, known, vocabulary) {
  const paths = new Set();
  for (const r of rows) collect(r, "", paths);
  const skip = new Set([...known].map((x) => x.toLowerCase()));
  const vocab = vocabulary ?? repoVocabulary();
  const out = new Set();
  for (const p of paths) {
    for (const seg of p.split(/\/+/)) {
      const stem = /^(.+?)\.[A-Za-z0-9]{1,8}$/.exec(seg)?.[1];
      for (const s of [seg, stem]) {
        if (s === undefined || s.length < MIN_FOLDER || s.length > MAX_FOLDER) continue;
        const lower = s.toLowerCase();
        if (LAYOUT.has(lower) || skip.has(lower) || STRUCT.has(s) || ID_NAME.test(s)) continue;
        if (/[<>:|*?"~]/.test(s) || /^[A-Za-z]--users-/i.test(s)) continue;
        if (vocab.includes(lower)) continue;
        out.add(s);
      }
    }
  }
  return [...out].sort();
}
