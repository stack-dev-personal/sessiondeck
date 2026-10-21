/**
 * Spool writer (hook side). Each SpoolLine is one write of `JSON.stringify(line) + "\n"` on an
 * O_APPEND descriptor of `<spool>/<yyyy-mm-dd>.jsonl` (UTC date). No lock, no counter, no other
 * file: the daemon assigns seq (see spool.ts).
 *
 * Line size cap: a line over MAX_LINE_BYTES gets its payload replaced by the marker
 * `{ "truncated": true, "original_bytes": <bytes of the whole original line>, "limit_bytes": 65536 }`.
 * If the line is still over the cap (huge id fields) it is not written at all.
 *
 * Hardening: directories 0700, files 0600 (the spool holds raw prompts and tool inputs); the day
 * file is opened with O_NOFOLLOW where it exists and a non-regular file is refused (Windows has no
 * O_NOFOLLOW, so lstat first).
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dayFileName } from "./paths.ts";
import { MAX_LINE_BYTES, type SpoolLine } from "./spool-format.ts";

export interface TruncatedMarker {
  truncated: true;
  original_bytes: number;
  limit_bytes: number;
}

/** The exact text the spool holds for a line; null when it cannot be made to fit the cap. */
export function serializeLine(env: SpoolLine): { line: string; truncated: boolean } | null {
  const line = JSON.stringify(env) + "\n";
  const bytes = Buffer.byteLength(line);
  if (bytes <= MAX_LINE_BYTES) return { line, truncated: false };
  const marker: TruncatedMarker = {
    truncated: true,
    original_bytes: bytes,
    limit_bytes: MAX_LINE_BYTES,
  };
  const small = JSON.stringify({ ...env, payload: marker }) + "\n";
  if (Buffer.byteLength(small) > MAX_LINE_BYTES) return null;
  return { line: small, truncated: true };
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

export function notRegular(): Error {
  return Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
}

/**
 * Opens a file for appending: created 0600 if absent, never through a symlink, and only if it is a
 * regular file. The caller closes the descriptor. Creates missing parent directories (0700).
 */
export function openAppendPrivate(path: string): number {
  // O_NONBLOCK: a FIFO named as a day file fails to open (ENXIO) instead of blocking the hook.
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
  const open = (): number => {
    if (constants.O_NOFOLLOW === undefined) {
      // Windows: no O_NOFOLLOW; refuse an existing non-regular file or a link.
      try {
        const st = lstatSync(path);
        if (!st.isFile()) throw notRegular();
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
      }
    }
    return openSync(path, flags, 0o600);
  };
  let fd: number;
  try {
    fd = open();
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = open();
  }
  try {
    if (!fstatSync(fd).isFile()) throw notRegular();
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

function writeAll(fd: number, line: string): void {
  const buf = Buffer.from(line);
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off);
}

export interface AppendResult {
  written: number;
  /** Lines dropped because they could not fit the cap. */
  dropped: number;
}

/**
 * Appends one line per envelope, in order. Throws when the spool cannot be written (callers log,
 * never rethrow).
 */
export function appendSpoolLines(
  dir: string,
  lines: readonly SpoolLine[],
  now: () => number = Date.now,
): AppendResult {
  const texts: string[] = [];
  let dropped = 0;
  for (const l of lines) {
    const s = serializeLine(l);
    if (s) texts.push(s.line);
    else dropped += 1;
  }
  if (texts.length === 0) return { written: 0, dropped };
  const fd = openAppendPrivate(join(dir, dayFileName(now())));
  try {
    for (const t of texts) writeAll(fd, t);
  } finally {
    closeSync(fd);
  }
  return { written: texts.length, dropped };
}
