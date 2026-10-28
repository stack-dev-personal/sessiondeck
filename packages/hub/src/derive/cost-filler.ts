// R2.12. Fills snapshot.cost.usd from the transcript-priced lifetime cost, off the ingest path.
// The ingest transaction never prices anything. After a batch commits, sessions whose transcript
// grew (or that have no cost yet) are marked. A debounce timer (one flush per debounceMs, however
// many batches arrive) then refreshes the usage index (UsageService), reads the same memoized
// figure GET /sessions/:id/cost returns, and writes the snapshot in a short transaction of its
// own. Pricing happens outside that transaction and yields to the event loop between sessions. A
// statusline cost is never replaced. The change leaves through Ingestor.publish, the event WS
// clients already follow. When a session's project_dir changed after its usage rows were indexed,
// UsageService.refresh would rebuild the whole index; that waits for a quiet ingest instead of
// running on the ingest path. State here is only the pending set and a timer; losing it on
// restart costs nothing, the next transcript batch marks again.
import type { SessionSnapshot } from "@sessiondeck/contract";
import type { Store } from "../db/store.ts";
import { rowOf, type BatchCommitted } from "../ingest/ingestor.ts";
import type { PricingProvider } from "../pricing/loader.ts";
import type { UsageService } from "../usage/service.ts";
import { applyCost } from "./apply.ts";

export interface CostFillerLog {
  error(obj: object, msg: string): void;
}

export interface CostFillerOptions {
  /** Window in which batches coalesce into one flush. */
  debounceMs?: number;
  /** Ingest quiet period a full usage-index rebuild waits for. */
  rebuildQuietMs?: number;
  /** A rebuild that has waited this long runs anyway (ingest never goes quiet). */
  rebuildMaxDeferMs?: number;
  /** Milliseconds until ingest has been quiet for quietMs (IngestActivity.waitMs); 0 = quiet now. */
  ingestWaitMs?: (quietMs: number) => number;
  /** Monotonic clock, injectable for tests. */
  clock?: () => number;
}

export const DEFAULT_DEBOUNCE_MS = 1000;
export const DEFAULT_REBUILD_QUIET_MS = 2000;
export const DEFAULT_REBUILD_MAX_DEFER_MS = 60_000;

const USAGE_MARK = '"usage":{';

/** Same memo key GET /sessions/:id/cost uses, so the figure is the identical cached object. */
export const costMemoKey = (zone: string | undefined, id: string): string =>
  `s|${zone ?? ""}|${id}`;

const yieldTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export class CostFiller {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private deferredSince: number | undefined;
  private readonly debounceMs: number;
  private readonly rebuildQuietMs: number;
  private readonly rebuildMaxDeferMs: number;
  private readonly ingestWaitMs: (quietMs: number) => number;
  private readonly clock: () => number;

  constructor(
    private readonly store: Store,
    private readonly usage: UsageService,
    private readonly pricing: PricingProvider,
    private readonly zone: string | undefined,
    private readonly publish: (host: string, sessions: SessionSnapshot[]) => void,
    private readonly log: CostFillerLog,
    opts: CostFillerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.rebuildQuietMs = opts.rebuildQuietMs ?? DEFAULT_REBUILD_QUIET_MS;
    this.rebuildMaxDeferMs = opts.rebuildMaxDeferMs ?? DEFAULT_REBUILD_MAX_DEFER_MS;
    this.ingestWaitMs = opts.ingestWaitMs ?? (() => 0);
    this.clock = opts.clock ?? (() => performance.now());
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Flushes everything marked so far now, skipping the debounce and any rebuild deferral, and
   * resolves when it is processed (tests, graceful shutdown).
   */
  async idle(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
    if (this.pending.size > 0 && !this.closed) {
      this.running = this.running.then(() => this.flush(true));
      await this.running;
    }
  }

  /** Marks the sessions of a committed batch that may need a cost fill. */
  onBatch(b: BatchCommitted): void {
    for (const d of b.transcripts) {
      if (d.lines.some((l) => l.raw.includes(USAGE_MARK))) this.mark(d.session_id);
    }
    for (const s of b.sessions) {
      if (s.sources?.cost === undefined && s.cost.usd === null) this.mark(s.session_id);
    }
  }

  private mark(sessionId: string): void {
    if (this.closed) return;
    this.pending.add(sessionId);
    this.schedule(this.debounceMs);
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.running.then(() => this.flush(false));
    }, delayMs);
    this.timer.unref();
  }

  /** True when refresh() would throw the index away: a session's project_dir moved since indexing. */
  private rebuildPending(): boolean {
    const current = new Map<string, string | null>();
    for (const r of this.store.listSessionProjects()) current.set(r.session_id, r.project_dir);
    return this.usage.index.staleProjects(current);
  }

  /** True when the flush should wait: a rebuild is due and ingest is busy (bounded by max defer). */
  private deferForRebuild(): boolean {
    if (!this.rebuildPending()) return false;
    const now = this.clock();
    this.deferredSince ??= now;
    if (now - this.deferredSince >= this.rebuildMaxDeferMs) return false;
    const wait = this.ingestWaitMs(this.rebuildQuietMs);
    if (wait <= 0) return false;
    this.schedule(Math.max(wait, this.rebuildQuietMs));
    return true;
  }

  private async flush(force: boolean): Promise<void> {
    if (this.closed || this.pending.size === 0) return;
    let ids: string[] = [];
    try {
      if (!force && this.deferForRebuild()) return;
      this.deferredSince = undefined;
      ids = [...this.pending];
      this.pending = new Set();
      await this.fill(ids);
    } catch (err) {
      // A cost fill that fails is a bug or an I/O fault, never silent: logged with the sessions.
      this.log.error(
        { err: err instanceof Error ? err.message : "unknown", sessions: ids.length },
        "cost fill failed",
      );
    }
  }

  private async fill(ids: string[]): Promise<void> {
    await this.usage.refresh();
    if (this.closed) return; // shutdown during the refresh: the DB may be closing
    const table = this.pricing.current();
    const costs = new Map<string, number>();
    for (const id of ids) {
      if (this.closed) return;
      const found = this.usage.memo(
        costMemoKey(this.zone, id),
        table,
        () => this.usage.index.sessions(table, this.zone, id)[0],
      );
      if (found !== undefined) costs.set(id, found.cost_usd);
      await yieldTurn(); // one session's re-sum per turn: ingest requests interleave
    }
    if (this.closed) return;
    const changed = new Map<string, SessionSnapshot[]>();
    this.store.transaction(() => {
      for (const [id, cost] of costs) {
        const row = this.store.getSession(id);
        if (row === undefined) continue;
        const snap = JSON.parse(row.snapshot) as SessionSnapshot;
        const next = applyCost(snap, cost);
        if (next === snap) continue;
        this.store.upsertSession(rowOf(next));
        changed.set(next.host, [...(changed.get(next.host) ?? []), next]);
      }
    });
    for (const [host, sessions] of changed) this.publish(host, sessions);
  }
}
