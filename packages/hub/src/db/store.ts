import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { migrations } from "./migrations.ts";

export interface HostRow {
  host: string;
  os: string | null;
  last_seen: number | null;
  last_seq: number | null;
}

export interface SessionRow {
  session_id: string;
  host: string | null;
  snapshot: string;
  state: string | null;
  project_dir: string | null;
  started_at: number | null;
  last_event_at: number | null;
  ended_at: number | null;
}

export interface ProjectRow {
  project_dir: string;
  name: string | null;
  color: string | null;
  vault_collection: string | null;
}

export interface EventRow {
  id: string;
  host: string;
  seq: number;
  kind: string;
  session_id: string | null;
  agent_id: string | null;
  hook_event_name: string | null;
  ts: number;
  payload: string;
  signature: string | null;
}

export interface SampleRow {
  session_id: string;
  ts: number;
  context_used_pct: number | null;
  cost_usd: number | null;
  five_hour_pct: number | null;
  five_hour_resets: number | null;
  seven_day_pct: number | null;
  seven_day_resets: number | null;
}

export interface UsageLineRow {
  session_id: string;
  raw: string;
}

export interface TranscriptLineRow {
  session_id: string;
  agent_id: string;
  line_no: number;
  ts: number;
  raw: string;
}

export class Store {
  readonly db: Database.Database;
  private readonly cache = new Map<string, Database.Statement>();

  private constructor(db: Database.Database) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)",
    );
  }

  /** Prepared on first use (tables may not exist before migrate) and cached. SQL is always a literal. */
  private stmt(sql: string): Database.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  static open(dbPath: string): Store {
    const file = dbPath !== ":memory:";
    const dir = path.dirname(path.resolve(dbPath));
    // mkdirSync returns the first directory it created (undefined if it already existed).
    const created = file ? mkdirSync(dir, { recursive: true, mode: 0o700 }) : undefined;
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    if (file && process.platform !== "win32") {
      // Payloads and raw transcript lines may hold secrets: owner-only.
      // Only tighten a directory this process created; never touch a pre-existing one.
      if (created !== undefined) {
        try {
          chmodSync(created, 0o700);
        } catch {
          // best effort
        }
      } else if ((statSync(dir).mode & 0o077) !== 0) {
        process.emitWarning(`hub data directory ${dir} is group/world accessible`);
      }
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(f)) chmodSync(f, 0o600);
      }
    }
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return new Store(db);
  }

  schemaVersion(): number {
    return (
      this.stmt("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
        v: number;
      }
    ).v;
  }

  /** Applies pending migrations in order, each in its own transaction. Returns versions applied. */
  migrate(): number[] {
    const applied: number[] = [];
    for (const m of migrations) {
      if (m.version <= this.schemaVersion()) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.stmt("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          m.version,
          m.name,
          Date.now(),
        );
      });
      applied.push(m.version);
    }
    return applied;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getHost(host: string): HostRow | undefined {
    return this.stmt("SELECT * FROM hosts WHERE host = ?").get(host) as HostRow | undefined;
  }

  upsertHost(row: HostRow): void {
    this.stmt(
      `INSERT INTO hosts (host, os, last_seen, last_seq) VALUES (@host, @os, @last_seen, @last_seq)
       ON CONFLICT(host) DO UPDATE SET os = excluded.os, last_seen = excluded.last_seen, last_seq = excluded.last_seq`,
    ).run(row);
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.stmt("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      SessionRow | undefined;
  }

  upsertSession(row: SessionRow): void {
    this.stmt(
      `INSERT INTO sessions (session_id, host, snapshot, state, project_dir, started_at, last_event_at, ended_at)
       VALUES (@session_id, @host, @snapshot, @state, @project_dir, @started_at, @last_event_at, @ended_at)
       ON CONFLICT(session_id) DO UPDATE SET host = excluded.host, snapshot = excluded.snapshot, state = excluded.state,
         project_dir = excluded.project_dir, started_at = excluded.started_at,
         last_event_at = excluded.last_event_at, ended_at = excluded.ended_at`,
    ).run(row);
  }

  /** An event with this signature and |ts - ts'| < windowMs exists (events_signature_ts index, a range seek). */
  hasSignatureWithin(signature: string, ts: number, windowMs: number): boolean {
    return (
      this.stmt("SELECT 1 AS x FROM events WHERE signature = ? AND ts > ? AND ts < ? LIMIT 1").get(
        signature,
        ts - windowMs,
        ts + windowMs,
      ) !== undefined
    );
  }

  /** True when a row was inserted; false when id or (host, seq) already exists. */
  insertEvent(e: EventRow): boolean {
    return (
      this.stmt(
        `INSERT INTO events (id, host, seq, kind, session_id, agent_id, hook_event_name, ts, payload, signature)
         VALUES (@id, @host, @seq, @kind, @session_id, @agent_id, @hook_event_name, @ts, @payload, @signature)
         ON CONFLICT DO NOTHING`,
      ).run(e).changes === 1
    );
  }

  /** Latest statusline sample per (session_id, ts) wins. */
  upsertSample(s: SampleRow): void {
    this.stmt(
      `INSERT INTO statusline_samples (session_id, ts, context_used_pct, cost_usd, five_hour_pct, five_hour_resets, seven_day_pct, seven_day_resets)
       VALUES (@session_id, @ts, @context_used_pct, @cost_usd, @five_hour_pct, @five_hour_resets, @seven_day_pct, @seven_day_resets)
       ON CONFLICT(session_id, ts) DO UPDATE SET context_used_pct = excluded.context_used_pct, cost_usd = excluded.cost_usd,
         five_hour_pct = excluded.five_hour_pct, five_hour_resets = excluded.five_hour_resets,
         seven_day_pct = excluded.seven_day_pct, seven_day_resets = excluded.seven_day_resets`,
    ).run(s);
  }

  /** True when the line was new; a re-sent (session, agent, line_no) is ignored. */
  insertTranscriptLine(l: TranscriptLineRow): boolean {
    return (
      this.stmt(
        `INSERT INTO transcript_lines (session_id, agent_id, line_no, ts, raw)
         VALUES (@session_id, @agent_id, @line_no, @ts, @raw) ON CONFLICT DO NOTHING`,
      ).run(l).changes === 1
    );
  }

  /**
   * Sessions of a host that are not in state 'ended'; the caller filters by pid. Written as a
   * range pair (state < 'ended' OR state > 'ended') so sessions_host_state seeks both sides and
   * ended rows are never visited; `<>` would scan every session the host ever had.
   */
  listOpenSessionsForHost(host: string): SessionRow[] {
    return this.stmt(
      "SELECT * FROM sessions WHERE host = ? AND (state < 'ended' OR state > 'ended')",
    ).all(host) as SessionRow[];
  }

  countOpenSessionsForHost(host: string): number {
    return (
      this.stmt(
        "SELECT COUNT(*) AS n FROM sessions WHERE host = ? AND (state < 'ended' OR state > 'ended')",
      ).get(host) as { n: number }
    ).n;
  }

  countHosts(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM hosts").get() as { n: number }).n;
  }

  /** Newest first (started_at, falling back to last_event_at); session_id breaks ties stably. */
  listSessions(limit: number): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions ORDER BY COALESCE(started_at, last_event_at, 0) DESC, session_id LIMIT ?`,
    ).all(limit) as SessionRow[];
  }

  /**
   * R2.6. Every session except those in state ended or exited whose end time (ended_at, else
   * last_event_at) is older than cutoffMs. A session with no end time at all counts as old.
   */
  listLiveSessions(cutoffMs: number, limit: number): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions
       WHERE state IS NULL OR state NOT IN ('ended', 'exited')
          OR COALESCE(ended_at, last_event_at, 0) >= ?
       ORDER BY COALESCE(started_at, last_event_at, 0) DESC, session_id LIMIT ?`,
    ).all(cutoffMs, limit) as SessionRow[];
  }

  /** Events of one session ordered by seq (a session lives on one host), seq > after. */
  listSessionEvents(sessionId: string, after: number, limit: number): EventRow[] {
    return this.stmt(
      "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    ).all(sessionId, after, limit) as EventRow[];
  }

  /** Raw stored lines, line_no > after; agentId null means every agent (ordered agent, line). */
  listTranscriptLines(
    sessionId: string,
    agentId: string | null,
    after: number,
    limit: number,
  ): TranscriptLineRow[] {
    return agentId === null
      ? (this.stmt(
          "SELECT * FROM transcript_lines WHERE session_id = ? AND line_no > ? ORDER BY agent_id, line_no LIMIT ?",
        ).all(sessionId, after, limit) as TranscriptLineRow[])
      : (this.stmt(
          "SELECT * FROM transcript_lines WHERE session_id = ? AND agent_id = ? AND line_no > ? ORDER BY line_no LIMIT ?",
        ).all(sessionId, agentId, after, limit) as TranscriptLineRow[]);
  }

  /**
   * Raw lines that carry a usage block ('"usage":{' is also ccusage's own line filter), one
   * session, ordered (agent_id, line_no): main transcript first, then subagents.
   */
  iterateSessionUsageLines(sessionId: string): IterableIterator<UsageLineRow> {
    return this.stmt(
      `SELECT session_id, raw FROM transcript_lines
       WHERE session_id = ? AND instr(raw, '"usage":{') > 0 ORDER BY agent_id, line_no`,
    ).iterate(sessionId) as IterableIterator<UsageLineRow>;
  }

  /** Same filter across every session, ordered (session_id, agent_id, line_no). */
  iterateAllUsageLines(): IterableIterator<UsageLineRow> {
    return this.stmt(
      `SELECT session_id, raw FROM transcript_lines
       WHERE instr(raw, '"usage":{') > 0 ORDER BY session_id, agent_id, line_no`,
    ).iterate() as IterableIterator<UsageLineRow>;
  }

  /** Configured projects plus every project_dir seen on a session. */
  listProjects(limit: number): ProjectRow[] {
    return this.stmt(
      `SELECT project_dir, name, color, vault_collection FROM projects
       UNION
       SELECT DISTINCT s.project_dir, NULL, NULL, NULL FROM sessions s
         WHERE s.project_dir IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.project_dir = s.project_dir)
       ORDER BY 1 LIMIT ?`,
    ).all(limit) as ProjectRow[];
  }

  listHosts(limit: number): HostRow[] {
    return this.stmt("SELECT * FROM hosts ORDER BY host LIMIT ?").all(limit) as HostRow[];
  }

  close(): void {
    this.db.close();
  }
}
