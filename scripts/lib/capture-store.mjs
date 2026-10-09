import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ERROR_LOG_MAX_BYTES,
  ERROR_LOG_NAME,
  GITIGNORE_BODY,
  GITIGNORE_NAME,
  RANDOM_SUFFIX_BYTES,
  STALE_TEMP_MS,
} from "./capture-config.mjs";
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
 * Creates the out dir if needed and makes sure it carries a .gitignore of "*", so raw captures
 * cannot be staged by a routine add even on a branch that lacks the repository ignore rule.
 * A file with other content (emptied, or edited to ignore nothing) is rewritten.
 * @param {string} root
 * @returns {Promise<void>}
 */
export async function ensureOutDir(root) {
  await mkdir(root, { recursive: true });
  const path = join(root, GITIGNORE_NAME);
  try {
    await writeFile(path, GITIGNORE_BODY, { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const body = await readFile(path, "utf8");
    if (body.trim() !== GITIGNORE_BODY.trim()) await writeFile(path, GITIGNORE_BODY);
  }
}

/**
 * Atomically writes text to <root>/<dirName>/<fileName>. Refuses paths that resolve outside root,
 * including through a junction or symlink at <root>/<dirName>.
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
  await ensureOutDir(root);
  await mkdir(dir, { recursive: true });
  if (!isInside(await realpath(root), await realpath(dir))) throw new Error("path escaped out dir");
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
 * Temp files left by a killed or cancelled write are removed once they are old.
 * @param {string} dir
 * @param {number} [now]
 * @returns {Promise<number>}
 */
export async function countEntries(dir, now = Date.now()) {
  try {
    const names = await readdir(dir);
    for (const name of names.filter((n) => n.startsWith(".tmp-")))
      await sweepIfStale(join(dir, name), now);
    return names.filter((n) => !n.startsWith(".")).length;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

/** @param {string} path @param {number} now */
async function sweepIfStale(path, now) {
  const info = await stat(path).catch(() => undefined);
  if (info && now - info.mtimeMs > STALE_TEMP_MS)
    await rm(path, { force: true }).catch(() => undefined);
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
  await appendLogLine(root, step, errorCode(error), false);
}

/**
 * Like logCaptureError with a fixed code, but writes nothing when the log already holds a line for
 * this step. Used to say once that recording stopped, without a line per refused payload.
 * @param {string} root @param {string} step @param {string} code
 * @returns {Promise<void>}
 */
export async function logOnce(root, step, code) {
  await appendLogLine(root, step, code, true);
}

/** @param {string} root @param {string} step @param {string} code @param {boolean} once */
async function appendLogLine(root, step, code, once) {
  const logPath = join(root, ERROR_LOG_NAME);
  try {
    const size = await stat(logPath).then(
      (s) => s.size,
      () => 0,
    );
    if (size >= ERROR_LOG_MAX_BYTES) return;
    if (once && size > 0) {
      const lines = (await readFile(logPath, "utf8")).split("\n");
      if (lines.some((l) => l.split(" ")[1] === step)) return;
    }
    await ensureOutDir(root);
    await appendFile(logPath, `${new Date().toISOString()} ${step} ${code}\n`);
  } catch {
    // Nothing safe left to do; stay silent.
  }
}
