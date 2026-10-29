// Local deny-list (R0.7, security gate fix): words that must never survive in a committed fixture,
// kept in raw/deny-words.txt, which is gitignored with the rest of raw/ and so can never be
// committed. One word per line, "#" starts a comment, matching is a case-insensitive substring.
// Both the scrub (replaces with <DENY>) and the leak check (fails on a survivor) read it. Without
// the file (CI) both run without it; the structural checks cover what they can without secrets.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DENY_FILE = "deny-words.txt";
export const DENY_PLACEHOLDER = "<DENY>";
const MIN_DENY = 3;

/**
 * Parses deny-list text: trimmed, lower-cased, unique, longest first.
 * @param {string} text
 * @returns {string[]}
 */
export function parseDenyWords(text) {
  const words = new Set();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().toLowerCase();
    if (w !== "" && !w.startsWith("#") && w.length >= MIN_DENY) words.add(w);
  }
  return [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * Loads <rawRoot>/deny-words.txt, or an empty list when raw/ or the file is absent.
 * @param {string | null | undefined} rawRoot
 * @returns {string[]}
 */
export function loadDenyWords(rawRoot) {
  if (!rawRoot) return [];
  const file = join(rawRoot, DENY_FILE);
  return existsSync(file) ? parseDenyWords(readFileSync(file, "utf8")) : [];
}

/**
 * Counts case-insensitive occurrences of any word in the text (counts only, never the match).
 * @param {string} text @param {string[]} words lower-case
 */
export function countDenyHits(text, words) {
  if (words.length === 0) return 0;
  const hay = text.toLowerCase();
  let n = 0;
  for (const w of words) {
    for (let at = hay.indexOf(w); at !== -1; at = hay.indexOf(w, at + w.length)) n += 1;
  }
  return n;
}
