// Retention: events older than the window are folded into per-session baselines and deleted;
// statusline samples older than their window are deleted. Both work in bounded batches (one
// transaction each) and yield to the event loop between batches so ingest is never stalled for
// longer than one batch.
//
// Invariant: baselines + remaining events (in rowid order) always fold to the sessions table.
// That holds because only a PREFIX of the events table (rowid order) is compacted: the scan stops
// at the first event whose ts is inside the window, so a late-arriving old event behind it waits
// until the prefix reaches it, and a replay order never differs from the ingest order.
import type { Store } from "./db/store.ts";
import { loadBaselines, foldEvents, type FoldStats } from "./replay.ts";
import type { Logger } from "./ingest/ingestor.ts";

export const DAY_MS = 86_400_000;
/** Events folded and deleted per transaction. Stall is one batch plus a possible WAL checkpoint fsync; measured by scripts/bench-replay.mjs. */
export const COMPACT_BATCH = 500;
/** Samples deleted per transaction. */
export const SAMPLE_BATCH = 5000;

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface CompactResult {
  events: number;
  batches: number;
  sessions: number;
  exceptions: number;
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
    maxOpenSessionsPerHost: number;
    batchSize?: number;
    now?: () => number;
  },
): Promise<CompactResult> {
  const t0 = performance.now();
  const size = opts.batchSize ?? COMPACT_BATCH;
  const now = opts.now ?? Date.now;
  const res: CompactResult = {
    events: 0,
    batches: 0,
    sessions: 0,
    exceptions: 0,
    elapsedMs: 0,
    maxBatchMs: 0,
    p50BatchMs: 0,
    p99BatchMs: 0,
  };
  const times: number[] = [];
  const first = store.listEventsAfterRowid(0, 1)[0];
  if (first !== undefined && first.ts < opts.cutoffMs) {
    const mem = loadBaselines(store);
    const touched = new Set<string>();
    const stats: FoldStats = { exceptions: 0 };
    for (;;) {
      const b0 = performance.now();
      const rows = store.listEventsAfterRowid(0, size);
      let n = 0;
      while (n < rows.length && (rows[n] as { ts: number }).ts < opts.cutoffMs) n++;
      if (n === 0) break;
      const prefix = rows.slice(0, n);
      const before = new Map(mem.map);
      foldEvents(mem, prefix, log, opts.maxOpenSessionsPerHost, null, stats);
      store.transaction(() => {
        for (const [id, sn] of mem.map) {
          if (before.get(id) === sn) continue;
          store.upsertBaseline(id, JSON.stringify(sn), now());
          touched.add(id);
        }
        store.deleteEventsRowidRange(
          (prefix[0] as { rid: number }).rid,
          (prefix[n - 1] as { rid: number }).rid,
        );
        store.advanceCompaction(opts.cutoffMs, n, now());
      });
      res.events += n;
      res.batches++;
      times.push(performance.now() - b0);
      if (n < rows.length || rows.length < size) break;
      await yieldLoop();
    }
    res.sessions = touched.size;
    res.exceptions = stats.exceptions;
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
  opts: { cutoffMs: number; batchSize?: number },
): Promise<{ samples: number; elapsedMs: number }> {
  const t0 = performance.now();
  const size = opts.batchSize ?? SAMPLE_BATCH;
  let total = 0;
  for (;;) {
    const n = store.transaction(() => store.deleteSamplesBefore(opts.cutoffMs, size));
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
}

/** One retention pass: compaction, then sample pruning. */
export async function runRetention(
  store: Store,
  log: Logger,
  cfg: RetentionConfig,
  now: number = Date.now(),
): Promise<{ compact: CompactResult; samples: number }> {
  const compact = await compactEvents(store, log, {
    cutoffMs: now - cfg.eventRetentionDays * DAY_MS,
    maxOpenSessionsPerHost: cfg.maxOpenSessionsPerHost,
  });
  const s = await pruneSamples(store, log, { cutoffMs: now - cfg.sampleRetentionDays * DAY_MS });
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
