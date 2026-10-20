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
import type { IngestActivity } from "./ingest/activity.ts";

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

/**
 * After each batch compaction rests for REST_FACTOR times the batch's own duration (1 to 50 ms), so
 * it takes at most a third of the event loop. A bare setImmediate yield put a batch in every loop
 * turn, and one ingest request needs several turns (body chunks, handler, reply); measured in
 * docs/HUB.md "Load harness", ingest p95 doubled while a pass ran.
 */
export const COMPACT_REST_FACTOR = 2;
const rest = (batchMs: number): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.min(50, Math.max(1, Math.round(batchMs * COMPACT_REST_FACTOR)))),
  );

/** Compaction starts a batch only after ingest has been quiet this long (ms). */
export const COMPACT_QUIET_MS = 15;
/** The longest one batch waits for a quiet moment before it runs anyway, so a saturated hub still drains. */
export const COMPACT_MAX_YIELD_MS = 250;
/** Default cap on events compacted per pass (HUB_COMPACT_MAX_EVENTS); the remainder drains in follow-up passes. */
export const DEFAULT_COMPACT_MAX_EVENTS = 1_000_000;
/** After a pass stopped at its cap the next one is scheduled this soon instead of a full interval. */
export const CAPPED_FOLLOW_UP_MS = 60_000;

/**
 * While serving, compaction pauses for COMPACT_BREATH_MS after every COMPACT_BREATH_BATCHES batches.
 * The checkpoint worker (checkpoint.ts, every 100 ms) can only let SQLite restart the WAL when it
 * has copied every frame before the next write begins; compaction writes every few milliseconds, so
 * without a gap the WAL grew to the writer's safety-net threshold and the commit that crossed it
 * ran the checkpoint inline (23 batches of 20 to 90 ms per 600k events, measured; docs/HUB.md "Load
 * harness"), which is exactly the ingest p95 it was meant to protect.
 */
export const COMPACT_BREATH_BATCHES = 100;
export const COMPACT_BREATH_MS = 150;

export interface CompactResult {
  /** True when the pass stopped at maxEvents with more left to compact. */
  capped: boolean;
  /** Time spent waiting for ingest to go quiet, and batches that ran only because the wait hit its cap. */
  yieldedMs: number;
  /** Time spent in the periodic pause that lets the WAL restart. */
  breathMs: number;
  forcedBatches: number;
  events: number;
  batches: number;
  sessions: number;
  exceptions: number;
  /** Events compacted only because their ts was beyond maxTs. */
  futureEvents: number;
  elapsedMs: number;
  /** Longest single synchronous batch: the worst time the event loop was held. */
  maxBatchMs: number;
  /** Batches that held the event loop for more than 10 ms. */
  slowBatches: number;
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
    /** Yield to ingest: a batch waits until no ingest request is in flight and none ended recently. */
    activity?: Pick<IngestActivity, "waitMs">;
    quietMs?: number;
    maxYieldMs?: number;
    /** Pause breathMs after every breathBatches batches (only with `activity`); 0 disables. */
    breathBatches?: number;
    breathMs?: number;
    /** Stop after this many events (0 or absent: no cap). */
    maxEvents?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<CompactResult> {
  const t0 = performance.now();
  const size = opts.batchSize ?? COMPACT_BATCH;
  const budget = opts.batchBudgetMs ?? COMPACT_BATCH_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const quietMs = opts.quietMs ?? COMPACT_QUIET_MS;
  const maxYieldMs = opts.maxYieldMs ?? COMPACT_MAX_YIELD_MS;
  const maxEvents = opts.maxEvents !== undefined && opts.maxEvents > 0 ? opts.maxEvents : Infinity;
  const breathBatches = Math.max(1, opts.breathBatches ?? COMPACT_BREATH_BATCHES);
  const breathMs = opts.breathMs ?? COMPACT_BREATH_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const res: CompactResult = {
    capped: false,
    yieldedMs: 0,
    breathMs: 0,
    forcedBatches: 0,
    events: 0,
    batches: 0,
    sessions: 0,
    exceptions: 0,
    futureEvents: 0,
    elapsedMs: 0,
    maxBatchMs: 0,
    slowBatches: 0,
    p50BatchMs: 0,
    p99BatchMs: 0,
  };
  const times: number[] = [];
  const touched = new Set<string>();
  const stats: FoldStats = { exceptions: 0 };
  const source = new BaselineSessions(store);
  const compactable = (ts: number): boolean => ts < opts.cutoffMs || ts > opts.maxTs;
  for (;;) {
    if (opts.activity !== undefined) {
      let waited = 0;
      for (;;) {
        const w = opts.activity.waitMs(quietMs);
        if (w <= 0) break;
        if (waited >= maxYieldMs) {
          res.forcedBatches++;
          break;
        }
        const d = Math.min(Math.max(1, Math.ceil(w)), maxYieldMs - waited);
        await sleep(d);
        waited += d;
      }
      res.yieldedMs += waited;
    }
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
    const took = performance.now() - b0;
    times.push(took);
    if (!step.more) break;
    if (res.events >= maxEvents) {
      // Capped only if something compactable is actually left (the last batch may have been the end).
      const next = store.listEventsAfterRowid(0, 1)[0];
      res.capped = next !== undefined && compactable(next.ts);
      break;
    }
    if (opts.activity !== undefined && res.batches % breathBatches === 0 && breathMs > 0) {
      await sleep(breathMs);
      res.breathMs += breathMs;
    }
    await rest(took);
  }
  res.sessions = touched.size;
  res.exceptions = stats.exceptions;
  if (res.futureEvents > 0) {
    log.warn(
      { future_events: res.futureEvents, max_ts: opts.maxTs },
      "compacted events stamped beyond the allowed clock skew",
    );
  }
  res.slowBatches = times.filter((t) => t > 10).length;
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
      capped: res.capped,
      yielded_ms: Math.round(res.yieldedMs),
      breath_ms: res.breathMs,
      forced_batches: res.forcedBatches,
      batches: res.batches,
      sessions: res.sessions,
      ms: res.elapsedMs,
      max_batch_ms: res.maxBatchMs,
      slow_batches: res.slowBatches,
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
  /** HUB_COMPACT_MAX_EVENTS: events compacted per pass; 0 or absent for no cap. */
  compactMaxEvents?: number;
  /** Ingest activity to yield to; absent for offline runs (CLI) that have no ingest to protect. */
  activity?: Pick<IngestActivity, "waitMs">;
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
    ...(cfg.compactMaxEvents !== undefined ? { maxEvents: cfg.compactMaxEvents } : {}),
    ...(cfg.activity !== undefined ? { activity: cfg.activity } : {}),
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
    let next = cfg.intervalMs;
    try {
      const r = await runRetention(store, log, cfg);
      // A pass cut short by its cap leaves a backlog: come back soon rather than in an hour.
      if (r.compact.capped) next = Math.min(next, CAPPED_FOLLOW_UP_MS);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "retention pass failed");
    }
    schedule(next);
  };
  schedule(cfg.initialDelayMs ?? Math.min(cfg.intervalMs, 30_000));
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
