import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ERROR_LOG_MAX_BYTES, ERROR_LOG_NAME, RANDOM_SUFFIX_BYTES } from "./capture-config.mjs";
import { isInside } from "./capture-paths.mjs";

/** @returns {string} short random hex used for collision-safe names */
export function randomSuffix() {
  return randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * Atomically writes text to <root>/<dirName>/<fileName>. Refuses paths that resolve outside root.
 * The temp file lives in the same directory, so the rename is atomic on one volume.
 * @param {string} root
 * @param {string} dirName
 * @param {string} fileName
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeInside(root, dirName, fileName, text) {
  const dir = join(root, dirName);
  const finalPath = join(dir, fileName);
  if (!isInside(root, finalPath)) throw new Error("path escaped out dir");
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.tmp-${randomSuffix()}`);
  try {
    await writeFile(tempPath, text, { flag: "wx" });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Number of captured entries (dotfiles such as temp files excluded). Missing dir counts as 0.
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function countEntries(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((n) => !n.startsWith(".")).length;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

/**
 * @param {string} path
 * @returns {Promise<unknown>} parsed JSON, or undefined when missing or invalid
 */
export async function readJsonOrUndefined(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Appends one line: timestamp, step label, error code. Never payload content, never a message
 * (messages can embed paths). Failure to log is swallowed on purpose: the hook must never fail.
 * @param {string} root
 * @param {string} step
 * @param {unknown} error
 * @returns {Promise<void>}
 */
export async function logCaptureError(root, step, error) {
  const logPath = join(root, ERROR_LOG_NAME);
  try {
    const size = await stat(logPath).then(
      (s) => s.size,
      () => 0,
    );
    if (size >= ERROR_LOG_MAX_BYTES) return;
    await mkdir(root, { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${step} ${errorCode(error)}\n`);
  } catch {
    // Nothing safe left to do; stay silent.
  }
}
