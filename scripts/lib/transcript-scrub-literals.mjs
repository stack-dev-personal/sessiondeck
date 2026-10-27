// Run-time discovery of the personal literals the transcript scrub must remove (R0.7). The values
// come from the raw rows and git config, live in memory only, and are never printed or written.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { deriveFragments } from "./transcript-scrub-fragments.mjs";
import { deriveFolders } from "./transcript-scrub-folders.mjs";

const HOME_USER = /(?:^|[\\/])(?:Users|home)[\\/]+([^\\/\s"']+)|[A-Za-z]--Users-([A-Za-z0-9._]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MIN_LITERAL = 4;
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

/** @param {string[]} args @returns {string} */
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
 * @returns {{ users: string[], emails: string[], accounts: string[], fragments: string[], folders: string[] }}
 */
export function discoverLiterals(rows, vocabulary) {
  const users = new Set();
  const emails = new Set();
  const accounts = new Set();
  /** Addresses that belong to the account itself; only their local parts are swept as names. */
  const own = new Set();
  /** @param {unknown} v @param {string} key */
  const walk = (v, key) => {
    if (typeof v === "string") {
      // Only path-valued fields name the real account; example paths in prose do not.
      if (PATH_FIELDS.has(key)) {
        for (const m of v.matchAll(HOME_USER)) {
          const name = m[1] ?? m[2];
          if (name && !LAYOUT.has(name.toLowerCase())) users.add(name);
        }
      }
      for (const m of v.matchAll(EMAIL)) emails.add(m[0]);
      if (key === "userEmail") {
        emails.add(v);
        own.add(v);
      }
      if (key === "prRepository") for (const o of ownersIn(`github.com/${v}`)) accounts.add(o);
      if (key === "prUrl") for (const o of ownersIn(v)) accounts.add(o);
      if (key === "organizationUuid" || key === "organizationName" || key === "owner")
        accounts.add(v);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el, key);
    } else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(child, k);
    }
  };
  const all = [...rows];
  for (const row of all) walk(row, "");

  const gitEmail = git(["config", "user.email"]);
  if (gitEmail) {
    emails.add(gitEmail);
    own.add(gitEmail);
  }
  for (const n of [git(["config", "user.name"])]) if (n) accounts.add(n);
  for (const o of ownersIn(git(["remote", "get-url", "origin"]))) accounts.add(o);
  for (const e of own) {
    const local = e.split("@")[0] ?? "";
    if (local.length >= MIN_LITERAL) accounts.add(local);
    const letters = local.replace(/[\d._+-]+$/, "");
    if (letters.length >= MIN_LITERAL) accounts.add(letters);
  }
  accounts.add(hostname()); // the machine name usually embeds the user name
  const keep = (/** @type {Set<string>} */ s) => [...s].filter((x) => x.length >= 3).sort();
  const accountList = keep(accounts).filter((x) => x.length >= MIN_LITERAL);
  const userList = keep(users);
  return {
    users: userList,
    emails: keep(emails),
    accounts: accountList,
    // Pieces of every name above (fix A): swept from free text as substrings.
    fragments: deriveFragments([...userList, ...accountList]),
    // Folder names from raw paths that also show up in prose and are not public vocabulary.
    folders: deriveFolders(all, [...userList, ...accountList], vocabulary),
  };
}
