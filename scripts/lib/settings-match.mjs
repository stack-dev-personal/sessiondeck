import { HOOK_SCRIPT_NAME, MARKER_VALUE } from "./install-config.mjs";

/**
 * Recognition of our entries. It does not depend on where the script lives: the marker argument
 * is the primary signal, the sidecar record the second, and the old script-name form the third
 * (entries written before the marker existed).
 */

/** @typedef {Record<string, unknown>} Json */
/**
 * What the installer wrote, recorded in the sidecar.
 * @typedef {{ hook: { command: string, args: string[] }, statusLine: string, subagentStatusLine: string }} Entries
 */

const LEGACY_STATUS = new RegExp(`node "[^"]*${HOOK_SCRIPT_NAME.replace(".", "\\.")}" --`, "i");
const LEGACY_SCRIPT = new RegExp(`(^|/)${HOOK_SCRIPT_NAME.replace(".", "\\.")}$`, "i");

/** @param {unknown} v @returns {v is Json} */
export function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Comparison key for a path or command: forward slashes, and lower case on Windows.
 * @param {string} p @param {string} [platform]
 * @returns {string}
 */
export function foldPath(p, platform = process.platform) {
  const posix = p.replace(/\\/g, "/");
  return platform === "win32" ? posix.toLowerCase() : posix;
}

/** @param {unknown} hook @param {Entries | undefined} record */
function matchesHookRecord(hook, record) {
  if (!record || !isRecord(hook) || !Array.isArray(hook.args)) return false;
  const args = hook.args;
  return (
    hook.command === record.hook.command &&
    args.length === record.hook.args.length &&
    args.every(
      (a, i) => typeof a === "string" && foldPath(a) === foldPath(record.hook.args[i] ?? ""),
    )
  );
}

/** @param {unknown} hook @param {Entries | undefined} record */
export function isOurHook(hook, record) {
  if (!isRecord(hook)) return false;
  const args = Array.isArray(hook.args) ? hook.args : [];
  const text = JSON.stringify([hook.command, args]);
  if (text.includes(MARKER_VALUE)) return true;
  if (typeof args[0] === "string" && LEGACY_SCRIPT.test(foldPath(args[0], "linux"))) return true;
  return matchesHookRecord(hook, record);
}

/** @param {unknown} group @param {Entries | undefined} record */
export function isOurGroup(group, record) {
  return (
    isRecord(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((h) => isOurHook(h, record))
  );
}

/**
 * @param {unknown} value @param {"statusLine" | "subagentStatusLine"} key
 * @param {Entries | undefined} record
 */
export function isOurStatus(value, key, record) {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  if (value.command.includes(MARKER_VALUE) || LEGACY_STATUS.test(value.command)) return true;
  return record !== undefined && foldPath(value.command) === foldPath(record[key]);
}

/**
 * Names of settings locations that still carry the marker (hooks per event, status keys).
 * @param {unknown} settings
 * @returns {string[]}
 */
export function findRemaining(settings) {
  if (!isRecord(settings)) return [];
  const found = [];
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, value] of Object.entries(hooks)) {
    if (JSON.stringify(value).includes(MARKER_VALUE)) found.push(`hooks.${event}`);
  }
  for (const key of /** @type {const} */ (["statusLine", "subagentStatusLine"])) {
    if (JSON.stringify(settings[key] ?? null).includes(MARKER_VALUE)) found.push(key);
  }
  return found;
}
