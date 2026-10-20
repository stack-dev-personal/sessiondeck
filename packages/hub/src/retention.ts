// Retention: events older than the window are folded into per-session baselines and deleted;
// statusline samples older than their window are deleted. Both work in bounded batches (one
// transaction each) and yield to the event loop between batches so ingest is never stalled for
// longer than one batch.
//
// Invariant: baselines + remaining events (in rowid order) always fold to the sessions table.
// That holds because only a PREFIX of the events table (rowid order) is compacted: the scan stops
// at the first event whose ts is inside the window, so a late-arriving old event behind it waits
// until the prefix reaches it, and a replay order never differs from the ingest order.
//
// Two further rules keep that safe in the field. (1) An event stamped beyond now + clock skew
// (written before ingest bounded ts, or by a bad clock within the skew bound that has since
// passed) is compactable like an old one, never a stopper: one such event must not freeze
// compaction for every host. (2) Every batch is ONE BEGIN IMMEDIATE transaction that reads the
// events and the baselines it folds inside it, so two compactors (the hub timer and a forced
// CLI run) cannot overwrite each other's baselines; the batch is time-budgeted, and baselines
// are read per session from the table instead of copying a map per batch.
import type { Store } from "./db/store.ts";
import { BaselineSessions, foldEvents, type FoldStats } from "./replay.ts";
import type { Logger } from "./ingest/ingestor.ts";

export const DAY_MS = 86_400_000;
/** Events read, folded and deleted per transaction (at most). */
export const COMPACT_BATCH = 100;
/** Fold time per batch; the fold stops (and the batch commits what it did) once exceeded. */
export const COMPACT_BATCH_BUDGET_MS = 10;
/** Events folded between budget checks. */
const SLICE = 20;
/** Samples deleted per transaction. */
export const SAMPLE_BATCH = 5000;
/** Default bound on how far past the hub's clock an envelope ts may be (HUB_MAX_CLOCK_SKEW_MS). */
export const DEFAULT_MAX_CLOCK_SKEW_MS = DAY_MS;

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface CompactResult {
  events: number;
  batches: number;
  sessions: number;
  exceptions: number;
  /** Events compacted only because their ts was beyond maxTs. */
  futureEvents: number;
  elapsedMs: number;
  /** Longest single synchronous batch: the worst time the event loop was held. */
  maxBatchMs: number;
  p50BatchMs: number;
  p99BatchMs: number;
}

export async function compactEvents(
  store: Store,
  log: Logger,
  opts: {
    cutoffMs: number;
    /** Events with ts above this (hub now + allowed skew) are compactable regardless of age. */
    maxTs: number;
    maxOpenSessionsPerHost: number;
    batchSize?: number;
    batchBudgetMs?: number;
    now?: () => number;
  },
): Promise<CompactResult> {
  const t0 = performance.now();
  const size = opts.batchSize ?? COMPACT_BATCH;
  const budget = opts.batchBudgetMs ?? COMPACT_BATCH_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const res: CompactResult = {
    events: 0,
    batches: 0,
    sessions: 0,
    exceptions: 0,
    futureEvents: 0,
    elapsedMs: 0,
    maxBatchMs: 0,
    p50BatchMs: 0,
    p99BatchMs: 0,
  };
  const times: number[] = [];
  const touched = new Set<string>();
  const stats: FoldStats = { exceptions: 0 };
  const source = new BaselineSessions(store);
  const compactable = (ts: number): boolean => ts < opts.cutoffMs || ts > opts.maxTs;
  for (;;) {
    const b0 = performance.now();
    const step = store.writeTransaction(() => {
      const rows = store.listEventsAfterRowid(0, size);
      let n = 0;
      while (n < rows.length && compactable((rows[n] as { ts: number }).ts)) n++;
      if (n === 0) return { done: 0, future: 0, more: false };
      const stamp = now();
      let done = 0;
      while (done < n) {
        const end = Math.min(n, done + SLICE);
        foldEvents(
          source,
          (sn) => {
            store.upsertBaseline(sn, stamp);
            touched.add(sn.session_id);
          },
          rows.slice(done, end),
          log,
          opts.maxOpenSessionsPerHost,
          null,
          stats,
        );
        done = end;
        if (performance.now() - b0 > budget) break;
      }
      let future = 0;
      for (let i = 0; i < done; i++) if ((rows[i] as { ts: number }).ts > opts.maxTs) future++;
      store.deleteEventsRowidRange(
        (rows[0] as { rid: number }).rid,
        (rows[done - 1] as { rid: number }).rid,
      );
      store.advanceCompaction(opts.cutoffMs, done, stamp);
      return { done, future, more: done < n || (n === rows.length && rows.length === size) };
    });
    if (step.done === 0) break;
    res.events += step.done;
    res.futureEvents += step.future;
    res.batches++;
    times.push(performance.now() - b0);
    if (!step.more) break;
    await yieldLoop();
  }
  res.sessions = touched.size;
  res.exceptions = stats.exceptions;
  if (res.futureEvents > 0) {
    log.warn(
      { future_events: res.futureEvents, max_ts: opts.maxTs },
      "compacted events stamped beyond the allowed clock skew",
    );
  }
  times.sort((a, b) => a - b);
  const q = (p: number): number =>
    Math.round((times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0) * 100) / 100;
  res.maxBatchMs = q(1);
  res.p50BatchMs = q(0.5);
  res.p99BatchMs = q(0.99);
  res.elapsedMs = Math.round(performance.now() - t0);
  log.info(
    {
      events: res.events,
      batches: res.batches,
      sessions: res.sessions,
      ms: res.elapsedMs,
      max_batch_ms: res.maxBatchMs,
      p99_batch_ms: res.p99BatchMs,
    },
    "event compaction",
  );
  return res;
}

export async function pruneSamples(
  store: Store,
  log: Logger,
  opts: { cutoffMs: number; maxTs: number; batchSize?: number },
): Promise<{ samples: number; elapsedMs: number }> {
  const t0 = performance.now();
  const size = opts.batchSize ?? SAMPLE_BATCH;
  let total = 0;
  for (;;) {
    const n = store.transaction(() => store.deleteSamplesOutside(opts.cutoffMs, opts.maxTs, size));
    total += n;
    if (n < size) break;
    await yieldLoop();
  }
  const elapsedMs = Math.round(performance.now() - t0);
  log.info({ samples: total, ms: elapsedMs }, "sample retention");
  return { samples: total, elapsedMs };
}

export interface RetentionConfig {
  eventRetentionDays: number;
  sampleRetentionDays: number;
  maxOpenSessionsPerHost: number;
  /** HUB_MAX_CLOCK_SKEW_MS; default one day. */
  maxClockSkewMs?: number;
  compactBatchSize?: number;
  compactBatchBudgetMs?: number;
}

/** One retention pass: compaction, then sample pruning. */
export async function runRetention(
  store: Store,
  log: Logger,
  cfg: RetentionConfig,
  now: number = Date.now(),
): Promise<{ compact: CompactResult; samples: number }> {
  const maxTs = now + (cfg.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS);
  const compact = await compactEvents(store, log, {
    cutoffMs: now - cfg.eventRetentionDays * DAY_MS,
    maxTs,
    maxOpenSessionsPerHost: cfg.maxOpenSessionsPerHost,
    ...(cfg.compactBatchSize !== undefined ? { batchSize: cfg.compactBatchSize } : {}),
    ...(cfg.compactBatchBudgetMs !== undefined ? { batchBudgetMs: cfg.compactBatchBudgetMs } : {}),
  });
  const s = await pruneSamples(store, log, {
    cutoffMs: now - cfg.sampleRetentionDays * DAY_MS,
    maxTs,
  });
  return { compact, samples: s.samples };
}

/**
 * Runs retention every intervalMs (0 disables). Self-rescheduling, so passes never overlap; a
 * failed pass is logged and the next one is scheduled. Holds no state beyond the timer.
 */
export function startRetentionTimer(
  store: Store,
  log: Logger,
  cfg: RetentionConfig & { intervalMs: number; initialDelayMs?: number },
): { stop: () => void } {
  if (cfg.intervalMs <= 0) return { stop: () => undefined };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void pass(), ms);
    timer.unref();
  };
  const pass = async (): Promise<void> => {
    try {
      await runRetention(store, log, cfg);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "retention pass failed");
    }
    schedule(cfg.intervalMs);
  };
  schedule(cfg.initialDelayMs ?? Math.min(cfg.intervalMs, 30_000));
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
