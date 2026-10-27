import type { SessionSnapshot } from "@sessiondeck/contract";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inferProject, projectIdOf } from "../atlas/infer.ts";
import { buildMatch, indexSessionText } from "../atlas/search.ts";
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
  /** Set by the store on upsert (inference or manual override); callers building rows omit it. */
  project_id?: string | null;
  /** Manual phase label (materialized from session_overrides). */
  phase_label?: string | null;
}

export interface ProjectRow {
  project_dir: string;
  name: string | null;
  color: string | null;
  vault_collection: string | null;
  id?: string | null;
}

export interface ProjectSummary {
  id: string;
  project_dir: string;
  name: string;
  color: string;
  vault_collection: string | null;
  sessions: number;
  live: number;
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

export interface UsageFeedRow {
  rid: number;
  session_id: string;
  agent_id: string;
  line_no: number;
  raw: string | null;
  project_dir: string | null;
}

export interface TranscriptLineRow {
  session_id: string;
  agent_id: string;
  line_no: number;
  ts: number;
  raw: string;
}

const INDEXED_AS_MAX = 4096;
const SEARCH_MAX_FAILURES = 3;
const SEARCH_QUARANTINE_MS = 60_000;
const SEARCH_FLUSH_MS = 200;

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
    // Explicit, so the level does not depend on the SQLITE_DEFAULT_WAL_SYNCHRONOUS build flag.
    db.pragma("synchronous = NORMAL");
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

  /** Test hook: migrations above this version are not applied (to seed pre-migration data). */
  migrateCeiling = Number.MAX_SAFE_INTEGER;

  /** Applies pending migrations in order, each in its own transaction. Returns versions applied. */
  migrate(): number[] {
    const applied: number[] = [];
    for (const m of migrations) {
      if (m.version <= this.schemaVersion() || m.version > this.migrateCeiling) continue;
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
    // Path inference is code, not SQL: assign projects to rows that predate migration 6.
    // Runs on every open at version >= 6 (cheap when nothing is NULL), so a crash between migration 6 and the backfill heals.
    if (this.schemaVersion() >= 6) this.backfillAtlas();
    if (this.schemaVersion() >= 7) this.backfillSearch();
    if (this.schemaVersion() >= 8) {
      // Rows left dirty by a crash are indexed on open.
      try {
        this.flushSearchIndex();
      } catch (err) {
        this.onSearchFlushError(err);
      }
    }
    return applied;
  }

  /** R5.1. Gives every session without a project one (inference, or its override) and every project an id. Idempotent. */
  backfillAtlas(): number {
    return this.transaction(() => {
      this.fillProjectIds();
      const rows = this.stmt(
        "SELECT session_id, project_dir, snapshot FROM sessions WHERE project_id IS NULL",
      ).all() as { session_id: string; project_dir: string | null; snapshot: string }[];
      for (const r of rows) {
        const pid = this.resolveProjectId(r.session_id, r.project_dir, () => cwdOf(r.snapshot));
        const ov = this.stmt("SELECT phase FROM session_overrides WHERE session_id = ?").get(
          r.session_id,
        ) as { phase: string | null } | undefined;
        this.stmt(
          "UPDATE sessions SET project_id = ?, phase_label = COALESCE(?, phase_label) WHERE session_id = ?",
        ).run(pid, ov?.phase ?? null, r.session_id);
      }
      return rows.length;
    });
  }

  private fillProjectIds(): void {
    const rows = this.stmt("SELECT project_dir FROM projects WHERE id IS NULL").all() as {
      project_dir: string;
    }[];
    for (const r of rows) {
      this.stmt(
        "UPDATE projects SET id = ?, created_at = COALESCE(created_at, ?) WHERE project_dir = ?",
      ).run(this.freeProjectId(r.project_dir), Date.now(), r.project_dir);
    }
  }

  /** Test hook: derives a project id from a key (forces collisions in tests). */
  projectIdFn: (key: string) => string = projectIdOf;

  /** The derived id, or the derived id plus a numeric suffix when another project already holds it. */
  private freeProjectId(key: string): string {
    const base = this.projectIdFn(key);
    for (let n = 0; ; n++) {
      const id = n === 0 ? base : `${base}_${n}`;
      if (this.stmt("SELECT 1 FROM projects WHERE id = ?").get(id) === undefined) return id;
    }
  }

  /** Inserts the project when absent (default name and color) and returns its id. */
  ensureProject(key: string, name: string, color: string): string {
    // A key collision on id (never expected at 128 bits) must not throw inside an ingest
    // transaction: the id is checked for a holder first and gets a suffix when taken.
    this.stmt(
      `INSERT INTO projects (project_dir, name, color, id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_dir) DO UPDATE SET
         name = COALESCE(projects.name, excluded.name),
         color = COALESCE(projects.color, excluded.color)`,
    ).run(key, name, color, this.freeProjectId(key), Date.now());
    const row = this.stmt("SELECT id FROM projects WHERE project_dir = ?").get(key) as {
      id: string | null;
    };
    if (row.id !== null) {
      this.indexProject(row.id);
      return row.id;
    }
    const id = this.freeProjectId(key);
    this.stmt("UPDATE projects SET id = ? WHERE project_dir = ?").run(id, key);
    this.indexProject(id);
    return id;
  }

  /** Manual override if any (and its project still exists), else the inferred project (created on demand). */
  private resolveProjectId(
    sessionId: string,
    projectDir: string | null,
    cwd: () => string | null,
  ): string {
    const ov = this.stmt(
      `SELECT o.project_id FROM session_overrides o JOIN projects p ON p.id = o.project_id
       WHERE o.session_id = ?`,
    ).get(sessionId) as { project_id: string } | undefined;
    if (ov !== undefined) return ov.project_id;
    const inf = inferProject(projectDir, cwd());
    return this.ensureProject(inf.key, inf.name, inf.color);
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

  /** Bumped whenever a write changes some session's project_dir (usage index staleness signal). */
  projectsVersion = 0;
  /** Number of listSessionProjects() scans (test observability). */
  projectScans = 0;

  upsertSession(row: SessionRow): void {
    const prev = this.stmt("SELECT project_dir, project_id FROM sessions WHERE session_id = ?").get(
      row.session_id,
    ) as
      | {
          project_dir: string | null;
          project_id: string | null;
        }
      | undefined;
    if ((prev?.project_dir ?? null) !== row.project_dir) this.projectsVersion++;
    // The project is re-derived only for a new row or when project_dir changed (cwd never does):
    // the hot path of an unchanged session adds no parse and no write.
    let projectId = prev?.project_id ?? null;
    let phaseLabel: string | null = null;
    if (prev === undefined || projectId === null || prev.project_dir !== row.project_dir) {
      projectId = this.resolveProjectId(row.session_id, row.project_dir, () => cwdOf(row.snapshot));
    }
    if (prev === undefined) {
      phaseLabel =
        (
          this.stmt("SELECT phase FROM session_overrides WHERE session_id = ?").get(
            row.session_id,
          ) as { phase: string | null } | undefined
        )?.phase ?? null;
    }
    this.stmt(
      `INSERT INTO sessions (session_id, host, snapshot, state, project_dir, started_at, last_event_at, ended_at, project_id, phase_label, search_dirty)
       VALUES (@session_id, @host, @snapshot, @state, @project_dir, @started_at, @last_event_at, @ended_at, @project_id, @phase_label, 1)
       ON CONFLICT(session_id) DO UPDATE SET host = excluded.host, snapshot = excluded.snapshot, state = excluded.state,
         project_dir = excluded.project_dir, started_at = excluded.started_at,
         last_event_at = excluded.last_event_at, ended_at = excluded.ended_at, project_id = excluded.project_id, search_dirty = 1`,
    ).run({
      session_id: row.session_id,
      host: row.host,
      snapshot: row.snapshot,
      state: row.state,
      project_dir: row.project_dir,
      started_at: row.started_at,
      last_event_at: row.last_event_at,
      ended_at: row.ended_at,
      project_id: projectId,
      phase_label: phaseLabel,
    });
    // R5.4: the search index follows the row, but not inside the ingest transaction. The UPSERT
    // above already set sessions.search_dirty (durable, same statement, so a crash cannot lose it);
    // here only the flush timer is armed. flushSearchIndex() indexes every dirty row from its
    // committed state in its own transaction, once per flush however many updates arrived. A
    // rolled-back batch rolls the flag back with the row.
    this.armSearchFlush();
  }

  // ---- R5.4 search index (FTS5) ------------------------------------------------------------

  /**
   * Writes one search document unless its text is unchanged. Returns null when nothing changed,
   * else what was there before (`existed`, and the project of the old document).
   */
  private putDoc(
    kind: string,
    refId: string,
    projectId: string | null,
    title: string,
    body: string,
  ): { existed: boolean; prevProject: string | null } | null {
    const hash = createHash("sha1")
      .update(`${projectId ?? ""}\u0000${title}\u0000${body}`)
      .digest("hex");
    const cur = this.stmt(
      "SELECT id, hash, project_id FROM search_docs WHERE kind = ? AND ref_id = ?",
    ).get(kind, refId) as { id: number; hash: string; project_id: string | null } | undefined;
    if (cur?.hash === hash) return null;
    let id: number;
    if (cur === undefined) {
      id = Number(
        this.stmt(
          "INSERT INTO search_docs (kind, ref_id, project_id, hash) VALUES (?, ?, ?, ?)",
        ).run(kind, refId, projectId, hash).lastInsertRowid,
      );
    } else {
      id = cur.id;
      this.stmt("DELETE FROM search_fts WHERE rowid = ?").run(id);
      this.stmt("UPDATE search_docs SET project_id = ?, hash = ? WHERE id = ?").run(
        projectId,
        hash,
        id,
      );
    }
    this.stmt(
      "INSERT INTO search_fts (rowid, kind, ref_id, project_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, kind, refId, projectId, title, body);
    return { existed: cur !== undefined, prevProject: cur?.project_id ?? null };
  }

  private dropDoc(kind: string, refId: string): void {
    const cur = this.stmt("SELECT id FROM search_docs WHERE kind = ? AND ref_id = ?").get(
      kind,
      refId,
    ) as { id: number } | undefined;
    if (cur === undefined) return;
    this.stmt("DELETE FROM search_fts WHERE rowid = ?").run(cur.id);
    this.stmt("DELETE FROM search_docs WHERE id = ?").run(cur.id);
  }

  /** The phase and project last indexed per session: a cache (a miss falls back to the safe path), capped. */
  private readonly indexedAs = new Map<
    string,
    { phase: string | null; projectId: string | null }
  >();
  /** Cache updates of the flush in progress; applied only after its transaction commits. */
  private readonly indexedPending = new Map<
    string,
    { phase: string | null; projectId: string | null }
  >();
  private readonly flushFailures = new Map<string, number>();
  private readonly quarantined = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Called with a flush failure (the timer must not throw). The server wires this to its logger. */
  onSearchFlushError: (err: unknown) => void = (err) => {
    process.emitWarning(
      `search index flush failed: ${err instanceof Error ? err.message : "error"}`,
    );
  };

  private rememberIndexed(id: string, v: { phase: string | null; projectId: string | null }): void {
    this.indexedAs.delete(id);
    this.indexedAs.set(id, v);
    if (this.indexedAs.size > INDEXED_AS_MAX) {
      const oldest = this.indexedAs.keys().next().value;
      if (oldest !== undefined) this.indexedAs.delete(oldest);
    }
  }

  private armSearchFlush(): void {
    if (this.flushTimer !== undefined || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushSearchIndexSafe();
    }, SEARCH_FLUSH_MS);
    this.flushTimer.unref();
  }

  /** Flush for paths that must not fail (timer, search reads): errors go to onSearchFlushError. */
  private flushSearchIndexSafe(): void {
    try {
      this.flushSearchIndex();
    } catch (err) {
      this.onSearchFlushError(err);
    }
  }

  /**
   * Indexes every session whose search_dirty flag is set, then re-derives the phase documents of
   * the projects whose phases may have lost support (once per project, not once per change).
   * Each session is indexed inside its own savepoint: one bad row is counted and, after
   * SEARCH_MAX_FAILURES, quarantined in memory (skipped for SEARCH_QUARANTINE_MS, then retried;
   * the durable flag stays set so the next open retries too) instead of blocking everyone. Called by the timer, before every search read, on open and close.
   */
  flushSearchIndex(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.closed) return;
    if (this.stmt("SELECT 1 FROM sessions WHERE search_dirty = 1 LIMIT 1").get() === undefined)
      return;
    this.indexedPending.clear();
    try {
      this.transaction(() => {
        const projects = new Set<string>();
        let after = "";
        for (;;) {
          const page = this.stmt(
            `SELECT session_id, snapshot, project_id, phase_label FROM sessions
             WHERE search_dirty = 1 AND session_id > ? ORDER BY session_id LIMIT 500`,
          ).all(after) as {
            session_id: string;
            snapshot: string;
            project_id: string | null;
            phase_label: string | null;
          }[];
          if (page.length === 0) break;
          for (const r of page) {
            const q = this.quarantined.get(r.session_id);
            if (q !== undefined) {
              if (Date.now() - q < SEARCH_QUARANTINE_MS) continue;
              this.quarantined.delete(r.session_id);
            }
            try {
              this.transaction(() => {
                this.indexSession(r.session_id, r.snapshot, r.project_id, r.phase_label, projects);
                this.stmt(
                  "UPDATE sessions SET search_dirty = 0 WHERE session_id = ? AND search_dirty = 1",
                ).run(r.session_id);
              });
              this.flushFailures.delete(r.session_id);
            } catch (err) {
              this.indexedPending.delete(r.session_id);
              const n = (this.flushFailures.get(r.session_id) ?? 0) + 1;
              if (n >= SEARCH_MAX_FAILURES) {
                this.flushFailures.delete(r.session_id);
                this.quarantined.set(r.session_id, Date.now());
                this.onSearchFlushError(
                  new Error(`search index quarantined session ${r.session_id}`, { cause: err }),
                );
              } else {
                this.flushFailures.set(r.session_id, n);
                this.onSearchFlushError(err);
              }
            }
          }
          after = page[page.length - 1]!.session_id;
        }
        for (const p of projects) {
          try {
            this.transaction(() => this.reindexProjectPhases(p));
          } catch (err) {
            this.onSearchFlushError(err);
          }
        }
      });
    } catch (err) {
      this.indexedPending.clear(); // rolled back: the flags are dirty again, the cache must not claim otherwise
      throw err;
    }
    for (const [id, v] of this.indexedPending) this.rememberIndexed(id, v);
    this.indexedPending.clear();
  }

  /**
   * Indexes a session and its phase document. Never throws on a bad snapshot. When the session's
   * phase or project may have changed (or is unknown after a restart) the affected projects are
   * added to `reindex`; with no collector (PATCH, backfill) the caller re-derives phases itself.
   */
  private indexSession(
    sessionId: string,
    snapshot: string,
    projectId: string | null,
    manualPhase: string | null,
    reindex?: Set<string>,
  ): void {
    let snap: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(snapshot);
      if (typeof v === "object" && v !== null) snap = v as Record<string, unknown>;
    } catch {
      // unreadable snapshot: not indexed
    }
    if (snap === null) return;
    const t = indexSessionText(snap, sessionId, manualPhase);
    const last = this.indexedAs.get(sessionId);
    const was = this.putDoc("session", sessionId, projectId, t.title, t.body);
    // Recorded only once the document write succeeded; inside a flush it is applied after commit.
    if (reindex !== undefined) this.indexedPending.set(sessionId, { phase: t.phase, projectId });
    else this.rememberIndexed(sessionId, { phase: t.phase, projectId });
    if (was === null) return;
    if (was.existed && reindex !== undefined) {
      // A renamed phase or a moved session can leave a phase document nobody supports any more.
      if (last === undefined || last.phase !== t.phase || was.prevProject !== projectId) {
        if (projectId !== null) reindex.add(projectId);
        if (was.prevProject !== null) reindex.add(was.prevProject);
        return;
      }
    }
    if (t.phase !== null && projectId !== null) this.putPhaseDoc(projectId, t.phase);
  }

  private putPhaseDoc(projectId: string, phase: string): void {
    const name = (
      this.stmt("SELECT COALESCE(name, '') AS name FROM projects WHERE id = ?").get(projectId) as
        { name: string } | undefined
    )?.name;
    this.putDoc("phase", `${projectId}/${phase}`, projectId, phase, name ?? "");
  }

  private indexProject(id: string): void {
    const p = this.stmt(
      "SELECT project_dir, COALESCE(name, '') AS name, vault_collection FROM projects WHERE id = ?",
    ).get(id) as { project_dir: string; name: string; vault_collection: string | null } | undefined;
    if (p === undefined) return;
    const base = p.project_dir.split("/").filter(Boolean).at(-1) ?? "";
    this.putDoc(
      "project",
      id,
      id,
      p.name || base,
      [base, p.vault_collection ?? ""].filter((x) => x !== "").join("\n"),
    );
  }

  /** Re-derives the phase documents of one project from its sessions (adds new, drops unused). */
  private reindexProjectPhases(projectId: string | null): void {
    if (projectId === null) return;
    const live = new Set<string>();
    for (const r of this.listProjectSessionSnapshots(projectId, 100_000)) {
      try {
        const t = indexSessionText(
          JSON.parse(r.snapshot) as Record<string, unknown>,
          r.session_id,
          r.phase_label,
        );
        if (t.phase !== null) live.add(t.phase);
      } catch {
        // unreadable snapshot: contributes no phase
      }
    }
    for (const phase of live) this.putPhaseDoc(projectId, phase);
    const prefix = `${projectId}/`;
    const have = this.stmt(
      "SELECT ref_id FROM search_docs WHERE kind = 'phase' AND project_id = ?",
    ).all(projectId) as { ref_id: string }[];
    for (const d of have)
      if (!live.has(d.ref_id.slice(prefix.length))) this.dropDoc("phase", d.ref_id);
  }

  private reindexSession(sessionId: string): void {
    const r = this.getSession(sessionId);
    if (r !== undefined)
      this.indexSession(sessionId, r.snapshot, r.project_id ?? null, r.phase_label ?? null);
  }

  /**
   * Indexes every project and session that has no document yet (first open after migration 7).
   * Sessions whose text changed after their first document are repaired by the durable
   * sessions.search_dirty flag (see flushSearchIndex), not here. Idempotent; an open with nothing missing costs two anti-join probes.
   */
  backfillSearch(): number {
    return this.transaction(() => {
      let n = 0;
      for (const p of this.stmt(
        `SELECT id FROM projects p WHERE id IS NOT NULL AND NOT EXISTS
           (SELECT 1 FROM search_docs d WHERE d.kind = 'project' AND d.ref_id = p.id)`,
      ).all() as {
        id: string;
      }[]) {
        this.indexProject(p.id);
        n++;
      }
      // Paged by primary key: indexing writes while the cursor would still be open.
      let after = "";
      for (;;) {
        const page = this.stmt(
          `SELECT session_id, snapshot, project_id, phase_label FROM sessions s
           WHERE session_id > ? AND NOT EXISTS
             (SELECT 1 FROM search_docs d WHERE d.kind = 'session' AND d.ref_id = s.session_id)
           ORDER BY session_id LIMIT 500`,
        ).all(after) as {
          session_id: string;
          snapshot: string;
          project_id: string | null;
          phase_label: string | null;
        }[];
        if (page.length === 0) break;
        for (const r of page) {
          this.indexSession(r.session_id, r.snapshot, r.project_id, r.phase_label);
          n++;
        }
        after = page[page.length - 1]!.session_id;
      }
      return n;
    });
  }

  /** Ranked matches for an already-built MATCH expression (see buildMatch); live sessions rank higher. */
  searchMatch(match: string, limit: number): SearchHit[] {
    this.flushSearchIndexSafe();
    // Ranking runs in the inner query on rowids only; snippet() is computed in the outer query for
    // the top `limit` rows, so a broad match builds `limit` snippets, not one per matched row.
    const rows = this.stmt(
      `SELECT search_fts.kind AS kind, search_fts.ref_id AS ref_id, search_fts.project_id AS project_id, search_fts.title AS title,
              snippet(search_fts, -1, '', '', '...', 16) AS snippet, top.state AS state, top.score AS score
       FROM (SELECT search_fts.rowid AS rid, s.state AS state,
                    -bm25(search_fts, 0, 0, 0, 8, 1) *
                      CASE WHEN s.state IS NOT NULL AND s.state NOT IN ('ended', 'exited', 'archived')
                           THEN 1.5 ELSE 1 END AS score
             FROM search_fts LEFT JOIN sessions s ON search_fts.kind = 'session' AND s.session_id = search_fts.ref_id
             WHERE search_fts MATCH @m
             ORDER BY score DESC, search_fts.rowid LIMIT @l) top
            JOIN search_fts ON search_fts.rowid = top.rid
       WHERE search_fts MATCH @m
       ORDER BY top.score DESC, top.rid`,
    ).all({ m: match, l: limit }) as SearchRow[];
    return rows.map(toHit);
  }

  /** Free-text search: the safe MATCH is built here; an empty query (or one with no tokens) returns recent items. */
  search(q: string, limit: number): SearchHit[] {
    const match = buildMatch(q);
    return match === null ? this.searchRecent(limit) : this.searchMatch(match, limit);
  }

  /** Most recently active sessions, then (at most 5) most recently active projects. */
  searchRecent(limit: number): SearchHit[] {
    this.flushSearchIndexSafe();
    const projects = (
      this.stmt(
        `SELECT 'project' AS kind, p.id AS ref_id, p.id AS project_id, COALESCE(p.name, p.project_dir) AS title,
                '' AS snippet, NULL AS state, 0 AS score
         FROM projects p WHERE p.id IS NOT NULL
         ORDER BY COALESCE((SELECT MAX(last_event_at) FROM sessions WHERE project_id = p.id), 0) DESC, p.id
         LIMIT ?`,
      ).all(Math.min(5, limit)) as SearchRow[]
    ).map(toHit);
    const sessions = (
      this.stmt(
        `SELECT 'session' AS kind, s.session_id AS ref_id, s.project_id AS project_id, f.title AS title,
                substr(f.body, 1, 120) AS snippet, s.state AS state, 0 AS score
         FROM (SELECT session_id, project_id, state, last_event_at FROM sessions
               ORDER BY last_event_at DESC, session_id LIMIT ?) s
              JOIN search_docs d ON d.kind = 'session' AND d.ref_id = s.session_id
              JOIN search_fts f ON f.rowid = d.id
         ORDER BY s.last_event_at DESC, s.session_id`,
      ).all(Math.max(0, limit - projects.length)) as SearchRow[]
    ).map(toHit);
    return [...sessions, ...projects];
  }

  /**
   * An event with this signature and |ts - ts'| < windowMs exists. Equal signatures share a
   * session_id (it is part of the hashed material), so the seek is a range on events_session_ts_sig
   * (session_id, ts, signature) and the signature is compared inside the index.
   */
  hasSignatureWithin(
    signature: string,
    sessionId: string | null,
    ts: number,
    windowMs: number,
  ): boolean {
    return (
      (sessionId === null
        ? this.stmt(
            "SELECT 1 AS x FROM events WHERE session_id IS NULL AND ts > ? AND ts < ? AND signature = ? LIMIT 1",
          ).get(ts - windowMs, ts + windowMs, signature)
        : this.stmt(
            "SELECT 1 AS x FROM events WHERE session_id = ? AND ts > ? AND ts < ? AND signature = ? LIMIT 1",
          ).get(sessionId, ts - windowMs, ts + windowMs, signature)) !== undefined
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
       WHERE state IS NULL OR (state <> 'archived' AND (state NOT IN ('ended', 'exited')
          OR COALESCE(ended_at, last_event_at, 0) >= ?))
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
   * Usage feed for the cost index. transcript_lines is append-only (inserts never update), so the
   * rowid is a high-water mark: pass the last rowid seen, get the next rows in rowid order.
   * `raw` is null for rows without a usage block ('"usage":{' is also ccusage's own line filter)
   * so the caller can advance past them without copying them. SQLite-specific (rowid).
   */
  listUsageLinesAfter(afterRowid: number, limit: number): UsageFeedRow[] {
    return this.stmt(
      `SELECT t.rowid AS rid, t.session_id, t.agent_id, t.line_no,
              CASE WHEN instr(t.raw, '"usage":{') > 0 THEN t.raw END AS raw,
              (SELECT s.project_dir FROM sessions s WHERE s.session_id = t.session_id) AS project_dir
       FROM transcript_lines t WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`,
    ).all(afterRowid, limit) as UsageFeedRow[];
  }

  /** Current project_dir of every session that has one (usage index staleness check). */
  listSessionProjects(): { session_id: string; project_dir: string }[] {
    this.projectScans++;
    return this.stmt(
      "SELECT session_id, project_dir FROM sessions WHERE project_dir IS NOT NULL",
    ).all() as { session_id: string; project_dir: string }[];
  }

  /** Configured projects plus every project_dir seen on a session (legacy shape, kept for GET /projects). */
  listProjects(limit: number): ProjectRow[] {
    this.fillProjectIds();
    return this.stmt(
      `SELECT project_dir, name, color, vault_collection, id FROM projects
       UNION
       SELECT DISTINCT s.project_dir, NULL, NULL, NULL, NULL FROM sessions s
         WHERE s.project_dir IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.project_dir = s.project_dir)
       ORDER BY 1 LIMIT ?`,
    ).all(limit) as ProjectRow[];
  }

  /** R5.1. Projects with session counts (live = not ended, exited or archived). */
  listProjectSummaries(limit: number): ProjectSummary[] {
    this.fillProjectIds();
    return this.stmt(
      `SELECT p.id AS id, p.project_dir AS project_dir, COALESCE(p.name, '') AS name, COALESCE(p.color, '') AS color,
              p.vault_collection AS vault_collection,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id
                 AND (s.state IS NULL OR s.state NOT IN ('ended', 'exited', 'archived'))) AS live
       FROM projects p ORDER BY p.project_dir LIMIT ?`,
    ).all(limit) as ProjectSummary[];
  }

  getProject(id: string): ProjectSummary | undefined {
    return this.stmt(
      `SELECT p.id AS id, p.project_dir AS project_dir, COALESCE(p.name, '') AS name, COALESCE(p.color, '') AS color,
              p.vault_collection AS vault_collection,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id
                 AND (s.state IS NULL OR s.state NOT IN ('ended', 'exited', 'archived'))) AS live
       FROM projects p WHERE p.id = ?`,
    ).get(id) as ProjectSummary | undefined;
  }

  /** Name and color of the given projects, without counts (annotation hot path). */
  getProjectLabels(ids: string[]): Map<string, { name: string; color: string }> {
    const rows = this.stmt(
      `SELECT id, COALESCE(name, '') AS name, COALESCE(color, '') AS color FROM projects
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as { id: string; name: string; color: string }[];
    return new Map(rows.map((r) => [r.id, { name: r.name, color: r.color }]));
  }

  /** Edits only the keys present; a null vault_collection clears it. Returns false for an unknown id. */
  patchProject(
    id: string,
    patch: { name?: string; color?: string; vault_collection?: string | null },
  ): boolean {
    return this.transaction(() => {
      if (this.getProject(id) === undefined) return false;
      if (patch.name !== undefined)
        this.stmt("UPDATE projects SET name = ? WHERE id = ?").run(patch.name, id);
      if (patch.color !== undefined)
        this.stmt("UPDATE projects SET color = ? WHERE id = ?").run(patch.color, id);
      if (patch.vault_collection !== undefined) {
        this.stmt("UPDATE projects SET vault_collection = ? WHERE id = ?").run(
          patch.vault_collection,
          id,
        );
      }
      this.indexProject(id);
      if (patch.name !== undefined) this.reindexProjectPhases(id);
      return true;
    });
  }

  /**
   * Manual reassignment (wins over inference on every later ingest and survives replay). A null
   * projectId clears the override and re-infers. Returns false for an unknown session or project.
   */
  setSessionProject(sessionId: string, projectId: string | null): boolean {
    return this.transaction(() => {
      const row = this.getSession(sessionId);
      if (row === undefined) return false;
      if (projectId !== null && this.getProject(projectId) === undefined) return false;
      this.stmt(
        `INSERT INTO session_overrides (session_id, project_id, phase, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`,
      ).run(sessionId, projectId, Date.now());
      const pid = this.resolveProjectId(sessionId, row.project_dir, () => cwdOf(row.snapshot));
      this.stmt("UPDATE sessions SET project_id = ? WHERE session_id = ?").run(pid, sessionId);
      this.reindexSession(sessionId);
      this.reindexProjectPhases(row.project_id ?? null);
      this.reindexProjectPhases(pid);
      return true;
    });
  }

  /** Manual phase label; null clears it (the inferred default shows again). False for an unknown session. */
  setSessionPhase(sessionId: string, phase: string | null): boolean {
    return this.transaction(() => {
      if (this.getSession(sessionId) === undefined) return false;
      this.stmt(
        `INSERT INTO session_overrides (session_id, project_id, phase, updated_at) VALUES (?, NULL, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET phase = excluded.phase, updated_at = excluded.updated_at`,
      ).run(sessionId, phase, Date.now());
      this.stmt("UPDATE sessions SET phase_label = ? WHERE session_id = ?").run(phase, sessionId);
      this.reindexSession(sessionId);
      this.reindexProjectPhases(this.getSession(sessionId)?.project_id ?? null);
      return true;
    });
  }

  /** project_id and manual phase for a set of sessions (list/detail annotation). */
  getSessionAtlas(
    ids: string[],
  ): Map<string, { project_id: string | null; phase_label: string | null }> {
    const out = new Map<string, { project_id: string | null; phase_label: string | null }>();
    // json_each keeps the statement a constant literal (no interpolated IN list).
    const rows = this.stmt(
      `SELECT session_id, project_id, phase_label FROM sessions
       WHERE session_id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as {
      session_id: string;
      project_id: string | null;
      phase_label: string | null;
    }[];
    for (const r of rows) out.set(r.session_id, r);
    return out;
  }

  /** Live (not archived; ended/exited only within the grace window), archived and totals for the project view. */
  listProjectLive(projectId: string, cutoffMs: number, limit: number): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions WHERE project_id = ?
         AND (state IS NULL OR (state <> 'archived' AND (state NOT IN ('ended', 'exited')
              OR COALESCE(ended_at, last_event_at, 0) >= ?)))
       ORDER BY COALESCE(started_at, last_event_at, 0) DESC, session_id LIMIT ?`,
    ).all(projectId, cutoffMs, limit) as SessionRow[];
  }

  listProjectArchived(projectId: string, limit: number): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions WHERE project_id = ? AND state = 'archived'
       ORDER BY COALESCE(ended_at, last_event_at, started_at, 0) DESC, session_id LIMIT ?`,
    ).all(projectId, limit) as SessionRow[];
  }

  /** Every session of a project: (id, snapshot, manual phase) for phase and branch roll-ups. */
  listProjectSessionSnapshots(
    projectId: string,
    limit: number,
  ): { session_id: string; snapshot: string; state: string | null; phase_label: string | null }[] {
    return this.stmt(
      `SELECT session_id, snapshot, state, phase_label FROM sessions WHERE project_id = ?
       ORDER BY COALESCE(started_at, last_event_at, 0) DESC, session_id LIMIT ?`,
    ).all(projectId, limit) as {
      session_id: string;
      snapshot: string;
      state: string | null;
      phase_label: string | null;
    }[];
  }

  projectTotals(projectId: string): { sessions: number; hours: number; ids: string[] } {
    const t = this.stmt(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN started_at IS NOT NULL AND COALESCE(ended_at, last_event_at) > started_at
                           THEN COALESCE(ended_at, last_event_at) - started_at ELSE 0 END), 0) AS ms
       FROM sessions WHERE project_id = ?`,
    ).get(projectId) as { n: number; ms: number };
    const ids = (
      this.stmt("SELECT session_id FROM sessions WHERE project_id = ?").all(projectId) as {
        session_id: string;
      }[]
    ).map((r) => r.session_id);
    return { sessions: t.n, hours: t.ms / 3_600_000, ids };
  }

  listHosts(limit: number): HostRow[] {
    return this.stmt("SELECT * FROM hosts ORDER BY host LIMIT ?").all(limit) as HostRow[];
  }

  /** Write transaction taken up front (BEGIN IMMEDIATE): other writers wait, then fail with SQLITE_BUSY. */
  writeTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** Compaction watermark: envelopes with ts below it were compacted away. Null before any compaction. */
  getCompactionCut(): number | null {
    const r = this.stmt("SELECT cut_ts FROM compaction_state WHERE id = 1").get() as
      { cut_ts: number } | undefined;
    return r === undefined ? null : r.cut_ts;
  }

  /** Raises the watermark (never lowers it) and adds to the running count of compacted events. */
  advanceCompaction(cutTs: number, compacted: number, now: number): void {
    this.stmt(
      `INSERT INTO compaction_state (id, cut_ts, compacted_events, updated_at) VALUES (1, @cutTs, @compacted, @now)
       ON CONFLICT(id) DO UPDATE SET
         cut_ts = CASE WHEN excluded.cut_ts > compaction_state.cut_ts THEN excluded.cut_ts ELSE compaction_state.cut_ts END,
         compacted_events = compaction_state.compacted_events + excluded.compacted_events,
         updated_at = excluded.updated_at`,
    ).run({ cutTs, compacted, now });
  }

  listBaselines(): { session_id: string; snapshot: string }[] {
    return this.stmt("SELECT session_id, snapshot FROM session_baselines").all() as {
      session_id: string;
      snapshot: string;
    }[];
  }

  upsertBaseline(sn: SessionSnapshot, now: number): void {
    this.stmt(
      `INSERT INTO session_baselines (session_id, snapshot, updated_at, host, state) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at,
         host = excluded.host, state = excluded.state`,
    ).run(sn.session_id, JSON.stringify(sn), now, sn.host, sn.state);
  }

  getBaseline(sessionId: string): string | undefined {
    const r = this.stmt("SELECT snapshot FROM session_baselines WHERE session_id = ?").get(
      sessionId,
    ) as { snapshot: string } | undefined;
    return r?.snapshot;
  }

  listOpenBaselinesForHost(host: string): string[] {
    return (
      this.stmt("SELECT snapshot FROM session_baselines WHERE host = ? AND state <> 'ended'").all(
        host,
      ) as { snapshot: string }[]
    ).map((r) => r.snapshot);
  }

  countOpenBaselinesForHost(host: string): number {
    return (
      this.stmt(
        "SELECT COUNT(*) AS n FROM session_baselines WHERE host = ? AND state <> 'ended'",
      ).get(host) as { n: number }
    ).n;
  }

  /** The serving hub's lease, or undefined when none was ever written or it was released. */
  getLease(): { holder: string; expires_at: number } | undefined {
    return this.stmt("SELECT holder, expires_at FROM hub_lease WHERE id = 1").get() as
      { holder: string; expires_at: number } | undefined;
  }

  setLease(holder: string, expiresAt: number): void {
    this.stmt(
      `INSERT INTO hub_lease (id, holder, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
    ).run(holder, expiresAt);
  }

  /** Releases the lease if this holder still owns it. */
  clearLease(holder: string): void {
    this.stmt("DELETE FROM hub_lease WHERE id = 1 AND holder = ?").run(holder);
  }

  /**
   * Events in ingest order (rowid; the table is append-only, so rowid is insertion order), rowid >
   * after. SQLite-specific: Phase 7 needs an explicit ingest sequence column on Postgres.
   */
  listEventsAfterRowid(after: number, limit: number): (EventRow & { rid: number })[] {
    return this.stmt(
      "SELECT rowid AS rid, * FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?",
    ).all(after, limit) as (EventRow & { rid: number })[];
  }

  countEvents(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  /** Deletes the contiguous rowid range [from, to] of events. */
  deleteEventsRowidRange(from: number, to: number): number {
    return this.stmt("DELETE FROM events WHERE rowid >= ? AND rowid <= ?").run(from, to).changes;
  }

  /**
   * Deletes up to limit statusline samples with ts < cutoff or ts > maxTs (statusline_samples_ts);
   * the second bound removes samples stamped in the future, which would otherwise never age out.
   */
  deleteSamplesOutside(cutoffMs: number, maxTs: number, limit: number): number {
    return this.stmt(
      `DELETE FROM statusline_samples WHERE (session_id, ts) IN
         (SELECT session_id, ts FROM statusline_samples WHERE ts < ? OR ts > ? LIMIT ?)`,
    ).run(cutoffMs, maxTs, limit).changes;
  }

  /** Replay only: drops every session row (the caller re-inserts inside the same transaction). */
  deleteAllSessions(): void {
    this.stmt("DELETE FROM sessions").run();
    // The index of sessions and phases is rebuilt by the re-inserts; project documents stay.
    this.stmt(
      "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_docs WHERE kind <> 'project')",
    ).run();
    this.stmt("DELETE FROM search_docs WHERE kind <> 'project'").run();
    this.indexedAs.clear();
    this.projectsVersion++;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flushSearchIndexSafe();
    } finally {
      this.closed = true;
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.db.close();
    }
  }
}

export interface SearchHit {
  kind: "session" | "project" | "phase";
  id: string;
  project_id: string | null;
  title: string;
  snippet: string;
  state?: string;
  score: number;
}

interface SearchRow {
  kind: SearchHit["kind"];
  ref_id: string;
  project_id: string | null;
  title: string;
  snippet: string;
  state: string | null;
  score: number;
}

function toHit(r: SearchRow): SearchHit {
  const hit: SearchHit = {
    kind: r.kind,
    // A phase document is keyed "<project_id>/<phase>"; the phase label is its public id.
    id: r.kind === "phase" ? r.ref_id.slice(r.ref_id.indexOf("/") + 1) : r.ref_id,
    project_id: r.project_id,
    title: r.title,
    snippet: r.snippet.replace(/\s+/g, " ").trim(),
    score: Math.round(r.score * 1000) / 1000,
  };
  if (r.state !== null) hit.state = r.state;
  return hit;
}

function cwdOf(snapshot: string): string | null {
  try {
    const c = (JSON.parse(snapshot) as { cwd?: unknown }).cwd;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}
