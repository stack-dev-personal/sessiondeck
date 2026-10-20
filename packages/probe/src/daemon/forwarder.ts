/**
 * Forwarder: reads the hook spool and the outbox, assigns seq, and POSTs batches to the hub.
 *
 * Crash safety (D-S2-2). Before a batch is sent, a pending-batch journal (the envelopes with seq
 * and the cursors the batch advances to) is written atomically into state.json. The hub's ack
 * commits the cursors and next_seq, again atomically, and clears the journal. After a kill the
 * journal is resent verbatim, so the hub sees the same ids with the same seq: no gaps, and the
 * hub's dedup by id absorbs the resend of a batch whose ack was lost.
 *
 * One batch in flight. A batch closes at 200 envelopes, 250 ms after its first envelope, or about
 * 900 KiB of body (the hub accepts 1 MiB).
 */
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import type { ProbeConfig } from "../config/config.ts";
import type { SpoolLine } from "../spool-format.ts";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from "./backoff.ts";
import { pruneOutbox } from "./outbox.ts";
import { writeFileAtomic } from "../install/atomic.ts";
import { DayFileReader } from "./reader.ts";
import { type DaemonState, type PendingBatch, loadState, saveState } from "./state.ts";
import type { Cursor, Logger } from "./types.ts";

export const MAX_BATCH_ENVELOPES = 200;
export const MAX_BATCH_MS = 250;
export const MAX_BODY_BYTES = 900 * 1024;
const OUTBOX_PER_BATCH = 100;
const BODY_WRAPPER_BYTES = 1024;

export interface ForwarderOptions {
  statePath: string;
  spoolDir: string;
  outboxDir: string;
  rejectedDir: string;
  getConfig: () => Promise<ProbeConfig | undefined> | ProbeConfig | undefined;
  log: Logger;
  fetch: typeof fetch;
  now: () => number;
  /** Resolves after ms or when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  rng: () => number;
  pollMs: number;
  batchMs: number;
  maxBatch: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  /** Upper bound of the retry delay; default 30 s. Shortened by tests and the loss harness. */
  backoffCapMs?: number;
  /** Called for each hook-spool envelope of a batch when it is about to be sent. */
  onSpoolLine?: (env: Envelope) => void;
}

type Outcome =
  | { kind: "ok" }
  | { kind: "retry"; why: string }
  | { kind: "auth"; status: number }
  | { kind: "reject"; status: number; why: string }
  | { kind: "aborted" };

export class Forwarder {
  private state!: DaemonState;
  private spool!: DayFileReader;
  private outbox!: DayFileReader;
  private buf: { outbox: SpoolLine[]; spool: SpoolLine[]; bytes: number; firstAt: number } = {
    outbox: [],
    spool: [],
    bytes: 0,
    firstAt: 0,
  };
  private bufFull = false;
  private readonly ctl = new AbortController();
  private loop: Promise<void> | undefined;
  private authLogged = false;
  private dead = false;
  /** Delays slept between failed attempts, for tests and the heartbeat. */
  attempts = 0;

  constructor(private readonly o: ForwarderOptions) {}

  async start(): Promise<void> {
    this.state = await loadState(this.o.statePath, this.o.log);
    const p = this.state.pending;
    // Reading resumes after the journaled batch, which is resent first.
    this.spool = new DayFileReader(
      this.o.spoolDir,
      p ? (p.spool ?? this.state.spool) : this.state.spool,
      this.o.log,
      this.o.now,
      "spool",
    );
    this.outbox = new DayFileReader(
      this.o.outboxDir,
      p ? (p.outbox ?? this.state.outbox) : this.state.outbox,
      this.o.log,
      this.o.now,
      "outbox",
    );
    this.loop = this.run();
  }

  /** Envelopes read or journaled but not yet acknowledged. */
  pendingCount(): number {
    return this.state.pending?.envelopes.length ?? this.buf.outbox.length + this.buf.spool.length;
  }

  async lagBytes(): Promise<number> {
    return this.spool.lagBytes();
  }

  nextSeq(): number {
    return this.state.next_seq;
  }

  /** Stops without flushing: nothing more is written or sent. Whatever is journaled is resent next start. */
  async stop(): Promise<void> {
    this.dead = true;
    this.ctl.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.dead) {
      try {
        if (this.state.pending) {
          this.notify(this.state.pending);
          await this.deliver(this.state.pending);
          continue;
        }
        await this.fill();
        if (this.shouldClose()) {
          await this.closeBatch();
          continue;
        }
        await this.o.sleep(this.o.pollMs, this.ctl.signal);
      } catch (e) {
        if (this.dead) return;
        this.o.log("error", `forwarder: ${e instanceof Error ? e.message : String(e)}`);
        await this.o.sleep(1000, this.ctl.signal);
      }
    }
  }

  private async fill(): Promise<void> {
    const b = this.buf;
    const room = (): number => this.o.maxBatch - b.outbox.length - b.spool.length;
    const budget = (): number => this.o.maxBodyBytes - BODY_WRAPPER_BYTES - b.bytes;
    if (room() > 0 && !this.bufFull) {
      const r = await this.outbox.read(Math.min(room(), OUTBOX_PER_BATCH), budget());
      b.outbox.push(...r.items);
      b.bytes += r.bytes;
      if (r.full) this.bufFull = true;
    }
    if (room() > 0 && !this.bufFull) {
      const r = await this.spool.read(room(), budget());
      b.spool.push(...r.items);
      b.bytes += r.bytes;
      if (r.full) this.bufFull = true;
    }
    if (b.firstAt === 0 && b.outbox.length + b.spool.length > 0) b.firstAt = this.o.now();
  }

  private shouldClose(): boolean {
    const n = this.buf.outbox.length + this.buf.spool.length;
    if (n === 0) return false;
    return (
      n >= this.o.maxBatch || this.bufFull || this.o.now() - this.buf.firstAt >= this.o.batchMs
    );
  }

  private async closeBatch(): Promise<void> {
    const { outbox, spool } = this.buf;
    const first = this.state.next_seq;
    const envelopes: Envelope[] = [...outbox, ...spool].map((l, i) => ({ ...l, seq: first + i }));
    const pending: PendingBatch = { first_seq: first, envelopes, spool_from: outbox.length };
    // Positions after everything read, including skipped invalid lines.
    if (this.spool.position) pending.spool = { ...this.spool.position };
    if (this.outbox.position) pending.outbox = { ...this.outbox.position };
    if (this.dead) return;
    await saveState(this.o.statePath, { ...this.state, pending });
    if (this.dead) return;
    this.state = { ...this.state, pending };
    this.buf = { outbox: [], spool: [], bytes: 0, firstAt: 0 };
    this.bufFull = false;
    this.notify(pending);
    await this.deliver(pending);
  }

  private notify(p: PendingBatch): void {
    if (!this.o.onSpoolLine) return;
    for (const env of p.envelopes.slice(p.spool_from)) {
      try {
        this.o.onSpoolLine(env);
      } catch (e) {
        this.o.log(
          "error",
          `component onSpoolLine threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private async deliver(p: PendingBatch): Promise<void> {
    let attempt = 0;
    const cap = this.o.backoffCapMs ?? BACKOFF_CAP_MS;
    this.authLogged = false;
    while (!this.dead) {
      const out = await this.post(p);
      this.attempts += 1;
      if (this.dead || out.kind === "aborted") return;
      if (out.kind === "ok") {
        await this.commit(p, false);
        return;
      }
      if (out.kind === "reject") {
        await this.reject(p, out.status, out.why);
        await this.commit(p, true);
        return;
      }
      let delay: number;
      if (out.kind === "auth") {
        if (!this.authLogged) {
          this.o.log(
            "error",
            `auth rejected by hub (HTTP ${out.status}); retrying every ${cap / 1000}s`,
          );
          this.authLogged = true;
        }
        delay = cap;
      } else {
        delay = backoffDelay(attempt, this.o.rng, BACKOFF_BASE_MS, cap);
        this.o.log("warn", `send failed (${out.why}); retry ${attempt + 1} in ${delay} ms`);
      }
      attempt += 1;
      await this.o.sleep(delay, this.ctl.signal);
    }
  }

  private async post(p: PendingBatch): Promise<Outcome> {
    const cfg = await this.o.getConfig();
    if (!cfg?.hubUrl || !cfg.token) {
      return { kind: "retry", why: "hubUrl or token missing in probe.json" };
    }
    const base = cfg.hubUrl.endsWith("/") ? cfg.hubUrl : `${cfg.hubUrl}/`;
    const body = JSON.stringify({ host: cfg.host, envelopes: p.envelopes });
    const signal = AbortSignal.any([this.ctl.signal, AbortSignal.timeout(this.o.requestTimeoutMs)]);
    try {
      const res = await this.o.fetch(new URL("ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
        body,
        signal,
      });
      await res.text().catch(() => "");
      const s = res.status;
      if (s >= 200 && s < 300) return { kind: "ok" };
      if (s === 401 || s === 403) return { kind: "auth", status: s };
      if (s === 408 || s === 429 || s >= 500) return { kind: "retry", why: `HTTP ${s}` };
      if (s >= 400) return { kind: "reject", status: s, why: `HTTP ${s}` };
      return { kind: "retry", why: `HTTP ${s}` };
    } catch (e) {
      if (this.ctl.signal.aborted) return { kind: "aborted" };
      const name = e instanceof Error ? e.name : "error";
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      return { kind: "retry", why: `${name}${cause ? `: ${cause}` : ""}` };
    }
  }

  private async reject(p: PendingBatch, status: number, why: string): Promise<void> {
    const file = join(this.o.rejectedDir, `${this.o.now()}-${p.first_seq}.jsonl`);
    const text = p.envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await writeFileAtomic(file, text, { mode: 0o600 });
    } catch (e) {
      this.o.log(
        "error",
        `could not write rejected batch: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.o.log(
      "error",
      `hub rejected batch seq ${p.first_seq}..${p.first_seq + p.envelopes.length - 1} (${why}, HTTP ${status}); saved to ${file}`,
    );
  }

  private async commit(p: PendingBatch, rejected: boolean): Promise<void> {
    if (this.dead) return;
    const next: DaemonState = {
      v: 1,
      // A rejected batch never reached the hub, so its seq are reused: no gap on the hub side.
      next_seq: rejected ? p.first_seq : p.first_seq + p.envelopes.length,
    };
    const sp: Cursor | undefined = p.spool ?? this.state.spool;
    const ob: Cursor | undefined = p.outbox ?? this.state.outbox;
    if (sp) next.spool = sp;
    if (ob) next.outbox = ob;
    await saveState(this.o.statePath, next);
    this.state = next;
    if (ob) pruneOutbox(this.o.outboxDir, ob.file);
  }
}
