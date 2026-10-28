// Text patterns shared by the hook-fixture leak check (fixture-leak-core.mjs) and the transcript
// leak check (transcript-leak-*.mjs). Moved out of fixture-leak-core.mjs unchanged, so both gates
// run the same home-path, email and token rules. Matchers only; nothing here reports values.
import { isToken } from "./fixture-scrub-core.mjs";

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]/;
// Home paths in every written form, any case: C:\Users\x, c:/users/x, JSON-escaped backslashes,
// MSYS (/c/Users/x), WSL (/mnt/c/Users/x), /home/x, /Users/x, and the encoded project folder.
export const HOME_SHAPES = [
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:|\/(?:mnt\/)?[A-Za-z])?[\\/]+(?:users|home)[\\/]+[^\s<\\/"]/i,
  /[A-Za-z]--users-[^\s<-]/i,
  // a drive letter and a home folder whose separators were lost: C:Users<name>...
  /(?<![A-Za-z0-9])[A-Za-z]:(?:users|home)[A-Za-z]/i,
];
export const TOKEN_IN_TEXT =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|Bearer [A-Za-z0-9._-]{8,}|(?:npm|sbp|glpat|hf)_[A-Za-z0-9_-]{8,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|cf(?:ut|at|k)_[A-Za-z0-9]{20,}|[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@)/;
const UUID_OR_TOOLU =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolu_[A-Za-z0-9]+|agent-[0-9a-f]+/gi;

// A path piece that reads as a folder or file name: words joined by - _ or ., each word letters only
// (lower, UPPER, camelCase or PascalCase as in useSessionList, SessionCard) with optional trailing digits, or digits with an optional letter
// suffix. Random base64 ("aB3dE5gH7jK") has case switches and digits between letters, so it fails.
const NAME_WORD =
  /^(?:(?:[a-z]+(?:[A-Z][a-z]+)*|[A-Z]+|(?:[A-Z][a-z]+)+)[0-9]*|[0-9]+(?:[a-z]+|[A-Z]+)?)$/;

/** @param {string} piece */
const looksLikeName = (piece) => piece.split(/[-_.]/).every((w) => w === "" || NAME_WORD.test(w));

const PARTIAL_UUID = /[0-9a-f]{8}(?:-[0-9a-f]{1,12}){0,4}(?=<TRUNCATED)/gi;

/** Words joined by / - _ . or = (a path, a kebab name, NAME=value), none of which is itself a token. @param {string} run */
const isNameRun = (run) =>
  run.split("/").every((part) => {
    const flat = part.replaceAll("=", "-");
    return looksLikeName(flat) && !flat.split(/[-_.]/).some(isToken);
  });

/**
 * @param {string} text
 * @param {boolean} [namesOk] a run whose parts (split on / - _ .) all read as words, with no part that is itself a token, is a kebab or snake case name (an API beta such as a-b-2025-06-27), not a secret
 * @returns {number} count of token-like runs
 */
export function tokenRuns(text, namesOk = false) {
  // An id cut by a truncation marker is a partial uuid, not a secret.
  const cut = namesOk ? text.replace(PARTIAL_UUID, "") : text;
  const stripped = cut.replace(UUID_OR_TOOLU, "");
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
    if (namesOk && isNameRun(m[0])) continue;
    if (isToken(m[0])) n += 1;
  }
  return n;
}

/** @param {string} s */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive literal. @param {string} s */
export const literalRe = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, "i");

/** A segment directly before or after a path separator (either slash, JSON-escaped included). @param {string} s */
export const segmentPathRe = (s) => {
  const e = escapeRe(s);
  return new RegExp(`(?:[\\\\/]${e}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${e}[\\\\/])`, "i");
};
