import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Locks held by this process (a lock file with our own pid but not in here is stale). */
const held = new Set<string>();

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

export interface Lock {
  release(): void;
}

/** Takes the single-instance lock; undefined when a live daemon already holds it. */
export function acquireLock(path: string): Lock | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      held.add(path);
      return {
        release: () => {
          held.delete(path);
          try {
            if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = NaN;
    try {
      pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      continue; // vanished between open and read
    }
    if (
      Number.isInteger(pid) &&
      pid > 0 &&
      pidAlive(pid) &&
      (pid !== process.pid || held.has(path))
    )
      return undefined;
    rmSync(path, { force: true }); // stale: owner is gone
  }
  return undefined;
}
