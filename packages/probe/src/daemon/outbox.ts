import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dayFileName } from "../paths.ts";
import type { SpoolLine } from "../spool-format.ts";

/**
 * Daemon-originated envelopes (heartbeat, liveness, transcript) go to `<home>/daemon/outbox`,
 * day files like the spool but written only by the daemon and without the 64 KB line cap. The
 * forwarder reads them with its own cursor.
 */
export function createOutbox(dir: string, now: () => number = Date.now): (line: SpoolLine) => void {
  return (line) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, dayFileName(now())), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };
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
