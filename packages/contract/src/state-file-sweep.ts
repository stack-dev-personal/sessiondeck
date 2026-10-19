import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Temp files are named ".<target>.<pid>.<hex>.tmp". A writer killed between write and rename
// leaves one behind for good, so writers and ensureStateLayout remove old ones.
export const TEMP_FILE_PATTERN = /^\..+\.\d+\.[0-9a-f]+\.tmp$/;

/** Younger temp files may belong to a writer that is still running, so they are left alone. */
export const STALE_TEMP_MS = 5 * 60 * 1000;

export interface SweepOptions {
  now?: () => number;
  staleMs?: number;
  /** Only sweep temp files of this target file name (for example "S1.json"); default: all. */
  targetName?: string;
}

/** True when the entry name is a temp file of targetName, or of any target when none is given. */
function isTempOf(name: string, targetName: string | undefined): boolean {
  if (!TEMP_FILE_PATTERN.test(name)) return false;
  return targetName === undefined || name.startsWith(`.${targetName}.`);
}

/**
 * Removes stale temp files in dir and returns their names. This is housekeeping: a file that
 * vanished meanwhile (another sweeper) or cannot be removed is skipped, because the leftover is
 * harmless and the next sweep retries; it must never fail the write that triggered it.
 */
export async function sweepStaleTemps(dir: string, options: SweepOptions = {}): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const staleMs = options.staleMs ?? STALE_TEMP_MS;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // directory does not exist yet; nothing to sweep
  }
  const removed: string[] = [];
  for (const name of names.filter((n) => isTempOf(n, options.targetName))) {
    const path = join(dir, name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs <= staleMs) continue;
      await rm(path, { force: true });
      removed.push(name);
    } catch {
      continue; // see above: skipped on purpose
    }
  }
  return removed;
}
