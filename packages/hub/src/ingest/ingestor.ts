import { type Envelope, type SessionSnapshot } from "@sessiondeck/contract";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import type { SampleRow, SessionRow, Store, TranscriptLineRow } from "../db/store.ts";
import { SnapshotEngine, type SessionSource } from "./engine.ts";
import { parseTranscriptPayload } from "./reduce.ts";
import { SIGNATURE_WINDOW_MS, computeEventSignature } from "./signature.ts";

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TranscriptDelta {
  session_id: string;
  agent_id: string;
  lines: { line_no: number; raw: string; ts: number }[];
}

/** Emitted once per committed batch, after the transaction commits. */
export interface BatchCommitted {
  host: string;
  /** Final snapshot of every session the batch changed. */
  sessions: SessionSnapshot[];
  transcripts: TranscriptDelta[];
}

/** `atlas`: sessions whose project or phase presentation changed by a PATCH (no ingest involved). */
export type HubEvents = { batch: [BatchCommitted]; atlas: [SessionSnapshot[]] };
export type HubEmitter = EventEmitter<HubEvents>;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  /**
   * Envelopes older than the compaction watermark. Their id and signature can no longer be checked
   * (the events were deleted), so hook, statusline and other envelopes are acknowledged but not
   * stored. Transcript envelopes are not in this count: their lines are always inserted.
   */
  expired: number;
  /**
   * The batch's acknowledged max (D-S3-6): the highest seq among THIS batch's envelopes, each of
   * which was either stored or recognized as a duplicate; 0 for an empty batch. It is never a max
   * across time, so a hostile huge seq in one batch cannot appear in a later response. The probe
   * must not trim its spool by last_seq beyond what it sent in that batch. Host identity is not
   * bound to a credential until per-host tokens exist: a token holder can pre-insert (host, seq)
   * rows for another host or squat its seq space. Accepted risk, same bucket as host squatting.
   */
  last_seq: number;
}

export interface IngestLimits {
  /** New sessions for a host are not created once it has this many open sessions. */
  maxOpenSessionsPerHost: number;
}

export function rowOf(s: SessionSnapshot): SessionRow {
  return {
    session_id: s.session_id,
    host: s.host,
    snapshot: JSON.stringify(s),
    state: s.state,
    project_dir: s.project_dir,
    started_at: s.started_at,
    last_event_at: s.last_event_at,
    ended_at: s.state === "ended" ? s.state_since : null,
  };
}

/** Live snapshots: the sessions table. */
class StoreSessions implements SessionSource {
  constructor(private readonly store: Store) {}

  get(id: string): SessionSnapshot | undefined {
    const row = this.store.getSession(id);
    return row === undefined ? undefined : (JSON.parse(row.snapshot) as SessionSnapshot);
  }

  listOpenForHost(host: string, skip: (id: string) => boolean): SessionSnapshot[] {
    // The listed rows already carry the snapshot: no per-session point SELECT.
    return this.store
      .listOpenSessionsForHost(host)
      .filter((r) => !skip(r.session_id))
      .map((r) => JSON.parse(r.snapshot) as SessionSnapshot);
  }

  countOpenForHost(host: string): number {
    return this.store.countOpenSessionsForHost(host);
  }
}

/**
 * One transaction per batch: dedup (id and (host, seq) by constraint, then the 5 s signature
 * window), insert, reduce, upsert snapshots, then emit. A reducer exception is logged and counted
 * and the event stays stored; a SQL error rolls the whole batch back.
 */
export class Ingestor {
  readonly events: HubEmitter = new EventEmitter<HubEvents>();
  private exceptions = 0;

  private readonly source: SessionSource;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
    private readonly limits: IngestLimits = { maxOpenSessionsPerHost: 1000 },
  ) {
    this.source = new StoreSessions(store);
  }

  reducerExceptionCount(): number {
    return this.exceptions;
  }

  ingest(host: string, envelopes: readonly Envelope[]): IngestResult {
    const started = performance.now();
    const batch: BatchCommitted = { host, sessions: [], transcripts: [] };
    const result = this.store.transaction(() => this.apply(host, envelopes, batch));
    // Committed from here on.
    try {
      this.events.emit("batch", batch);
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : "listener error" },
        "ingest listener threw",
      );
    }
    if (result.expired > 0) {
      this.log.warn(
        { host: host.slice(0, 64), expired: result.expired, count: envelopes.length },
        "ingest envelopes older than the compaction watermark were not stored",
      );
    }
    this.log.info(
      {
        host: host.slice(0, 64), // bounded at the route (128); truncated again so logs stay small
        count: envelopes.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        expired: result.expired,
        ms: Math.round((performance.now() - started) * 100) / 100,
      },
      "ingest batch",
    );
    return result;
  }

  private apply(host: string, envelopes: readonly Envelope[], out: BatchCommitted): IngestResult {
    const store = this.store;
    const engine = new SnapshotEngine(this.source, this.log, this.limits.maxOpenSessionsPerHost);
    const transcripts = new Map<string, TranscriptDelta>();
    let accepted = 0;
    let duplicates = 0;
    let expired = 0;
    const known = store.getHost(host);
    // hosts.last_seq is observability only: the highest seq ever STORED. It is never returned.
    let storedMax = known?.last_seq ?? null;
    // The acknowledged max of this batch, returned to the sender (D-S3-6).
    let batchMax: number | null = null;
    let os = known?.os ?? null;
    // Events older than the compaction watermark were deleted, so their id and signature can no
    // longer be checked: they are acknowledged but not stored or reduced, and counted as expired.
    // Transcript lines have their own primary-key dedup and no dependence on events, so a spool
    // flushed after a long offline period still lands its cost data.
    const compactedBefore = store.getCompactionCut();

    for (const env of envelopes) {
      // Stored or duplicate, every envelope of the batch is acknowledged.
      if (batchMax === null || env.seq > batchMax) batchMax = env.seq;
      os = env.os;

      if (compactedBefore !== null && env.ts < compactedBefore) {
        if (env.kind !== "transcript" || env.session_id === null) {
          expired++;
          continue;
        }
        let lines: { line_no: number; raw: string }[] = [];
        try {
          lines = parseTranscriptPayload(env.payload);
        } catch (err) {
          this.exceptions++;
          this.log.warn(
            {
              envelope_id: env.id,
              kind: env.kind,
              err: err instanceof Error ? err.name : "unknown",
            },
            "reducer exception",
          );
        }
        if (this.insertLines(env, env.session_id, lines, transcripts) > 0) accepted++;
        else duplicates++;
        continue;
      }
      const signature = computeEventSignature(env);
      if (store.hasSignatureWithin(signature, env.session_id, env.ts, SIGNATURE_WINDOW_MS)) {
        duplicates++;
        continue;
      }
      const inserted = store.insertEvent({
        id: env.id,
        host: env.host,
        seq: env.seq,
        kind: env.kind,
        session_id: env.session_id,
        agent_id: env.agent_id ?? null,
        hook_event_name: env.hook_event_name ?? null,
        ts: env.ts,
        payload: JSON.stringify(env.payload),
        signature,
      });
      if (!inserted) {
        duplicates++;
        continue;
      }
      accepted++;
      if (storedMax === null || env.seq > storedMax) storedMax = env.seq;
      if (env.session_id === null || env.kind === "probe") continue;

      // Pure computation inside try; SQL effects happen after, outside it, so a SQL error aborts the batch.
      let sample: SampleRow | null = null;
      let lines: { line_no: number; raw: string }[] = [];
      // Session reads happen before the try so an I/O error is never mistaken for a reducer bug.
      if (env.kind !== "transcript") engine.load(env.session_id);
      try {
        if (env.kind === "transcript") lines = parseTranscriptPayload(env.payload);
        else sample = engine.reduceOne(env, env.session_id);
      } catch (err) {
        // A SQLite error (supersede and admit read the database) is not a reducer exception: it
        // aborts the batch and the transaction rolls back.
        if (err instanceof Database.SqliteError) throw err;
        this.exceptions++;
        this.log.warn(
          { envelope_id: env.id, kind: env.kind, err: err instanceof Error ? err.name : "unknown" },
          "reducer exception",
        );
      }
      if (sample !== null) store.upsertSample(sample);
      this.insertLines(env, env.session_id, lines, transcripts);
    }

    if (os !== null && envelopes.length > 0) {
      store.upsertHost({ host, os, last_seen: this.clock(), last_seq: storedMax });
    }
    for (const sn of engine.dirtySnapshots()) {
      store.upsertSession(rowOf(sn));
      out.sessions.push(sn);
    }
    out.transcripts.push(...transcripts.values());
    return { accepted, duplicates, expired, last_seq: batchMax ?? 0 };
  }

  /** Inserts parsed transcript lines (primary-key dedup) and records the fresh ones; returns how many were new. */
  private insertLines(
    env: Envelope,
    sessionId: string,
    lines: readonly { line_no: number; raw: string }[],
    transcripts: Map<string, TranscriptDelta>,
  ): number {
    if (lines.length === 0) return 0;
    const agent = env.agent_id ?? "";
    const fresh: TranscriptDelta["lines"] = [];
    for (const l of lines) {
      const row: TranscriptLineRow = {
        session_id: sessionId,
        agent_id: agent,
        line_no: l.line_no,
        ts: env.ts,
        raw: l.raw,
      };
      if (this.store.insertTranscriptLine(row)) fresh.push({ ...l, ts: env.ts });
    }
    if (fresh.length > 0) {
      const key = `${sessionId}\u0000${agent}`;
      const d = transcripts.get(key) ?? { session_id: sessionId, agent_id: agent, lines: [] };
      d.lines.push(...fresh);
      transcripts.set(key, d);
    }
    return fresh.length;
  }
}
