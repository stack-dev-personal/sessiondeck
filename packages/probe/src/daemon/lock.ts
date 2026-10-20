import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";

/**
 * Single-instance lock: a file holding {pid, boot, start, token}.
 *
 * Creation is atomic: the content goes into a private temp file, which is hard-linked into place
 * (EEXIST means contended), so the lock is never observable half-written. Every removal (of the
 * lock or of the takeover mutex) is a rename to a unique name followed by a check of what was
 * renamed; if it is not what was judged, it is linked back. A lock is stale when its pid is dead,
 * or the machine rebooted since it was written, or (Linux) the pid has another start time, or it
 * was not touched for LOCK_STALE_MS (pid reuse on Windows, or a long sleep). The owner touches the
 * file every LOCK_TOUCH_MS. Taking over a stale lock is serialized by a mutex file.
 *
 * Fencing is the last line: the owner (and the forwarder, before every state write and POST) calls
 * verify(), which is false only when the file parses to another token. Whoever loses stops.
 */
export const LOCK_TOUCH_MS = 10_000;
export const LOCK_STALE_MS = 10 * 60_000;
const BOOT_TOLERANCE_MS = 10 * 60_000;
const TAKEOVER_STALE_MS = 10_000;
/** A lock file that does not parse is treated as live for this long (it should not exist). */
const UNPARSEABLE_GRACE_MS = 5_000;
/** How long a starter keeps waiting for a takeover in progress (a crashed mutex goes stale at 10 s). */
export const TAKEOVER_WAIT_MS = TAKEOVER_STALE_MS + 2_000;

interface LockInfo {
  pid: number;
  boot?: number;
  start?: number;
  token?: string;
}

export interface LockDeps {
  alive: (pid: number) => boolean;
  bootMs: () => number;
  /** Process start time in clock ticks since boot, where the platform can tell (Linux). */
  procStart: (pid: number) => number | undefined;
  now: () => number;
  /** Runs while the takeover mutex is held, before the stale lock is removed (tests). */
  duringTakeover?: () => void;
  /** How long to wait for another starter's takeover (default TAKEOVER_WAIT_MS; tests shorten it). */
  takeoverWaitMs?: number;
}

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

function linuxProcStart(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command name; starttime is field 22 overall.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const n = Number(rest[19]);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

const realDeps: LockDeps = {
  alive: pidAlive,
  bootMs: () => Date.now() - uptime() * 1000,
  procStart: linuxProcStart,
  now: Date.now,
};

export interface Lock {
  release(): void;
  /** Refreshes the lock's mtime. False when the lock now belongs to someone else. */
  touch(): boolean;
  /** Token check only (no write): false when the lock file parses to another token. */
  verify(): boolean;
}

function parseInfo(text: string): LockInfo | undefined {
  const t = text.trim();
  if (/^\d+$/.test(t)) return { pid: Number.parseInt(t, 10) }; // first format: bare pid
  try {
    const o = JSON.parse(t) as Partial<LockInfo>;
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid)) return undefined;
    const info: LockInfo = { pid: o.pid };
    if (typeof o.boot === "number") info.boot = o.boot;
    if (typeof o.start === "number") info.start = o.start;
    if (typeof o.token === "string") info.token = o.token;
    return info;
  } catch {
    return undefined;
  }
}

type Raw = { ok: true; text: string } | { ok: false; code: string };

function readRaw(path: string): Raw {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (e) {
    return { ok: false, code: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
  }
}

function isLive(path: string, text: string, d: LockDeps): boolean {
  let age: number;
  try {
    age = d.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const info = parseInfo(text);
  if (!info) return age < UNPARSEABLE_GRACE_MS; // atomic creation: only a foreign or damaged file
  if (info.pid <= 0) return false;
  if (!d.alive(info.pid)) return false;
  if (info.pid === process.pid && !held.has(path)) return false;
  if (info.boot !== undefined && Math.abs(info.boot - d.bootMs()) > BOOT_TOLERANCE_MS) return false;
  if (info.start !== undefined) {
    const now = d.procStart(info.pid);
    if (now !== undefined && now !== info.start) return false;
  }
  return age <= LOCK_STALE_MS;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Creates `path` with `content` atomically; false when it exists. */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
      throw e;
    }
    // No hard links on this file system: fall back to O_EXCL (content follows the creation).
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Removes `path` only if what is there passes `ok`: rename to a unique name, look at what was
 * renamed, delete it if it passes, else link it back (if a newer file took the name meanwhile,
 * the renamed one is dropped and its owner's fence check settles it). True when the path is gone.
 */
function removeVerified(path: string, ok: (text: string, mtimeMs: number) => boolean): boolean {
  const aside = `${path}.old-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  let pass = false;
  try {
    const text = readFileSync(aside, "utf8");
    pass = ok(text, statSync(aside).mtimeMs);
  } catch {
    pass = false;
  }
  if (!pass) {
    try {
      linkSync(aside, path);
    } catch {
      // a newer file holds the name; fencing handles the loser
    }
  }
  rmSync(aside, { force: true });
  return pass;
}

function makeLock(path: string, token: string, content: string): Lock {
  let released = false;
  const check = (write: boolean): boolean => {
    if (released) return false;
    const r = readRaw(path);
    if (!r.ok) {
      if (r.code !== "ENOENT") return true; // transient (sharing violation, EPERM): try again later
      try {
        if (createExclusive(path, content)) return true; // someone removed it; ours again
      } catch {
        return true;
      }
      const again = readRaw(path);
      if (!again.ok) return true;
      const info = parseInfo(again.text);
      return !info || info.token === token;
    }
    const info = parseInfo(r.text);
    if (info && info.token !== token) return false;
    if (write) {
      try {
        const t = new Date();
        utimesSync(path, t, t);
      } catch {
        // best effort; the next tick tries again
      }
    }
    return true;
  };
  return {
    release: () => {
      released = true;
      held.delete(path);
      removeVerified(path, (text) => parseInfo(text)?.token === token);
    },
    touch: () => check(true),
    verify: () => check(false),
  };
}

function tryCreate(path: string, d: LockDeps): Lock | undefined {
  const token = randomBytes(8).toString("hex");
  const info: LockInfo = { pid: process.pid, boot: Math.round(d.bootMs()), token };
  const start = d.procStart(process.pid);
  if (start !== undefined) info.start = start;
  const content = JSON.stringify(info);
  if (!createExclusive(path, content)) return undefined;
  held.add(path);
  return makeLock(path, token, content);
}

/**
 * Takes the single-instance lock; undefined when a live daemon already holds it. Throws when a
 * takeover by another starter does not finish within TAKEOVER_WAIT_MS ("takeover in progress").
 */
export function acquireLock(path: string, deps: Partial<LockDeps> = {}): Lock | undefined {
  const d: LockDeps = { ...realDeps, ...deps };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mutex = `${path}.takeover`;
  const deadline = performance.now() + (d.takeoverWaitMs ?? TAKEOVER_WAIT_MS);
  for (;;) {
    const created = tryCreate(path, d);
    if (created) return created;
    if (performance.now() > deadline) throw new Error("daemon lock takeover in progress");
    const cur = readRaw(path);
    if (!cur.ok) {
      if (cur.code !== "ENOENT") sleepSync(5 + Math.floor(Math.random() * 20));
      continue; // vanished between link and read, or transiently unreadable
    }
    if (isLive(path, cur.text, d)) return undefined;

    // Stale. Only the holder of the takeover mutex may remove it, and it re-checks first.
    const mine = `${process.pid}:${randomBytes(8).toString("hex")}`;
    if (!createExclusive(mutex, mine)) {
      // A mutex older than TAKEOVER_STALE_MS belongs to a crashed starter.
      // Look first: renaming a live mutex away, even briefly, would let a third starter in.
      const stale = (mtimeMs: number): boolean => d.now() - mtimeMs > TAKEOVER_STALE_MS;
      try {
        if (stale(statSync(mutex).mtimeMs)) removeVerified(mutex, (_t, m) => stale(m));
      } catch {
        // gone already
      }
      sleepSync(5 + Math.floor(Math.random() * 20));
      continue;
    }
    try {
      const again = readRaw(path);
      if (again.ok && again.text === cur.text && !isLive(path, again.text, d)) {
        d.duringTakeover?.();
        removeVerified(path, (text) => text === cur.text);
      }
      const lock = tryCreate(path, d);
      if (lock) return lock;
    } finally {
      removeVerified(mutex, (text) => text === mine);
    }
  }
}
