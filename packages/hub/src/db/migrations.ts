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
];
