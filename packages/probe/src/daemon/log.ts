import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./types.ts";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Appends `ISO level message` lines to the daemon log; never throws. Rotates once at 5 MiB. */
export function createFileLogger(path: string, now: () => number = Date.now): Logger {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet, or cannot rotate: carry on
  }
  return (level, msg) => {
    try {
      appendFileSync(path, `${new Date(now()).toISOString()} ${level} ${msg}\n`, { mode: 0o600 });
    } catch {
      // logging must never take the daemon down
    }
  };
}

/** Never log more than this many characters of anything that came from a spool line. */
export function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
