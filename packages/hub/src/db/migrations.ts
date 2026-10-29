export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Forward-only. Portable SQL (maps to Postgres in Phase 7). Never edit a shipped migration.
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE hosts (host TEXT PRIMARY KEY, os TEXT, last_seen BIGINT, last_seq INTEGER);
CREATE TABLE events (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  session_id TEXT, agent_id TEXT, hook_event_name TEXT, ts BIGINT NOT NULL,
  payload TEXT NOT NULL, signature TEXT, UNIQUE(host, seq));
CREATE INDEX events_session_ts ON events(session_id, ts);
CREATE INDEX events_signature ON events(signature);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, host TEXT, snapshot TEXT NOT NULL, state TEXT, project_dir TEXT, started_at BIGINT, last_event_at BIGINT, ended_at BIGINT);
CREATE TABLE transcript_lines (session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', line_no INTEGER NOT NULL, ts BIGINT, raw TEXT, PRIMARY KEY(session_id, agent_id, line_no));
CREATE TABLE statusline_samples (session_id TEXT NOT NULL, ts BIGINT NOT NULL, context_used_pct REAL, cost_usd REAL, five_hour_pct REAL, five_hour_resets BIGINT, seven_day_pct REAL, seven_day_resets BIGINT, PRIMARY KEY(session_id, ts));
CREATE TABLE projects (project_dir TEXT PRIMARY KEY, name TEXT, color TEXT, vault_collection TEXT);
CREATE TABLE layouts (id TEXT PRIMARY KEY, name TEXT, spec TEXT, builtin INTEGER DEFAULT 0);
`,
  },
  {
    version: 2,
    name: "ingest_indexes",
    // The 5 s signature window is a (signature, ts) range: an index on signature alone scans every
    // row of a signature (hostile or constant heartbeats make that O(rows)). The old index is a
    // strict prefix of the new one. sessions(host, state) serves the open-sessions lookup.
    sql: `
CREATE INDEX events_signature_ts ON events(signature, ts);
DROP INDEX events_signature;
CREATE INDEX sessions_host_state ON sessions(host, state);
`,
  },
  {
    version: 3,
    name: "retention_baselines",
    // Compaction deletes events older than the retention window after folding them into one
    // baseline snapshot per session; replay starts from these baselines and applies the remaining
    // events. compaction_state is a single row (id = 1): cut_ts is the watermark, ingest treats an
    // envelope older than it as already seen (its id and signature are gone with the event).
    // statusline_samples_ts serves the bounded retention delete (the primary key leads with session_id).
    sql: `
CREATE TABLE session_baselines (session_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE compaction_state (id INTEGER PRIMARY KEY, cut_ts BIGINT NOT NULL, compacted_events BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX statusline_samples_ts ON statusline_samples(ts);
`,
  },
  {
    version: 4,
    name: "baseline_index_and_lease",
    // Compaction folds each batch against the baselines table itself (inside the batch's write
    // transaction), so the open-session cap and the supersede pid index need host and state as
    // columns. The backfill uses SQLite json_extract; the Postgres twin of this file (Phase 7)
    // uses snapshot::json ->> 'host'. hub_lease is a single row (id = 1): the serving hub
    // refreshes expires_at every few seconds; replay and compact refuse while it is fresh.
    sql: `
ALTER TABLE session_baselines ADD COLUMN host TEXT;
ALTER TABLE session_baselines ADD COLUMN state TEXT;
UPDATE session_baselines SET host = json_extract(snapshot, '$.host'), state = json_extract(snapshot, '$.state');
CREATE INDEX session_baselines_host_state ON session_baselines(host, state);
CREATE TABLE hub_lease (id INTEGER PRIMARY KEY, holder TEXT NOT NULL, expires_at BIGINT NOT NULL);
`,
  },
  {
    version: 5,
    name: "dedup_index_by_session",
    // R2.4. The 5 s duplicate check ran on events(signature, ts). A signature is a hash, so every
    // insert dirtied a random leaf of that index: about 100 of the ~200 WAL pages a batch of 100
    // wrote, and about a third of its CPU. The signature material includes session_id, so equal
    // signatures always share a session: the check now seeks (session_id, ts) and compares the
    // signature inside the same index entries (covering, no table reads). Inserts append at the
    // tail of the session's range. The new index also serves everything events_session_ts did
    // (it is a strict prefix), so both old indexes are dropped. Valid on SQLite and Postgres.
    sql: `
CREATE INDEX events_session_ts_sig ON events(session_id, ts, signature);
DROP INDEX events_signature_ts;
DROP INDEX events_session_ts;
`,
  },
  {
    version: 6,
    name: "atlas_projects_phases",
    // R5.1, R5.5. Each session carries exactly one project_id (inferred on ingest, or the manual
    // override). Manual choices live in session_overrides, outside sessions, so `hub replay`
    // (which deletes and rebuilds sessions) cannot lose them; upsertSession re-applies them.
    // sessions.phase_label is the materialized manual phase. projects gains a stable short id.
    // Existing rows are backfilled by Store.migrate (path inference is code, not SQL).
    sql: `
ALTER TABLE projects ADD COLUMN id TEXT;
ALTER TABLE projects ADD COLUMN created_at BIGINT;
CREATE UNIQUE INDEX projects_id ON projects(id);
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN phase_label TEXT;
CREATE INDEX sessions_project ON sessions(project_id, state);
CREATE TABLE session_overrides (session_id TEXT PRIMARY KEY, project_id TEXT, phase TEXT, updated_at BIGINT NOT NULL);
`,
  },
  {
    version: 7,
    name: "search_fts",
    // R5.4. FTS5 is SQLite-only: the Postgres twin of this file (Phase 7, same number) uses a
    // tsvector column with a GIN index. search_docs maps (kind, ref_id) to the FTS rowid so a row is
    // replaced by rowid, never by a scan; hash is the digest of the indexed text, so the ingest hot
    // path writes the index only when that text changed. Stored rows are filled by Store.migrate
    // (the text is derived from snapshots in code, like the project backfill).
    sql: `
CREATE TABLE search_docs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, project_id TEXT, hash TEXT NOT NULL);
CREATE UNIQUE INDEX search_docs_ref ON search_docs(kind, ref_id);
CREATE VIRTUAL TABLE search_fts USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
CREATE INDEX sessions_last_event ON sessions(last_event_at);
`,
  },
  {
    version: 8,
    name: "search_dirty",
    // R5.4. Search indexing is deferred off the ingest transaction. The upsert sets
    // sessions.search_dirty = 1 in the same statement (no extra write); the flush clears it, and
    // the next open indexes every flagged row, so a crash between commit and flush loses nothing.
    // The partial index keeps "find dirty rows" a probe. Valid on SQLite and Postgres.
    sql: `
ALTER TABLE sessions ADD COLUMN search_dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_search_dirty ON sessions(session_id) WHERE search_dirty = 1;
-- Entries left stale by the earlier in-memory pending design are repaired on the next open (unchanged text is skipped by digest).
UPDATE sessions SET search_dirty = 1;
`,
  },
  {
    version: 9,
    name: "layouts_slots",
    // R6.3. Saved layouts get a hotkey slot (1-9) and an optional host pin (NULL = all hosts).
    // One layout holds a slot per host scope: partial unique expression index, valid on SQLite and
    // Postgres. updated_at is epoch ms.
    sql: `
ALTER TABLE layouts ADD COLUMN hotkey INTEGER;
ALTER TABLE layouts ADD COLUMN host TEXT;
ALTER TABLE layouts ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX layouts_slot ON layouts(hotkey, (COALESCE(host, ''))) WHERE hotkey IS NOT NULL;
`,
  },
];
