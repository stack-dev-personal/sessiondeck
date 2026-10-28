// Rebuilds every derived row from stored events: session snapshots and statusline samples. The
// reducer is the same SnapshotEngine ingest uses, so replay of the retained events reproduces the
// ingest-time snapshots exactly. Replay starts from the compaction baselines where they exist.
//
// Concurrency: the whole rebuild is ONE write transaction (BEGIN IMMEDIATE). A hub running on the
// same database file keeps serving reads (WAL snapshot of the old state) and its ingest writes
// wait up to busy_timeout (5 s) and then fail with SQLITE_BUSY (the probe retries from its spool),
// so nothing ingested during a replay can be lost or interleaved. A crash or exception rolls
// back and leaves the old snapshots. Run it with the hub stopped for a clean experience; the
// hub's in-process state (WS clients, usage index) would go stale, so the CLI refuses while the
// serving hub's lease is fresh.
import type { Envelope, HostOs, SessionSnapshot } from "@sessiondeck/contract";
import type { EventRow, SampleRow, Store } from "./db/store.ts";
import { parseArchiveEnvelope } from "./ingest/archive.ts";
import { MemSessions, SnapshotEngine, type SessionSource } from "./ingest/engine.ts";
import { rowOf, type Logger } from "./ingest/ingestor.ts";

/** Events read per page, and events per engine (an engine stands in for one ingest batch). */
const PAGE = 2000;
const CHUNK = 500;

/** The os field is not stored per event and no reducer reads it. */
const REPLAY_OS: HostOs = "linux";

export function toEnvelope(row: EventRow): Envelope {
  return {
    v: 1,
    id: row.id,
    kind: row.kind as Envelope["kind"],
    host: row.host,
    os: REPLAY_OS,
    session_id: row.session_id,
    ...(row.agent_id !== null ? { agent_id: row.agent_id } : {}),
    ...(row.hook_event_name !== null ? { hook_event_name: row.hook_event_name } : {}),
    ts: row.ts,
    seq: row.seq,
    payload: JSON.parse(row.payload) as unknown,
  };
}

export interface FoldStats {
  exceptions: number;
}

/**
 * Folds events (already in ingest order) into source; commit receives every snapshot a chunk
 * changed, after the chunk (the next chunk's engine reads it back from source). Transcript and probe envelopes and events
 * without a session do not touch snapshots, exactly as at ingest. A reducer exception is logged
 * with the envelope id and counted, and the event is skipped, as at ingest.
 */
export function foldEvents(
  source: SessionSource,
  commit: (sn: SessionSnapshot) => void,
  rows: readonly EventRow[],
  log: Logger,
  maxOpenSessionsPerHost: number,
  onSample: ((s: SampleRow) => void) | null,
  stats: FoldStats,
): void {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const engine = new SnapshotEngine(source, log, maxOpenSessionsPerHost);
    const end = Math.min(rows.length, i + CHUNK);
    for (let j = i; j < end; j++) {
      const row = rows[j] as EventRow;
      if (row.session_id === null || row.kind === "probe" || row.kind === "transcript") continue;
      let env: Envelope;
      try {
        env = toEnvelope(row);
        engine.load(row.session_id);
        if (row.kind === "archive") {
          // Same rule as ingest: validated, no admit(), never the reducers. A stored event that
          // fails validation (written by a hub that predates the check) is skipped, id only.
          const parsed = parseArchiveEnvelope(env);
          if (parsed === null) {
            log.warn(
              { envelope_id: row.id, reason: "invalid_archive" },
              "stored archive event skipped",
            );
          } else if (engine.applyArchive(parsed) === "host_mismatch") {
            log.warn(
              { envelope_id: row.id, reason: "archive_host_mismatch" },
              "stored archive event skipped",
            );
          }
          continue;
        }
        const sample = engine.reduceOne(env, row.session_id);
        if (sample !== null && onSample !== null) onSample(sample);
      } catch (err) {
        stats.exceptions++;
        log.warn(
          { envelope_id: row.id, kind: row.kind, err: err instanceof Error ? err.name : "unknown" },
          "reducer exception",
        );
      }
    }
    for (const sn of engine.dirtySnapshots()) commit(sn);
  }
}

export function loadBaselines(store: Store): MemSessions {
  const mem = new MemSessions();
  for (const b of store.listBaselines()) {
    mem.map.set(b.session_id, JSON.parse(b.snapshot) as SessionSnapshot);
  }
  return mem;
}

/**
 * Compaction's view of the baselines: reads go to the session_baselines table, so a batch sees
 * what other writers committed (it runs inside the batch's own write transaction) and no
 * whole-map copy or full load is needed per batch.
 */
export class BaselineSessions implements SessionSource {
  constructor(private readonly store: Store) {}

  get(id: string): SessionSnapshot | undefined {
    const raw = this.store.getBaseline(id);
    return raw === undefined ? undefined : (JSON.parse(raw) as SessionSnapshot);
  }

  listOpenForHost(host: string, skip: (id: string) => boolean): SessionSnapshot[] {
    return this.store
      .listOpenBaselinesForHost(host)
      .map((raw) => JSON.parse(raw) as SessionSnapshot)
      .filter((sn) => !skip(sn.session_id));
  }

  countOpenForHost(host: string): number {
    return this.store.countOpenBaselinesForHost(host);
  }
}

export interface ReplayOptions {
  maxOpenSessionsPerHost: number;
  /**
   * Samples outside [minTs, maxTs] are not rebuilt: the retention window must not be undone by
   * replay (a pruned sample must not come back from a retained statusline event).
   */
  sampleWindow?: { minTs: number; maxTs: number };
  /** Called after every page of events, inside the transaction (tests use it to interleave). */
  onProgress?: (eventsSoFar: number) => void;
}

export interface ReplayResult {
  sessions: number;
  events: number;
  samples: number;
  exceptions: number;
  elapsedMs: number;
}

export function replay(store: Store, log: Logger, opts: ReplayOptions): ReplayResult {
  const t0 = performance.now();
  return store.writeTransaction(() => {
    const mem = loadBaselines(store);
    const stats: FoldStats = { exceptions: 0 };
    let events = 0;
    let samples = 0;
    const win = opts.sampleWindow;
    const onSample = (s: SampleRow): void => {
      if (win !== undefined && (s.ts < win.minTs || s.ts > win.maxTs)) return;
      store.upsertSample(s);
      samples++;
    };
    const commit = (sn: SessionSnapshot): void => void mem.map.set(sn.session_id, sn);
    let after = 0;
    for (;;) {
      const rows = store.listEventsAfterRowid(after, PAGE);
      if (rows.length === 0) break;
      foldEvents(mem, commit, rows, log, opts.maxOpenSessionsPerHost, onSample, stats);
      events += rows.length;
      after = (rows[rows.length - 1] as { rid: number }).rid;
      opts.onProgress?.(events);
      if (rows.length < PAGE) break;
    }
    store.deleteAllSessions();
    for (const sn of mem.map.values()) store.upsertSession(rowOf(sn));
    return {
      sessions: mem.map.size,
      events,
      samples,
      exceptions: stats.exceptions,
      elapsedMs: Math.round(performance.now() - t0),
    };
  });
}
