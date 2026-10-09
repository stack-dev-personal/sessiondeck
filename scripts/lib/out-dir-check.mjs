import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./capture-paths.mjs";
import { findGitRoot, nearestExisting, realpathLoose } from "./fs-roots.mjs";
import { InstallRefused } from "./install-errors.mjs";
import { foldPath } from "./settings-match.mjs";

/**
 * Where raw captures may go. They are unscrubbed, so the installer refuses any location that
 * could end up in a commit, or that would mix raw files into the committed fixtures layout.
 */

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_TIMEOUT_MS = 15_000;
const PROBE_PATH = ["Stop", "probe.json"];
const GIT_IGNORED = 0;
const GIT_NOT_IGNORED = 1;

/** @returns {string} <repo>/packages/contract/fixtures of the checkout this script lives in */
export function fixturesRoot() {
  return resolve(SCRIPTS_DIR, "..", "packages", "contract", "fixtures");
}

/** @returns {string} <repo>/packages/contract/fixtures/raw */
export function defaultOutDir() {
  return join(fixturesRoot(), "raw");
}

/** @param {string} a @param {string} b */
function sameDir(a, b) {
  return foldPath(a) === foldPath(b);
}

/** @param {string} root @param {string} candidate */
function insideOrSame(root, candidate) {
  return sameDir(root, candidate) || isInside(foldPath(root), foldPath(candidate));
}

/**
 * Refuses the committed fixtures root, anything that contains it, and anything under it other
 * than fixtures/raw (the committed layout is fixtures/<Event>/).
 * @param {string} realOut
 */
async function assertNotCommittedLayout(realOut) {
  const fixtures = await realpathLoose(fixturesRoot());
  const raw = join(fixtures, "raw");
  const containsFixtures = insideOrSame(realOut, fixtures);
  const underFixturesOutsideRaw = insideOrSame(fixtures, realOut) && !insideOrSame(raw, realOut);
  if (containsFixtures || underFixturesOutsideRaw) {
    throw new InstallRefused(
      `capture directory would mix raw files into the committed fixtures layout: ${realOut}`,
    );
  }
}

/**
 * @param {string} cwd @param {string} probe @param {NodeJS.ProcessEnv} env
 * @returns {number | null} git's exit status, null when git could not run
 */
function gitCheckIgnore(cwd, probe, env) {
  const result = spawnSync("git", ["-C", cwd, "check-ignore", "-q", "--", probe], {
    env,
    windowsHide: true,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    stdio: "ignore",
  });
  return result.error ? null : result.status;
}

/**
 * Inside a git work tree, git itself must say the capture directory is ignored.
 * @param {string} realOut @param {NodeJS.ProcessEnv} env
 */
async function assertIgnoredByGit(realOut, env) {
  if ((await findGitRoot(realOut)) === undefined) return;
  const cwd = await nearestExisting(realOut);
  const status = gitCheckIgnore(cwd, join(realOut, ...PROBE_PATH), env);
  if (status === GIT_IGNORED) return;
  const why =
    status === GIT_NOT_IGNORED ? "is not ignored by git" : "could not be checked with git";
  throw new InstallRefused(
    `capture directory ${why}: ${realOut}. Add an ignore rule for it first, or choose a directory outside the repository.`,
  );
}

/**
 * Throws InstallRefused unless outDir is a safe place for raw captures. Reads only.
 * @param {string} outDir @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
export async function checkOutDir(outDir, env) {
  const realOut = await realpathLoose(outDir);
  await assertNotCommittedLayout(realOut);
  await assertIgnoredByGit(realOut, env);
}
