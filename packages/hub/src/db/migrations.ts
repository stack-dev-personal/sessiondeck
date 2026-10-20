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
CREATE TABLE hosts (host TEXT PRIMARY KEY, os TEXT, last_seen INTEGER, last_seq INTEGER);
CREATE TABLE events (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  session_id TEXT, agent_id TEXT, hook_event_name TEXT, ts INTEGER NOT NULL,
  payload TEXT NOT NULL, signature TEXT, UNIQUE(host, seq));
CREATE INDEX events_session_ts ON events(session_id, ts);
CREATE INDEX events_signature ON events(signature);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, host TEXT, snapshot TEXT NOT NULL, state TEXT, project_dir TEXT, started_at INTEGER, last_event_at INTEGER, ended_at INTEGER);
CREATE TABLE transcript_lines (session_id TEXT, agent_id TEXT, line_no INTEGER, ts INTEGER, raw TEXT, PRIMARY KEY(session_id, agent_id, line_no));
CREATE TABLE statusline_samples (session_id TEXT, ts INTEGER, context_used_pct REAL, cost_usd REAL, five_hour_pct REAL, five_hour_resets INTEGER, seven_day_pct REAL, seven_day_resets INTEGER, PRIMARY KEY(session_id, ts));
CREATE TABLE projects (project_dir TEXT PRIMARY KEY, name TEXT, color TEXT, vault_collection TEXT);
CREATE TABLE layouts (id TEXT PRIMARY KEY, name TEXT, spec TEXT, builtin INTEGER DEFAULT 0);
`,
  },
];
