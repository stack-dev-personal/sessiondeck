import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HOOK_MAX_FILES_PER_DIR,
  MAX_OUT_SUBDIRS,
  MAX_STDIN_BYTES,
  OUT_MAX_TOTAL_BYTES,
  STATE_DIR,
  STATE_MAX_FILES,
  STATUSLINE_DIR,
  STATUSLINE_MAX_FILES,
  STATUSLINE_MIN_INTERVAL_MS,
  SUBAGENT_STATUSLINE_DIR,
  SUBAGENT_STATUSLINE_MAX_FILES,
  UNPARSED_DIR,
  UNPARSED_MAX_BYTES,
  UNPARSED_MAX_FILES,
  BUDGET_LOG_CODE,
  FULL_STEP_PREFIX,
  SAMPLE_CAP_STEPS,
} from "./capture-config.mjs";
import { budgetReached, recordBytes, usedBytes } from "./capture-budget.mjs";
import { safeEventName, safeSegment, safeSessionId } from "./capture-paths.mjs";
import { shouldRecordStatus, statusSignature } from "./capture-throttle.mjs";
import {
  countEntries,
  errorCode,
  logOnce,
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

/**
 * Writes the throttle state unless that would add a new file past STATE_MAX_FILES.
 * @param {string} root @param {string} name @param {{ t: number, sig: string }} state
 */
async function writeState(root, name, state) {
  const names = await readdir(join(root, STATE_DIR)).catch(() => /** @type {string[]} */ ([]));
  if (!names.includes(name) && names.length >= STATE_MAX_FILES) return;
  await writeInside(root, STATE_DIR, name, JSON.stringify(state));
}

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

/**
 * Cuts text to at most maxBytes of UTF-8, backing up to the start of a character that the cut would
 * split, so the result is valid text and never longer than the limit.
 * @param {string} text @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) cut--;
  return bytes.subarray(0, cut).toString("utf8");
}

/**
 * Stores one captured payload according to the mode. Throws on I/O errors; the caller logs them.
 * Skips when a cap, the byte budget, or the throttle says so; a cap or budget refusal is logged
 * once and reported as full, so the status line can show it. Never writes to stdout itself.
 * @param {{ mode: CaptureMode, out: string, text: string, truncated: boolean, now: number }} args
 * @returns {Promise<{ full: boolean }>}
 */
export async function captureOnce({ mode, out, text, truncated, now }) {
  const payload = truncated ? undefined : parseObject(text);
  if (payload === undefined) {
    const kept = truncateUtf8(text, UNPARSED_MAX_BYTES);
    const name = fileName(now, "raw", ".txt");
    return { full: (await store(out, UNPARSED_DIR, UNPARSED_MAX_FILES, name, kept)) === FULL };
  }
  const sid = safeSessionId(payload.session_id);
  const name = fileName(now, sid, ".json");
  if (mode === "hook") {
    const dir = safeEventName(payload.hook_event_name);
    return { full: (await store(out, dir, HOOK_MAX_FILES_PER_DIR, name, text)) === FULL };
  }
  const { dir, cap } = STATUS_MODES[mode];
  const throttle = await statusThrottle(out, mode, payload, now);
  const result = throttle.allowed ? await store(out, dir, cap, name, text) : undefined;
  if (result === STORED) await throttle.commit();
  return { full: result === FULL || (await budgetReached(out)) };
}

const STORED = "stored";
const FULL = "full";
/** A status-sample cap refused the write: logged once, but not the "full" signal. */
const SAMPLE_CAPPED = "sample-capped";

/**
 * @param {string} out @param {string} step
 * @returns {Promise<"full">}
 */
async function refuse(out, step) {
  await logOnce(out, step, BUDGET_LOG_CODE);
  return FULL;
}

/**
 * @param {string} out
 * @param {string} dir
 * @param {number} cap
 * @param {string} name
 * @param {string} text
 * @returns {Promise<"stored" | "full" | "sample-capped">} full when a limit refused the write;
 *   sample-capped when only a status-sample cap did
 */
async function store(out, dir, cap, name, text) {
  if (!(await mayUseDir(out, dir))) return refuse(out, `${FULL_STEP_PREFIX}dirs`);
  if ((await countEntries(join(out, dir))) >= cap) {
    const step = `${FULL_STEP_PREFIX}cap-${dir}`;
    const refused = await refuse(out, step);
    return SAMPLE_CAP_STEPS.includes(step) ? SAMPLE_CAPPED : refused;
  }
  const bytes = Buffer.byteLength(text);
  if ((await usedBytes(out)) + bytes > OUT_MAX_TOTAL_BYTES)
    return refuse(out, `${FULL_STEP_PREFIX}budget`);
  await writeInside(out, dir, name, text);
  await recordBytes(out, bytes);
  return STORED;
}
