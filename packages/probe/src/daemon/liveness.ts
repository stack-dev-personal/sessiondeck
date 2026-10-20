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
//    start (rate-limited) and a changed machine boot time ends every tracked entry.
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
const DISCOVERED_KEEP_MS = 10 * 60 * 1000;
/** Registration lines waiting in the queue; the excess is dropped (the next hook line retries). */
const MAX_PENDING_REG = 128;
const MAX_SESSION_ID_CHARS = 256;
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]+$/;
/** Process lookups that start a child process: bucket of LOOKUP_BURST, one token per second. */
export const LOOKUP_BURST = 20;
export const LOOKUP_REFILL_MS = 1000;
/** A process younger than the hook's envelope by more than this cannot be the hook's ancestor. */
const START_SKEW_MS = 2000;
/** Windows and macOS: re-read a tracked pid's start at most this often. */
const RECHECK_MS = 60_000;
/** Boot time changes by more than this (clock steps, uptime drift) mean the machine rebooted. */
const BOOT_TOLERANCE_MS = 60_000;
/** Probation is checked on the first tick that finds the entry at least this old. */
const PROBATION_MIN_MS = 2000;
const RESOLVE_RETRIES_PER_TICK = 3;

export type EntryState = "tracking" | "unconfirmed" | "ended" | "dead" | "superseded";
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
  /** Not yet seen alive on a tick; a death now is dropped silently, never reported. */
  probation?: true;
  /** A process lookup was rate-limited while resolving; the tick resolves again. */
  retry?: true;
  /** The machine rebooted since this entry was tracked: the pid is gone whatever kill says. */
  stale?: true;
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
  private fileCache: { at: number; files: SessionFile[] } | undefined;
  private inflight = 0;
  private pendingReg = 0;
  private dirty = false;
  private bootMs = 0;
  private tokens = LOOKUP_BURST;
  private tokenAt = 0;
  private dropped = 0;
  private warned = new Set<string>();
  private loaded = false;
  private stopped = false;
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
    this.procs = o.procs ?? defaultProcLookup();
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
    await this.chain.catch(() => undefined);
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
          this.warnOnce("queue", "registration queue is full; dropping excess liveness lines");
          return;
        }
        this.pendingReg += 1;
        this.fire(
          this.registerSession(sid, p.pid as number, env.ts).finally(() => (this.pendingReg -= 1)),
          "register",
        );
      }
      return;
    }
    if (env.kind !== "hook") return;
    if (env.hook_event_name === "SessionEnd") {
      this.fire(this.endSession(sid, env.ts), "SessionEnd");
    } else {
      this.fire(this.discover(sid, env.ts), "discover");
    }
  }

  private fire(p: Promise<unknown>, what: string): void {
    p.catch((e: unknown) =>
      this.log("error", `liveness ${what}: ${e instanceof Error ? e.message : String(e)}`),
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
      ...(ancestry ? { ancestry: wrap(ancestry, [] as ProcInfo[]) } : {}),
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
      for (const [k, e] of Object.entries(s.sessions)) {
        if (typeof e?.pid === "number" && typeof e.ts === "number" && typeof e.state === "string") {
          this.entries.set(k, e);
        }
      }
      if (typeof s.boot === "number" && Math.abs(s.boot - this.bootMs) > BOOT_TOLERANCE_MS) {
        // The machine rebooted while the daemon was down: every pid recorded before is gone or
        // reused, whatever kill(pid, 0) says. The first tick reports them.
        for (const e of this.entries.values()) {
          if (e.state === "tracking") e.stale = true;
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

  /** Room for one more entry: evicts the oldest entry that is not tracking; false when none can go. */
  private admit(sid: string): boolean {
    if (this.entries.has(sid) || this.entries.size < MAX_ENTRIES) return true;
    let victim: LivenessEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.state !== "tracking" && (victim === undefined || e.at < victim.at)) victim = e;
    }
    if (victim === undefined) {
      this.warnOnce("cap", `registry holds ${MAX_ENTRIES} tracked sessions; dropping new ones`);
      return false;
    }
    this.entries.delete(victim.session_id);
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
        !prev.stale &&
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
    const info = await findParent(reported, this.gated(), this.isAlive);
    if (info === undefined) return undefined;
    if (info.startMs !== undefined && info.startMs > ts + START_SKEW_MS) {
      this.log("info", `liveness: pid ${info.pid} started after the hook line; not claude`);
      return undefined;
    }
    return { info, walked: info.pid !== reported };
  }

  /** A sessions-file pid with no process-path anchor: alive and, when readable, not a shell. */
  private async fileCandidate(files: SessionFile[], ts: number): Promise<ProcInfo | undefined> {
    for (const f of files.filter((x) => this.isAlive(x.pid)).slice(0, 3)) {
      const info = await this.gated().lookup(f.pid);
      if (info === undefined || isShellProcess(info.name)) continue;
      if (info.startMs !== undefined && info.startMs > ts + START_SKEW_MS) continue;
      return info;
    }
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
    const mine = this.files().filter((f) => f.sessionId === e.session_id);
    const before = this.dropped;
    const c = await this.processCandidate(e.reported_pid, ts);
    if (c !== undefined) {
      const file = mine.find((f) => f.pid === c.info.pid);
      this.adopt(e, c.info, file ? "sessions" : c.walked ? "walked" : "process", file);
      return;
    }
    if (this.dropped > before) {
      e.retry = true; // not "dead": the lookup was rate-limited, try again on a tick
      return;
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
      await this.load();
      const e = this.entries.get(sid);
      if (!e || ts < e.ts) return;
      if (e.state === "ended") return;
      e.state = "ended";
      e.ts = ts;
      e.at = this.now();
      this.dirty = true;
    });
  }

  // --- the check ---

  /**
   * Is the watched process gone, or no longer the process we registered (pid reuse)? `force`
   * ignores the re-check interval (the second look of a death).
   */
  private async gone(e: LivenessEntry, force = false): Promise<boolean> {
    if (e.stale === true) return true;
    if (!this.isAlive(e.pid)) return true;
    const cheap = this.procs.cheapStart;
    if (e.proc_start !== undefined && cheap !== undefined) {
      const cur = cheap.call(this.procs, e.pid);
      if (cur !== undefined && cur !== e.proc_start) return true; // Linux: pid reused
    }
    let fileFresh = false;
    if (e.file_start !== undefined) {
      // Claude's own file for this pid gives a start. Needs a repeat, because a file being
      // rewritten could read oddly once.
      const cur = liveFileStart(this.reader.readPid(e.pid));
      if (cur !== undefined && cur !== e.file_start) {
        const n = (this.fileMismatch.get(e.session_id) ?? 0) + 1;
        this.fileMismatch.set(e.session_id, n);
        return n >= FILE_MISMATCH_TICKS;
      }
      this.fileMismatch.delete(e.session_id);
      fileFresh = cur !== undefined;
    }
    if (cheap === undefined && e.proc_start !== undefined) {
      // Windows and macOS: no per-tick process start, and a crashed claude leaves its file behind,
      // so the file alone cannot prove the pid was not reused. Re-read the start now and then.
      const now = this.now();
      const last = this.lastLookup.get(e.session_id);
      if (force || last === undefined || now - last >= RECHECK_MS) {
        if (!fileFresh || force) {
          const before = this.dropped;
          const info = await this.gated().lookup(e.pid);
          if (this.dropped === before) this.lastLookup.set(e.session_id, now);
          if (info?.start !== undefined && info.start !== e.proc_start) return true;
        } else {
          this.lastLookup.set(e.session_id, now);
        }
      }
    }
    return false;
  }

  /** One pass over the registry; the interval calls it every 10 s. */
  tick(): Promise<void> {
    return this.run(async () => {
      await this.load();
      if (this.stopped) return;
      const now = this.now();
      let changed = false;
      let retries = 0;
      for (const [sid, at] of this.discovered) {
        if (now - at > DISCOVERED_KEEP_MS) this.discovered.delete(sid);
      }
      for (const e of [...this.entries.values()]) {
        if (e.state === "tracking") {
          if (e.probation === true) {
            if (now - e.at < PROBATION_MIN_MS) continue;
            delete e.probation;
            changed = true;
            if (!this.isAlive(e.pid)) {
              // Never confirmed to be claude (a shim, a reused pid): drop without a word.
              e.state = "unconfirmed";
              e.pid = 0;
              e.at = now;
              this.log("info", `liveness: ${shown(e.session_id)} pid gone while on probation`);
              continue;
            }
          }
          if ((await this.gone(e)) && !this.dying.has(e.session_id)) {
            this.dying.add(e.session_id);
            const t = setTimeout(() => {
              this.graceTimers.delete(t);
              this.fire(this.confirmDeath(e.session_id), "confirm");
            }, this.o.graceMs ?? GRACE_MS);
            t.unref();
            this.graceTimers.add(t);
          }
        } else if (e.state === "unconfirmed") {
          if (e.retry === true && retries < RESOLVE_RETRIES_PER_TICK) {
            retries += 1;
            await this.resolve(e, e.ts);
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
        } else if (now - e.at > FINISHED_KEEP_MS) {
          this.entries.delete(e.session_id);
          this.lastLookup.delete(e.session_id);
          changed = true;
        }
      }
      if (changed) this.dirty = true;
    });
  }

  private confirmDeath(sid: string): Promise<void> {
    return this.run(async () => {
      this.dying.delete(sid);
      const e = this.entries.get(sid);
      if (this.stopped || !e || e.state !== "tracking") return; // SessionEnd or supersede won
      if (await this.gone(e, true)) {
        // Order: queue, flush, then record. A crash in between repeats the envelope after a
        // restart (the reducer ignores a second alive:false); it can never lose one.
        this.emit(sid, e.pid, false);
        e.state = "dead";
        e.at = this.now();
        this.stats.deaths += 1;
        this.fileMismatch.delete(sid);
        this.dirty = true;
      }
    });
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
