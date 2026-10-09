import { mkdir, lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorCode, randomSuffix } from "./capture-store.mjs";
import { CONFIG_DIR_ENV, STALE_INSTALL_TEMP_MS } from "./install-config.mjs";
import { foldPath } from "./settings-match.mjs";
import { parseSidecar, SidecarError } from "./sidecar.mjs";

const SETTINGS_NAME = "settings.json";
const SIDECAR_NAME = "settings.json.sessiondeck-capture-state.json";
const BACKUP_PREFIX = "settings.json.sessiondeck-backup-";
const OUR_TEMP = /^settings\.json(\.sessiondeck-capture-state\.json)?\.tmp-[0-9a-f]{12}$/;
const MAX_BACKUP_ATTEMPTS = 50;
const BOM = "﻿";

export class SettingsReadError extends Error {}
export class SettingsChangedError extends Error {}

/**
 * Settings file inside CLAUDE_CONFIG_DIR if set, else inside <home>/.claude.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home]
 * @returns {string}
 */
export function resolveTarget(env, home = homedir()) {
  const override = env[CONFIG_DIR_ENV];
  const dir = override ? resolve(override) : join(home, ".claude");
  return join(dir, SETTINGS_NAME);
}

/**
 * True when the target is the default (real) config directory, set explicitly or not.
 * @param {NodeJS.ProcessEnv} env @param {string} [home]
 */
export function isDefaultTarget(env, home = homedir()) {
  const defaultTarget = join(resolve(home, ".claude"), SETTINGS_NAME);
  return foldPath(resolveTarget(env, home)) === foldPath(defaultTarget);
}

/** @param {string} target */
export function sidecarPath(target) {
  return join(dirname(target), SIDECAR_NAME);
}

/**
 * Reads and parses the settings file. A missing file is `{ exists: false }`; a symbolic link is
 * refused because the atomic rename would replace the link with a regular file.
 * The parser's own message is deliberately dropped: it can quote file content.
 * @param {string} target
 * @returns {Promise<{ exists: boolean, buffer: Buffer | undefined, settings: unknown }>}
 */
export async function readSettings(target) {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new SettingsReadError("settings file is a symbolic link; refusing to replace it");
    }
  } catch (error) {
    if (error instanceof SettingsReadError) throw error;
    if (errorCode(error) === "ENOENT") return { exists: false, buffer: undefined, settings: {} };
    throw new SettingsReadError(`cannot read settings file (${errorCode(error)})`);
  }
  let buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    throw new SettingsReadError(`cannot read settings file (${errorCode(error)})`);
  }
  const text = buffer.toString("utf8");
  try {
    return {
      exists: true,
      buffer,
      settings: JSON.parse(text.startsWith(BOM) ? text.slice(1) : text),
    };
  } catch {
    throw new SettingsReadError("settings file is not valid JSON; nothing was changed");
  }
}

/** @param {unknown} settings @returns {string} */
export function serialize(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Temp file plus rename in the same directory.
 * @param {string} path
 * @param {string} text
 */
export async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomSuffix()}`;
  try {
    await writeFile(temp, text, { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes the bytes that were parsed to a new timestamped name next to the target. Never overwrites.
 * @param {string} target @param {Buffer} bytes
 * @returns {Promise<string>} the backup path
 */
export async function createBackup(target, bytes) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const path = join(dirname(target), `${BACKUP_PREFIX}${stamp}${suffix}`);
    try {
      await writeFile(path, bytes, { flag: "wx" });
      return path;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("could not find a free backup name");
}

/** @param {string} target @returns {Promise<string[]>} every backup the installer made, sorted */
export async function listBackups(target) {
  const names = await readdir(dirname(target)).catch(() => /** @type {string[]} */ ([]));
  return names
    .filter((n) => n.startsWith(BACKUP_PREFIX))
    .sort()
    .map((n) => join(dirname(target), n));
}

/**
 * @param {string} target
 * @returns {Promise<import("./settings-model.mjs").SidecarState | undefined>} undefined when absent
 * @throws {SidecarError} when present but unreadable or malformed
 */
export async function readSidecar(target) {
  const text = await readTextOrUndefined(sidecarPath(target));
  if (text === undefined) return undefined;
  try {
    return parseSidecar(JSON.parse(text));
  } catch (error) {
    if (error instanceof SidecarError) throw error;
    throw new SidecarError("capture state file is not valid JSON; nothing was changed");
  }
}

/** @param {string} path @returns {Promise<string | undefined>} */
async function readTextOrUndefined(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new SidecarError(`capture state file cannot be read (${errorCode(error)})`);
  }
}

/** @param {string} target @param {unknown} state */
export async function writeSidecar(target, state) {
  await writeAtomic(sidecarPath(target), serialize(state));
}

/** @param {string} target */
export async function removeSidecar(target) {
  await rm(sidecarPath(target), { force: true });
}

/** @param {string} target @param {Buffer | undefined} original */
async function assertUnchanged(target, original) {
  const now = await readFile(target).catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  const same = original === undefined ? now === undefined : now?.equals(original) === true;
  if (!same) {
    throw new SettingsChangedError("settings file changed while running; nothing was written");
  }
}

/**
 * Backup, sidecar, byte re-check, then the atomic write (or removal when next is null). Any
 * failure rolls the sidecar and backup back, so a failed run leaves the settings untouched.
 * @param {{ target: string, original: Buffer | undefined, next: string | null,
 *   state: unknown }} args state is written as the new sidecar when not undefined
 * @returns {Promise<string | undefined>} the backup path
 */
export async function commitSettings({ target, original, next, state }) {
  const backup = original ? await createBackup(target, original) : undefined;
  const priorSidecar = await readTextOrUndefined(sidecarPath(target));
  try {
    if (state !== undefined) await writeSidecar(target, state);
    await assertUnchanged(target, original);
    if (next === null) await rm(target, { force: true });
    else await writeAtomic(target, next);
  } catch (error) {
    if (state !== undefined) await restoreSidecar(target, priorSidecar);
    if (backup) await rm(backup, { force: true }).catch(() => undefined);
    throw error;
  }
  return backup;
}

/** @param {string} target @param {string | undefined} text */
async function restoreSidecar(target, text) {
  const path = sidecarPath(target);
  if (text === undefined) await rm(path, { force: true }).catch(() => undefined);
  else await writeFile(path, text).catch(() => undefined);
}

/**
 * Removes temp files the installer itself left behind (killed mid-write), once they are old.
 * @param {string} target @param {number} [now]
 * @returns {Promise<string[]>} the removed paths
 */
export async function sweepInstallTemps(target, now = Date.now()) {
  const dir = dirname(target);
  const names = await readdir(dir).catch(() => /** @type {string[]} */ ([]));
  const removed = [];
  for (const name of names.filter((n) => OUR_TEMP.test(n))) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > STALE_INSTALL_TEMP_MS) {
      await rm(path, { force: true });
      removed.push(path);
    }
  }
  return removed;
}
