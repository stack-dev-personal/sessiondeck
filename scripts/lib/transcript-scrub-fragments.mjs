// Fragments of the account names the transcript scrub must remove from free text (R0.7, fix A).
// A name such as "first.last42" or "some-org" can survive in prose as a piece ("first", "last"),
// so every piece of 5 or more characters is swept as a case-insensitive substring. The same set
// feeds the leak check (transcript-leak-raw.mjs), so scrub and gate cannot drift apart.
// Values are held in memory only and never printed.
//
// A handle is also expanded into every substring of 5+ characters (a surname inside a longer handle
// has no separator to split on). A substring that is part of a schema word (a key name, a tool or
// agent name, a settings source) is skipped: the scrub keeps those words by design.
import { BUILTIN_AGENTS, BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { TRANSCRIPT_KEYS } from "./fixture-keys.mjs";

/** Shortest piece that is swept on its own; shorter pieces are too common in ordinary text. */
export const MIN_FRAGMENT = 5;

/**
 * Pieces that are ordinary words, product names or our own placeholder words. Narrow on purpose:
 * everything else is over-redacted. Lowercase.
 */
export const COMMON_PIECES = new Set([
  "users",
  "admin",
  "local",
  "localhost",
  "github",
  "gitlab",
  "gmail",
  "hotmail",
  "outlook",
  "noreply",
  "example",
  "claude",
  "anthropic",
  "desktop",
  "laptop",
  "windows",
  "server",
  "email",
  "account",
  "redacted",
  "truncated",
  "thinking",
  "project",
  "request",
  "agent",
]);

/** Enum values the scrub keeps that are not key names. */
const ENUM_WORDS = "userSettings projectSettings localSettings policySettings flagSettings cliArg";
/** Lower-cased schema words, space separated, for substring tests. */
const SCHEMA_TEXT = [
  ...TRANSCRIPT_KEYS,
  ...BUILTIN_TOOLS,
  ...BUILTIN_AGENTS,
  ...ENUM_WORDS.split(" "),
]
  .join(" ")
  .toLowerCase();

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pieces of one token: the token, without digits, letter runs, camelCase words. @param {string} token */
function piecesOfToken(token) {
  const out = new Set([token, token.replace(/\d+/g, "")]);
  for (const run of token.match(/[A-Za-z]+/g) ?? []) {
    out.add(run);
    for (const w of run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []) out.add(w);
  }
  return out;
}

/** Longest handle that is expanded into every substring (longer values are only split into pieces). */
const MAX_HANDLE = 40;

/**
 * Every substring of 5+ characters of one handle, so a surname inside a longer handle is found
 * although no separator marks it. Taken from the letters-and-digits form and the letters-only form.
 * @param {string} value
 */
function* substringsOf(value) {
  if (value.length > MAX_HANDLE) return;
  const lower = value.toLowerCase();
  for (const form of new Set([lower.replace(/[^a-z0-9]/g, ""), lower.replace(/[^a-z]/g, "")])) {
    for (let from = 0; from + MIN_FRAGMENT <= form.length; from += 1) {
      for (let to = from + MIN_FRAGMENT; to <= form.length; to += 1) yield form.slice(from, to);
    }
  }
}

/**
 * Derives the fragment list from account-bearing values (user names, git names, owners, the
 * local part of the account's own email, the host name). Sorted longest first, lowercase, unique.
 * @param {Iterable<string>} values
 * @returns {string[]}
 */
export function deriveFragments(values) {
  const out = new Set();
  const add = (/** @type {string} */ piece) => {
    const p = piece.toLowerCase();
    if (p.length >= MIN_FRAGMENT && !COMMON_PIECES.has(p) && /[a-z]/.test(p)) out.add(p);
  };
  for (const value of values) {
    if (UUID_SHAPE.test(value)) continue; // an organization id is hex groups, not a name
    add(value);
    for (const sub of substringsOf(value)) if (!SCHEMA_TEXT.includes(sub)) add(sub);
    for (const token of value.split(/[^A-Za-z0-9]+/)) {
      if (token === "") continue;
      for (const piece of piecesOfToken(token)) add(piece);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}
