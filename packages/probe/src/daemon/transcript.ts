// Transcript tailer (R1.6).
//
// Adapted from cctop.
//   Source repo: cctop (Dean Langsam), commit 6ec6256
//   Path:        plugin/scripts/cctop-poller.py, function read_new_jsonl_lines
//   License:     MIT, Copyright (c) 2025 Dean Langsam
//   Changes:     ported from Python to TypeScript; asynchronous fs; byte offsets kept per
//                (session, agent) and persisted atomically; complete lines only (a partial trailing
//                line waits for its newline); the inode-only replace test became a strategy
//                (inode on POSIX; birthtime plus a head-bytes fingerprint on Windows, where inode is
//                unreliable); lines are emitted as `transcript` envelopes into the daemon outbox
//                with a start_line counter that survives resets; oversize lines become a marker.
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { hostOs } from "../envelope.ts";
import { writeFileAtomic } from "../install/atomic.ts";
import type { SpoolLine } from "../spool-format.ts";
import { ulid } from "../ulid.ts";
import type { ComponentContext, DaemonComponent, Logger } from "./types.ts";
import type { Envelope } from "@sessiondeck/contract";

/** A transcript envelope body stays well under the forwarder's 900 KiB request budget. */
export const MAX_ENVELOPE_BYTES = 600 * 1024;
/** A single line whose JSON-encoded size exceeds this is replaced by a marker line. */
export const MAX_LINE_JSON_BYTES = 500 * 1024;
export const MAX_LINES_PER_ENVELOPE = 500;
/** How many leading bytes identify a file (compaction rewrites change them). */
export const HEAD_BYTES = 256;
const READ_CHUNK = 8 * 1024 * 1024;
const ENDED_KEEP_MS = 7 * 24 * 3600 * 1000;
/** How long a pruned key (and a loss of the offsets file) is remembered; bounds the state file. */
export const PRUNED_KEEP_MS = 30 * 24 * 3600 * 1000;

export type ReplaceStrategy = "posix" | "win32";

export interface StatLike {
  size: number;
  ino: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
}

/** What the tailer remembers about the file it last read. */
export interface FileSig {
  ino: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
  /** base64 of the first min(offset, HEAD_BYTES) consumed bytes; "" before anything was read. */
  head: string;
}

export interface TailEntry {
  session_id: string;
  agent_id?: string;
  path: string;
  /** Byte offset of the next unread byte (always just after a newline, or 0). */
  offset: number;
  /** start_line of the next line emitted; never reset, so the hub key never collides. */
  next_line: number;
  resets: number;
  sig: FileSig;
  ended_at?: number;
}

interface TailState {
  v: 1;
  files: Record<string, TailEntry>;
  /** Highest line number ever issued by this daemon, across all streams. */
  max_issued?: number;
  /** Pruned key to prune time; a re-track within PRUNED_KEEP_MS restarts above max_issued. */
  pruned?: Record<string, number>;
  /** Offsets were lost (corrupt file) at this time; keys first seen until lost_until restart high. */
  lost_until?: number;
}

export function isUnder(p: string, dir: string): boolean {
  const w = looksWindows(dir) || looksWindows(p);
  const m = w ? path.win32 : path.posix;
  const norm = (x: string): string => (w ? m.resolve(x).toLowerCase() : m.resolve(x));
  const rel = m.relative(norm(dir), norm(p));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${m.sep}`) && !m.isAbsolute(rel);
}

/**
 * realpath of p, or of its deepest existing ancestor with the rest appended (the file may not exist
 * yet). Paths in the other platform's style (table tests) are returned unchanged.
 */
export async function realpathLoose(p: string): Promise<string> {
  if (looksWindows(p) !== (process.platform === "win32")) return p;
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await realpath(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** isUnder after resolving symlinks on both sides: a link inside dir that points out does not pass. */
export async function isUnderReal(p: string, dir: string): Promise<boolean> {
  if (!isUnder(p, dir)) return false;
  return isUnder(await realpathLoose(p), await realpathLoose(dir));
}

/**
 * Pure replace test. `headMatches` is undefined when it could not be checked (nothing consumed yet).
 * POSIX trusts the inode. Windows has no reliable inode and NTFS file tunneling can give a rewritten
 * file its old birthtime, so it uses size regression, a birthtime change, and the head fingerprint.
 * On both, a head mismatch (an in-place rewrite that ended up as long as the old file) is a reset.
 */
export function shouldReset(
  strategy: ReplaceStrategy,
  prev: FileSig,
  cur: StatLike,
  offset: number,
  headMatches: boolean | undefined,
): boolean {
  if (cur.size < offset) return true;
  if (offset === 0) return false;
  if (strategy === "posix") {
    if (prev.ino !== 0 && cur.ino !== 0 && prev.ino !== cur.ino) return true;
  } else if (prev.birthtimeMs !== 0 && cur.birthtimeMs !== prev.birthtimeMs) {
    return true;
  }
  return headMatches === false;
}

export interface TranscriptTailerOptions {
  /** Where offsets persist, e.g. `<home>/daemon/transcript-offsets.json`. */
  statePath: string;
  enqueue?: (line: SpoolLine) => void;
  host?: string;
  log?: Logger;
  now?: () => number;
  strategy?: ReplaceStrategy;
  /** Test seam for stat (fake inode or birthtime). */
  stat?: (p: string) => Promise<StatLike>;
  /** Claude projects dir; subagent transcript paths from hooks must live under it or the main dir. */
  projectsDir?: string;
  /** Flushes the outbox to disk; defaults to `enqueue.sync` when the outbox provides one. */
  syncOutbox?: () => void;
  pollMs?: number;
  maxEnvelopeBytes?: number;
  maxLineJsonBytes?: number;
}

/** Seconds since 2026-01-01 times 4: ~1.2e8 in 2026, below 2^31 until about 2043. */
const HIGH_MARK_EPOCH_MS = Date.UTC(2026, 0, 1);
export function highMark(nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - HIGH_MARK_EPOCH_MS) / 1000)) * 4;
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Same alphabet as the liveness component's session ids; ".." is rejected on top (path segment). */
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]+$/;
const MAX_SESSION_ID_CHARS = 200;
const validSessionId = (s: string): boolean =>
  s.length <= MAX_SESSION_ID_CHARS && SESSION_ID_RE.test(s) && !s.includes("..");
/** Distinct refusals remembered for log rate limiting. */
const MAX_REFUSALS = 1000;

const key = (session: string, agent?: string): string => `${session}|${agent ?? ""}`;

function looksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
}

/**
 * `<dir of transcript>/<session_id>/subagents/agent-<agent_id>.jsonl` (architecture 4.2; the layout
 * matches the SubagentStop fixture's agent_transcript_path). SubagentStart carries no path itself.
 */
export function subagentTranscriptPath(
  transcriptPath: string,
  sessionId: string,
  agentId: string,
): string {
  const p = looksWindows(transcriptPath) ? path.win32 : path.posix;
  return p.join(p.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

function marker(bytes: number): string {
  return JSON.stringify({ type: "sessiondeck_marker", reason: "line_too_large", bytes });
}

/** Splits complete lines (LF, optional CR) out of buf; blank lines are dropped. */
export function splitLines(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    let end = nl;
    if (end > start && buf[end - 1] === 0x0d) end -= 1;
    if (end > start) out.push(buf.toString("utf8", start, end));
    start = nl + 1;
  }
  return out;
}

function validEntry(e: unknown): e is TailEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  const s = o["sig"] as Record<string, unknown> | undefined;
  return (
    typeof o["session_id"] === "string" &&
    typeof o["path"] === "string" &&
    Number.isInteger(o["offset"]) &&
    (o["offset"] as number) >= 0 &&
    Number.isInteger(o["next_line"]) &&
    (o["next_line"] as number) >= 0 &&
    typeof s === "object" &&
    s !== null &&
    typeof s["head"] === "string"
  );
}

export class TranscriptTailer implements DaemonComponent {
  readonly name = "transcript";
  private files = new Map<string, TailEntry>();
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private enqueue: (line: SpoolLine) => void;
  private host: string;
  private log: Logger;
  private readonly now: () => number;
  private readonly strategy: ReplaceStrategy;
  private readonly statFn: (p: string) => Promise<StatLike>;
  private dirty = false;
  private maxIssued = -1;
  private lostUntil = 0;
  private pruned = new Map<string, number>();
  /** Counters for harnesses and logs. */
  readonly stats = { lines: 0, envelopes: 0, resets: 0, markers: 0 };

  private readonly o: TranscriptTailerOptions;

  constructor(o: TranscriptTailerOptions) {
    this.o = o;
    this.enqueue =
      o.enqueue ??
      ((): void => {
        throw new Error("transcript tailer has no outbox");
      });
    this.host = o.host ?? "unknown";
    this.log = o.log ?? ((): void => undefined);
    this.now = o.now ?? Date.now;
    this.strategy = o.strategy ?? (process.platform === "win32" ? "win32" : "posix");
    this.statFn =
      o.stat ??
      (async (p): Promise<StatLike> => {
        const s = await stat(p);
        return {
          size: s.size,
          ino: Number(s.ino),
          birthtimeMs: s.birthtimeMs,
          ctimeMs: s.ctimeMs,
          mtimeMs: s.mtimeMs,
        };
      });
  }

  // --- DaemonComponent ---

  async start(ctx?: ComponentContext): Promise<void> {
    if (ctx) {
      this.enqueue = ctx.enqueue;
      this.host = ctx.host;
      this.log = ctx.log;
    }
    await this.load();
    if (this.o.pollMs !== 0) {
      this.timer = setInterval(() => void this.poll().catch(() => undefined), this.o.pollMs ?? 500);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.poll();
  }

  /** Hook-spool envelope tap (at-least-once; every handler here is idempotent). */
  onSpoolLine(env: Envelope): void {
    const sid = env.session_id;
    if (env.kind !== "hook" || !sid) return;
    const p = (
      typeof env.payload === "object" && env.payload !== null ? env.payload : {}
    ) as Record<string, unknown>;
    const tp = typeof p["transcript_path"] === "string" ? p["transcript_path"] : undefined;
    const aid = env.agent_id ?? (typeof p["agent_id"] === "string" ? p["agent_id"] : undefined);
    switch (env.hook_event_name) {
      case "SessionStart":
        if (tp) this.fire(this.onSessionStart(sid, tp), "SessionStart");
        break;
      case "SubagentStart":
        if (aid) this.fire(this.onSubagentStart(sid, aid, tp), "SubagentStart");
        break;
      case "SubagentStop":
        if (aid)
          this.fire(
            this.onSubagentStop(
              sid,
              aid,
              typeof p["agent_transcript_path"] === "string"
                ? p["agent_transcript_path"]
                : undefined,
            ),
            "SubagentStop",
          );
        break;
      case "SessionEnd":
        this.fire(this.onSessionEnd(sid), "SessionEnd");
        break;
    }
  }

  /** A failed handler is logged, never an unhandled rejection; the spool replay retries it. */
  private fire(p: Promise<unknown>, what: string): void {
    p.catch((e: unknown) =>
      this.log("error", `transcript ${what}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // --- API for the daemon wiring and tests ---

  onSessionStart(sessionId: string, transcriptPath: string): Promise<void> {
    return this.run(async () => {
      // D-S2-10: the path comes from the spool; only files under the daemon's own projects dir count.
      const real = validSessionId(sessionId) ? await this.trusted(transcriptPath) : undefined;
      if (!real) {
        this.refuse(sessionId, "SessionStart transcript_path outside the projects dir");
        return;
      }
      this.track(sessionId, undefined, real);
      await this.persist();
    });
  }

  /** transcriptPath is the session's own transcript_path; the agent file is derived from it. */
  onSubagentStart(sessionId: string, agentId: string, transcriptPath?: string): Promise<void> {
    return this.run(async () => {
      if (!AGENT_ID_RE.test(agentId)) {
        this.log("warn", "transcript: SubagentStart with an invalid agent id ignored");
        return;
      }
      const main = this.files.get(key(sessionId));
      const base = transcriptPath ?? main?.path;
      if (!base) {
        this.log("warn", `transcript: SubagentStart ${agentId} without a known transcript path`);
        return;
      }
      if (!validSessionId(sessionId)) {
        this.refuse(sessionId, "SubagentStart with an invalid session id");
        return;
      }
      const real = await this.trusted(subagentTranscriptPath(base, sessionId, agentId));
      if (!real) {
        this.refuse(`${sessionId}|${agentId}`, "SubagentStart path outside the projects dir");
        return;
      }
      this.track(sessionId, agentId, real);
      await this.persist();
    });
  }

  onSubagentStop(sessionId: string, agentId: string, agentPath?: string): Promise<void> {
    return this.run(async () => {
      if (!AGENT_ID_RE.test(agentId)) {
        this.log("warn", "transcript: SubagentStop with an invalid agent id ignored");
        return;
      }
      let e = this.files.get(key(sessionId, agentId));
      let ok: string | undefined;
      if (agentPath) {
        // The payload's own transcript_path is not a trust anchor; only the projects dir is.
        ok = await this.trusted(agentPath);
        if (!ok)
          this.log("warn", "transcript: SubagentStop agent_transcript_path outside projects dir");
      }
      if (!e) {
        if (!ok) return;
        this.track(sessionId, agentId, ok);
        e = this.files.get(key(sessionId, agentId));
        if (!e) return;
      } else if (ok && ok !== e.path && e.offset === 0) {
        e.path = ok;
      }
      await this.drain(e);
      this.endEntry(e);
      await this.persist();
    });
  }

  /** Final drain of the session and its subagents, then tailing stops. */
  onSessionEnd(sessionId: string): Promise<void> {
    return this.run(async () => {
      for (const e of this.files.values()) {
        if (e.session_id !== sessionId || e.ended_at !== undefined) continue;
        await this.drain(e);
        this.endEntry(e);
      }
      await this.persist();
    });
  }

  /**
   * The resolved path of p when it is a file under the (resolved) projects dir, else undefined.
   * Refuses when no projects dir is configured, and files with more than one hard link.
   */
  private async trusted(p: string): Promise<string | undefined> {
    const root = this.o.projectsDir;
    if (!root || !(await isUnderReal(p, root))) return undefined;
    const rp = await realpathLoose(p);
    try {
      const st = await lstat(rp);
      if (st.isFile() && st.nlink > 1) return undefined;
    } catch {
      // not there yet: the tailer waits for it
    }
    return rp;
  }

  /** Containment check of an already resolved path, repeated before every read. */
  private async stillTrusted(rp: string): Promise<string | undefined> {
    const root = this.o.projectsDir;
    if (!root) return undefined;
    const now = await realpathLoose(rp);
    return isUnder(now, await realpathLoose(root)) ? now : undefined;
  }

  private readonly refused = new Set<string>();
  /** Logs a refusal once per subject. */
  private refuse(subject: string, what: string): void {
    if (this.refused.has(`${subject}|${what}`) || this.refused.size >= MAX_REFUSALS) return;
    this.refused.add(`${subject}|${what}`);
    this.log("warn", `transcript: ${what}; not tailing (session ${subject.slice(0, 80)})`);
  }

  /** One pass over every active file; resolves with the number of lines delivered. */
  poll(): Promise<number> {
    return this.run(async () => {
      const before = this.stats.lines;
      for (const e of [...this.files.values()]) {
        if (e.ended_at !== undefined) continue;
        try {
          await this.drain(e);
        } catch (err) {
          // one bad file must not starve the rest; its entry is untouched, so the next poll retries
          this.log(
            "warn",
            `transcript drain ${e.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.prune();
      await this.persist();
      return this.stats.lines - before;
    });
  }

  /** Test and harness view of the tracked files. */
  entries(): TailEntry[] {
    return [...this.files.values()].map((e) => ({ ...e, sig: { ...e.sig } }));
  }

  // --- internals ---

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      await this.load();
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let text: string;
    try {
      text = await readFile(this.o.statePath, "utf8");
    } catch (e) {
      // loaded stays false on other errors (EBUSY, EIO): never persist over offsets we could not read
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(text) as Partial<TailState>;
      if (parsed.v === 1 && typeof parsed.files === "object" && parsed.files !== null) {
        for (const [k, v] of Object.entries(parsed.files)) {
          if (!validEntry(v)) continue;
          const real = validSessionId(v.session_id) ? await this.trusted(v.path) : undefined;
          if (!real) {
            this.refuse(v.session_id, "saved transcript path outside the projects dir");
            this.pruned.set(k, this.now()); // keep its numbering clear of what it already issued
            this.maxIssued = Math.max(this.maxIssued, v.next_line);
            this.dirty = true;
            continue;
          }
          v.path = real;
          this.files.set(k, v);
        }
        const pr = parsed.pruned;
        if (typeof pr === "object" && pr !== null && !Array.isArray(pr)) {
          for (const [k, t] of Object.entries(pr)) if (Number.isFinite(t)) this.pruned.set(k, t);
        }
        if (Number.isInteger(parsed.max_issued)) this.maxIssued = parsed.max_issued as number;
        if (Number.isFinite(parsed.lost_until)) this.lostUntil = parsed.lost_until as number;
        for (const e of this.files.values()) this.maxIssued = Math.max(this.maxIssued, e.next_line);
        this.loaded = true;
        return;
      }
    } catch {
      // fall through
    }
    const aside = `${this.o.statePath}.corrupt-${this.now()}`;
    this.log("error", `transcript offsets unreadable; moved to ${aside}`);
    await rename(this.o.statePath, aside).catch(() => undefined);
    // max_issued is unknown: assume everything below the current high mark may be taken, and
    // restart every key first seen during the next PRUNED_KEEP_MS above it.
    this.maxIssued = Math.max(this.maxIssued, highMark(this.now()) - 1);
    this.lostUntil = this.now() + PRUNED_KEEP_MS;
    this.dirty = true;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    // The offsets must never get ahead of the outbox lines they cover (power loss).
    const sync = this.o.syncOutbox ?? (this.enqueue as { sync?: () => void }).sync;
    sync?.();
    const state: TailState = {
      v: 1,
      files: Object.fromEntries(this.files),
      ...(this.maxIssued >= 0 ? { max_issued: this.maxIssued } : {}),
      ...(this.pruned.size > 0 ? { pruned: Object.fromEntries(this.pruned) } : {}),
      ...(this.lostUntil > this.now() ? { lost_until: this.lostUntil } : {}),
    };
    await writeFileAtomic(this.o.statePath, JSON.stringify(state), { mode: 0o600 });
    this.dirty = false;
  }

  private track(sessionId: string, agentId: string | undefined, p: string): void {
    const k = key(sessionId, agentId);
    const cur = this.files.get(k);
    if (cur) {
      if (cur.ended_at !== undefined) {
        delete cur.ended_at; // resumed session: continue at the saved offset
        this.dirty = true;
      }
      if (cur.path !== p) {
        // a different file for the same stream: read it from the start, keep numbering
        cur.path = p;
        cur.offset = 0;
        cur.sig = { ino: 0, birthtimeMs: 0, ctimeMs: 0, mtimeMs: 0, head: "" };
        this.dirty = true;
      }
      return;
    }
    let next_line = 0;
    if (this.pruned.has(k) || this.now() < this.lostUntil) {
      // State for this stream was lost; the hub may hold lines from 0, and ON CONFLICT DO NOTHING
      // would drop re-read lines that collide. Number above everything this daemon ever issued
      // (and above a wall-clock mark, for the case where max_issued itself was lost). The clock
      // can step back, so the maximum with max_issued keeps it monotonic. Fits INTEGER.
      next_line = Math.max(highMark(this.now()), this.maxIssued + 1);
      this.pruned.delete(k);
      this.log("warn", `transcript ${k}: no saved offsets, numbering restarts at ${next_line}`);
    }
    this.maxIssued = Math.max(this.maxIssued, next_line);
    this.files.set(k, {
      session_id: sessionId,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      path: p,
      offset: 0,
      next_line,
      resets: 0,
      sig: { ino: 0, birthtimeMs: 0, ctimeMs: 0, mtimeMs: 0, head: "" },
    });
    this.dirty = true;
  }

  private endEntry(e: TailEntry): void {
    e.ended_at = this.now();
    this.dirty = true;
  }

  private prune(): void {
    const cutoff = this.now() - ENDED_KEEP_MS;
    for (const [k, e] of this.files) {
      if (e.ended_at !== undefined && e.ended_at < cutoff) {
        this.files.delete(k);
        this.pruned.set(k, this.now());
        this.dirty = true;
      }
    }
    const pcut = this.now() - PRUNED_KEEP_MS;
    for (const [k, t] of this.pruned) {
      if (t < pcut) {
        this.pruned.delete(k);
        this.dirty = true;
      }
    }
    if (this.lostUntil !== 0 && this.now() >= this.lostUntil) {
      this.lostUntil = 0;
      this.dirty = true;
    }
  }

  private async readHead(p: string, len: number): Promise<Buffer | undefined> {
    const fh = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, 0);
      return b.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** Reads what is new in one file, enqueues it, and only then commits the offset. */
  private async drain(e: TailEntry): Promise<void> {
    // Re-resolve every time: a link or junction swapped in after tracking began must not be followed.
    const rp = await this.stillTrusted(e.path);
    if (!rp) {
      this.refuse(e.session_id, "tracked transcript now resolves outside the projects dir");
      return;
    }
    let st: StatLike;
    try {
      st = await this.statFn(rp);
    } catch (err) {
      const c = (err as NodeJS.ErrnoException).code;
      if (c !== "ENOENT" && c !== "ENOTDIR") this.log("warn", `transcript stat ${e.path}: ${c}`);
      return;
    }
    const changed =
      st.size !== e.offset ||
      st.ctimeMs !== e.sig.ctimeMs ||
      st.mtimeMs !== e.sig.mtimeMs ||
      st.ino !== e.sig.ino;
    if (!changed) return;

    let headMatches: boolean | undefined;
    if (e.offset > 0 && e.sig.head !== "" && st.size >= e.offset) {
      const want = Buffer.from(e.sig.head, "base64");
      try {
        const got = await this.readHead(rp, want.length);
        headMatches = got !== undefined && got.equals(want);
      } catch {
        return; // vanished between stat and open; next poll
      }
    }
    let offset = e.offset;
    let reset = false;
    if (shouldReset(this.strategy, e.sig, st, offset, headMatches)) {
      offset = 0;
      reset = true;
      this.log("info", `transcript reset ${e.path} (size=${st.size} was offset=${e.offset})`);
    }

    let consumed = 0;
    let lines: string[] = [];
    const avail = st.size - offset;
    if (avail > 0) {
      let fh;
      try {
        fh = await open(rp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        return;
      }
      try {
        let want = Math.min(avail, READ_CHUNK);
        for (;;) {
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fh.read(buf, 0, want, offset);
          const data = buf.subarray(0, bytesRead);
          const lastNl = data.lastIndexOf(0x0a);
          if (lastNl >= 0) {
            consumed = lastNl + 1;
            lines = splitLines(data.subarray(0, consumed));
            break;
          }
          if (bytesRead < want || want >= avail) break; // partial line: wait for its newline
          want = Math.min(avail, want * 2);
        }
      } finally {
        await fh.close();
      }
    }

    const newOffset = offset + consumed;
    // Emit before committing anything: a throw leaves the entry untouched and the next poll retries.
    let line = e.next_line;
    if (lines.length > 0) line = this.emit(e, lines);
    if (reset) {
      e.resets += 1;
      this.stats.resets += 1;
    }
    e.offset = newOffset;
    e.next_line = line;
    this.maxIssued = Math.max(this.maxIssued, line);
    e.sig = {
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      ctimeMs: st.ctimeMs,
      mtimeMs: st.mtimeMs,
      head: await this.headFor(e, rp, newOffset, reset, headMatches),
    };
    this.dirty = true;
  }

  private async headFor(
    e: TailEntry,
    rp: string,
    offset: number,
    reset: boolean,
    headMatches: boolean | undefined,
  ): Promise<string> {
    if (offset === 0) return "";
    const want = Math.min(offset, HEAD_BYTES);
    if (!reset && e.sig.head !== "" && Buffer.from(e.sig.head, "base64").length >= want) {
      return headMatches === false ? "" : e.sig.head;
    }
    try {
      const b = await this.readHead(rp, want);
      return b && b.length === want ? b.toString("base64") : "";
    } catch {
      return "";
    }
  }

  /** Builds envelopes for lines and enqueues them; returns the next start_line. */
  private emit(e: TailEntry, lines: string[]): number {
    const maxEnv = this.o.maxEnvelopeBytes ?? MAX_ENVELOPE_BYTES;
    const maxLine = this.o.maxLineJsonBytes ?? MAX_LINE_JSON_BYTES;
    let start = e.next_line;
    let chunk: string[] = [];
    let size = 0;
    const flush = (): void => {
      if (chunk.length === 0) return;
      const env: SpoolLine = {
        v: 1,
        id: ulid(this.now()),
        kind: "transcript",
        host: this.host,
        os: hostOs(),
        session_id: e.session_id,
        ...(e.agent_id !== undefined ? { agent_id: e.agent_id } : {}),
        ts: this.now(),
        payload: { start_line: start, lines: chunk },
      };
      this.enqueue(env);
      this.stats.envelopes += 1;
      this.stats.lines += chunk.length;
      start += chunk.length;
      chunk = [];
      size = 0;
    };
    for (let l of lines) {
      let n = Buffer.byteLength(JSON.stringify(l)) + 1;
      if (n > maxLine) {
        l = marker(Buffer.byteLength(l));
        n = Buffer.byteLength(JSON.stringify(l)) + 1;
        this.stats.markers += 1;
      }
      if (chunk.length > 0 && (size + n > maxEnv || chunk.length >= MAX_LINES_PER_ENVELOPE))
        flush();
      chunk.push(l);
      size += n;
    }
    flush();
    return start;
  }
}
