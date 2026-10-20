import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  chmodSync,
  lstatSync,
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
/** A lock file is a few dozen bytes; anything at or above this is foreign. */
const MAX_LOCK_BYTES = 4096;
/** Highest generation we will create; planting one at or above it makes starting fail loudly. */
const MAX_GEN = 10 ** 15 - 1;

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

/**
 * Reads a lock file. Only a regular file under MAX_LOCK_BYTES is read (lstat, so a symlink is never
 * followed and a FIFO is never opened); anything else yields code ENOTREG. A current holder is never
 * such a file, so the starter treats it as stale; touch/verify treat it as transient.
 */
function readRaw(path: string): Raw {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size >= MAX_LOCK_BYTES) return { ok: false, code: "ENOTREG" };
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

interface GenEntry {
  gen: number;
  path: string;
}

/**
 * Existing generations, ascending. Any digit-suffixed name counts (however long, or with leading
 * zeros) so an existing file is never invisible to the fence. Throws when the directory cannot be
 * listed.
 */
function scan(base: string): GenEntry[] {
  const dir = dirname(base);
  const name = basename(base);
  const gens: GenEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (f === name) gens.push({ gen: 0, path: base });
    else if (f.startsWith(`${name}.`)) {
      const rest = f.slice(name.length + 1);
      if (/^\d+$/.test(rest)) gens.push({ gen: Number(rest), path: join(dir, f) });
    }
  }
  return gens.sort((a, b) => a.gen - b.gen);
}

/** Tombstones (pid 0) a generation file we created, keeping its number taken. Best effort. */
function tombstone(base: string, file: string, token: string): void {
  const tmp = `${base}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: 0, token }), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
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
      if (g.gen < mine) {
        try {
          rmSync(g.path, { force: true });
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
      return g.length > 0 && g[g.length - 1]!.gen > gen;
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
        if (createExclusive(mine, content, d)) {
          // Ours again, unless a takeover happened meanwhile (we may have slept through it).
          if (higherExists() === true) {
            tombstone(base, mine, token);
            return fail();
          }
          return true;
        }
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
      tombstone(base, mine, token);
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
  ensurePrivateDir(dirname(path));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const gens = scan(path);
    const topEntry = gens.length ? gens[gens.length - 1]! : undefined;
    const top = topEntry ? topEntry.gen : -1;
    if (top >= MAX_GEN) {
      throw new Error(
        `lock generation ${top} in ${dirname(path)} is out of range; remove the stray ${basename(path)}.* files`,
      );
    }
    if (topEntry) {
      const cur = readRaw(topEntry.path);
      if (!cur.ok) {
        if (cur.code === "ENOTREG") {
          // symlink, FIFO, directory or oversized: never a live holder, never read; take over
        } else {
          if (cur.code !== "ENOENT") sleepSync(5 + Math.floor(Math.random() * 20));
          continue; // vanished between scan and read, or transiently unreadable
        }
      } else if (isLive(topEntry.path, cur.text, d)) return undefined;
    }
    const gen = top + 1 || 1; // none -> 1; legacy 0 -> 1
    const token = randomBytes(8).toString("hex");
    const info: LockInfo = { pid: process.pid, boot: Math.round(d.bootMs()), token };
    const start = d.procStart(process.pid);
    if (start !== undefined) info.start = start;
    const content = JSON.stringify(info);
    const mine = genPath(path, gen);
    if (!createExclusive(mine, content, d)) continue; // lost the race: judge again
    try {
      const after = scan(path);
      if (after.length > 0 && after[after.length - 1]!.gen > gen) {
        // A later starter took a higher generation while we were stalled: we never held it.
        tombstone(path, mine, token);
        continue;
      }
    } catch {
      // cannot list: the fence (verify) will catch it
    }
    held.add(mine);
    cleanup(path, gen, d);
    return makeLock(path, gen, token, content, d);
  }
  return undefined;
}

/** Creates the lock directory user-only; on POSIX refuses a symlink or a foreign owner, tightens loose modes. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`lock directory ${dir} is not a plain directory`);
  if (st.uid !== process.getuid())
    throw new Error(`lock directory ${dir} is owned by another user`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}
