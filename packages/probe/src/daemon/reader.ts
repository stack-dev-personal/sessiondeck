/**
 * Incremental reader for a directory of day files (`yyyy-mm-dd.jsonl`): the hook spool and the
 * daemon outbox share it. The cursor is {file, offset}; there are no inode assumptions (Windows):
 * a file that is shorter than the cursor offset was replaced or truncated and is read from 0.
 *
 * Only complete lines are consumed: a trailing partial line is held back until its newline
 * arrives. Invalid lines are skipped (counted; the log gets file, offset, length and the parse
 * error, never line content) and get no seq. The reader moves to the next day file only when the
 * current one is exhausted, a later one exists, and the current one has not grown for DAY_GRACE_MS
 * (counted from the end of its UTC day at the earliest): a hook that picked the old day's name just before UTC midnight may still append to it.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSpoolLine } from "../spool.ts";
import type { SpoolLine } from "../spool-format.ts";
import type { Cursor, Logger } from "./types.ts";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const FIRST_CHUNK = 1024 * 1024;
/** Bytes added to a line's length to estimate its size once `,"seq":N` is added. */
export const SEQ_OVERHEAD = 24;
/** A torn last line of a past day file is dropped after this long without growth. */
const TORN_TAIL_MS = 60_000;
/** An exhausted day file is left for the next one only after this long without a write. */
export const DAY_GRACE_MS = 60_000;

/** End (exclusive) of the UTC day a day file is named after, in ms. */
function dayEnd(file: string): number {
  const t = Date.parse(`${file.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t + 86_400_000 : 0;
}

export interface ReadOutcome {
  items: SpoolLine[];
  /** Per item: the position just after its line (a restart from here repeats nothing before it). */
  ends: Cursor[];
  /** Per item: estimated serialized bytes. */
  costs: number[];
  /** Estimated serialized bytes of the items. */
  bytes: number;
  /** Stopped because the next item did not fit the byte budget. */
  full: boolean;
  /** Stopped because there was nothing more to read (not for a limit). */
  drained: boolean;
}

export class DayFileReader {
  position: Cursor | undefined;
  skipped = 0;

  constructor(
    private readonly dir: string,
    start: Cursor | undefined,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly label = "spool",
  ) {
    this.position = start ? { ...start } : undefined;
  }

  async listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => DAY_FILE.test(f)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** Bytes between the position and the end of the newest day file. */
  async lagBytes(): Promise<number> {
    const files = await this.listFiles();
    let lag = 0;
    for (const f of files) {
      if (this.position && f < this.position.file) continue;
      try {
        const size = (await stat(join(this.dir, f))).size;
        lag +=
          this.position && f === this.position.file
            ? Math.max(0, size - this.position.offset)
            : size;
      } catch {
        // file vanished
      }
    }
    return lag;
  }

  /**
   * Reads up to maxItems complete lines. The byte budget holds for every item except the first,
   * which is let through over budget only when `allowOversizeFirst` (the caller's buffer is empty,
   * so the line goes out alone).
   */
  async read(maxItems: number, maxBytes: number, allowOversizeFirst = true): Promise<ReadOutcome> {
    const out: ReadOutcome = {
      items: [],
      ends: [],
      costs: [],
      bytes: 0,
      full: false,
      drained: false,
    };
    while (out.items.length < maxItems && !out.full) {
      const files = await this.listFiles();
      if (!this.position) {
        const first = files[0];
        if (!first) break;
        this.position = { file: first, offset: 0 };
      } else if (!files.includes(this.position.file)) {
        const next = files.find((f) => f > (this.position as Cursor).file);
        if (!next) break;
        this.position = { file: next, offset: 0 };
        continue;
      }
      const pos = this.position;
      const path = join(this.dir, pos.file);
      let st;
      try {
        st = await stat(path);
      } catch {
        continue; // vanished since the listing; the next pass moves on
      }
      if (st.size < pos.offset) {
        this.log(
          "warn",
          `${this.label}: ${pos.file} shrank (${st.size} < ${pos.offset}); reading from 0`,
        );
        pos.offset = 0;
      }
      const later = files.find((f) => f > pos.file);
      // Quiet time counts from the end of the file's UTC day at the earliest: a hook that picked
      // this name just before midnight may still be on its way to append, however old the mtime.
      const quietSince = Math.max(st.mtimeMs, dayEnd(pos.file));
      if (st.size === pos.offset) {
        if (!later || this.now() - quietSince <= DAY_GRACE_MS) break;
        this.position = { file: later, offset: 0 };
        continue;
      }
      const progressed = await this.readFile(
        path,
        pos,
        st.size,
        quietSince,
        later !== undefined,
        out,
        maxItems,
        maxBytes,
        allowOversizeFirst,
      );
      if (!progressed) {
        // Only a partial line is left. Elsewhere to go and nothing new: wait for the newline.
        break;
      }
    }
    out.drained = !out.full && out.items.length < maxItems;
    return out;
  }

  /** Consumes complete lines from one file; false when nothing could be consumed. */
  private async readFile(
    path: string,
    pos: Cursor,
    size: number,
    quietSince: number,
    hasLater: boolean,
    out: ReadOutcome,
    maxItems: number,
    maxBytes: number,
    allowOversizeFirst: boolean,
  ): Promise<boolean> {
    const fh = await open(path, "r");
    try {
      let want = Math.min(size - pos.offset, FIRST_CHUNK);
      let buf = Buffer.alloc(0);
      for (;;) {
        buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos.offset);
        buf = buf.subarray(0, bytesRead);
        if (buf.includes(0x0a) || pos.offset + bytesRead >= size || bytesRead < want) break;
        want *= 2; // one line longer than the chunk
      }
      let consumed = 0;
      let start = 0;
      let progressed = false;
      let stopped = false;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0) break;
        const n = nl + 1 - start;
        let text = buf.toString("utf8", start, nl);
        if (text.endsWith("\r")) text = text.slice(0, -1);
        if (text.trim() === "") {
          start = nl + 1;
          consumed = start;
          progressed = true;
          continue;
        }
        const parsed = parseSpoolLine(text);
        if (parsed.ok) {
          const cost = n + SEQ_OVERHEAD;
          if (out.items.length >= maxItems) {
            stopped = true;
            break;
          }
          if ((out.items.length > 0 || !allowOversizeFirst) && out.bytes + cost > maxBytes) {
            out.full = true;
            stopped = true;
            break;
          }
          out.items.push(parsed.line);
          out.ends.push({ file: pos.file, offset: pos.offset + nl + 1 });
          out.costs.push(cost);
          out.bytes += cost;
        } else {
          this.skipped += 1;
          this.log(
            "warn",
            `${this.label}: skipped invalid line in ${pos.file} at ${pos.offset + start} length ${n} (${parsed.error})`,
          );
        }
        start = nl + 1;
        consumed = start;
        progressed = true;
      }
      pos.offset += consumed;
      if (
        !progressed &&
        !stopped &&
        hasLater &&
        this.now() - quietSince > TORN_TAIL_MS &&
        buf.length > 0
      ) {
        // A torn final line in a past day file will never be completed.
        this.skipped += 1;
        this.log(
          "warn",
          `${this.label}: dropped torn tail of ${pos.file} at ${pos.offset} length ${buf.length}`,
        );
        pos.offset += buf.length;
        return true;
      }
      return progressed;
    } finally {
      await fh.close();
    }
  }
}
