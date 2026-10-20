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
];
