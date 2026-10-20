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
import { open, readFile, rename, stat } from "node:fs/promises";
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
  /** Keys of entries pruned after SessionEnd; a later re-track starts at a high mark. */
  pruned?: string[];
  /** Offsets were lost once (corrupt file); new entries start at a high mark. */
  lost?: boolean;
}

function isUnder(p: string, dir: string): boolean {
  const w = looksWindows(dir) || looksWindows(p);
  const m = w ? path.win32 : path.posix;
  const norm = (x: string): string => (w ? m.resolve(x).toLowerCase() : m.resolve(x));
  const rel = m.relative(norm(dir), norm(p));
  return rel !== "" && !rel.startsWith("..") && !m.isAbsolute(rel);
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
  private lost = false;
  private pruned = new Set<string>();
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
              tp,
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
      this.track(sessionId, undefined, transcriptPath);
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
      this.track(sessionId, agentId, subagentTranscriptPath(base, sessionId, agentId));
      await this.persist();
    });
  }

  onSubagentStop(
    sessionId: string,
    agentId: string,
    agentPath?: string,
    transcriptPath?: string,
  ): Promise<void> {
    return this.run(async () => {
      if (!AGENT_ID_RE.test(agentId)) {
        this.log("warn", "transcript: SubagentStop with an invalid agent id ignored");
        return;
      }
      let e = this.files.get(key(sessionId, agentId));
      let ok: string | undefined;
      if (agentPath) {
        const mainPath = this.files.get(key(sessionId))?.path ?? transcriptPath;
        const roots = [
          ...(mainPath ? [path.dirname(mainPath)] : []),
          ...(this.o.projectsDir ? [this.o.projectsDir] : []),
        ];
        if (roots.some((r) => isUnder(agentPath, r))) ok = agentPath;
        else this.log("warn", "transcript: SubagentStop agent_transcript_path outside projects dir");
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
          if (validEntry(v)) this.files.set(k, v);
        }
        if (Array.isArray(parsed.pruned)) {
          for (const k of parsed.pruned) if (typeof k === "string") this.pruned.add(k);
        }
        this.lost = parsed.lost === true;
        this.loaded = true;
        return;
      }
    } catch {
      // fall through
    }
    const aside = `${this.o.statePath}.corrupt-${this.now()}`;
    this.log("error", `transcript offsets unreadable; moved to ${aside}`);
    await rename(this.o.statePath, aside).catch(() => undefined);
    this.lost = true;
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
      ...(this.pruned.size > 0 ? { pruned: [...this.pruned] } : {}),
      ...(this.lost ? { lost: true } : {}),
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
    if (this.lost || this.pruned.has(k)) {
      // State for this stream was lost; the hub may hold lines from 0, and ON CONFLICT DO NOTHING
      // would drop re-read lines that collide. Number from a time-based mark that fits INTEGER.
      next_line = highMark(this.now());
      this.pruned.delete(k);
      this.log("warn", `transcript ${k}: no saved offsets, numbering restarts at ${next_line}`);
    }
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
        this.pruned.add(k);
        this.dirty = true;
      }
    }
  }

  private async readHead(p: string, len: number): Promise<Buffer | undefined> {
    const fh = await open(p, "r");
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
    let st: StatLike;
    try {
      st = await this.statFn(e.path);
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
        const got = await this.readHead(e.path, want.length);
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
        fh = await open(e.path, "r");
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
    e.sig = {
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      ctimeMs: st.ctimeMs,
      mtimeMs: st.mtimeMs,
      head: await this.headFor(e, newOffset, reset, headMatches),
    };
    this.dirty = true;
  }

  private async headFor(
    e: TailEntry,
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
      const b = await this.readHead(e.path, want);
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
