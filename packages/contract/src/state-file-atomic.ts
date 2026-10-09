import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
import { errorCode, StateFileError } from "./state-file-error.ts";

/**
 * Windows refuses to rename over a file another process has open for reading: EPERM, EBUSY or
 * EACCES. Those clear within milliseconds, so they are retried; every other code fails at once.
 */
export const RENAME_RETRY_CODES: readonly string[] = ["EPERM", "EBUSY", "EACCES"];
export const RENAME_MAX_ATTEMPTS = 5;
export const RENAME_RETRY_DELAY_MS = 20;

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

async function renameWithRetry(
  from: string,
  to: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const doRename = options.rename ?? rename;
  const maxAttempts = options.maxAttempts ?? RENAME_MAX_ATTEMPTS;
  const delayMs = options.retryDelayMs ?? RENAME_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error: unknown) {
      const code = errorCode(error) ?? "UNKNOWN";
      if (!RENAME_RETRY_CODES.includes(code) || attempt >= maxAttempts) {
        throw new StateFileError(
          "write-failed",
          `cannot replace ${to}: ${code} after ${attempt} attempt(s)`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    // force:true already ignores ENOENT (temp file never created or already gone), which is the
    // goal; anything else is reported alongside the original failure, never swallowed.
    return ` (temp file ${tempPath} not removed: ${errorCode(error) ?? "UNKNOWN"})`;
  }
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
  const text = `${JSON.stringify(value, null, JSON_INDENT)}\n`;
  const tempPath = tempPathFor(filePath);
  try {
    await mkdir(dirname(filePath), { recursive: true });
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
