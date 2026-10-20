/**
 * Spool writer. One envelope is one line: `JSON.stringify(envelope) + "\n"`, appended with a
 * single write to an O_APPEND descriptor of `<spool>/<yyyy-mm-dd>.jsonl` (UTC date).
 *
 * Other files in the spool directory (the daemon must ignore anything not ending in `.jsonl`):
 *   .lock  advisory lock, created with the exclusive flag 'wx'
 *   .seq   per-host counter, 16 zero-padded digits, the last seq handed out
 *
 * Under the lock a writer reads the counter, hands out the next seq numbers, appends its lines and
 * stores the counter, so seq is unique and strictly increasing in file order. The lock is
 * advisory and bounded: after LOCK_WAIT_MS the writer appends anyway (a lost line is worse than a
 * duplicate seq) and uses a best-effort seq. A lock older than LOCK_STALE_MS is broken.
 *
 * Line size cap: a line longer than MAX_LINE_BYTES (64 KB) is not written as is. Its payload is
 * replaced by the truncated marker `{ "truncated": true, "original_bytes": <bytes of the whole
 * original line>, "limit_bytes": 65536 }`; every other envelope field stays.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { dayFileName } from "./paths.ts";

export const MAX_LINE_BYTES = 64 * 1024;
export const LOCK_NAME = ".lock";
export const SEQ_NAME = ".seq";
export const LOCK_WAIT_MS = 1_200;
export const LOCK_STALE_MS = 1_000;
const SEQ_DIGITS = 16;

export interface TruncatedMarker {
  truncated: true;
  original_bytes: number;
  limit_bytes: number;
}

/** The exact line (with trailing newline) the spool holds for an envelope. */
export function serializeLine(env: Envelope): { line: string; truncated: boolean } {
  const line = JSON.stringify(env) + "\n";
  const bytes = Buffer.byteLength(line);
  if (bytes <= MAX_LINE_BYTES) return { line, truncated: false };
  const marker: TruncatedMarker = {
    truncated: true,
    original_bytes: bytes,
    limit_bytes: MAX_LINE_BYTES,
  };
  return { line: JSON.stringify({ ...env, payload: marker }) + "\n", truncated: true };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/** Tries to take the lock; returns true when held. Never waits longer than LOCK_WAIT_MS. */
function acquire(lockPath: string, dir: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let madeDir = false;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return true;
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" && !madeDir) {
        madeDir = true;
        mkdirSync(dir, { recursive: true });
        continue;
      }
      if (code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath); // holder died; a rare double-break only risks a duplicate seq
            continue;
          }
        } catch {
          continue; // vanished between open and stat: retry at once
        }
      } else {
        return false; // cannot create a lock here at all
      }
    }
    if (Date.now() >= deadline) return false;
    sleepSync(1 + Math.floor(Math.random() * 5));
  }
}

function readCounter(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^\d{1,16}$/.test(text)) return null; // empty or torn file is not a counter
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function writeCounter(path: string, n: number): void {
  try {
    writeFileSync(path, String(n).padStart(SEQ_DIGITS, "0"));
  } catch {
    // The lines are already appended; a missed counter write is repaired by the recovery rule.
  }
}

function appendOnce(path: string, line: string): void {
  const buf = Buffer.from(line);
  const fd = openSync(path, "a");
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off);
  } finally {
    closeSync(fd);
  }
}

export type EnvelopeFactory = (seq: number) => Envelope;

export interface AppendResult {
  lines: number;
  locked: boolean;
}

/**
 * Appends one line per factory, in order, under one lock acquisition. Each factory receives the
 * seq to use. Throws when the spool directory cannot be written (callers log, never rethrow).
 */
export function appendEnvelopes(
  dir: string,
  factories: readonly EnvelopeFactory[],
  now: () => number = Date.now,
): AppendResult {
  const lockPath = join(dir, LOCK_NAME);
  const seqPath = join(dir, SEQ_NAME);
  const locked = acquire(lockPath, dir);
  try {
    // Missing or unreadable counter (first run, or a torn write): restart from the clock, which is
    // above any earlier counter value, so seq never goes backwards.
    let seq = readCounter(seqPath) ?? now();
    for (const make of factories) {
      seq += 1;
      const { line } = serializeLine(make(seq));
      appendOnce(join(dir, dayFileName(now())), line);
    }
    writeCounter(seqPath, seq);
    return { lines: factories.length, locked };
  } finally {
    if (locked) {
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone (stale-broken by another writer)
      }
    }
  }
}
