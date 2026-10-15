// Shared helpers for the fixture tools: list the capture directory and read payloads.
// Raw files are read only; nothing here writes into a capture directory.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = resolve(here, "..", "..", "packages", "contract", "fixtures");
export const RAW_ROOT = join(FIXTURES_ROOT, "raw");

/** Capture-tool bookkeeping inside raw/ that is never a payload directory. */
const NON_EVENT_DIRS = new Set(["_state"]);

/** Raw file name: <epoch-ms>-<8 char session id>-<random>.json */
const RAW_NAME = /^(\d+)-([^-]+)-([^.]+)\.json$/;

/**
 * Event directory names under a capture root, sorted.
 * @param {string} root
 * @returns {string[]}
 */
export function listEvents(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(
      (n) => !n.startsWith(".") && !NON_EVENT_DIRS.has(n) && statSync(join(root, n)).isDirectory(),
    )
    .sort();
}

/**
 * Parsed payloads of one event directory, ordered by (epoch, file name). Unparseable files are
 * counted, not thrown: `bad` carries the number skipped.
 * @param {string} root
 * @param {string} event
 * @returns {{ items: { file: string, epoch: number, short: string, payload: any }[], bad: number }}
 */
export function readEvent(root, event) {
  const dir = join(root, event);
  const items = [];
  let bad = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const m = RAW_NAME.exec(file);
    try {
      const payload = JSON.parse(readFileSync(join(dir, file), "utf8"));
      items.push({ file, epoch: m ? Number(m[1]) : 0, short: m?.[2] ?? "", payload });
    } catch {
      bad += 1;
    }
  }
  items.sort((a, b) => a.epoch - b.epoch || (a.file < b.file ? -1 : 1));
  return { items, bad };
}

/**
 * Sorted top-level key names of a payload. Non-objects give an empty list.
 * @param {unknown} payload
 * @returns {string[]}
 */
export function keysOf(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).sort();
}
