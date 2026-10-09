import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ERROR_LOG_NAME,
  FULL_STEP_PREFIX,
  OUT_MAX_TOTAL_BYTES,
  USAGE_LOG_NAME,
} from "./capture-config.mjs";

/**
 * Running total of captured bytes. Each stored payload appends one line holding its size, so the
 * hook never walks the tree. Concurrent hooks append whole short lines, which do not interleave.
 * Deleting the out dir resets the total. A line larger than the whole budget cannot come from a
 * stored payload and is ignored, so one edited line cannot stop recording for good.
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
    if (Number.isFinite(n) && n > 0 && n <= OUT_MAX_TOTAL_BYTES) total += n;
  }
  return total;
}

/** @param {string} root @param {number} bytes */
export async function recordBytes(root, bytes) {
  await appendFile(join(root, USAGE_LOG_NAME), `${bytes}\n`);
}

/**
 * Whether the error log already holds a line saying a write was refused (byte budget, a per
 * directory cap, or too many directories). The log is capped at a few KiB, so reading it is cheap.
 * @param {string} root
 * @returns {Promise<boolean>}
 */
async function refusalLogged(root) {
  try {
    const text = await readFile(join(root, ERROR_LOG_NAME), "utf8");
    return text.split("\n").some((line) => (line.split(" ")[1] ?? "").startsWith(FULL_STEP_PREFIX));
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {Promise<boolean>} true when recording has stopped for anything: the recorded total used
 *   up the budget, or any cap or budget refusal is in the error log
 */
export async function budgetReached(root) {
  if ((await usedBytes(root)) >= OUT_MAX_TOTAL_BYTES) return true;
  return refusalLogged(root);
}
