// Run-time discovery of the personal literals the transcript scrub must remove (R0.7). The values
// come from the raw rows and git config, live in memory only, and are never printed or written.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { deriveFragments } from "./transcript-scrub-fragments.mjs";
import { deriveFolders, repoVocabulary } from "./transcript-scrub-folders.mjs";
import { deriveMcpServers, deriveRepos } from "./transcript-scrub-names.mjs";

const HOME_USER = /(?:^|[\\/])(?:Users|home)[\\/]+([^\\/\s"']+)|[A-Za-z]--Users-([A-Za-z0-9._]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MIN_LITERAL = 4;
/**
 * Shape of a literal that is swept from free text: one handle (letters, digits and . _ @ + -), no
 * spaces, at most 40 characters. A value of any other shape is a sentence or a blob that happened
 * to sit in an account field; sweeping it would cut ordinary words and its leftovers would show
 * which letters were removed.
 */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,39}$/;
/** A plain address: a single at-sign, no spaces, at most 100 characters. */
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,63}$/;

/** @param {string} v */
export const isHandle = (v) => HANDLE.test(v);
/** @param {string} v */
export const isAddress = (v) => v.length <= 100 && ADDRESS.test(v);
const PATH_FIELDS = new Set([
  "cwd",
  "workingDirectory",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "displayPath",
  "filename",
  "planFilePath",
  "scratchpadDirectory",
  "trackingPath",
  "additionalWorkingDirectories",
]);
/** Path words after a home prefix that are layout, not a person. */
const LAYOUT = new Set(["public", "default", "shared", "all", "guest"]);

/** The words of a person's name that have the shape of a handle. @param {string} name */
function nameWords(name) {
  if (isHandle(name)) return [name];
  if (name.length > 80) return [];
  return name.split(/\s+/).filter((w) => isHandle(w) && w.length >= MIN_LITERAL);
}

/** @typedef {(args: string[]) => string} GitLookup */

/** The real git runner; "" when git fails (the caller reports the empty source). @type {GitLookup} */
function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** @param {string} url @returns {string[]} */
function ownersIn(url) {
  const m = /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]+([A-Za-z0-9_.-]+)/i.exec(url);
  return m?.[1] ? [m[1]] : [];
}

/**
 * Collects literals from parsed raw rows.
 * @param {Iterable<unknown>} rows
 * @param {string} [vocabulary] lower-cased public text that exempts folder names (default: tracked repo files)
 * @param {GitLookup} [lookup] git runner (default: the real git); tests pass a stub
 * @returns {{ users: string[], emails: string[], accounts: string[], fragments: string[], folders: string[], mcpServers: string[], gitMissing: string[] }} gitMissing names the git sources that gave nothing usable
 */
export function discoverLiterals(rows, vocabulary, lookup = git) {
  const users = new Set();
  const emails = new Set();
  const accounts = new Set();
  /** Addresses that belong to the account itself; only their local parts are swept as names. */
  const own = new Set();
  /** @param {string} v */
  const addHandle = (v) => {
    if (isHandle(v)) accounts.add(v);
  };
  /** @param {unknown} v @param {string} key */
  const walk = (v, key) => {
    if (typeof v === "string") {
      // Only path-valued fields name the real account; example paths in prose do not.
      if (PATH_FIELDS.has(key)) {
        for (const m of v.matchAll(HOME_USER)) {
          const name = m[1] ?? m[2];
          if (name && isHandle(name) && !LAYOUT.has(name.toLowerCase())) users.add(name);
        }
      }
      for (const m of v.matchAll(EMAIL)) if (isAddress(m[0])) emails.add(m[0]);
      if (key === "userEmail" && isAddress(v)) {
        emails.add(v);
        own.add(v);
      }
      if (key === "prRepository") for (const o of ownersIn(`github.com/${v}`)) addHandle(o);
      if (key === "prUrl") for (const o of ownersIn(v)) addHandle(o);
      if (key === "organizationUuid" || key === "organizationName" || key === "owner")
        if (isHandle(v)) accounts.add(v);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el, key);
    } else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(child, k);
    }
  };
  const all = [...rows];
  for (const row of all) walk(row, "");

  /** @type {string[]} */
  const gitMissing = [];
  const gitEmail = lookup(["config", "user.email"]);
  if (gitEmail && isAddress(gitEmail)) {
    emails.add(gitEmail);
    own.add(gitEmail);
  } else gitMissing.push("git user.email");
  // The git name is a person's name: swept whole when it is one handle, otherwise word by word.
  // A set name counts as present even when no word of it is long enough to sweep (e.g. "Al Wu").
  const gitName = lookup(["config", "user.name"]);
  for (const n of nameWords(gitName)) accounts.add(n);
  if (gitName === "") gitMissing.push("git user.name");
  const owners = ownersIn(lookup(["remote", "get-url", "origin"]));
  for (const o of owners) addHandle(o);
  if (owners.length === 0) gitMissing.push("origin owner");
  for (const e of own) {
    const local = e.split("@")[0] ?? "";
    if (local.length >= MIN_LITERAL) accounts.add(local);
    const letters = local.replace(/[\d._+-]+$/, "");
    if (letters.length >= MIN_LITERAL) accounts.add(letters);
  }
  addHandle(hostname()); // the machine name usually embeds the user name
  const keep = (/** @type {Set<string>} */ s) => [...s].filter((x) => x.length >= 3).sort();
  const accountList = keep(accounts).filter((x) => x.length >= MIN_LITERAL);
  const userList = keep(users);
  const vocab = vocabulary ?? repoVocabulary();
  const known = [...userList, ...accountList];
  const folders = deriveFolders(all, known, vocab);
  const repos = deriveRepos(all, vocab, known);
  return {
    users: userList,
    emails: keep(emails),
    accounts: accountList,
    // Pieces of every name above (fix A): swept from free text as substrings.
    fragments: deriveFragments([...userList, ...accountList]),
    // Folder names from raw paths that also show up in prose and are not public vocabulary, plus
    // repository names from URLs, API paths and gh loops that are not public vocabulary.
    folders: [...new Set([...folders, ...repos])].sort(),
    mcpServers: deriveMcpServers(all),
    gitMissing,
  };
}
