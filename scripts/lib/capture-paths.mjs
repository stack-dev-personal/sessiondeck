import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_DIR_ENV,
  MAX_SEGMENT_LENGTH,
  NO_SESSION_SEGMENT,
  SHORT_SESSION_ID_LENGTH,
  UNKNOWN_SEGMENT,
} from "./capture-config.mjs";

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Returns the value only if it is a safe single path segment, else the fallback.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function safeSegment(value, fallback) {
  if (typeof value !== "string") return fallback;
  if (value.length === 0 || value.length > MAX_SEGMENT_LENGTH) return fallback;
  if (!SEGMENT_PATTERN.test(value) || WINDOWS_DEVICE_NAME.test(value)) return fallback;
  return value;
}

/**
 * Directory name for an event. Leading underscore is reserved for our own directories.
 * @param {unknown} value
 * @returns {string}
 */
export function safeEventName(value) {
  const segment = safeSegment(value, UNKNOWN_SEGMENT);
  return segment.startsWith("_") ? UNKNOWN_SEGMENT : segment;
}

/**
 * @param {unknown} value
 * @returns {string} at most SHORT_SESSION_ID_LENGTH safe characters
 */
export function safeSessionId(value) {
  const segment = safeSegment(value, "");
  return segment === "" ? NO_SESSION_SEGMENT : segment.slice(0, SHORT_SESSION_ID_LENGTH);
}

/**
 * True when candidate is strictly below root after resolution.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

/**
 * @param {string} p
 * @returns {string} the path with forward slashes only
 */
export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/** Default raw capture directory, resolved from this file: <repo>/packages/contract/fixtures/raw. */
export function defaultOutDir() {
  const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(scriptsDir, "..", "packages", "contract", "fixtures", "raw");
}

/**
 * Out dir precedence: --out, then SESSIONDECK_CAPTURE_DIR, then the default.
 * @param {string | undefined} flagValue
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveOutDir(flagValue, env) {
  const fromEnv = env[CAPTURE_DIR_ENV];
  if (flagValue) return resolve(flagValue);
  if (fromEnv) return resolve(fromEnv);
  return resolve(defaultOutDir());
}
