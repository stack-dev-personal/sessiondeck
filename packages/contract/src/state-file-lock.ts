import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
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
  /** Creates the lock file exclusively and writes the token; replaceable to simulate a denied create. */
  create?: (lockPath: string, token: string) => Promise<void>;
  /** Writes the token into the new lock file; replaceable to simulate a full disk. */
  writeToken?: WriteToken;
  /** Reads the token back at release; replaceable to simulate a lock that is being deleted. */
  readToken?: (lockPath: string) => Promise<string>;
}

export type WriteToken = (handle: FileHandle, token: string) => Promise<void>;

/**
 * Windows reports a lock file that is being deleted (or briefly open elsewhere) as EPERM, EBUSY
 * or EACCES instead of EEXIST or ENOENT. All of these mean "someone else is using it right now".
 */
const CONTENDED_CODES: readonly string[] = ["EEXIST", "ENOENT", ...RENAME_RETRY_CODES];
/** Codes that can also mean "cannot create here at all" (no ACL right, wrong owner, no folder). */
const AMBIGUOUS_CODES: readonly string[] = ["EPERM", "EACCES", "ENOENT"];
const TOKEN_BYTES = 8;
export const RELEASE_RETRIES = 5;
const RELEASE_RETRY_DELAY_MS = 20;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const writeTokenDefault: WriteToken = (handle, token) => handle.writeFile(token, "utf8");

async function createExclusive(
  lockPath: string,
  token: string,
  writeToken: WriteToken = writeTokenDefault,
): Promise<void> {
  const handle = await open(lockPath, "wx");
  try {
    await writeToken(handle, token);
  } catch (error: unknown) {
    // The file now exists but holds no token (disk full). Left behind it would block every writer
    // until it turns stale, and nobody owns it, so remove it before reporting the failure.
    await handle.close().catch(() => undefined); // the write error is the one worth reporting
    await rm(lockPath, { force: true });
    throw error;
  }
  await handle.close();
}

async function lockFileExists(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    return true; // cannot tell, so treat it as present and let the wait budget decide
  }
}

function cannotLock(lockPath: string, error: unknown): StateFileError {
  const code = errorCode(error) ?? "UNKNOWN";
  return new StateFileError("write-failed", `cannot lock ${lockPath}: ${code}`, { cause: error });
}

/**
 * True when the lock was created; false when another writer holds it. A denied create (deny ACL,
 * a bind mount owned by another uid) looks like contention by its code but leaves no lock file,
 * so that case fails at once instead of spinning and blaming a writer that does not exist. The
 * file may also have just vanished while Windows finished deleting it, hence one second try.
 */
async function tryCreate(lockPath: string, token: string, options: LockOptions): Promise<boolean> {
  const create =
    options.create ?? ((path: string, t: string) => createExclusive(path, t, options.writeToken));
  let lastError: unknown;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      await create(lockPath, token);
      return true;
    } catch (error: unknown) {
      const code = errorCode(error) ?? "";
      if (!CONTENDED_CODES.includes(code)) throw cannotLock(lockPath, error);
      if (!AMBIGUOUS_CODES.includes(code) || (await lockFileExists(lockPath))) return false;
      lastError = error;
    }
  }
  throw cannotLock(lockPath, lastError);
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

async function acquire(lockPath: string, token: string, options: LockOptions): Promise<void> {
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
  while (!(await tryCreate(lockPath, token, options))) {
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

/**
 * Removes the lock only if it still holds our token. If this holder was paused past the stale
 * threshold, another writer took the lock over; deleting it would let a third writer in.
 */
async function release(lockPath: string, token: string, options: LockOptions): Promise<void> {
  const readToken = options.readToken ?? ((path: string) => readFile(path, "utf8"));
  const sleep = options.sleep ?? realSleep;
  let held: string | undefined;
  for (let attempt = 1; held === undefined; attempt += 1) {
    try {
      held = await readToken(lockPath);
    } catch (error: unknown) {
      const code = errorCode(error) ?? "";
      if (code === "ENOENT") return; // already taken over and released by someone else
      // A lock being deleted by a stale takeover reads as EPERM or EBUSY for a moment. Past the
      // retries, give up quietly: throwing here would hide a write that already succeeded, and
      // the lock either belongs to the taker or turns stale and is taken over.
      if (!RENAME_RETRY_CODES.includes(code) || attempt >= RELEASE_RETRIES) return;
      await sleep(RELEASE_RETRY_DELAY_MS);
    }
  }
  if (held !== token) return;
  await rm(lockPath, {
    force: true,
    maxRetries: RELEASE_RETRIES,
    retryDelay: RELEASE_RETRY_DELAY_MS,
  });
}

/** Runs fn while holding the lock of targetPath; the lock is released if it is still ours. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = targetPath + LOCK_SUFFIX;
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await acquire(lockPath, token, options);
  try {
    return await fn();
  } finally {
    await release(lockPath, token, options);
  }
}
