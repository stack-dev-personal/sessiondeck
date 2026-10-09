import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_LOG_NAME } from "./capture-config.mjs";

/**
 * Running total of captured bytes. Each stored payload appends one line holding its size, so the
 * hook never walks the tree. Concurrent hooks append whole short lines, which do not interleave.
 * Deleting the out dir resets the total.
 */

/**
 * @param {string} root
 * @returns {Promise<number>} bytes recorded so far (0 when nothing was recorded)
 */
export async function usedBytes(root) {
  let text;
  try {
    text = await readFile(join(root, USAGE_LOG_NAME), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const line of text.split("\n")) {
    const n = Number(line);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/** @param {string} root @param {number} bytes */
export async function recordBytes(root, bytes) {
  await appendFile(join(root, USAGE_LOG_NAME), `${bytes}\n`);
}
