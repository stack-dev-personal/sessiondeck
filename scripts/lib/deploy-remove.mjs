import { lstat, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInside } from "./capture-paths.mjs";
import { errorCode } from "./capture-store.mjs";
import { sha256 } from "./deploy.mjs";
import { findGitRoot, realpathLoose } from "./fs-roots.mjs";

/**
 * Removal of a deployed copy. The record it works from is read from the state file, which is only
 * as trustworthy as the settings file next to it, so every delete is checked against the disk:
 * the file must sit in the real deploy directory and hold exactly the recorded bytes.
 */

/**
 * @typedef {object} RemoveResult
 * @property {string[]} removed files deleted
 * @property {string[]} modified files kept because they differ from the record or sit behind a link
 * @property {boolean} kept the directory still exists
 * @property {string | undefined} refused set (to the work tree root) when nothing was touched
 */

/** @param {string} root @param {string} candidate */
function sameOrInside(root, candidate) {
  return root === candidate || isInside(root, candidate);
}

/**
 * Removes a directory only when it is a plain directory (not a link) and empty.
 * @param {string} dir
 */
async function removeIfEmpty(dir) {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return;
    await rmdir(dir);
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errorCode(error))) throw error;
  }
}

/**
 * Decides what to do with one recorded file.
 * @param {string} dir deploy directory @param {string} realRoot its real path
 * @param {{ path: string, sha256: string }} file
 * @returns {Promise<"remove" | "modified" | "absent">}
 */
async function classify(dir, realRoot, file) {
  const path = join(dir, file.path);
  if (!isInside(dir, path)) return "absent";
  const realParent = await realpath(dirname(path)).catch(() => undefined);
  if (realParent === undefined) return "absent";
  if (!sameOrInside(realRoot, realParent)) return "modified";
  const bytes = await readFile(path).catch(() => undefined);
  if (bytes === undefined) return "absent";
  return sha256(bytes) === file.sha256 ? "remove" : "modified";
}

/**
 * Removes the recorded files that are still exactly what was deployed, then the (now empty)
 * directories. Files that differ, or sit behind a link that leaves the directory, are kept.
 * Never recursive.
 * @param {import("./settings-model.mjs").DeployRecord} deploy
 * @returns {Promise<RemoveResult>} kept is true when the directory stays
 */
export async function removeDeployed(deploy) {
  const realRoot = await realpathLoose(deploy.dir);
  const tree = await findGitRoot(realRoot);
  if (tree !== undefined) return { removed: [], modified: [], kept: true, refused: tree };
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const modified = [];
  for (const file of deploy.files) {
    const verdict = await classify(deploy.dir, realRoot, file);
    const path = join(deploy.dir, file.path);
    if (verdict === "remove") {
      await rm(path, { force: true });
      removed.push(path);
    } else if (verdict === "modified") modified.push(path);
  }
  await removeIfEmpty(join(deploy.dir, "lib"));
  await removeIfEmpty(deploy.dir);
  const kept = await lstat(deploy.dir).then(
    () => true,
    () => false,
  );
  return { removed, modified, kept, refused: undefined };
}

/**
 * Which of the named files are absent from the directory right now.
 * @param {string} dir @param {{ path: string, sha256: string }[]} files @param {string[]} only
 * @returns {Promise<{ path: string, sha256: string }[]>}
 */
export async function missingFiles(dir, files, only) {
  const missing = [];
  for (const file of files.filter((f) => only.includes(f.path))) {
    const present = await readFile(join(dir, file.path)).then(
      () => true,
      () => false,
    );
    if (!present) missing.push({ path: file.path, sha256: file.sha256 });
  }
  return missing;
}

/**
 * Report lines for files that were not removed and why.
 * @param {RemoveResult} result
 * @returns {string[]}
 */
export function describeLeftovers(result) {
  const lines = [];
  if (result.refused !== undefined) {
    lines.push(`Nothing was deleted: the directory is inside a git work tree (${result.refused}).`);
  }
  if (result.modified.length > 0) {
    lines.push("Kept because they differ from what was deployed (delete them yourself if wanted):");
    lines.push(...result.modified.map((m) => `  ${m}`));
  }
  return lines;
}
