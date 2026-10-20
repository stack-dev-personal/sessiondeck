import {
  createSnapshot,
  reduce,
  reduceLiveness,
  supersedeSamePid,
  type Envelope,
  type SessionSnapshot,
} from "@sessiondeck/contract";
import { EventEmitter } from "node:events";
import type { SampleRow, SessionRow, Store, TranscriptLineRow } from "../db/store.ts";
import { applyStatusLine, applySubagents, parseTranscriptPayload } from "./reduce.ts";
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

export type HubEvents = { batch: [BatchCommitted] };
export type HubEmitter = EventEmitter<HubEvents>;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  last_seq: number;
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

function cwdOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const cwd = (payload as Record<string, unknown>)["cwd"];
    if (typeof cwd === "string") return cwd;
  }
  return "";
}

/**
 * One transaction per batch: dedup (id and (host, seq) by constraint, then the 5 s signature
 * window), insert, reduce, upsert snapshots, then emit. A reducer exception is logged and counted
 * and the event stays stored; a SQL error rolls the whole batch back.
 */
export class Ingestor {
  readonly events: HubEmitter = new EventEmitter<HubEvents>();
  private exceptions = 0;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
  ) {}

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
    this.log.info(
      {
        host,
        count: envelopes.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        ms: Math.round((performance.now() - started) * 100) / 100,
      },
      "ingest batch",
    );
    return result;
  }

  private apply(host: string, envelopes: readonly Envelope[], out: BatchCommitted): IngestResult {
    const store = this.store;
    const cache = new Map<string, SessionSnapshot | undefined>();
    const original = new Map<string, SessionSnapshot | undefined>();
    const dirty = new Set<string>();
    const transcripts = new Map<string, TranscriptDelta>();
    let accepted = 0;
    let duplicates = 0;
    const known = store.getHost(host);
    let lastSeq = known?.last_seq ?? null;
    let os = known?.os ?? null;

    const load = (id: string): SessionSnapshot | undefined => {
      if (!cache.has(id)) {
        const row = store.getSession(id);
        const snap = row === undefined ? undefined : (JSON.parse(row.snapshot) as SessionSnapshot);
        cache.set(id, snap);
        original.set(id, snap);
      }
      return cache.get(id);
    };
    const set = (snap: SessionSnapshot): void => {
      load(snap.session_id);
      cache.set(snap.session_id, snap);
      if (snap !== original.get(snap.session_id)) dirty.add(snap.session_id);
    };

    const supersede = (snap: SessionSnapshot, ts: number): void => {
      if (snap.pid === null) return;
      const candidates = new Map<string, SessionSnapshot>();
      for (const row of store.listOpenSessionsForHost(snap.host)) {
        candidates.set(
          row.session_id,
          load(row.session_id) ?? (JSON.parse(row.snapshot) as SessionSnapshot),
        );
      }
      for (const [id, s] of cache)
        if (s !== undefined && s.host === snap.host) candidates.set(id, s);
      const before = [...candidates.values()];
      const after = supersedeSamePid(before, {
        host: snap.host,
        session_id: snap.session_id,
        pid: snap.pid,
        ts,
      });
      after.forEach((s, i) => {
        if (s !== before[i]) set(s);
      });
    };

    const reduceOne = (env: Envelope, sessionId: string): SampleRow | null => {
      const prev = load(sessionId);
      const fresh = (): SessionSnapshot =>
        createSnapshot({
          session_id: sessionId,
          host: env.host,
          cwd: cwdOf(env.payload),
          ts: env.ts,
        });
      switch (env.kind) {
        case "hook": {
          const next = reduce(prev ?? fresh(), env as Envelope<"hook">);
          set(next);
          if (env.hook_event_name === "SessionStart") supersede(next, env.ts);
          return null;
        }
        case "liveness": {
          const base = prev ?? fresh();
          const next = reduceLiveness(base, env as Envelope<"liveness">);
          set(next);
          if (next.pid !== base.pid) supersede(next, env.ts);
          return null;
        }
        case "statusline": {
          const r = applyStatusLine(prev ?? fresh(), env, (field) =>
            this.log.warn({ envelope_id: env.id, field }, "used_percentage out of range, nulled"),
          );
          set(r.snapshot);
          return r.sample;
        }
        case "subagents":
          set(applySubagents(prev ?? fresh(), env));
          return null;
        default:
          return null;
      }
    };

    for (const env of envelopes) {
      if (lastSeq === null || env.seq > lastSeq) lastSeq = env.seq;
      os = env.os;

      const signature = computeEventSignature(env);
      if (store.hasSignatureWithin(signature, env.ts, SIGNATURE_WINDOW_MS)) {
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
      if (env.session_id === null || env.kind === "probe") continue;

      // Pure computation inside try; SQL effects happen after, outside it, so a SQL error aborts the batch.
      let sample: SampleRow | null = null;
      let lines: { line_no: number; raw: string }[] = [];
      try {
        if (env.kind === "transcript") lines = parseTranscriptPayload(env.payload);
        else sample = reduceOne(env, env.session_id);
      } catch (err) {
        this.exceptions++;
        this.log.warn(
          { envelope_id: env.id, kind: env.kind, err: err instanceof Error ? err.name : "unknown" },
          "reducer exception",
        );
      }
      if (sample !== null) store.upsertSample(sample);
      if (lines.length > 0) {
        const agent = env.agent_id ?? "";
        const fresh: TranscriptDelta["lines"] = [];
        for (const l of lines) {
          const row: TranscriptLineRow = {
            session_id: env.session_id,
            agent_id: agent,
            line_no: l.line_no,
            ts: env.ts,
            raw: l.raw,
          };
          if (store.insertTranscriptLine(row)) fresh.push({ ...l, ts: env.ts });
        }
        if (fresh.length > 0) {
          const key = `${env.session_id}\u0000${agent}`;
          const d = transcripts.get(key) ?? {
            session_id: env.session_id,
            agent_id: agent,
            lines: [],
          };
          d.lines.push(...fresh);
          transcripts.set(key, d);
        }
      }
    }

    if (os !== null && lastSeq !== null && envelopes.length > 0) {
      store.upsertHost({ host, os, last_seen: this.clock(), last_seq: lastSeq });
    }
    for (const id of dirty) {
      const s = cache.get(id);
      if (s === undefined) continue;
      store.upsertSession(rowOf(s));
      out.sessions.push(s);
    }
    out.transcripts.push(...transcripts.values());
    return { accepted, duplicates, last_seq: lastSeq ?? 0 };
  }
}
