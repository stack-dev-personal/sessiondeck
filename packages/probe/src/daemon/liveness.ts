// Liveness component (R1.7): notices a Claude Code process that died without a SessionEnd.
//
// The hook reports a pid with each SessionStart (a `liveness` envelope {pid, alive: true}). This
// component keeps a registry of those pids, checks them every 10 s with process.kill(pid, 0), and
// queues a `liveness` envelope {pid, alive: false} in the daemon outbox when one is gone. It
// borrows findParentPID, cleanupSamePID and isShellProcess from ccmonitor (see proc-info.ts and
// the notes at registerSession). Nothing here runs inside a hook.
//
// Rules that keep a wrong "died" from ever being sent:
//  - A pid is watched only when it is confirmed to be the Claude process: the sessions file
//    ~/.claude/sessions/<pid>.json names this session, or the reported pid is a non-shell process,
//    or the walk up from a shell found a live non-shell ancestor. Anything else stays
//    "unconfirmed" and is never reported dead.
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
import { buildEnvelope } from "../envelope.ts";
import { writeFileAtomic } from "../install/atomic.ts";
import type { SpoolLine } from "../spool-format.ts";
import {
  defaultProcLookup,
  findParentPID,
  isShellProcess,
  pidAlive,
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
}

interface LivenessState {
  v: 1;
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
  private discovered = new Set<string>();
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
  readonly stats = { registered: 0, deaths: 0, corrections: 0, superseded: 0 };

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
    await this.chain.catch(() => undefined);
  }

  /** Hook-spool envelope tap (at-least-once; every handler here is idempotent by ts). */
  onSpoolLine(env: Envelope): void {
    const sid = env.session_id;
    if (!sid) return;
    if (env.kind === "liveness") {
      const p = (typeof env.payload === "object" && env.payload !== null ? env.payload : {}) as {
        pid?: unknown;
        alive?: unknown;
      };
      if (p.alive === true && Number.isInteger(p.pid) && (p.pid as number) > 0) {
        this.fire(this.registerSession(sid, p.pid as number, env.ts), "register");
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

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // --- registry ---

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
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
    } catch {
      this.log("error", "liveness state corrupt; starting empty");
    }
  }

  private async persist(): Promise<void> {
    const sessions: Record<string, LivenessEntry> = {};
    for (const [k, e] of this.entries) sessions[k] = e;
    await this.store.save(JSON.stringify({ v: 1, sessions } satisfies LivenessState));
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

  /** Public for tests and harnesses: registers a reported pid for a session. */
  registerSession(sid: string, reportedPid: number, ts: number): Promise<void> {
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
        await this.persist();
        return;
      }
      const now = this.now();
      const e: LivenessEntry = {
        session_id: sid,
        pid: 0,
        reported_pid: reportedPid,
        state: "unconfirmed",
        ts,
        at: now,
      };
      await this.resolve(e);
      this.entries.set(sid, e);
      this.afterTracked(e);
      await this.persist();
    });
  }

  /**
   * Decide which pid to watch for e. Order: the sessions file entry for this session (alive
   * candidates first, the reported pid preferred); else the reported pid when it is a non-shell
   * process; else findParentPID from a shell. Leaves e unconfirmed when none confirms.
   */
  private async resolve(e: LivenessEntry): Promise<void> {
    const files = this.reader.readAll().filter((f) => f.sessionId === e.session_id);
    const pick =
      files.find((f) => f.pid === e.reported_pid && this.isAlive(f.pid)) ??
      files.find((f) => this.isAlive(f.pid)) ??
      files.find((f) => f.pid === e.reported_pid) ??
      files[0];
    if (pick !== undefined) {
      e.pid = pick.pid;
      e.source = "sessions";
      e.state = "tracking";
      const fs = liveFileStart(pick);
      if (fs !== undefined) e.file_start = fs;
      const ps = this.procs.cheapStart?.(pick.pid);
      if (ps !== undefined) e.proc_start = ps;
      return;
    }
    if (e.reported_pid <= 0) return;
    const info = await this.procs.lookup(e.reported_pid);
    if (info === undefined) return; // dead already, or unreadable: cannot confirm what it was
    let pid = 0;
    let source: PidSource = "process";
    if (!isShellProcess(info.name)) {
      pid = this.isAlive(e.reported_pid) ? e.reported_pid : 0;
    } else {
      pid = await findParentPID(e.reported_pid, this.procs, this.isAlive);
      source = "walked";
    }
    if (pid === 0) {
      this.log(
        "info",
        `liveness: pid ${e.reported_pid} of ${e.session_id} not confirmed as claude`,
      );
      return;
    }
    const start = pid === e.reported_pid ? info.start : (await this.procs.lookup(pid))?.start;
    e.pid = pid;
    e.source = source;
    e.state = "tracking";
    if (start !== undefined) e.proc_start = start;
  }

  /** cleanupSamePID and the alive:true correction, for an entry that just became tracked. */
  private afterTracked(e: LivenessEntry): void {
    if (e.state !== "tracking") return;
    this.stats.registered += 1;
    // cleanupSamePID: another session on this pid was replaced (/clear, --resume). Stop watching it
    // and send nothing: the process is alive, the hub's supersedeSamePid ends the old session.
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

  /** A hook event for a session this daemon never saw register (daemon started mid-session). */
  private discover(sid: string, ts: number): Promise<void> {
    if (this.entries.has(sid) || this.discovered.has(sid)) return Promise.resolve();
    this.discovered.add(sid);
    return this.run(async () => {
      await this.load();
      if (this.entries.has(sid)) return;
      const f = this.reader.readAll().find((x) => x.sessionId === sid && this.isAlive(x.pid));
      if (f === undefined) return;
      const e: LivenessEntry = {
        session_id: sid,
        pid: f.pid,
        reported_pid: 0,
        source: "sessions",
        state: "tracking",
        ts,
        at: this.now(),
      };
      if (f.procStart !== undefined) e.file_start = f.procStart;
      const ps = this.procs.cheapStart?.(f.pid);
      if (ps !== undefined) e.proc_start = ps;
      this.entries.set(sid, e);
      this.afterTracked(e);
      await this.persist();
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
      await this.persist();
    });
  }

  // --- the check ---

  /** Is the watched process gone, or no longer the process we registered (pid reuse)? */
  private gone(e: LivenessEntry): boolean {
    if (!this.isAlive(e.pid)) return true;
    if (e.proc_start !== undefined) {
      const cur = this.procs.cheapStart?.(e.pid);
      if (cur !== undefined && cur !== e.proc_start) return true; // Linux: pid reused
    }
    if (e.file_start !== undefined) {
      // Windows and macOS have no per-tick process start; Claude's own file for this pid gives
      // one. Needs a repeat, because a file being rewritten could read oddly once.
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

  /** One pass over the registry; the interval calls it every 10 s. */
  tick(): Promise<void> {
    return this.run(async () => {
      await this.load();
      if (this.stopped) return;
      const now = this.now();
      let changed = false;
      let files: SessionFile[] | undefined;
      for (const e of this.entries.values()) {
        if (e.state === "tracking") {
          if (this.gone(e) && !this.dying.has(e.session_id)) {
            this.dying.add(e.session_id);
            const t = setTimeout(() => {
              this.graceTimers.delete(t);
              this.fire(this.confirmDeath(e.session_id), "confirm");
            }, this.o.graceMs ?? GRACE_MS);
            t.unref();
            this.graceTimers.add(t);
          }
        } else if (e.state === "unconfirmed") {
          files ??= this.reader.readAll();
          const f = files.find((x) => x.sessionId === e.session_id && this.isAlive(x.pid));
          if (f !== undefined) {
            e.pid = f.pid;
            e.source = "sessions";
            e.state = "tracking";
            e.at = now;
            if (f.procStart !== undefined) e.file_start = f.procStart;
            const ps = this.procs.cheapStart?.(f.pid);
            if (ps !== undefined) e.proc_start = ps;
            this.afterTracked(e);
            changed = true;
          } else if (now - e.at > UNCONFIRMED_KEEP_MS) {
            e.state = "ended";
            e.at = now;
            changed = true;
          }
        } else if (now - e.at > FINISHED_KEEP_MS) {
          this.entries.delete(e.session_id);
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }

  private confirmDeath(sid: string): Promise<void> {
    return this.run(async () => {
      this.dying.delete(sid);
      const e = this.entries.get(sid);
      if (this.stopped || !e || e.state !== "tracking") return; // SessionEnd or supersede won
      if (this.gone(e)) {
        // Order: queue, flush, then record. A crash in between repeats the envelope after a
        // restart (the reducer ignores a second alive:false); it can never lose one.
        this.emit(sid, e.pid, false);
        e.state = "dead";
        e.at = this.now();
        this.stats.deaths += 1;
        this.fileMismatch.delete(sid);
        await this.persist();
      }
    });
  }

  /** Read-only view for tests and harnesses. */
  snapshot(): LivenessEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
}
