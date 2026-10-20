import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Single-instance lock built from generation-numbered files: `<path>.<gen>` (gen a non-negative
 * integer; the old single `<path>` of earlier builds counts as generation 0). The current lock is
 * the highest existing generation. Each file holds {pid, boot, start, token}.
 *
 * Taking over: scan; none -> try to create gen 1; highest gen n live -> lose; stale -> try to create
 * gen n+1. Creation writes a private temp file and hard-links it to the generation name, so the
 * file is never observable half-written and exactly one process can create any given generation
 * (EEXIST: someone else won; re-scan and judge again). No lock file is ever removed or renamed in
 * order to take over, so a late starter that judged an old file stale cannot displace a fresh lock.
 * Without hard links (FAT/exFAT) creation falls back to O_EXCL + write; a young empty or
 * unparseable file counts as live.
 *
 * A lock is stale when its pid is dead, or the machine rebooted since it was written, or (Linux)
 * the pid has another start time, or it was not touched for LOCK_STALE_MS (pid reuse on Windows, a
 * long sleep). The owner touches its file every LOCK_TOUCH_MS and, once it holds the lock, deletes
 * the lower generations and old temp files (best effort).
 *
 * Fence: I hold the lock iff my generation file exists with my token and no higher generation
 * exists. The owner (and the forwarder, before every state write and POST) calls verify(). A lock
 * that was found lost never releases anything.
 */
export const LOCK_TOUCH_MS = 10_000;
export const LOCK_STALE_MS = 10 * 60_000;
const BOOT_TOLERANCE_MS = 10 * 60_000;
/** A lock file that does not parse is treated as live for this long (it should not exist). */
const UNPARSEABLE_GRACE_MS = 5_000;
const TMP_STALE_MS = 60_000;
const MAX_ROUNDS = 200;

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
  /** Hard-link primitive (tests inject failures to exercise the O_EXCL fallback). */
  link: (existing: string, target: string) => void;
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
  link: linkSync,
};

export interface Lock {
  /** Tombstones our generation file (pid 0) if it still has our token; a no-op once the lock was lost. */
  release(): void;
  /** Refreshes the lock's mtime. False when the lock now belongs to someone else. */
  touch(): boolean;
  /** Fence check (no mtime write): false when we no longer hold the lock. */
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

const genPath = (base: string, gen: number): string => (gen === 0 ? base : `${base}.${gen}`);

/** Existing generations, ascending. Throws when the directory cannot be listed. */
function scan(base: string): number[] {
  const dir = dirname(base);
  const name = basename(base);
  const gens: number[] = [];
  for (const f of readdirSync(dir)) {
    if (f === name) gens.push(0);
    else if (f.startsWith(`${name}.`)) {
      const rest = f.slice(name.length + 1);
      if (/^\d{1,15}$/.test(rest)) gens.push(Number(rest));
    }
  }
  return gens.sort((a, b) => a - b);
}

/**
 * Creates `target` with `content`, exclusively; false when it exists. Hard-links a complete temp
 * file into place; any link error other than EEXIST falls back to O_EXCL + write + fsync.
 */
function createExclusive(target: string, content: string, d: LockDeps): boolean {
  const tmp = `${target.replace(/\.\d+$/, "")}.tmp-${randomBytes(6).toString("hex")}`;
  let linkErr: unknown;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    d.link(tmp, target);
    return true;
  } catch (e) {
    linkErr = e;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Windows EPERM/EBUSY after a successful link must not fail a won lock
    }
  }
  if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") return false;
  let fd: number;
  try {
    fd = openSync(target, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      rmSync(target, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
  closeSync(fd);
  return true;
}

/** Owner cleanup: lower generations and stale temp files. Best effort. */
function cleanup(base: string, mine: number, d: LockDeps): void {
  try {
    for (const g of scan(base)) {
      if (g < mine) {
        try {
          rmSync(genPath(base, g), { force: true });
        } catch {
          // ignore
        }
      }
    }
    const dir = dirname(base);
    const prefix = `${basename(base)}.tmp-`;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      try {
        if (d.now() - statSync(join(dir, f)).mtimeMs > TMP_STALE_MS)
          rmSync(join(dir, f), { force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function makeLock(base: string, gen: number, token: string, content: string, d: LockDeps): Lock {
  const mine = genPath(base, gen);
  let released = false;
  let lost = false;
  const higherExists = (): boolean | undefined => {
    try {
      const g = scan(base);
      return g.length > 0 && g[g.length - 1]! > gen;
    } catch {
      return undefined; // cannot list: transient
    }
  };
  const check = (write: boolean): boolean => {
    if (released) return false;
    if (lost) return false;
    const fail = (): boolean => {
      lost = true;
      held.delete(mine);
      return false;
    };
    const higher = higherExists();
    if (higher === true) return fail();
    const r = readRaw(mine);
    if (!r.ok) {
      if (r.code !== "ENOENT") return true; // transient (sharing violation, EPERM): try again later
      if (higher === undefined) return true;
      try {
        if (createExclusive(mine, content, d)) return true; // someone removed it; ours again
      } catch {
        return true;
      }
      const again = readRaw(mine);
      if (!again.ok) return true;
      const info = parseInfo(again.text);
      return !info || info.token === token ? true : fail();
    }
    const info = parseInfo(r.text);
    if (info && info.token !== token) return fail();
    if (write) {
      try {
        const t = new Date();
        utimesSync(mine, t, t);
      } catch {
        // best effort; the next tick tries again
      }
    }
    return true;
  };
  return {
    release: () => {
      if (released) return;
      released = true;
      held.delete(mine);
      if (lost) return;
      const r = readRaw(mine);
      if (!r.ok || parseInfo(r.text)?.token !== token) return;
      // Tombstone, not delete: generation numbers must never be reused, or a late starter that
      // judged an older generation stale could create the number a fresh holder just vacated.
      const tmp = `${base}.tmp-${randomBytes(6).toString("hex")}`;
      try {
        writeFileSync(tmp, JSON.stringify({ pid: 0, token }), { mode: 0o600, flag: "wx" });
        renameSync(tmp, mine);
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // ignore
        }
      }
    },
    touch: () => check(true),
    verify: () => check(false),
  };
}

/**
 * Takes the single-instance lock; undefined when a live daemon already holds it (or contention
 * did not settle within MAX_ROUNDS).
 */
export function acquireLock(path: string, deps: Partial<LockDeps> = {}): Lock | undefined {
  const d: LockDeps = { ...realDeps, ...deps };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const gens = scan(path);
    const top = gens.length ? gens[gens.length - 1]! : -1;
    if (top >= 0) {
      const topPath = genPath(path, top);
      const cur = readRaw(topPath);
      if (!cur.ok) {
        if (cur.code !== "ENOENT") sleepSync(5 + Math.floor(Math.random() * 20));
        continue; // vanished between scan and read, or transiently unreadable
      }
      if (isLive(topPath, cur.text, d)) return undefined;
    }
    const gen = top + 1 || 1; // none -> 1; legacy 0 -> 1
    const token = randomBytes(8).toString("hex");
    const info: LockInfo = { pid: process.pid, boot: Math.round(d.bootMs()), token };
    const start = d.procStart(process.pid);
    if (start !== undefined) info.start = start;
    const content = JSON.stringify(info);
    if (!createExclusive(genPath(path, gen), content, d)) continue; // lost the race: judge again
    held.add(genPath(path, gen));
    cleanup(path, gen, d);
    return makeLock(path, gen, token, content, d);
  }
  return undefined;
}
