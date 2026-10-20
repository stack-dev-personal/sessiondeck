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
 * 900 KiB of body (the hub accepts 1 MiB). A batch the hub still answers 413 to is split in halves
 * and resent (same ids, same seq). An envelope the hub rejects for good goes to rejected/ and,
 * when the rest of its batch was delivered, a small `probe` stand-in takes its seq (no gap).
 *
 * Seq order follows `ts`: each batch merges the outbox and the hook spool by ts, and only takes
 * from a source while the other source's next envelope is known (see select()).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import type { ProbeConfig } from "../config/config.ts";
import type { SpoolLine } from "../spool-format.ts";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from "./backoff.ts";
import { HUB_URL_REFUSED, checkHubUrl } from "./hub-url.ts";
import { pruneOutbox } from "./outbox.ts";
import { ensurePrivateDir, writeFileAtomic } from "../install/atomic.ts";
import { DayFileReader } from "./reader.ts";
import { REJECTED_MAX_BYTES, REJECTED_MAX_FILES, capRejected } from "./rejected.ts";
import { type DaemonState, type PendingBatch, loadState, saveState } from "./state.ts";
import type { Cursor, Logger } from "./types.ts";

export const MAX_BATCH_ENVELOPES = 200;
export const MAX_BATCH_MS = 250;
export const MAX_BODY_BYTES = 900 * 1024;
type Src = "outbox" | "spool";
const SOURCES: readonly Src[] = ["outbox", "spool"];
interface Queued {
  line: SpoolLine;
  end: Cursor;
  cost: number;
}
interface Rejection {
  envs: Envelope[];
  status: number;
  why: string;
}
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
  /** Caps for the rejected-batch directory (defaults 200 files, 64 MiB). */
  rejectedMaxFiles?: number;
  rejectedMaxBytes?: number;
  /**
   * Fencing: checked immediately before every state write and every POST. False means the daemon
   * lock is foreign; the forwarder then stops without writing or sending and calls onFenced.
   */
  fence?: () => boolean;
  onFenced?: () => void;
  /** Called for each hook-spool envelope of a batch when it is about to be sent. */
  onSpoolLine?: (env: Envelope) => void;
}

type Outcome =
  | { kind: "ok" }
  | { kind: "retry"; why: string }
  | { kind: "auth"; status: number }
  | { kind: "reject"; status: number; why: string }
  | { kind: "aborted" };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Small probe envelope that takes the seq of an envelope the hub rejected. The id is derived from
 * the original's (same timestamp part, hashed random part) so a resend produces the same id.
 */
function standIn(env: Envelope, status: number): Envelope {
  const h = createHash("sha256").update(env.id).digest();
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[(h[i] as number) % 32];
  return {
    v: 1,
    id: env.id.slice(0, 10) + tail,
    kind: "probe",
    host: env.host,
    os: env.os,
    session_id: null,
    ts: env.ts,
    seq: env.seq,
    payload: { type: "rejected", reason: `HTTP ${status}`, original_id: env.id },
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

export class Forwarder {
  private state!: DaemonState;
  private spool!: DayFileReader;
  private outbox!: DayFileReader;
  private q: Record<Src, Queued[]> = { outbox: [], spool: [] };
  private qBytes: Record<Src, number> = { outbox: 0, spool: 0 };
  /** The last read of a source ran out of data (rather than stopping at a limit). */
  private drained: Record<Src, boolean> = { outbox: false, spool: false };
  private firstAt = 0;
  private bufFull = false;
  private readonly ctl = new AbortController();
  private loop: Promise<void> | undefined;
  private authLogged = false;
  private policyLogged = false;
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
    return this.state.pending?.envelopes.length ?? this.q.outbox.length + this.q.spool.length;
  }

  async lagBytes(): Promise<number> {
    return this.spool.lagBytes();
  }

  nextSeq(): number {
    return this.state.next_seq;
  }

  /** True (and the forwarder is stopped) when the fence says the lock is foreign. */
  private fenced(): boolean {
    if (this.dead) return true;
    if (!this.o.fence || this.o.fence()) return false;
    this.dead = true;
    this.ctl.abort();
    this.o.log("error", "forwarder fenced: the daemon lock is foreign; no further writes or sends");
    try {
      this.o.onFenced?.();
    } catch {
      // the caller's handler must not break the loop's exit
    }
    return true;
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
    const budgetAll = this.o.maxBodyBytes - BODY_WRAPPER_BYTES;
    for (const src of SOURCES) {
      const q = this.q[src];
      if (q.length >= this.o.maxBatch) {
        this.drained[src] = false;
        continue;
      }
      // The byte budget holds for everything but a line read into an empty queue.
      const r = await this[src].read(
        this.o.maxBatch - q.length,
        budgetAll - this.qBytes[src],
        q.length === 0,
      );
      r.items.forEach((line, i) => {
        q.push({ line, end: r.ends[i] as Cursor, cost: r.costs[i] as number });
      });
      this.qBytes[src] += r.bytes;
      this.drained[src] = r.drained;
      if (r.full) this.bufFull = true;
    }
    if (this.firstAt === 0 && this.queued() > 0) this.firstAt = this.o.now();
  }

  private queued(): number {
    return this.q.outbox.length + this.q.spool.length;
  }

  private shouldClose(): boolean {
    const n = this.queued();
    if (n === 0) return false;
    return (
      n >= this.o.maxBatch ||
      this.bufFull ||
      this.qBytes.outbox + this.qBytes.spool > this.o.maxBodyBytes - BODY_WRAPPER_BYTES ||
      this.o.now() - this.firstAt >= this.o.batchMs
    );
  }

  /**
   * Picks the next batch from the two queues in `ts` order (ties: outbox first). A source whose
   * queue is used up but which stopped at a limit (not drained) may hold an older envelope that
   * is not read yet, so selection stops there. The first pick is always allowed; later ones must
   * fit the body budget.
   */
  private select(): { src: Src; q: Queued }[] {
    const budget = this.o.maxBodyBytes - BODY_WRAPPER_BYTES;
    const at: Record<Src, number> = { outbox: 0, spool: 0 };
    const picked: { src: Src; q: Queued }[] = [];
    let bytes = 0;
    while (picked.length < this.o.maxBatch) {
      const o = this.q.outbox[at.outbox];
      const s = this.q.spool[at.spool];
      let src: Src;
      if (o && s) src = s.line.ts < o.line.ts ? "spool" : "outbox";
      else if (o) {
        if (!this.drained.spool) break;
        src = "outbox";
      } else if (s) {
        if (!this.drained.outbox) break;
        src = "spool";
      } else break;
      const item = this.q[src][at[src]] as Queued;
      if (picked.length > 0 && bytes + item.cost > budget) break;
      picked.push({ src, q: item });
      bytes += item.cost;
      at[src] += 1;
    }
    for (const src of SOURCES) {
      this.q[src].splice(0, at[src]);
      this.qBytes[src] = this.q[src].reduce((n, x) => n + x.cost, 0);
    }
    return picked;
  }

  private async closeBatch(): Promise<void> {
    const picked = this.select();
    if (picked.length === 0) {
      this.firstAt = this.o.now();
      return;
    }
    const first = this.state.next_seq;
    const envelopes: Envelope[] = picked.map((x, i) => ({ ...x.q.line, seq: first + i }));
    const pending: PendingBatch = {
      first_seq: first,
      envelopes,
      spool_idx: picked.flatMap((x, i) => (x.src === "spool" ? [i] : [])),
    };
    // Cursors: after the last picked line of a source, or (queue empty) after everything read,
    // including skipped invalid lines.
    for (const src of SOURCES) {
      const last = picked.filter((x) => x.src === src).at(-1);
      const pos = this[src].position;
      const cur = this.q[src].length === 0 ? pos : last?.q.end;
      if (cur) pending[src] = { ...cur };
    }
    if (this.fenced()) return;
    try {
      await saveState(this.o.statePath, { ...this.state, pending });
    } catch (e) {
      // Nothing is journaled: put the picks back in order and let the loop retry.
      for (const src of SOURCES) {
        this.q[src].unshift(...picked.filter((x) => x.src === src).map((x) => x.q));
        this.qBytes[src] = this.q[src].reduce((n, x) => n + x.cost, 0);
      }
      throw e;
    }
    if (this.dead) return;
    this.state = { ...this.state, pending };
    this.firstAt = this.queued() > 0 ? this.o.now() : 0;
    this.bufFull = false;
    this.notify(pending);
    await this.deliver(pending);
  }

  private notify(p: PendingBatch): void {
    if (!this.o.onSpoolLine) return;
    const idx = p.spool_idx ?? range(p.spool_from ?? p.envelopes.length, p.envelopes.length);
    for (const i of idx) {
      const env = p.envelopes[i];
      if (!env) continue;
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
    this.authLogged = false;
    const tally = { delivered: 0, rejected: [] as Rejection[] };
    if (!(await this.send(p.envelopes, tally))) return;
    if (tally.rejected.length > 0) {
      await this.reject(tally.rejected);
      // Part of the batch was delivered: keep seq contiguous on the hub with a stand-in per
      // rejected envelope (the original stays in rejected/).
      if (tally.delivered > 0 && !(await this.sendStandIns(tally.rejected))) return;
    }
    // Nothing reached the hub when everything was rejected: reuse the seq, no gap on its side.
    await this.commit(p, tally.delivered === 0);
  }

  private async sendStandIns(groups: Rejection[]): Promise<boolean> {
    const standIns = groups.flatMap((g) => g.envs.map((e) => standIn(e, g.status)));
    const t = { delivered: 0, rejected: [] as Rejection[] };
    if (!(await this.send(standIns, t))) return false;
    for (const g of t.rejected) {
      this.o.log(
        "error",
        `hub rejected the stand-ins for seq ${g.envs.map((e) => e.seq).join(",")} (HTTP ${g.status}); the hub will see a seq gap`,
      );
    }
    return true;
  }

  /** Sends envelopes until the hub acks, rejects, or the forwarder stops (false). */
  private async send(
    envs: Envelope[],
    tally: { delivered: number; rejected: Rejection[] },
  ): Promise<boolean> {
    let attempt = 0;
    const cap = this.o.backoffCapMs ?? BACKOFF_CAP_MS;
    while (!this.dead) {
      const out = await this.post(envs);
      this.attempts += 1;
      if (this.dead || out.kind === "aborted") return false;
      if (out.kind === "ok") {
        tally.delivered += envs.length;
        return true;
      }
      if (out.kind === "reject") {
        if (out.status === 413 && envs.length > 1) {
          // Too large for the hub: split and resend the halves (same ids and seq).
          const mid = envs.length >> 1;
          this.o.log("warn", `hub answered 413 for ${envs.length} envelopes; splitting`);
          return (
            (await this.send(envs.slice(0, mid), tally)) &&
            (await this.send(envs.slice(mid), tally))
          );
        }
        tally.rejected.push({ envs, status: out.status, why: out.why });
        return true;
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
    return false;
  }

  private async post(envs: Envelope[]): Promise<Outcome> {
    const cfg = await this.o.getConfig();
    if (!cfg?.hubUrl || !cfg.token) {
      return { kind: "retry", why: "hubUrl or token missing in probe.json" };
    }
    const check = checkHubUrl(cfg.hubUrl, cfg.allowInsecureHub === true);
    if (!check.ok) {
      if (!this.policyLogged) {
        this.o.log("error", HUB_URL_REFUSED);
        this.policyLogged = true;
      }
      return { kind: "retry", why: "hub URL refused by policy" };
    }
    this.policyLogged = false;
    const base = check.url.href.endsWith("/") ? check.url.href : `${check.url.href}/`;
    const body = JSON.stringify({ host: cfg.host, envelopes: envs });
    if (this.fenced()) return { kind: "aborted" };
    const signal = AbortSignal.any([this.ctl.signal, AbortSignal.timeout(this.o.requestTimeoutMs)]);
    try {
      const res = await this.o.fetch(new URL("ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
        body,
        signal,
        redirect: "error", // never carry the bearer token to another host
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

  private async reject(groups: Rejection[]): Promise<void> {
    try {
      await ensurePrivateDir(this.o.rejectedDir);
    } catch (e) {
      this.o.log(
        "error",
        `could not create rejected dir: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const g of groups) {
      const firstSeq = g.envs[0]?.seq ?? 0;
      const lastSeq = g.envs.at(-1)?.seq ?? firstSeq;
      const file = join(this.o.rejectedDir, `${this.o.now()}-${firstSeq}.jsonl`);
      const text = g.envs.map((e) => JSON.stringify(e)).join("\n") + "\n";
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
        `hub rejected batch seq ${firstSeq}..${lastSeq} (${g.why}, HTTP ${g.status}); saved to ${file}`,
      );
    }
    await capRejected(
      this.o.rejectedDir,
      this.o.rejectedMaxFiles ?? REJECTED_MAX_FILES,
      this.o.rejectedMaxBytes ?? REJECTED_MAX_BYTES,
      this.o.log,
    );
  }

  private async commit(p: PendingBatch, rejected: boolean): Promise<void> {
    if (this.fenced()) return;
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
