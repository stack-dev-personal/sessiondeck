import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
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

export class Store {
  readonly db: Database.Database;
  private readonly cache = new Map<string, Database.Statement>();

  private constructor(db: Database.Database) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
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
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
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

  close(): void {
    this.db.close();
  }
}
