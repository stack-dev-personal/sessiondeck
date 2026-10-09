import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, randomSuffix } from "./capture-store.mjs";
import { isInside } from "./capture-paths.mjs";
import { findGitRoot, realpathLoose } from "./fs-roots.mjs";
import { DeployError, InstallRefused } from "./install-errors.mjs";
import {
  APP_DIR_NAME,
  COPY_RETRY_ATTEMPTS,
  COPY_RETRY_DELAY_MS,
  DEPLOY_DIR_NAME,
  DEPLOY_FILES,
  DEPLOY_HOME_ENV,
} from "./install-config.mjs";

/**
 * The deployed copy: the capture hook and exactly the lib files it imports, copied to a fixed
 * directory outside any work tree. Claude Code runs this copy, so editing or switching the
 * checkout cannot change what runs inside every session.
 */

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ path: string, sha256: string }} ManifestEntry */
/** @typedef {ManifestEntry & { content: Buffer }} PlanFile */

/**
 * Deploy directory: SESSIONDECK_CAPTURE_HOME, else the sessiondeck app-data directory.
 * @param {NodeJS.ProcessEnv} env @param {string} home @param {string} [platform]
 * @returns {string}
 */
export function resolveDeployDir(env, home, platform = process.platform) {
  const override = env[DEPLOY_HOME_ENV];
  if (override) return resolve(override);
  const base =
    platform === "win32"
      ? resolve(env.LOCALAPPDATA || join(home, "AppData", "Local"))
      : resolve(env.XDG_DATA_HOME || join(home, ".local", "share"));
  return join(base, APP_DIR_NAME, DEPLOY_DIR_NAME);
}

/** @param {Buffer | string} bytes @returns {string} */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Refuses a deploy directory that sits inside a git work tree.
 * @param {string} deployDir
 * @returns {Promise<string>} the real path of the deploy directory
 */
export async function assertOutsideWorkTree(deployDir) {
  const real = await realpathLoose(deployDir);
  const root = await findGitRoot(real);
  if (root !== undefined) {
    throw new InstallRefused(`deploy directory is inside a git work tree (${root}): ${real}`);
  }
  return real;
}

/** @returns {Promise<PlanFile[]>} the files to deploy, read from this checkout */
export async function readSources() {
  return Promise.all(
    DEPLOY_FILES.map(async (path) => {
      const content = await readFile(join(SOURCE_DIR, path));
      return { path, sha256: sha256(content), content };
    }),
  );
}

/**
 * Relative paths that are missing or whose hash differs from the plan.
 * @param {string} deployDir @param {ManifestEntry[]} files
 * @returns {Promise<string[]>}
 */
export async function findStale(deployDir, files) {
  const stale = [];
  for (const file of files) {
    const bytes = await readFile(join(deployDir, file.path)).catch(() => undefined);
    if (bytes === undefined || sha256(bytes) !== file.sha256) stale.push(file.path);
  }
  return stale;
}

/** @param {number} ms */
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Windows can refuse a rename while another process holds the target open; retry briefly.
 * @param {string} from @param {string} to
 */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const busy = ["EPERM", "EBUSY", "EACCES"].includes(errorCode(error));
      if (!busy || attempt >= COPY_RETRY_ATTEMPTS) throw error;
      await pause(COPY_RETRY_DELAY_MS);
    }
  }
}

/**
 * Copies the named files into the deploy directory (temp file plus rename) and re-hashes each.
 * @param {string} deployDir @param {PlanFile[]} files @param {string[]} only
 */
export async function writeDeployed(deployDir, files, only) {
  for (const file of files.filter((f) => only.includes(f.path))) {
    const dest = join(deployDir, file.path);
    if (!isInside(deployDir, dest)) throw new DeployError("deploy path escaped its directory");
    await mkdir(dirname(dest), { recursive: true });
    const temp = `${dest}.tmp-${randomSuffix()}`;
    try {
      await writeFile(temp, file.content, { flag: "wx" });
      await renameWithRetry(temp, dest);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  const bad = await findStale(
    deployDir,
    files.filter((f) => only.includes(f.path)),
  );
  if (bad.length > 0) throw new DeployError(`deployed copy failed verification: ${bad.join(", ")}`);
}

/** @param {string} dir */
async function removeIfEmpty(dir) {
  try {
    await rmdir(dir);
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errorCode(error))) throw error;
  }
}

/**
 * Removes only the files named in the manifest, then the (now empty) directories. Never recursive.
 * @param {import("./settings-model.mjs").DeployRecord} deploy
 * @returns {Promise<{ removed: string[], kept: boolean }>} kept is true when the directory stays
 */
export async function removeDeployed(deploy) {
  const removed = [];
  for (const file of deploy.files) {
    const path = join(deploy.dir, file.path);
    if (!isInside(deploy.dir, path)) continue;
    const existed = await stat(path).then(
      () => true,
      () => false,
    );
    await rm(path, { force: true });
    if (existed) removed.push(path);
  }
  await removeIfEmpty(join(deploy.dir, "lib"));
  await removeIfEmpty(deploy.dir);
  const kept = await stat(deploy.dir).then(
    () => true,
    () => false,
  );
  return { removed, kept };
}
