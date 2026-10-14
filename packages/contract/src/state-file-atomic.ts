import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorCode, StateFileError } from "./state-file-error.ts";
import { sweepStaleTemps, type SweepOptions } from "./state-file-sweep.ts";

/**
 * Windows refuses to rename over a file another process has open for reading: EPERM, EBUSY or
 * EACCES. Those clear within milliseconds to a second, so they are retried with exponential
 * backoff and jitter; every other code fails at once.
 */
export const RENAME_RETRY_CODES: readonly string[] = ["EPERM", "EBUSY", "EACCES"];
/** Cleanup errors that mean the temp file is not there (ENOTDIR: a file stands where a directory should be). */
const TEMP_ABSENT_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];
export const RENAME_MAX_ATTEMPTS = 7;
/** Delays double from this base: 20, 40, 80, 160, 320, 640 ms, about one second after jitter. */
export const RENAME_RETRY_DELAY_MS = 20;
/** Each delay is scaled by a factor in [JITTER_FLOOR, 1] so competing writers drift apart. */
export const RENAME_JITTER_FLOOR = 0.5;

const TEMP_SUFFIX_BYTES = 4;
const JSON_INDENT = 2;

export type RenameFn = (from: string, to: string) => Promise<void>;

export interface AtomicWriteOptions {
  /** Replaceable so tests can simulate a Windows sharing violation without mocking node:fs. */
  rename?: RenameFn;
  /** Replaceable so tests can make the temp file cleanup fail. */
  remove?: (path: string) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Jitter source returning [0, 1); injectable so the backoff schedule is deterministic. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  sweep?: SweepOptions;
}

/** Delay before retry number `attempt` (1 for the first retry). */
export function renameBackoffMs(attempt: number, baseMs: number, random: () => number): number {
  const jitter = RENAME_JITTER_FLOOR + (1 - RENAME_JITTER_FLOOR) * random();
  return Math.round(baseMs * 2 ** (attempt - 1) * jitter);
}

function tempPathFor(filePath: string): string {
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString("hex");
  // Same directory as the target so the rename never crosses a volume.
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${suffix}.tmp`);
}

async function writeFlushed(tempPath: string, text: string): Promise<void> {
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Owner write bit; Windows maps the read-only attribute to its absence. */
const OWNER_WRITE_BIT = 0o200;

/** True only when the target exists and is not writable; any stat failure counts as "unknown". */
async function isReadOnly(path: string): Promise<boolean> {
  try {
    return ((await stat(path)).mode & OWNER_WRITE_BIT) === 0;
  } catch {
    // Missing or unreadable: nothing shows the target is permanently blocked, so keep "busy".
    return false;
  }
}

async function renameWithRetry(
  from: string,
  to: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const doRename = options.rename ?? rename;
  const maxAttempts = options.maxAttempts ?? RENAME_MAX_ATTEMPTS;
  const baseMs = options.retryDelayMs ?? RENAME_RETRY_DELAY_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error: unknown) {
      const code = errorCode(error) ?? "UNKNOWN";
      const sharing = RENAME_RETRY_CODES.includes(code);
      if (!sharing || attempt >= maxAttempts) {
        // A sharing violation that outlasts the budget is "busy": the content is fine and the
        // write can be repeated later. Any other code is a real failure such as a full disk, and
        // so is a read-only target, which no retry can ever replace.
        const readOnly = sharing && (await isReadOnly(to));
        const why = readOnly ? "; the file is read-only, clear that first" : "";
        throw new StateFileError(
          sharing && !readOnly ? "busy" : "write-failed",
          `cannot replace ${to}: ${code} after ${attempt} attempt(s)${why}`,
          { cause: error },
        );
      }
      await sleep(renameBackoffMs(attempt, baseMs, random));
    }
  }
}

/** Removes the temp file after a failed write; returns a note if cleanup itself failed. */
async function discardTemp(tempPath: string, options: AtomicWriteOptions): Promise<string> {
  const remove = options.remove ?? ((path: string) => rm(path, { force: true }));
  try {
    await remove(tempPath);
    return "";
  } catch (error: unknown) {
    // force:true already ignores ENOENT, but a file standing where a directory should be gives
    // ENOTDIR on Linux. Both mean the temp file was never created or is already gone, which is the
    // goal. Anything else is reported alongside the original failure, never swallowed.
    const code = errorCode(error) ?? "UNKNOWN";
    return TEMP_ABSENT_CODES.includes(code) ? "" : ` (temp file ${tempPath} not removed: ${code})`;
  }
}

/** JSON.stringify throws on BigInt and cycles and returns undefined for undefined or a function. */
function serialize(filePath: string, value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, JSON_INDENT);
  } catch (error: unknown) {
    throw new StateFileError("write-failed", `cannot serialize the value for ${filePath} as JSON`, {
      cause: error,
    });
  }
  if (typeof text !== "string") {
    throw new StateFileError("write-failed", `the value for ${filePath} has no JSON form`);
  }
  return `${text}\n`;
}

/**
 * Writes JSON to filePath so a reader sees either the old or the new complete content:
 * temp file in the same directory, flushed, then renamed over the target.
 */
export async function writeStateFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const text = serialize(filePath, value);
  const tempPath = tempPathFor(filePath);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await sweepStaleTemps(dirname(filePath), { ...options.sweep, targetName: basename(filePath) });
    await writeFlushed(tempPath, text);
    await renameWithRetry(tempPath, filePath, options);
  } catch (error: unknown) {
    const note = await discardTemp(tempPath, options);
    if (error instanceof StateFileError) {
      if (note) throw new StateFileError(error.kind, error.message + note, { cause: error });
      throw error;
    }
    throw new StateFileError(
      "write-failed",
      `cannot write ${filePath}: ${errorCode(error) ?? "UNKNOWN"}${note}`,
      { cause: error },
    );
  }
}
