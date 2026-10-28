// R2.12. Fills snapshot.cost.usd from the transcript-priced lifetime cost, off the ingest path.
// The ingest transaction never prices anything. After a batch commits, sessions whose transcript
// grew (or that have no cost yet) are marked; one flush per tick, coalesced per session, refreshes
// the usage index (UsageService), reads the same memoized figure GET /sessions/:id/cost returns,
// and writes the snapshot in its own short transaction. A statusline cost is never replaced. The
// change leaves through Ingestor.publish, the event WS clients already follow. State here is only
// the pending set; losing it on restart costs nothing, the next transcript batch marks again.
import type { SessionSnapshot } from "@sessiondeck/contract";
import type { Store } from "../db/store.ts";
import { rowOf, type BatchCommitted } from "../ingest/ingestor.ts";
import type { PricingProvider } from "../pricing/loader.ts";
import type { UsageService } from "../usage/service.ts";
import { applyCost } from "./apply.ts";

export interface CostFillerLog {
  error(obj: object, msg: string): void;
}

const USAGE_MARK = '"usage":{';

/** Same memo key GET /sessions/:id/cost uses, so the figure is the identical cached object. */
export const costMemoKey = (zone: string | undefined, id: string): string =>
  `s|${zone ?? ""}|${id}`;

export class CostFiller {
  private pending = new Set<string>();
  private scheduled = false;
  private running: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly usage: UsageService,
    private readonly pricing: PricingProvider,
    private readonly zone: string | undefined,
    private readonly publish: (host: string, sessions: SessionSnapshot[]) => void,
    private readonly log: CostFillerLog,
  ) {}

  close(): void {
    this.closed = true;
  }

  /** Resolves when everything marked so far has been processed (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.running;
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
    if (this.scheduled) return;
    this.scheduled = true;
    this.running = this.running.then(() =>
      new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.flush()),
    );
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const ids = [...this.pending];
    this.pending = new Set();
    if (this.closed || ids.length === 0) return;
    try {
      await this.usage.refresh();
      const table = this.pricing.current();
      const changed = new Map<string, SessionSnapshot[]>();
      this.store.transaction(() => {
        for (const id of ids) {
          const found = this.usage.memo(
            costMemoKey(this.zone, id),
            table,
            () => this.usage.index.sessions(table, this.zone, id)[0],
          );
          if (found === undefined) continue;
          const row = this.store.getSession(id);
          if (row === undefined) continue;
          const snap = JSON.parse(row.snapshot) as SessionSnapshot;
          const next = applyCost(snap, found.cost_usd);
          if (next === snap) continue;
          this.store.upsertSession(rowOf(next));
          changed.set(next.host, [...(changed.get(next.host) ?? []), next]);
        }
      });
      for (const [host, sessions] of changed) this.publish(host, sessions);
    } catch (err) {
      // A cost fill that fails is a bug or an I/O fault, never silent: logged with the sessions.
      this.log.error(
        { err: err instanceof Error ? err.message : "unknown", sessions: ids.length },
        "cost fill failed",
      );
    }
  }
}
