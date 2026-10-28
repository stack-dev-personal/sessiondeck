// Session-state reduction shared by live ingest and by replay/compaction. The engine owns the
// per-run snapshot cache, the per-host pid index (supersede) and the open-session cap; where
// snapshots are read from is a SessionSource, so the same code path runs against the database
// (ingest) and against an in-memory map (replay, compaction). Time comes only from envelope ts.
import {
  createSnapshot,
  type ArchiveEnvelope,
  reduce,
  reduceLiveness,
  supersedeSamePid,
  type Envelope,
  type SessionSnapshot,
} from "@sessiondeck/contract";
import type { SampleRow } from "../db/store.ts";
import {
  archiveOnlySnapshot,
  archiveRecordOf,
  isArchiveOnly,
  isOpenSnapshot,
  sameArchive,
  type ArchiveOutcome,
  type ArchivedSnapshot,
} from "./archive.ts";
import { applyStatusLine, applySubagents, clampSnapshot } from "./reduce.ts";

export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface SessionSource {
  get(id: string): SessionSnapshot | undefined;
  /** Non-ended sessions of a host; ids for which skip() is true need not be returned. */
  listOpenForHost(host: string, skip: (id: string) => boolean): SessionSnapshot[];
  countOpenForHost(host: string): number;
}

/** In-memory sessions: the replay and compaction state. */
export class MemSessions implements SessionSource {
  readonly map = new Map<string, SessionSnapshot>();

  get(id: string): SessionSnapshot | undefined {
    return this.map.get(id);
  }

  listOpenForHost(host: string, skip: (id: string) => boolean): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const s of this.map.values()) {
      if (s.host === host && isOpenSnapshot(s) && !skip(s.session_id)) out.push(s);
    }
    return out;
  }

  countOpenForHost(host: string): number {
    let n = 0;
    for (const s of this.map.values()) if (s.host === host && isOpenSnapshot(s)) n++;
    return n;
  }
}

function cwdOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const cwd = (payload as Record<string, unknown>)["cwd"];
    if (typeof cwd === "string") return cwd;
  }
  return "";
}

/** One engine per batch (ingest) or per chunk of events (replay, compaction). */
export class SnapshotEngine {
  private readonly cache = new Map<string, SessionSnapshot | undefined>();
  private readonly original = new Map<string, SessionSnapshot | undefined>();
  private readonly dirty = new Set<string>();
  private readonly pidIndex = new Map<string, Map<number, Set<string>>>();
  private readonly openCount = new Map<string, number>();
  private readonly capLogged = new Set<string>();

  constructor(
    private readonly source: SessionSource,
    private readonly log: EngineLogger,
    private readonly maxOpenSessionsPerHost: number,
  ) {}

  load(id: string): SessionSnapshot | undefined {
    if (!this.cache.has(id)) {
      const snap = this.source.get(id);
      this.cache.set(id, snap);
      this.original.set(id, snap);
    }
    return this.cache.get(id);
  }

  /** The snapshot as first loaded in this run (before any change), if the session existed. */
  before(id: string): SessionSnapshot | undefined {
    return this.original.get(id);
  }

  /** Changed snapshots in first-change order. */
  dirtySnapshots(): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const id of this.dirty) {
      const s = this.cache.get(id);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  // Per-batch pid index, built lazily per host from ONE source query, so supersede costs
  // O(sessions on that pid) per call instead of a table scan per envelope.
  private reindex(old: SessionSnapshot | undefined, next: SessionSnapshot): void {
    const idx = this.pidIndex.get(next.host);
    if (idx === undefined) return;
    if (old?.pid != null) idx.get(old.pid)?.delete(old.session_id);
    if (next.pid !== null) {
      const ids = idx.get(next.pid) ?? new Set<string>();
      ids.add(next.session_id);
      idx.set(next.pid, ids);
    }
  }

  private hostIndex(h: string): Map<number, Set<string>> {
    let idx = this.pidIndex.get(h);
    if (idx === undefined) {
      for (const snap of this.source.listOpenForHost(h, (id) => this.cache.has(id))) {
        this.cache.set(snap.session_id, snap);
        this.original.set(snap.session_id, snap);
      }
      idx = new Map();
      this.pidIndex.set(h, idx);
      for (const sn of this.cache.values())
        if (sn !== undefined && sn.host === h) this.reindex(undefined, sn);
    }
    return idx;
  }

  private set(raw: SessionSnapshot): void {
    const snap = clampSnapshot(raw);
    const old = this.load(snap.session_id);
    this.cache.set(snap.session_id, snap);
    this.reindex(old, snap);
    if (snap !== this.original.get(snap.session_id)) this.dirty.add(snap.session_id);
    // Keep the cached open count exact: ingest (probe batches) and replay (chunks) must admit and
    // refuse at the same event, so a session that ends frees its slot and a revived one takes it.
    const n = this.openCount.get(snap.host);
    if (n !== undefined && old !== undefined) {
      const wasOpen = isOpenSnapshot(old);
      const isOpen = isOpenSnapshot(snap);
      if (wasOpen && !isOpen) this.openCount.set(snap.host, n - 1);
      else if (!wasOpen && isOpen) this.openCount.set(snap.host, n + 1);
    }
  }

  // Open-session cap per host: counted lazily, once per host per engine.
  private admit(h: string, take = true): boolean {
    const n = this.openCount.get(h) ?? this.source.countOpenForHost(h);
    if (n >= this.maxOpenSessionsPerHost) {
      if (!this.capLogged.has(h)) {
        this.capLogged.add(h);
        this.log.warn({ host: h.slice(0, 64) }, "open session cap reached, session not created");
      }
      this.openCount.set(h, n);
      return false;
    }
    this.openCount.set(h, take ? n + 1 : n);
    return true;
  }

  // A new session_id or a changed pid ends the other non-terminal sessions on that host and pid.
  // Only liveness envelopes ever carry a pid; hook envelopes never do, so the SessionStart call
  // is a no-op in practice and the liveness path does the work.
  private supersede(snap: SessionSnapshot, ts: number): void {
    if (snap.pid === null) return;
    const ids = this.hostIndex(snap.host).get(snap.pid);
    if (ids === undefined) return;
    const before = [...ids].flatMap((id) => {
      const sn = this.cache.get(id);
      return sn === undefined ? [] : [sn];
    });
    const after = supersedeSamePid(before, {
      host: snap.host,
      session_id: snap.session_id,
      pid: snap.pid,
      ts,
    });
    after.forEach((sn, i) => {
      if (sn !== before[i]) this.set(sn);
    });
  }

  /**
   * R5.3. Attaches a validated archive envelope to the session row identified by its session_id
   * (host must match; the caller checks first so a mismatch is not stored). Never calls admit():
   * an archive creates an `archived` row, which does not count against the open-session cap.
   * Live fields are kept; a live session stays live; an older source.mtime_ms never replaces a
   * newer one; an identical record changes nothing (no dirty snapshot, so no row write, WS delta
   * or search re-index).
   */
  applyArchive(env: ArchiveEnvelope): ArchiveOutcome {
    const prev = this.load(env.session_id) as ArchivedSnapshot | undefined;
    if (prev !== undefined && prev.host !== env.host) return "host_mismatch";
    const rec = archiveRecordOf(env.payload);
    if (prev === undefined) {
      this.set(archiveOnlySnapshot(env, rec));
      return "created";
    }
    const old = prev.archive;
    if (old !== undefined) {
      if (rec.source.mtime_ms < old.source.mtime_ms) return "stale";
      if (sameArchive(old, rec)) return "unchanged";
    }
    // Still archive-only (no live event yet): the synthetic fields follow the new capture.
    if (old !== undefined && isArchiveOnly(prev)) {
      this.set(archiveOnlySnapshot(env, rec));
      return "replaced";
    }
    this.set({ ...prev, archive: rec } as SessionSnapshot);
    return old === undefined ? "merged" : "replaced";
  }

  /** Reduces one non-transcript envelope into the cache; returns the statusline sample, if any. */
  reduceOne(env: Envelope, sessionId: string): SampleRow | null {
    // Archive envelopes go through applyArchive; they never reach the reducers or admit().
    if (env.kind === "archive") return null;
    let prev = this.load(sessionId) as ArchivedSnapshot | undefined;
    if (prev === undefined && !this.admit(env.host)) return null;
    // R5.3: the first live event for a session known only from its capture. The synthetic ended
    // snapshot is not a live history (the reducer would refuse most events on an ended session), so
    // the live fields start fresh from this event and the archive record stays attached. set()
    // takes the open slot when the result is live; a refused slot leaves the archive-only row.
    if (prev !== undefined && isArchiveOnly(prev) && prev.host === env.host) {
      if (!this.admit(env.host, false)) return null;
      prev = {
        ...createSnapshot({
          session_id: sessionId,
          host: env.host,
          cwd: cwdOf(env.payload),
          ts: env.ts,
        }),
        archive: prev.archive as NonNullable<typeof prev.archive>,
      };
    }
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
        this.set(next);
        if (env.hook_event_name === "SessionStart") this.supersede(next, env.ts);
        return null;
      }
      case "liveness": {
        const base = prev ?? fresh();
        const next = reduceLiveness(base, env as Envelope<"liveness">);
        this.set(next);
        if (next.pid !== base.pid) this.supersede(next, env.ts);
        return null;
      }
      case "statusline": {
        const r = applyStatusLine(prev ?? fresh(), env, (field) =>
          this.log.warn({ envelope_id: env.id, field }, "used_percentage out of range, nulled"),
        );
        if (r.sample === null) {
          this.log.warn({ envelope_id: env.id }, "statusline for another host ignored");
        }
        this.set(r.snapshot);
        return r.sample;
      }
      case "subagents":
        this.set(applySubagents(prev ?? fresh(), env));
        return null;
      default:
        return null;
    }
  }
}
