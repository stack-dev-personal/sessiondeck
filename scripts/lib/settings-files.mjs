import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorCode, randomSuffix } from "./capture-store.mjs";

export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const SETTINGS_NAME = "settings.json";
const SIDECAR_NAME = "settings.json.sessiondeck-capture-state.json";
const BACKUP_PREFIX = "settings.json.sessiondeck-backup-";
const MAX_BACKUP_ATTEMPTS = 50;
const BOM = "﻿";

export class SettingsReadError extends Error {}

/**
 * Settings file inside CLAUDE_CONFIG_DIR if set, else the default config dir under the home dir.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveTarget(env) {
  const override = env[CONFIG_DIR_ENV];
  const dir = override ? resolve(override) : join(homedir(), ".claude");
  return join(dir, SETTINGS_NAME);
}

/** @param {string} target */
export function sidecarPath(target) {
  return join(dirname(target), SIDECAR_NAME);
}

/**
 * Reads and parses the settings file. A missing file is `{ exists: false }`.
 * The parser's own message is deliberately dropped: it can quote file content.
 * @param {string} target
 * @returns {Promise<{ exists: boolean, text: string, settings: unknown }>}
 */
export async function readSettings(target) {
  let text;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, text: "", settings: {} };
    throw new SettingsReadError(`cannot read settings file (${errorCode(error)})`);
  }
  try {
    return {
      exists: true,
      text,
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
 * Copies the settings file to a new timestamped name next to it. Never overwrites a backup.
 * @param {string} target
 * @returns {Promise<string>} the backup path
 */
export async function createBackup(target) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const path = join(dirname(target), `${BACKUP_PREFIX}${stamp}${suffix}`);
    try {
      await copyFile(target, path, 1); // COPYFILE_EXCL: fail if it exists
      return path;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("could not find a free backup name");
}

/**
 * @param {string} target
 * @returns {Promise<import("./settings-model.mjs").SidecarState | undefined>}
 */
export async function readSidecar(target) {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(target), "utf8"));
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
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

/** @param {string} target */
export async function removeSettings(target) {
  await rm(target, { force: true });
}
