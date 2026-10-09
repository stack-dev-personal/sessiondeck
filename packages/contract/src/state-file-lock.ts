import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode, StateFileError } from "./state-file-error.ts";
import { RENAME_RETRY_CODES } from "./state-file-atomic.ts";

// A read-modify-write of one status file is guarded by "<file>.lock", created with the "wx" flag
// so exactly one process wins. A holder can be killed, so a lock older than LOCK_STALE_MS is
// taken over, and a live lock is waited for only up to LOCK_WAIT_MS.
export const LOCK_SUFFIX = ".lock";
/** Far longer than the milliseconds a locked merge takes, short enough to recover from a kill. */
export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 5_000;
export const LOCK_POLL_MS = 25;

export interface LockOptions {
  /** Clock and wait are injectable so tests neither sleep for real nor depend on timing. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Windows reports a lock file that is being deleted (or briefly open elsewhere) as EPERM, EBUSY
 * or EACCES instead of EEXIST or ENOENT. All of these mean "someone else is using it right now".
 */
const CONTENDED_CODES: readonly string[] = ["EEXIST", "ENOENT", ...RENAME_RETRY_CODES];
const RELEASE_RETRIES = 5;
const RELEASE_RETRY_DELAY_MS = 20;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    await handle.close();
    return true;
  } catch (error: unknown) {
    if (CONTENDED_CODES.includes(errorCode(error) ?? "")) return false;
    throw new StateFileError(
      "write-failed",
      `cannot lock ${lockPath}: ${errorCode(error) ?? "UNKNOWN"}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Removes the lock when its holder is presumed dead. Two takers can race here; the worst case is
 * one overlapping merge after a crash, which is what having no lock at all would have cost.
 */
async function removeIfStale(lockPath: string, now: number, staleMs: number): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (now - mtimeMs > staleMs) await rm(lockPath, { force: true });
  } catch (error: unknown) {
    // Released (ENOENT) or being deleted by its holder between our attempt and this check.
    if (!CONTENDED_CODES.includes(errorCode(error) ?? "")) {
      throw new StateFileError(
        "write-failed",
        `cannot inspect ${lockPath}: ${errorCode(error) ?? "UNKNOWN"}`,
        {
          cause: error,
        },
      );
    }
  }
}

async function acquire(lockPath: string, options: LockOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch (error: unknown) {
    throw new StateFileError("write-failed", `cannot create the folder of ${lockPath}`, {
      cause: error,
    });
  }
  const deadline = now() + waitMs;
  while (!(await tryCreate(lockPath))) {
    await removeIfStale(lockPath, now(), staleMs);
    if (now() >= deadline) {
      throw new StateFileError(
        "lock-timeout",
        `${lockPath} is held by another writer after ${waitMs} ms; if no writer is running, delete it`,
      );
    }
    await sleep(pollMs);
  }
}

/** Runs fn while holding the lock of targetPath; the lock is always released. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = targetPath + LOCK_SUFFIX;
  await acquire(lockPath, options);
  try {
    return await fn();
  } finally {
    await rm(lockPath, {
      force: true,
      maxRetries: RELEASE_RETRIES,
      retryDelay: RELEASE_RETRY_DELAY_MS,
    });
  }
}
