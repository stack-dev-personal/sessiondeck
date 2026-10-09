import { stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorCode } from "./capture-store.mjs";

/**
 * Real path of p even when p (and some of its parents) do not exist yet: the nearest existing
 * ancestor is resolved and the missing tail is appended.
 * @param {string} p
 * @returns {Promise<string>}
 */
export async function realpathLoose(p) {
  try {
    return await realpath(p);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await realpathLoose(parent), basename(p));
  }
}

/**
 * Nearest existing ancestor directory of p (p itself when it exists).
 * @param {string} p
 * @returns {Promise<string>}
 */
export async function nearestExisting(p) {
  const info = await stat(p).catch(() => undefined);
  if (info) return info.isDirectory() ? p : dirname(p);
  const parent = dirname(p);
  return parent === p ? p : nearestExisting(parent);
}

/**
 * Directory that holds a `.git` entry at or above p, or undefined when p is not in a work tree.
 * @param {string} p a real path (see realpathLoose)
 * @returns {Promise<string | undefined>}
 */
export async function findGitRoot(p) {
  let dir = p;
  for (;;) {
    if (
      await stat(join(dir, ".git")).then(
        () => true,
        () => false,
      )
    )
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
