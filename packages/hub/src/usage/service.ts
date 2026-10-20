// Keeps the in-memory usage index (UsageCollector) current with transcript_lines. The index is a
// cache: it is rebuilt from the database on startup (or on first use) and advanced by a rowid
// high-water mark, so the hub stays stateless apart from the DB. Refreshing yields to the event
// loop between batches so ingest and WS heartbeats keep running during a cold build.
import type { Store } from "../db/store.ts";
import type { PricingTable } from "../pricing/pricing.ts";
import { UsageCollector } from "./usage.ts";

const BATCH = 2000;
const RESULT_CACHE_MAX = 32;

export interface UsageLog {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export class UsageService {
  readonly index = new UsageCollector();
  private hwm = 0;
  private inflight: Promise<void> | null = null;
  private closed = false;
  private results = new Map<string, unknown>();
  private resultsFor = { version: -1, pricing: undefined as PricingTable | undefined };

  constructor(
    private readonly store: Store,
    private readonly log?: UsageLog,
  ) {}

  close(): void {
    this.closed = true;
  }

  /** Single-flight: concurrent callers share one catch-up pass. */
  refresh(): Promise<void> {
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    const t0 = performance.now();
    let rows = 0;
    for (;;) {
      if (this.closed) return;
      const batch = this.store.listUsageLinesAfter(this.hwm, BATCH);
      for (const r of batch) {
        if (r.raw === null) continue;
        this.index.addRow({
          session_id: r.session_id,
          agent_id: r.agent_id,
          line_no: r.line_no,
          project_dir: r.project_dir,
          raw: r.raw,
        });
      }
      const last = batch.at(-1);
      if (last !== undefined) this.hwm = last.rid;
      rows += batch.length;
      if (batch.length < BATCH) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (rows > 0) {
      this.log?.info(
        { rows, entries: this.index.count, ms: Math.round(performance.now() - t0) },
        "usage index advanced",
      );
    }
  }

  /** Memoizes a read until the index or the pricing table changes (tz/from/to go in the key). */
  memo<T>(key: string, pricing: PricingTable, compute: () => T): T {
    if (this.resultsFor.version !== this.index.version || this.resultsFor.pricing !== pricing) {
      this.results = new Map();
      this.resultsFor = { version: this.index.version, pricing };
    }
    if (this.results.has(key)) return this.results.get(key) as T;
    const v = compute();
    if (this.results.size >= RESULT_CACHE_MAX) this.results.clear();
    this.results.set(key, v);
    return v;
  }
}
