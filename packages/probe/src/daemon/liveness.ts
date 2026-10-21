// Liveness component (R1.7): notices a Claude Code process that died without a SessionEnd.
//
// The hook reports a pid with each SessionStart (a `liveness` envelope {pid, alive: true}). This
// component keeps a registry of those pids, checks them every 10 s with process.kill(pid, 0), and
// queues a `liveness` envelope {pid, alive: false} in the daemon outbox when one is gone. The
// provenance of findParentPID and isShellProcess is in proc-info.ts, that of cleanupSamePID at
// afterTracked. Nothing here runs inside a hook.
//
// Rules that keep a wrong "died" from ever being sent:
//  - A pid is watched only when it is confirmed to be the Claude process: the reported pid, or the
//    first live non-shell ancestor found by walking up from a shell, and in both cases the process
//    must be alive and not younger than the hook's envelope. A sessions file
//    ~/.claude/sessions/<pid>.json naming this session confirms that pid further (no probation);
//    a sessions-file pid is never accepted on its own word when it differs from the process path.
//    Anything else stays "unconfirmed" and is never reported dead.
//  - A pid whose process name is not "claude" (a node shim, a node-run cli.js) is on probation
//    until the first tick that finds it alive; if it is gone by then it is dropped silently.
//  - Pid reuse: Linux compares /proc starttime every tick; Windows and macOS re-read the process
//    start every RECHECK_MS whatever the sessions file says (one shared process snapshot per tick on
//    Windows). A changed machine boot time only forces that re-read at once; it is never a verdict.
//  - The 10 s check itself never waits for a child process: it is one synchronous pass of
//    process.kill probes, and start re-checks and the confirming look run outside the registry's
//    work queue, so a flood of registrations or a slow PowerShell cannot delay a death past 15 s.
//  - A death is confirmed twice (the tick, then GRACE later) so a SessionEnd that is still on its
//    way through the spool wins.
//  - When the watched pid differs from the one the hook reported, an alive:true correction is
//    queued first, because the hub reducer ignores alive:false for a pid other than the one on
//    record (packages/contract/src/state.ts reduceLiveness).
//  - A session retired because a new session_id appeared on its pid (/clear, --resume) gets no
//    envelope: the process is alive, and the hub's supersedeSamePid ends the old one when the new
//    session's alive:true arrives. alive:false would wrongly say "pid_gone" for a live process.
import type { Envelope } from "@sessiondeck/contract";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import { buildEnvelope } from "../envelope.ts";
import { writeFileAtomic } from "../install/atomic.ts";
import type { SpoolLine } from "../spool-format.ts";
import {
  defaultProcLookup,
  findParent,
  isShellProcess,
  pidAlive,
  ProcTableUnreadable,
  type ProcInfo,
  type ProcLookup,
} from "./proc-info.ts";
import { SessionsReader, sessionsDir, type SessionFile } from "./sessions-file.ts";
import type { ComponentContext, DaemonComponent, Logger } from "./types.ts";

export const TICK_MS = 10_000;
/** Second look at a death, after the tick that saw it. TICK_MS + GRACE_MS stays under the 15 s budget. */
export const GRACE_MS = 1_500;
const UNCONFIRMED_KEEP_MS = 10 * 60 * 1000;
const FINISHED_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A procStart mismatch in the sessions file must repeat on this many ticks before it counts. */
const FILE_MISMATCH_TICKS = 2;
/** Registry cap; the oldest entry that is not tracking is evicted first. */
export const MAX_ENTRIES = 256;
const MAX_DISCOVERED = 1024;
/** stop() waits at most this long for queued work. */
const STOP_WAIT_MS = 3000;
const DISCOVERED_KEEP_MS = 10 * 60 * 1000;
/** Registration lines waiting in the queue; the excess is parked (MAX_PARKED_REG) and replayed. */
const MAX_PENDING_REG = 128;
/** Registrations that did not fit the queue, newest per session id; replayed as the queue drains. */
const MAX_PARKED_REG = 256;
const REG_DROP_LOG_MS = 10_000;
const MAX_SESSION_ID_CHARS = 256;
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]+$/;
/** Process lookups that start a child process: bucket of LOOKUP_BURST, one token per second. */
export const LOOKUP_BURST = 20;
export const LOOKUP_REFILL_MS = 1000;
/** A process younger than the hook's envelope by more than this cannot be the hook's ancestor. */
const START_SKEW_MS = 2000;
/** Windows and macOS: re-read a tracked pid's start at most this often. */
const RECHECK_MS = 60_000;
/** A boot time change by more than this (clock steps, uptime drift) forces a start re-check. */
const BOOT_TOLERANCE_MS = 60_000;
/** Probation is checked on the first tick that finds the entry at least this old. */
const PROBATION_MIN_MS = 2000;
const RESOLVE_RETRIES_PER_TICK = 3;
/** Ticks on which an unreadable process table (timeout, spawn error) is retried before giving up. */
const MAX_UNREADABLE_RETRIES = 6;
/** More live sessions-file pids than this for one session id is not a situation to guess about. */
const MAX_FILE_CANDIDATES = 4;

export type EntryState = "tracking" | "unconfirmed" | "ended" | "dead" | "superseded";
const ENTRY_STATES: readonly string[] = ["tracking", "unconfirmed", "ended", "dead", "superseded"];
export type PidSource = "sessions" | "process" | "walked";

export interface LivenessEntry {
  session_id: string;
  /** The pid being watched (0 while unconfirmed). */
  pid: number;
  /** The pid the hook reported (0 when found through the sessions file alone). */
  reported_pid: number;
  source?: PidSource;
  state: EntryState;
  /** Highest envelope ts applied to this entry; replays of older lines are ignored. */
  ts: number;
  /** When the entry last changed state (pruning). */
  at: number;
  /** Process start token from the OS (Linux /proc starttime, ps lstart, CIM ticks). */
  proc_start?: string;
  /** procStart from the sessions file. */
  file_start?: string;
  /** Not yet seen alive on a tick; a death now is dropped silently unless its start was verified. */
  probation?: true;
  /** The process start was read and was not younger than the hook line, or a correction went out. */
  start_ok?: true;
  /** Process name when adopted (eviction prefers names other than "claude"). */
  name?: string;
  /** A process lookup was rate-limited while resolving; the tick resolves again. */
  retry?: true;
  /** The boot time moved: read the OS start again at the next opportunity (never a verdict). */
  recheck?: true;
}

interface LivenessState {
  v: 1;
  /** Boot time (epoch ms) when this was written. */
  boot?: number;
  sessions: Record<string, LivenessEntry>;
}

export interface LivenessStore {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
}

export function fileStore(statePath: string): LivenessStore {
  return {
    async load() {
      try {
        return await readFile(statePath, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    save: (text) => writeFileAtomic(statePath, text, { mode: 0o600 }),
  };
}

export interface LivenessOptions {
  /** Where the registry persists, e.g. `<home>/daemon/liveness.json`. Ignored when `store` is set. */
  statePath?: string;
  store?: LivenessStore;
  enqueue?: (line: SpoolLine) => void;
  host?: string;
  log?: Logger;
  /** Flushes the outbox to disk; defaults to `enqueue.sync` when the outbox provides one. */
  syncOutbox?: () => void;
  now?: () => number;
  /** Test seam for process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  procs?: ProcLookup;
  sessionsDir?: string;
  tickMs?: number;
  graceMs?: number;
  /** Test seam for the boot time in epoch ms (default: now minus os.uptime()). */
  bootTime?: () => number;
}

function liveFileStart(f: SessionFile | undefined): string | undefined {
  return f?.procStart;
}

export class LivenessMonitor implements DaemonComponent {
  readonly name = "liveness";
  private entries = new Map<string, LivenessEntry>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private graceTimers = new Set<NodeJS.Timeout>();
  private dying = new Set<string>();
  private fileMismatch = new Map<string, number>();
  /** session_id -> time of the last discovery attempt. */
  private discovered = new Map<string, number>();
  private lastLookup = new Map<string, number>();
  /** Set by processCandidate when the process table could not be read; read and cleared by resolve. */
  private unreadableNow = false;
  /** session_id -> resolves that failed because the process table was unreadable. */
  private unreadable = new Map<string, number>();
  private fileCache: { at: number; files: SessionFile[] } | undefined;
  private inflight = 0;
  private pendingReg = 0;
  private parkedReg = new Map<string, { pid: number; ts: number }>();
  private lastRegDropLog = -Infinity;
  private bg = new Set<Promise<unknown>>();
  private rechecking = false;
  private maintainQueued = false;
  private dirty = false;
  private bootMs = 0;
  private tokens = LOOKUP_BURST;
  private tokenAt = 0;
  private dropped = 0;
  private warned = new Set<string>();
  private loaded = false;
  private stopped = false;
  /** Set when stop() gave up waiting: work still queued behind the hung task is skipped. */
  private abandoned = false;
  /** SessionEnd lines seen but not yet applied (the work queue may be behind); newest ts per session. */
  private pendingEnd = new Map<string, number>();
  private enqueue: (line: SpoolLine) => void;
  private host: string;
  private log: Logger;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly procs: ProcLookup;
  private readonly store: LivenessStore;
  private reader: SessionsReader;
  /** Counters for harnesses and logs. */
  readonly stats = {
    registered: 0,
    deaths: 0,
    corrections: 0,
    superseded: 0,
    lookups: 0,
    throttled: 0,
    regDropped: 0,
    regReplayed: 0,
    evictedTracking: 0,
    capRefused: 0,
  };

  private readonly o: LivenessOptions;

  constructor(o: LivenessOptions = {}) {
    this.o = o;
    this.enqueue =
      o.enqueue ??
      ((): void => {
        throw new Error("liveness monitor has no outbox");
      });
    this.host = o.host ?? "unknown";
    this.log = o.log ?? ((): void => undefined);
    this.now = o.now ?? Date.now;
    this.isAlive = o.isAlive ?? pidAlive;
    this.procs = o.procs ?? defaultProcLookup(undefined, (m) => this.log("warn", `liveness: ${m}`));
    this.store =
      o.store ??
      fileStore(
        o.statePath ??
          (() => {
            throw new Error("liveness monitor needs statePath or store");
          })(),
      );
    this.reader = new SessionsReader(o.sessionsDir ?? sessionsDir(), this.log);
  }

  // --- DaemonComponent ---

  async start(ctx?: ComponentContext): Promise<void> {
    if (ctx) {
      this.enqueue = ctx.enqueue;
      this.host = ctx.host;
      this.log = ctx.log;
      this.reader = new SessionsReader(this.o.sessionsDir ?? sessionsDir(), this.log);
    }
    this.stopped = false;
    this.abandoned = false;
    if (this.timer) clearInterval(this.timer);
    await this.run(() => this.load());
    // A pid that died while the daemon was down is found by this first tick.
    this.fire(this.tick(), "tick");
    const ms = this.o.tickMs ?? TICK_MS;
    if (ms > 0) {
      this.timer = setInterval(() => this.fire(this.tick(), "tick"), ms);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of this.graceTimers) clearTimeout(t);
    this.graceTimers.clear();
    this.dying.clear();
    // Wait for queued work, but never for a hung one: a daemon shutdown must not hang on a lookup.
    let cap: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([this.chain, ...this.bg]),
      new Promise<void>((r) => {
        cap = setTimeout(r, STOP_WAIT_MS);
        cap.unref();
      }),
    ]);
    clearTimeout(cap);
    if (this.inflight > 0) this.abandoned = true;
    this.pendingEnd.clear();
  }

  /** Hook-spool envelope tap (at-least-once; every handler here is idempotent by ts). */
  onSpoolLine(env: Envelope): void {
    const sid = env.session_id;
    if (!sid || !validSessionId(sid)) {
      if (sid)
        this.warnOnce("sid", `ignoring a spool line with an invalid session id ${shown(sid)}`);
      return;
    }
    if (env.kind === "liveness") {
      const p = (typeof env.payload === "object" && env.payload !== null ? env.payload : {}) as {
        pid?: unknown;
        alive?: unknown;
      };
      if (p.alive === true && Number.isInteger(p.pid) && (p.pid as number) > 0) {
        if (this.pendingReg >= MAX_PENDING_REG) {
          this.park(sid, p.pid as number, env.ts);
          return;
        }
        this.startRegistration(sid, p.pid as number, env.ts);
      }
      return;
    }
    if (env.kind !== "hook") return;
    if (env.hook_event_name === "SessionEnd") {
      // Noted before the queue so a death grace timer firing while this waits sees the end.
      this.pendingEnd.set(sid, Math.max(env.ts, this.pendingEnd.get(sid) ?? env.ts));
      this.fire(this.endSession(sid, env.ts), "SessionEnd");
    } else {
      this.fire(this.discover(sid, env.ts), "discover");
    }
  }

  private startRegistration(sid: string, pid: number, ts: number): void {
    this.pendingReg += 1;
    this.fire(
      this.registerSession(sid, pid, ts).finally(() => {
        this.pendingReg -= 1;
        this.replayParked();
      }),
      "register",
    );
  }

  /** The queue is full: keep the newest (pid, ts) per session id and replay it when room appears. */
  private park(sid: string, pid: number, ts: number): void {
    this.stats.regDropped += 1;
    const prev = this.parkedReg.get(sid);
    if (prev === undefined || ts >= prev.ts) {
      this.parkedReg.delete(sid);
      this.parkedReg.set(sid, { pid, ts });
      if (this.parkedReg.size > MAX_PARKED_REG) {
        const oldest = this.parkedReg.keys().next().value;
        if (oldest !== undefined) this.parkedReg.delete(oldest);
      }
    }
    const now = this.now();
    if (now - this.lastRegDropLog >= REG_DROP_LOG_MS) {
      this.lastRegDropLog = now;
      this.log(
        "warn",
        `liveness: registration queue is full; ${this.stats.regDropped} parked so far, replayed as it drains`,
      );
    }
  }

  private replayParked(): void {
    while (this.pendingReg < MAX_PENDING_REG && this.parkedReg.size > 0) {
      const first = this.parkedReg.entries().next().value;
      if (first === undefined) return;
      this.parkedReg.delete(first[0]);
      this.stats.regReplayed += 1;
      this.startRegistration(first[0], first[1].pid, first[1].ts);
    }
  }

  private fire(p: Promise<unknown>, what: string): void {
    const q = p.catch((e: unknown) =>
      this.log("error", `liveness ${what}: ${e instanceof Error ? e.message : String(e)}`),
    );
    this.bg.add(q);
    void q.finally(() => this.bg.delete(q));
  }

  /** Persists the registry after work done outside the work queue. */
  private flushSoon(): void {
    this.dirty = true;
    this.fire(
      this.run(() => Promise.resolve()),
      "flush",
    );
  }

  /**
   * Serializes registry work. While tasks are queued back to back they share one sessions-dir read
   * and one state write; both happen again as soon as the queue goes idle.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight += 1;
    const exec = async (): Promise<T> => {
      try {
        if (this.abandoned) return undefined as T; // stop() has returned: nothing new starts
        return await fn();
      } finally {
        this.inflight -= 1;
        if (this.inflight === 0) {
          this.fileCache = undefined;
          if (this.dirty) {
            this.dirty = false;
            try {
              await this.persist();
            } catch (e) {
              this.log("error", `liveness state write failed: ${(e as Error).message}`);
            }
          }
        }
      }
    };
    const next = this.chain.then(exec, exec);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log("warn", `liveness: ${msg}`);
  }

  /** One sessions-dir read shared by everything queued back to back (see run). */
  private files(): SessionFile[] {
    const now = this.now();
    if (this.fileCache === undefined || now - this.fileCache.at > 2000) {
      this.fileCache = { at: now, files: this.reader.readAll() };
    }
    return this.fileCache.files;
  }

  /** Rate-limited process lookup; undefined also when the bucket is empty (this.dropped counts it). */
  private takeToken(): boolean {
    const now = this.now();
    if (this.tokenAt === 0) this.tokenAt = now;
    const refill = Math.floor((now - this.tokenAt) / LOOKUP_REFILL_MS);
    if (refill > 0) {
      this.tokens = Math.min(LOOKUP_BURST, this.tokens + refill);
      this.tokenAt += refill * LOOKUP_REFILL_MS;
    }
    if (this.tokens <= 0) {
      this.dropped += 1;
      this.stats.throttled += 1;
      this.warnOnce("lookups", "process lookups are rate-limited; dropping the excess");
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private gated(): Pick<ProcLookup, "lookup" | "ancestry"> {
    const p = this.procs;
    if (p.spawns !== true) return p;
    const wrap =
      <A, R>(fn: (a: A) => Promise<R>, empty: R) =>
      (a: A): Promise<R> => {
        if (!this.takeToken()) return Promise.resolve(empty);
        this.stats.lookups += 1;
        return fn(a);
      };
    const ancestry = p.ancestry?.bind(p);
    return {
      lookup: wrap((pid: number) => p.lookup(pid), undefined),
      ...(ancestry
        ? {
            ancestry: (pid: number, notBefore?: number): Promise<ProcInfo[]> =>
              wrap((a: number) => ancestry(a, notBefore), [] as ProcInfo[])(pid),
          }
        : {}),
    };
  }

  // --- registry ---

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.bootMs = (this.o.bootTime ?? ((): number => Date.now() - uptime() * 1000))();
    let text: string | undefined;
    try {
      text = await this.store.load();
    } catch (e) {
      this.log("error", `liveness state unreadable: ${(e as Error).message}; starting empty`);
      return;
    }
    if (text === undefined) return;
    try {
      const s = JSON.parse(text) as Partial<LivenessState>;
      if (s.v !== 1 || typeof s.sessions !== "object" || s.sessions === null)
        throw new Error("shape");
      const good: LivenessEntry[] = [];
      for (const [k, raw] of Object.entries(s.sessions)) {
        const e = sanitizeEntry(k, raw);
        if (e !== undefined) good.push(e);
      }
      good.sort((a, b) => b.at - a.at); // newest first; the cap keeps the newest
      if (good.length > MAX_ENTRIES) {
        this.log("warn", `liveness: state held ${good.length} entries; keeping the newest`);
        good.length = MAX_ENTRIES;
      }
      for (const e of good) this.entries.set(e.session_id, e);
      // A boot time that moved is either a reboot or a wall-clock step (the boot time is now minus
      // uptime). Linux compares /proc starttime every check, which settles it. Elsewhere it forces
      // an OS start re-check at the next check; the verdict is the OS's, never the clock's.
      if (
        typeof s.boot === "number" &&
        Math.abs(s.boot - this.bootMs) > BOOT_TOLERANCE_MS &&
        this.procs.cheapStart === undefined
      ) {
        for (const e of this.entries.values()) {
          if (e.state === "tracking") e.recheck = true;
        }
        this.dirty = true;
      }
    } catch {
      this.log("error", "liveness state corrupt; starting empty");
    }
  }

  private async persist(): Promise<void> {
    const sessions: Record<string, LivenessEntry> = {};
    for (const [k, e] of this.entries) sessions[k] = e;
    await this.store.save(
      JSON.stringify({ v: 1, boot: this.bootMs, sessions } satisfies LivenessState),
    );
  }

  private emit(sid: string, pid: number, alive: boolean): void {
    this.enqueue(
      buildEnvelope({
        kind: "liveness",
        host: this.host,
        payload: { pid, alive },
        session_id: sid,
        ts: this.now(),
      }),
    );
    const sync = this.o.syncOutbox ?? (this.enqueue as { sync?: () => void }).sync;
    sync?.();
  }

  /**
   * Room for one more entry. When the registry is full the oldest entry that is not tracking goes;
   * with none, the tracking entry least likely to be a real claude goes (a name other than
   * "claude", then one no sessions file confirms, then the oldest), and that is counted and logged.
   */
  private admit(sid: string): boolean {
    if (this.entries.has(sid) || this.entries.size < MAX_ENTRIES) return true;
    let victim: LivenessEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.state !== "tracking" && (victim === undefined || e.at < victim.at)) victim = e;
    }
    if (victim === undefined) {
      const rank = (e: LivenessEntry): number =>
        (e.name === "claude" ? 2 : 0) + (e.source === "sessions" ? 1 : 0);
      for (const e of this.entries.values()) {
        if (victim === undefined) victim = e;
        else if (rank(e) < rank(victim) || (rank(e) === rank(victim) && e.at < victim.at))
          victim = e;
      }
      if (victim === undefined) {
        this.stats.capRefused += 1;
        this.warnOnce("cap", `registry is full of ${MAX_ENTRIES} entries; refusing new ones`);
        return false;
      }
      this.stats.evictedTracking += 1;
      this.log(
        "warn",
        `liveness: registry full; no longer watching ${shown(victim.session_id)} (pid ${victim.pid}) to admit ${shown(sid)}`,
      );
    }
    this.entries.delete(victim.session_id);
    this.lastLookup.delete(victim.session_id);
    this.unreadable.delete(victim.session_id);
    this.fileMismatch.delete(victim.session_id);
    return true;
  }

  /** Public for tests and harnesses: registers a reported pid for a session. */
  registerSession(sid: string, reportedPid: number, ts: number): Promise<void> {
    if (!validSessionId(sid)) return Promise.resolve();
    return this.run(async () => {
      await this.load();
      const prev = this.entries.get(sid);
      if (prev && ts <= prev.ts) return; // replay of a line already applied
      if (
        prev?.state === "tracking" &&
        prev.reported_pid === reportedPid &&
        this.isAlive(prev.pid)
      ) {
        prev.ts = ts; // same session announced again by the same process
        this.dirty = true;
        return;
      }
      const now = this.now();
      if (
        prev?.state === "unconfirmed" &&
        prev.reported_pid === reportedPid &&
        prev.retry !== true &&
        now - prev.at < TICK_MS
      ) {
        prev.ts = ts; // a repeat of a registration that was just tried: do not look the pid up again
        this.dirty = true;
        return;
      }
      if (!this.admit(sid)) return;
      const e: LivenessEntry = {
        session_id: sid,
        pid: 0,
        reported_pid: reportedPid,
        state: "unconfirmed",
        ts,
        at: now,
      };
      this.unreadable.delete(sid); // a new entry starts its retries from zero
      await this.resolve(e, ts);
      this.entries.set(sid, e);
      this.afterTracked(e);
      this.dirty = true;
    });
  }

  /** The process path: the reported pid, or the live non-shell ancestor of a reported shell. */
  private async processCandidate(
    reported: number,
    ts: number,
  ): Promise<{ info: ProcInfo; walked: boolean } | undefined> {
    if (reported <= 0) return undefined;
    let info: ProcInfo | undefined;
    try {
      info = await findParent(reported, this.gated(), this.isAlive, ts);
    } catch (e) {
      if (!(e instanceof ProcTableUnreadable)) throw e;
      this.unreadableNow = true; // unknown, not a negative: resolve() schedules a retry
      return undefined;
    }
    if (info === undefined) return undefined;
    if (info.startMs !== undefined && info.startMs > ts + START_SKEW_MS) {
      this.log("info", `liveness: pid ${info.pid} started after the hook line; not claude`);
      return undefined;
    }
    return { info, walked: info.pid !== reported };
  }

  /**
   * A sessions-file pid with no process-path anchor: alive, not a shell, not younger than the hook
   * line. A file whose procStart equals the OS start of its pid is preferred over one that does not
   * (a crashed run's file whose pid went to a long-running process). When several files still
   * qualify, the one with the strictly newest startedAt wins; with no such winner nothing is taken.
   */
  private async fileCandidate(files: SessionFile[], ts: number): Promise<ProcInfo | undefined> {
    const live = files.filter((x) => this.isAlive(x.pid));
    if (live.length > MAX_FILE_CANDIDATES) return undefined;
    const found: { f: SessionFile; info: ProcInfo }[] = [];
    for (const f of live) {
      const info = await this.gated().lookup(f.pid);
      if (info === undefined || isShellProcess(info.name)) continue;
      if (info.startMs !== undefined && info.startMs > ts + START_SKEW_MS) continue;
      found.push({ f, info });
    }
    let pool = found;
    const matching = found.filter(
      (c) => c.f.procStart !== undefined && c.info.start === c.f.procStart,
    );
    if (matching.length > 0) pool = matching;
    if (pool.length <= 1) return pool[0]?.info;
    const at = pool.map((c) => startedAtMs(c.f));
    if (at.some((v) => v === undefined)) return this.ambiguous();
    const max = Math.max(...(at as number[]));
    const top = pool.filter((_, i) => at[i] === max);
    return top.length === 1 ? top[0]?.info : this.ambiguous();
  }

  private ambiguous(): undefined {
    this.warnOnce("ambiguous", "several sessions files qualify for one session; watching none");
    return undefined;
  }

  private adopt(
    e: LivenessEntry,
    info: ProcInfo,
    source: PidSource,
    file: SessionFile | undefined,
  ): void {
    e.pid = info.pid;
    e.source = source;
    e.state = "tracking";
    delete e.retry;
    const start = this.procs.cheapStart?.(info.pid) ?? info.start;
    if (start !== undefined) e.proc_start = start;
    e.name = info.name;
    if (info.startMs !== undefined) e.start_ok = true; // not younger than the hook line (checked by the caller)
    if (this.procs.cheapStart === undefined && info.start !== undefined) {
      this.lastLookup.set(e.session_id, this.now()); // just read: the first re-check is a RECHECK_MS away
    }
    if (file?.procStart !== undefined) e.file_start = file.procStart;
    if (file === undefined && info.name !== "claude") e.probation = true;
  }

  /**
   * Decide which pid to watch for e. The process path decides (the reported pid when it is not a
   * shell, else the live non-shell ancestor); a sessions file naming this session on that same pid
   * confirms it. A sessions-file pid that differs from the process path is never taken: it may be a
   * crashed run's stale file, or a reused pid. Leaves e unconfirmed when nothing confirms.
   */
  private async resolve(e: LivenessEntry, ts: number): Promise<void> {
    delete e.retry;
    const mine = this.files().filter((f) => f.sessionId === e.session_id);
    const before = this.dropped;
    this.unreadableNow = false;
    const c = await this.processCandidate(e.reported_pid, ts);
    const unreadable = this.unreadableNow;
    this.unreadableNow = false;
    if (c !== undefined) {
      this.unreadable.delete(e.session_id);
      const file = mine.find((f) => f.pid === c.info.pid);
      this.adopt(e, c.info, file ? "sessions" : c.walked ? "walked" : "process", file);
      return;
    }
    if (this.dropped > before) {
      e.retry = true; // not "dead": the lookup was rate-limited, try again on a tick
      return;
    }
    if (unreadable) {
      // The snapshot timed out or failed (a cold PowerShell on a loaded box): the pid was never
      // judged. Keep it as the candidate and look again on the next ticks, a bounded number of times.
      const n = (this.unreadable.get(e.session_id) ?? 0) + 1;
      this.unreadable.set(e.session_id, n);
      if (n <= MAX_UNREADABLE_RETRIES) {
        e.retry = true;
        this.log(
          "warn",
          `liveness: process table unreadable for ${shown(e.session_id)} (pid ${e.reported_pid}); retrying (${n}/${MAX_UNREADABLE_RETRIES})`,
        );
        return;
      }
      this.unreadable.delete(e.session_id);
    }
    if (e.reported_pid <= 0) return;
    this.log(
      "info",
      `liveness: pid ${e.reported_pid} of ${shown(e.session_id)} not confirmed as claude`,
    );
  }

  /**
   * cleanupSamePID and the alive:true correction, for an entry that just became tracked.
   *
   * Provenance: the behaviour (a /clear or --resume puts a new session_id under the same pid with
   * no SessionEnd for the old one, so the old one is retired) follows ccmonitor
   *   Source repo: https://github.com/martinwickman/ccmonitor, commit 88f7d1adfbff82a790fbb37346cc70d276548f5c
   *   Path:        internal/hook/hook.go (cleanupSamePID)
   *   License:     MIT, Copyright (c) 2026 Martin Wickman
   * as described in docs/planning/01-architecture.md section 3.2. The Go source of this function
   * was not opened, so no code is copied; the implementation is original.
   *   Changes from the described behaviour: nothing is deleted on disk (there are no per-session
   *   files here); the old entry is marked superseded and no envelope is sent, because the process
   *   is alive and the hub's supersedeSamePid ends the old session on the new one's alive:true.
   */
  private afterTracked(e: LivenessEntry): void {
    if (e.state !== "tracking") return;
    this.stats.registered += 1;
    for (const o of this.entries.values()) {
      if (o.session_id !== e.session_id && o.pid === e.pid && o.state === "tracking") {
        o.state = "superseded";
        o.at = this.now();
        this.stats.superseded += 1;
      }
    }
    if (e.pid !== e.reported_pid) {
      this.emit(e.session_id, e.pid, true);
      this.stats.corrections += 1;
    }
  }

  /**
   * A hook event for a session this daemon never saw register (daemon started mid-session, or the
   * hook ran before claude wrote its sessions file). Retried on later hook lines, at most once per
   * tick interval per session id.
   */
  private discover(sid: string, ts: number): Promise<void> {
    if (this.entries.has(sid)) return Promise.resolve();
    const now = this.now();
    const last = this.discovered.get(sid);
    if (last !== undefined && now - last < (this.o.tickMs ?? TICK_MS)) return Promise.resolve();
    this.discovered.delete(sid);
    this.discovered.set(sid, now);
    if (this.discovered.size > MAX_DISCOVERED) {
      const oldest = this.discovered.keys().next().value;
      if (oldest !== undefined) this.discovered.delete(oldest);
    }
    return this.run(async () => {
      await this.load();
      if (this.entries.has(sid)) return;
      const mine = this.files().filter((x) => x.sessionId === sid);
      const info = await this.fileCandidate(mine, ts);
      if (info === undefined || !this.admit(sid)) return;
      const e: LivenessEntry = {
        session_id: sid,
        pid: 0,
        reported_pid: 0,
        state: "unconfirmed",
        ts,
        at: this.now(),
      };
      this.adopt(
        e,
        info,
        "sessions",
        mine.find((f) => f.pid === info.pid),
      );
      this.entries.set(sid, e);
      this.discovered.delete(sid);
      this.afterTracked(e);
      this.dirty = true;
    });
  }

  endSession(sid: string, ts: number): Promise<void> {
    return this.run(async () => {
      try {
        await this.endNow(sid, ts);
      } finally {
        if (this.pendingEnd.get(sid) === ts) this.pendingEnd.delete(sid);
      }
    });
  }

  private async endNow(sid: string, ts: number): Promise<void> {
    await this.load();
    const e = this.entries.get(sid);
    if (!e || ts < e.ts) return;
    if (e.state === "ended") return;
    this.unreadable.delete(sid);
    e.state = "ended";
    e.ts = ts;
    e.at = this.now();
    this.dirty = true;
  }

  // --- the check ---

  /**
   * Synchronous verdict from what is free every tick: kill(pid, 0), the Linux /proc start, and a
   * repeated procStart change in Claude's own sessions file. Never starts a process.
   */
  private goneNow(e: LivenessEntry): boolean {
    if (!this.isAlive(e.pid)) return true;
    const cheap = this.procs.cheapStart;
    if (e.proc_start !== undefined && cheap !== undefined) {
      const cur = cheap.call(this.procs, e.pid);
      if (cur !== undefined && cur !== e.proc_start) return true; // Linux: pid reused
    }
    if (e.file_start !== undefined) {
      // A file being rewritten could read oddly once, so a mismatch has to repeat.
      const cur = liveFileStart(this.reader.readPid(e.pid));
      if (cur !== undefined && cur !== e.file_start) {
        const n = (this.fileMismatch.get(e.session_id) ?? 0) + 1;
        this.fileMismatch.set(e.session_id, n);
        return n >= FILE_MISMATCH_TICKS;
      }
      this.fileMismatch.delete(e.session_id);
    }
    return false;
  }

  /**
   * Windows and macOS have no free per-tick process start, and a crashed claude leaves its sessions
   * file behind, so the file proves nothing about pid reuse: the OS start is read again every
   * RECHECK_MS, or at once when `recheck` is set, whatever the file says.
   */
  private startCheckDue(e: LivenessEntry, now: number): boolean {
    if (this.procs.cheapStart !== undefined || e.proc_start === undefined) return false;
    if (e.recheck === true) return true;
    const last = this.lastLookup.get(e.session_id);
    return last === undefined || now - last >= RECHECK_MS;
  }

  /**
   * One process read for several pids, rate-limited as one lookup (one snapshot) when the platform
   * has lookupMany, else in parallel. A pid missing from the result was not looked up (bucket empty).
   */
  private async startLookup(pids: number[]): Promise<Map<number, ProcInfo | undefined>> {
    const out = new Map<number, ProcInfo | undefined>();
    const p = this.procs;
    if (p.spawns === true && p.lookupMany !== undefined) {
      if (!this.takeToken()) return out;
      this.stats.lookups += 1;
      const m = await p.lookupMany(pids);
      if (m === undefined) return out; // the table could not be read: nothing was looked up
      for (const pid of pids) out.set(pid, m.get(pid));
      return out;
    }
    await Promise.all(
      pids.map(async (pid) => {
        if (p.spawns === true) {
          if (!this.takeToken()) return;
          this.stats.lookups += 1;
        }
        out.set(pid, await p.lookup(pid));
      }),
    );
    return out;
  }

  private scheduleDeath(e: LivenessEntry): void {
    if (this.stopped || this.dying.has(e.session_id)) return;
    this.dying.add(e.session_id);
    const t = setTimeout(() => {
      this.graceTimers.delete(t);
      this.fire(this.confirmDeath(e.session_id), "confirm");
    }, this.o.graceMs ?? GRACE_MS);
    t.unref();
    this.graceTimers.add(t);
  }

  /**
   * The synchronous half of the 10 s check, outside the work queue so nothing queued behind a slow
   * lookup can delay it: every tracking entry is probed with kill(pid, 0) and the free checks, and a
   * death gets its grace timer. Returns the entries whose OS start is due for a re-read.
   */
  private sweep(): LivenessEntry[] {
    const now = this.now();
    const due: LivenessEntry[] = [];
    for (const e of [...this.entries.values()]) {
      if (e.state !== "tracking") continue;
      // A forced re-check only means something where the OS start is read and one is recorded.
      if (
        e.recheck === true &&
        (e.proc_start === undefined || this.procs.cheapStart !== undefined)
      ) {
        delete e.recheck;
        this.dirty = true;
      }
      if (e.probation === true) {
        if (now - e.at < PROBATION_MIN_MS) continue;
        delete e.probation;
        this.dirty = true;
        // A process never confirmed to be claude (a shim, a reused pid) that is already gone is
        // dropped without a word, unless its start was verified or a correction already went to the
        // hub (which would otherwise keep that pid alive forever).
        if (!this.isAlive(e.pid) && e.start_ok !== true && e.pid === e.reported_pid) {
          e.state = "unconfirmed";
          e.pid = 0;
          e.at = now;
          this.log("info", `liveness: ${shown(e.session_id)} pid gone while on probation`);
          continue;
        }
      }
      if (this.goneNow(e)) this.scheduleDeath(e);
      else if (this.startCheckDue(e, now)) due.push(e);
    }
    return due;
  }

  /** Start re-checks for the due entries: one shared read, outside the work queue. */
  private async recheck(due: LivenessEntry[]): Promise<void> {
    if (due.length === 0 || this.rechecking) return;
    this.rechecking = true;
    try {
      const r = await this.startLookup([...new Set(due.map((e) => e.pid))]);
      const now = this.now();
      for (const e of due) {
        if (this.stopped || e.state !== "tracking" || this.entries.get(e.session_id) !== e)
          continue;
        if (!r.has(e.pid)) continue; // bucket empty: still due next tick
        this.lastLookup.set(e.session_id, now);
        if (e.recheck === true) {
          delete e.recheck;
          this.dirty = true;
        }
        const info = r.get(e.pid);
        if (info?.start !== undefined && info.start !== e.proc_start) this.scheduleDeath(e);
      }
    } finally {
      this.rechecking = false;
    }
  }

  /** One pass over the registry; the interval calls it every 10 s. */
  async tick(): Promise<void> {
    if (!this.loaded) await this.run(() => this.load());
    if (this.stopped) return;
    const due = this.sweep();
    const parts: Promise<unknown>[] = [];
    if (due.length > 0) parts.push(this.recheck(due));
    if (!this.maintainQueued) {
      this.maintainQueued = true;
      parts.push(
        this.run(() => {
          this.maintainQueued = false;
          return this.maintain();
        }),
      );
    }
    await Promise.all(parts);
  }

  /** The slow half of the check, on the work queue: unconfirmed entries, pruning, bookkeeping. */
  private async maintain(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    let changed = false;
    let retries = 0;
    let unreadableHit = false; // one unreadable snapshot per pass: the rest wait for the next tick
    for (const [sid, at] of this.discovered) {
      if (now - at > DISCOVERED_KEEP_MS) this.discovered.delete(sid);
    }
    for (const e of [...this.entries.values()]) {
      if (e.state === "unconfirmed") {
        if (e.retry === true && retries < RESOLVE_RETRIES_PER_TICK && !unreadableHit) {
          retries += 1;
          await this.resolve(e, e.ts);
          if (e.retry === true && this.unreadable.has(e.session_id)) unreadableHit = true;
          if ((e.state as EntryState) === "tracking") {
            e.at = now;
            this.afterTracked(e);
          }
          changed = true;
          continue;
        }
        const mine = this.files().filter((x) => x.sessionId === e.session_id);
        const info =
          mine.length > 0 && retries < RESOLVE_RETRIES_PER_TICK
            ? await this.fileCandidate(mine, e.ts)
            : undefined;
        if (info !== undefined) {
          retries += 1;
          this.adopt(
            e,
            info,
            "sessions",
            mine.find((f) => f.pid === info.pid),
          );
          e.at = now;
          this.afterTracked(e);
          changed = true;
        } else if (now - e.at > UNCONFIRMED_KEEP_MS) {
          e.state = "ended";
          e.at = now;
          changed = true;
        }
      } else if (e.state !== "tracking" && now - e.at > FINISHED_KEEP_MS) {
        this.entries.delete(e.session_id);
        this.lastLookup.delete(e.session_id);
        this.unreadable.delete(e.session_id);
        changed = true;
      }
    }
    if (changed) this.dirty = true;
  }

  /**
   * The second look at a death, GRACE_MS after the tick that saw it, outside the work queue. When
   * the free checks no longer say gone but a start re-check made the case, the OS start is read
   * again; if that read cannot be made (bucket empty) the entry is marked for a forced re-check on
   * the next tick rather than judged either way.
   */
  private async confirmDeath(sid: string): Promise<void> {
    this.dying.delete(sid);
    const e = this.entries.get(sid);
    if (this.stopped || !e || e.state !== "tracking") return; // SessionEnd or supersede won
    if (this.endPending(e)) return; // a SessionEnd is still queued: it wins
    let dead = this.goneNow(e);
    if (!dead && this.procs.cheapStart === undefined && e.proc_start !== undefined) {
      const r = await this.startLookup([e.pid]);
      if (this.stopped || this.entries.get(sid) !== e || e.state !== "tracking") return;
      if (this.endPending(e)) return;
      if (!r.has(e.pid)) {
        e.recheck = true;
        this.flushSoon();
      } else {
        this.lastLookup.set(sid, this.now());
        const info = r.get(e.pid);
        dead = info?.start !== undefined && info.start !== e.proc_start;
        if (!dead && !this.isAlive(e.pid)) dead = true;
      }
    }
    if (!dead) return;
    // Order: queue, flush, then record. A crash in between repeats the envelope after a restart
    // (the reducer ignores a second alive:false); it can never lose one.
    this.emit(sid, e.pid, false);
    e.state = "dead";
    e.at = this.now();
    this.stats.deaths += 1;
    this.fileMismatch.delete(sid);
    this.flushSoon();
  }

  private endPending(e: LivenessEntry): boolean {
    const t = this.pendingEnd.get(e.session_id);
    return t !== undefined && t >= e.ts;
  }

  /** Read-only view for tests and harnesses. */
  snapshot(): LivenessEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
}

function validSessionId(sid: string): boolean {
  return sid.length <= MAX_SESSION_ID_CHARS && SESSION_ID_RE.test(sid);
}

/** A session id for a log line: JSON-encoded and cut, so a forged id cannot forge a line. */
function shown(sid: string): string {
  return JSON.stringify(sid.slice(0, 64));
}

function startedAtMs(f: SessionFile): number | undefined {
  const v = f.startedAt;
  if (v === undefined) return undefined;
  const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * One persisted entry, copied field by field; undefined when it is not usable. The key must equal
 * the session id and be a valid one (a mismatch would defeat pruning and the cap).
 */
function sanitizeEntry(key: string, raw: unknown): LivenessEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["session_id"] !== "string" || r["session_id"] !== key || !validSessionId(key))
    return undefined;
  const state = r["state"];
  if (typeof state !== "string" || !ENTRY_STATES.includes(state)) return undefined;
  const pid = r["pid"];
  if (!finite(pid) || !Number.isInteger(pid) || pid < 0) return undefined;
  const rpid = r["reported_pid"];
  if (!finite(r["ts"]) || !finite(r["at"])) return undefined;
  const e: LivenessEntry = {
    session_id: key,
    pid,
    reported_pid: finite(rpid) && Number.isInteger(rpid) && rpid >= 0 ? rpid : 0,
    state: state as EntryState,
    ts: r["ts"],
    at: r["at"],
  };
  const src = r["source"];
  if (src === "sessions" || src === "process" || src === "walked") e.source = src;
  const ps = optStr(r["proc_start"]);
  if (ps !== undefined) e.proc_start = ps.slice(0, 128);
  const fs = optStr(r["file_start"]);
  if (fs !== undefined) e.file_start = fs.slice(0, 128);
  const nm = optStr(r["name"]);
  if (nm !== undefined) e.name = nm.slice(0, 64);
  if (r["probation"] === true) e.probation = true;
  if (r["start_ok"] === true) e.start_ok = true;
  if (r["retry"] === true) e.retry = true;
  if (r["recheck"] === true) e.recheck = true;
  return e;
}
