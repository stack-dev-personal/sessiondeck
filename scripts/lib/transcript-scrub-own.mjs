// Run-level guards of the transcript scrub and its leak check (R0.7, review fixes). Both fail
// closed instead of running with a reduced rule set:
//   1. the three git lookups behind account-name discovery (user.email, user.name, origin owner)
//      must each return something, unless --no-git-literals is given
//   2. the project that counts as "inside" (<PROJECT_A> in the output) must be this repository's own
//      folder name, not whichever project name sorts first among the raw cwd values
// Pure except for the git call in ownProjectName. Messages name sources, never values.
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** Flag that turns the git-literal gate off (the three sources are then reported but not fatal). */
export const NO_GIT_LITERALS = "--no-git-literals";
/** Flag that names this repository's folder when it cannot be derived from git. */
export const OWN_PROJECT = "--own-project";

/**
 * Message for the git lookups that came back empty, or null when none did or the gate is off.
 * @param {string[]} missing source names from discoverLiterals
 * @param {boolean} optOut whether --no-git-literals was given
 * @returns {string | null}
 */
export function gitLiteralProblem(missing, optOut) {
  if (missing.length === 0 || optOut) return null;
  return `git lookup empty: ${missing.join(", ")}. Account names from git are not swept; fix the git config or pass ${NO_GIT_LITERALS}`;
}

/**
 * This repository's folder name: the parent of the shared .git directory, so a worktree reports the
 * main checkout's name. Returns "" when it cannot be derived.
 * @returns {string}
 */
export function ownProjectName() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dir = resolve(common);
    return basename(dir) === ".git" ? basename(dirname(dir)) : "";
  } catch {
    return "";
  }
}

/** A folder name that can be matched against a path segment. @param {string} name */
export const isProjectName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);

/**
 * Checks that the project mapped to <PROJECT_A> is the repository's own.
 * @param {ReadonlyMap<string, string>} projects mapper.projects (folder name to placeholder)
 * @param {string} own the repository's folder name
 * @returns {string | null} problem text, or null when <PROJECT_A> is the own project
 */
export function ownProjectProblem(projects, own) {
  const mapped = [...projects].find(([name]) => name.toLowerCase() === own.toLowerCase());
  if (mapped?.[1] === "<PROJECT_A>") return null;
  return `<PROJECT_A> is not the repository's own project folder; pass ${OWN_PROJECT} <folder name>`;
}
