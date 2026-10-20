import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { dayFileName } from "../paths.ts";
import type { SpoolLine } from "../spool-format.ts";

/**
 * Daemon-originated envelopes (heartbeat, liveness, transcript) go to `<home>/daemon/outbox`,
 * day files like the spool but written only by the daemon and without the 64 KB line cap. The
 * forwarder reads them with its own cursor.
 */
export type Outbox = ((line: SpoolLine) => void) & { sync: () => void };

export function createOutbox(dir: string, now: () => number = Date.now): Outbox {
  const written = new Set<string>();
  const put = (line: SpoolLine): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = join(dir, dayFileName(now()));
    appendFileSync(f, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    written.add(f);
  };
  /** fsyncs every day file written since the last sync (a poll can straddle the day rollover). */
  const sync = (): void => {
    for (const f of [...written]) {
      let fd: number;
      try {
        fd = openSync(f, "r+");
      } catch {
        written.delete(f); // removed (pruned) or unreadable: nothing left to flush
        continue;
      }
      try {
        fsyncSync(fd);
        written.delete(f);
      } finally {
        closeSync(fd);
      }
    }
  };
  return Object.assign(put, { sync });
}

/** Removes outbox day files older than the one the cursor is in (they are fully delivered). */
export function pruneOutbox(dir: string, cursorFile: string): void {
  try {
    for (const f of readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f < cursorFile)
        rmSync(join(dir, f), { force: true });
    }
  } catch {
    // best effort
  }
}
