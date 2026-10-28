// R5.2 / R5.3. Pure helpers for envelopes of kind `archive`: validation, the record kept on a
// snapshot (`snapshot.archive`), the synthetic snapshot of a session the hub only knows from its
// vault capture, and the row state a snapshot maps to. Nothing here touches the database, and time
// comes only from the payload (never the wall clock or the envelope ts) so a replay reproduces the
// same snapshots and a re-sent identical capture compares equal.
import {
  ArchiveEnvelopeSchema,
  createSnapshot,
  type ArchiveEnvelope,
  type ArchivePayload,
  type Envelope,
  type SessionSnapshot,
} from "@sessiondeck/contract";

/** What the hub keeps of a capture: the payload minus schema_version and session_id (the row key). */
export type ArchiveRecord = Omit<ArchivePayload, "session_id" | "schema_version">;

/** A snapshot that may carry the archive record (additive; the contract type does not know it). */
export type ArchivedSnapshot = SessionSnapshot & { archive?: ArchiveRecord };

/**
 * The envelope with its payload replaced by the parsed, strict one, or null when it is not a valid
 * archive envelope (payload shape, payload.session_id equal to the envelope's). Callers store and
 * reduce only what this returns, never the raw payload.
 */
export function parseArchiveEnvelope(env: Envelope): ArchiveEnvelope | null {
  const r = ArchiveEnvelopeSchema.safeParse(env);
  return r.success ? (r.data as unknown as ArchiveEnvelope) : null;
}

export function archiveRecordOf(p: ArchivePayload): ArchiveRecord {
  // Explicit key order: equality of two records is JSON equality.
  return {
    source: {
      root_label: p.source.root_label,
      rel_path: p.source.rel_path,
      mtime_ms: p.source.mtime_ms,
      size: p.source.size,
    },
    collection: p.collection,
    title: p.title,
    date: p.date,
    started_at: p.started_at,
    ended_at: p.ended_at,
    duration_s: p.duration_s,
    project_dir: p.project_dir,
    branch: p.branch,
    tools_used: p.tools_used.map((t) => ({ name: t.name, count: t.count })),
    commits: [...p.commits],
    prs: [...p.prs],
    outcome: p.outcome,
    outcome_truncated: p.outcome_truncated,
  };
}

export function sameArchive(a: ArchiveRecord, b: ArchiveRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const ISO =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Epoch ms of an ISO date or datetime; a missing zone is UTC (never the host's local zone). */
export function isoToMs(v: string | null): number | null {
  if (v === null) return null;
  const m = v.match(ISO);
  if (m === null) return null;
  const zone =
    m[6] === undefined ? "Z" : m[6].length === 5 ? `${m[6].slice(0, 3)}:${m[6].slice(3)}` : m[6];
  const t = Date.parse(
    `${m[1]!}T${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}${m[5] ?? ""}${zone}`,
  );
  return Number.isFinite(t) ? t : null;
}

/** Start and end (epoch ms) of a capture, from the payload alone. */
export function archiveTimes(a: ArchiveRecord): { started: number; ended: number } {
  const dur = a.duration_s === null ? null : Math.round(a.duration_s * 1000);
  let started = isoToMs(a.started_at) ?? isoToMs(a.date);
  let ended = isoToMs(a.ended_at);
  if (ended === null && started !== null && dur !== null) ended = started + dur;
  if (started === null && ended !== null && dur !== null) started = ended - dur;
  const s = started ?? ended ?? a.source.mtime_ms;
  return { started: s, ended: Math.max(ended ?? s, s) };
}

/** The snapshot of a session known only from its capture: ended, with the capture's times. */
export function archiveOnlySnapshot(env: ArchiveEnvelope, a: ArchiveRecord): ArchivedSnapshot {
  const { started, ended } = archiveTimes(a);
  const base = createSnapshot({
    session_id: env.session_id,
    host: env.host,
    cwd: a.project_dir ?? "",
    ts: ended,
  });
  return {
    ...base,
    state: "ended",
    state_since: ended,
    started_at: started,
    last_event_at: ended,
    project_dir: a.project_dir,
    session_name: a.title,
    git: { branch: a.branch, worktree: null, pr: null },
    archive: a,
  };
}

/** True while no live event has touched an archive-only snapshot (its last_event_at is still the capture's). */
export function isArchiveOnly(s: ArchivedSnapshot): boolean {
  return (
    s.archive !== undefined &&
    s.state === "ended" &&
    s.last_event_at === archiveTimes(s.archive).ended
  );
}

/**
 * The sessions.state column for a snapshot: a session that has an archive entry and is no longer
 * live (ended or exited) is `archived`; a live one keeps its state and stays on the board.
 */
export function rowStateOf(s: ArchivedSnapshot): string {
  return s.archive !== undefined && (s.state === "ended" || s.state === "exited")
    ? "archived"
    : s.state;
}

/** Counts against the per-host open-session cap: the SQL twin is `state NOT IN ('ended','archived')`. */
export function isOpenSnapshot(s: ArchivedSnapshot): boolean {
  const st = rowStateOf(s);
  return st !== "ended" && st !== "archived";
}

export type ArchiveOutcome =
  "created" | "merged" | "replaced" | "unchanged" | "stale" | "host_mismatch";
