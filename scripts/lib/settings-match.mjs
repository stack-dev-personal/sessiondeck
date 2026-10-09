import { HOOK_SCRIPT_NAME, MARKER_FLAG, MARKER_VALUE } from "./install-config.mjs";

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

const MARKER_TOKENS = new RegExp(String.raw`(^|\s)${MARKER_FLAG}\s+${MARKER_VALUE}(\s|$)`);
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

/**
 * True when args holds the marker flag immediately followed by the marker value. A path that
 * merely contains the marker text (a user script in a directory with a similar name) is not a match.
 * @param {unknown} args
 * @returns {boolean}
 */
export function hasMarkerPair(args) {
  if (!Array.isArray(args)) return false;
  return args.some((a, i) => a === MARKER_FLAG && args[i + 1] === MARKER_VALUE);
}

/**
 * The same adjacent pair as whole whitespace-separated tokens of a shell command line.
 * @param {unknown} command
 * @returns {boolean}
 */
export function hasMarkerTokens(command) {
  return typeof command === "string" && MARKER_TOKENS.test(command);
}

const MAX_SCAN_DEPTH = 12;

/**
 * True when any array in the value holds the adjacent marker pair, or any string holds the marker
 * tokens. Used to report leftovers wherever they sit.
 * @param {unknown} value @param {number} [depth]
 * @returns {boolean}
 */
export function containsMarker(value, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (typeof value === "string") return hasMarkerTokens(value);
  if (Array.isArray(value)) {
    return hasMarkerPair(value) || value.some((v) => containsMarker(v, depth + 1));
  }
  if (isRecord(value)) return Object.values(value).some((v) => containsMarker(v, depth + 1));
  return false;
}

/** @param {unknown} hook @param {Entries | undefined} record */
export function isOurHook(hook, record) {
  if (!isRecord(hook)) return false;
  const args = Array.isArray(hook.args) ? hook.args : [];
  if (hasMarkerPair(args)) return true;
  if (typeof args[0] === "string" && LEGACY_SCRIPT.test(foldPath(args[0], "linux"))) return true;
  return matchesHookRecord(hook, record);
}

/**
 * @param {unknown} value @param {"statusLine" | "subagentStatusLine"} key
 * @param {Entries | undefined} record
 */
export function isOurStatus(value, key, record) {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  if (hasMarkerTokens(value.command) || LEGACY_STATUS.test(value.command)) return true;
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
    if (containsMarker(value)) found.push(`hooks.${event}`);
  }
  for (const key of /** @type {const} */ (["statusLine", "subagentStatusLine"])) {
    if (containsMarker(settings[key])) found.push(key);
  }
  return found;
}
