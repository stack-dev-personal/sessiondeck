import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HOOK_MAX_FILES_PER_DIR,
  MAX_OUT_SUBDIRS,
  MAX_STDIN_BYTES,
  STATE_DIR,
  STATUSLINE_DIR,
  STATUSLINE_MAX_FILES,
  STATUSLINE_MIN_INTERVAL_MS,
  SUBAGENT_STATUSLINE_DIR,
  SUBAGENT_STATUSLINE_MAX_FILES,
  UNPARSED_DIR,
  UNPARSED_MAX_FILES,
} from "./capture-config.mjs";
import { safeEventName, safeSegment, safeSessionId } from "./capture-paths.mjs";
import { shouldRecordStatus, statusSignature } from "./capture-throttle.mjs";
import {
  countEntries,
  errorCode,
  randomSuffix,
  readJsonOrUndefined,
  writeInside,
} from "./capture-store.mjs";

/** @typedef {"hook" | "statusline" | "subagents"} CaptureMode */

/**
 * Reads a stream to the end, stopping at maxBytes.
 * @param {AsyncIterable<Buffer | string>} stream
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function readAll(stream, maxBytes = MAX_STDIN_BYTES) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
      chunks.push(buf);
    }
  } catch {
    // A closed or broken stdin is treated as whatever arrived before it.
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | undefined} the parsed object, or undefined when not a JSON object
 */
export function parseObject(text) {
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Fall through: unparsable input is saved as text by the caller.
  }
  return undefined;
}

/** @param {number} now @param {string} sid @param {string} ext */
function fileName(now, sid, ext) {
  return `${now}-${sid}-${randomSuffix()}${ext}`;
}

/**
 * Whether a new top-level directory may be created under root (names are untrusted input).
 * @param {string} root
 * @param {string} dirName
 */
async function mayUseDir(root, dirName) {
  try {
    const names = await readdir(root);
    return names.includes(dirName) || names.length < MAX_OUT_SUBDIRS;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

/** @type {Record<"statusline" | "subagents", { dir: string, cap: number }>} */
const STATUS_MODES = {
  statusline: { dir: STATUSLINE_DIR, cap: STATUSLINE_MAX_FILES },
  subagents: { dir: SUBAGENT_STATUSLINE_DIR, cap: SUBAGENT_STATUSLINE_MAX_FILES },
};

/**
 * Throttle bookkeeping for status modes. State is one small file per mode and session.
 * @param {string} root
 * @param {"statusline" | "subagents"} mode
 * @param {Record<string, unknown>} payload
 * @param {number} now
 */
async function statusThrottle(root, mode, payload, now) {
  const sid = safeSegment(payload.session_id, "nosession");
  const stateName = `${mode}-${sid}.json`;
  const sig = statusSignature(payload);
  const raw = await readJsonOrUndefined(join(root, STATE_DIR, stateName));
  const previous = isStatusState(raw) ? raw : undefined;
  const allowed = shouldRecordStatus(previous, sig, now, STATUSLINE_MIN_INTERVAL_MS);
  const commit = () => writeState(root, stateName, { t: now, sig });
  return { allowed, commit };
}

/**
 * @param {unknown} v
 * @returns {v is { t: number, sig: string }}
 */
function isStatusState(v) {
  if (v === null || typeof v !== "object") return false;
  const rec = /** @type {Record<string, unknown>} */ (v);
  return typeof rec.t === "number" && typeof rec.sig === "string";
}

/** @param {string} root @param {string} name @param {{ t: number, sig: string }} state */
async function writeState(root, name, state) {
  await writeInside(root, STATE_DIR, name, JSON.stringify(state));
}

/**
 * Stores one captured payload according to the mode. Throws on I/O errors; the caller logs them.
 * Silently skips when a cap or the throttle says so.
 * @param {{ mode: CaptureMode, out: string, text: string, truncated: boolean, now: number }} args
 * @returns {Promise<void>}
 */
export async function captureOnce({ mode, out, text, truncated, now }) {
  const payload = truncated ? undefined : parseObject(text);
  if (payload === undefined) {
    await store(out, UNPARSED_DIR, UNPARSED_MAX_FILES, fileName(now, "raw", ".txt"), text);
    return;
  }
  const sid = safeSessionId(payload.session_id);
  const name = fileName(now, sid, ".json");
  if (mode === "hook") {
    const dir = safeEventName(payload.hook_event_name);
    await store(out, dir, HOOK_MAX_FILES_PER_DIR, name, text);
    return;
  }
  const { dir, cap } = STATUS_MODES[mode];
  const throttle = await statusThrottle(out, mode, payload, now);
  if (!throttle.allowed) return;
  if (await store(out, dir, cap, name, text)) await throttle.commit();
}

/**
 * @param {string} out
 * @param {string} dir
 * @param {number} cap
 * @param {string} name
 * @param {string} text
 * @returns {Promise<boolean>} true when written
 */
async function store(out, dir, cap, name, text) {
  if (!(await mayUseDir(out, dir))) return false;
  if ((await countEntries(join(out, dir))) >= cap) return false;
  await writeInside(out, dir, name, text);
  return true;
}
