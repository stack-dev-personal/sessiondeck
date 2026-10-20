import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";

/**
 * Single-instance lock: a file holding {pid, boot, start, token}, created with O_EXCL.
 *
 * A lock is stale when its pid is dead, or the machine rebooted since it was written (boot time
 * differs), or (Linux) the pid now has another start time, or it was not touched for LOCK_STALE_MS
 * even though the pid is alive (pid reuse on Windows). The owner touches the file every
 * LOCK_TOUCH_MS. Taking over a stale lock is serialized by a second O_EXCL file, so two starters
 * cannot each delete the other's fresh lock; an owner that finds a foreign token calls onLost.
 */
export const LOCK_TOUCH_MS = 10_000;
export const LOCK_STALE_MS = 10 * 60_000;
const BOOT_TOLERANCE_MS = 10 * 60_000;
const TAKEOVER_STALE_MS = 10_000;

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

function readInfo(path: string): { text: string; info: LockInfo | undefined } | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return { text, info: parseInfo(text) };
  } catch {
    return undefined;
  }
}

function isLive(path: string, info: LockInfo | undefined, d: LockDeps): boolean {
  if (!info || info.pid <= 0) return false;
  if (!d.alive(info.pid)) return false;
  if (info.pid === process.pid && !held.has(path)) return false;
  if (info.boot !== undefined && Math.abs(info.boot - d.bootMs()) > BOOT_TOLERANCE_MS) return false;
  if (info.start !== undefined) {
    const now = d.procStart(info.pid);
    if (now !== undefined && now !== info.start) return false;
  }
  try {
    if (d.now() - statSync(path).mtimeMs > LOCK_STALE_MS) return false;
  } catch {
    return false;
  }
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeLock(path: string, token: string): Lock {
  return {
    release: () => {
      held.delete(path);
      // Narrow race with a takeover is harmless: a takeover only happens to stale locks.
      const cur = readInfo(path);
      if (cur?.info?.token === token) rmSync(path, { force: true });
    },
    touch: () => {
      const cur = readInfo(path);
      if (cur?.info?.token !== token) return false;
      try {
        const t = new Date();
        utimesSync(path, t, t);
      } catch {
        // best effort; the next tick tries again
      }
      return true;
    },
  };
}

function tryCreate(path: string, d: LockDeps): Lock | undefined {
  const token = randomBytes(8).toString("hex");
  const info: LockInfo = { pid: process.pid, boot: Math.round(d.bootMs()), token };
  const start = d.procStart(process.pid);
  if (start !== undefined) info.start = start;
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  held.add(path);
  return makeLock(path, token);
}

/** Takes the single-instance lock; undefined when a live daemon already holds it. */
export function acquireLock(path: string, deps: Partial<LockDeps> = {}): Lock | undefined {
  const d: LockDeps = { ...realDeps, ...deps };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mutex = `${path}.takeover`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const created = tryCreate(path, d);
    if (created) return created;
    const cur = readInfo(path);
    if (!cur) continue; // vanished between open and read
    if (isLive(path, cur.info, d)) return undefined;

    // Stale. Only the holder of the takeover mutex may remove it, and it re-checks first.
    let fd: number;
    try {
      fd = openSync(mutex, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (d.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) rmSync(mutex, { force: true });
      } catch {
        // gone already
      }
      sleepSync(5 + Math.floor(Math.random() * 20));
      continue;
    }
    closeSync(fd);
    try {
      const again = readInfo(path);
      if (again && again.text === cur.text && !isLive(path, again.info, d)) {
        d.duringTakeover?.();
        rmSync(path, { force: true });
      }
      const lock = tryCreate(path, d);
      if (lock) return lock;
    } finally {
      rmSync(mutex, { force: true });
    }
  }
  return undefined;
}
