# Atlas: projects and phases (hub side)

Requirements: R5.1 (one project per session, worktrees roll up), R5.5 (phase labels persist), R5.6 (project view).

## How a session gets its project

On every ingest (and on `hub replay`) the hub derives a project key from the session snapshot:

1. `workspace.project_dir` from the statusLine (stored as `project_dir`), else
2. the session `cwd`, else
3. the `Unassigned` project.

The key is the repo root. The hub may run on another machine, so nothing touches the filesystem; a
worktree is recognized by its path shape only. Rules, applied after normalization:

| Path shape | Rolls up to |
|------------|-------------|
| `<repo>/.claude/worktrees/<name>[/...]` | `<repo>` |
| `<repo>/.worktrees/<name>[/...]` | `<repo>` |
| `<repo>/.git/worktrees/<name>[/...]` | `<repo>` |
| `<parent>/<repo>-wt/<name>` or `<repo>-worktrees/<name>` (the worktree root is the LAST segment) | `<parent>/<repo>` |

Normalization: backslashes to `/`, duplicate and trailing slashes removed, `/mnt/c/...` to `c:/...`,
drive letter lower-cased; a Windows path (drive letter) is lower-cased entirely for the key (the
display name keeps its case). Posix paths are case-sensitive.

The sibling rule applies only when the container is the parent of the final path segment, so a repo
that is itself called `foo-wt` (cwd `/home/u/foo-wt/packages`) or an early `-wt` segment is never
rolled up. A cwd deeper than the worktree root under a sibling container therefore does not roll up;
the statusLine `project_dir` (the worktree root) does. For example a cwd fallback (no `project_dir`) of `/x/repo-wt/feat/packages/hub` yields the project `hub`, not `repo`; such a session needs a manual project override (`PATCH /sessions/:id/project`). The project key ignores the host on purpose:
the same repo path on two machines is one project.

The project is created on first sight (`projects` row): name = basename of the repo root, color = a
deterministic hex from a fixed palette (hash of the key). The id is `p_` plus 32 hex (128 bits of SHA-256 of the key); if an id is ever already held by another project, a `_<n>` suffix is appended instead of failing the ingest batch. Inferred names are capped at 80 characters with control and bidi characters removed; the same cleaning applies to names, phases on PATCH.
The project is re-derived only for a new session or when its `project_dir` changes.

Sibling directories that are not named `<repo>-wt` are NOT rolled up (the payload carries no main
repo path; `worktree.original_cwd` is not stored in the snapshot). Fix those by hand (below).

## Phases

A phase is a label on a session. The effective phase is:

1. the manual label, if set; else
2. inferred: the name starts with `P<n>` followed by a separator (`:`, `-`, `/`, `.`, `_`), the end, or a space not followed by a metric word (latency, ms, cpu, ...), or `\bphase\s*(\d+)\b` in `session_name` (case-insensitive; "fix p95 latency" is not a phase), else a `p<n>/` branch prefix; shown as `P<n>`; else
3. none.

Manual labels (and manual project assignments) live in `session_overrides`, outside `sessions`, so
`hub replay` and restarts keep them.

## API (all routes need the same bearer token as ingest and reads)

| Call | Purpose |
|------|---------|
| `GET /projects` | projects with `id`, `project_dir`, `name`, `color`, `vault_collection`, `sessions`, `live` |
| `GET /projects/:id` | `{project, live[], archived[<=20], totals{sessions,hours,cost_usd}, branches[{branch,sessions}]}` |
| `PATCH /projects/:id` | `{name?<=80, color? "#rrggbb" or a design-system token (accent, accent-attention, state-*, meter-*), vault_collection? string\|null}` |
| `GET /projects/:id/phases` | `{phases:[{phase,sessions}]}` effective phases of the project |
| `PATCH /sessions/:id/project` | `{project_id: string\|null}` manual reassignment; `null` clears it and re-infers |
| `PATCH /sessions/:id/phase` | `{phase: string(1..60)\|null}`; `null` restores the inferred default |

`GET /sessions`, `/sessions/:id` and the WS initial message carry the additive fields `project_id`,
`project_name`, `project_color`, `phase`, `phase_source` (`manual`, `inferred` or null).

`vault_collection` is a label, never a path: the laptop must not use it to build file paths.

PATCH requests are charged to the same per-token read bucket as GET.

WS: `session` deltas carry the same additive fields as `initial`. After a successful PATCH of a
session's project or phase, the hub pushes an annotated `session` delta for that session; after a
PATCH of a project's name or color, one for each of the project's live sessions. No new message type.

Totals: `sessions` and `hours` come from the sessions table (end = `ended_at`, else `last_event_at`);
`cost_usd` is the ccusage-equivalent history cost of the project's sessions (not statusLine).
Archived sessions are rows with `state = 'archived'`; branches are those of sessions that are not
ended, exited or archived.

## Web origin and CORS

When the web app is served from a different origin than the hub (the compose topology: nginx on
`:5173`, hub on `:8787`), the browser's REST calls need CORS. The hub answers it from
`HUB_ALLOWED_ORIGINS` (comma-separated, exact match):

- Request `Origin` equals an entry: the response carries `Access-Control-Allow-Origin: <that origin>`.
  Never `*`, never `Allow-Credentials` (auth is the bearer header).
- Preflight (`OPTIONS` with `Access-Control-Request-Method`) from an allowed origin gets 204 with
  `Allow-Methods: GET, PATCH`, `Allow-Headers: authorization, content-type`, `Max-Age: 600`. It is
  answered before the bearer check (browsers send no Authorization on preflight), carries no data, and
  shares the read rate limit. The real request still needs the token (401 otherwise).
- Any other origin gets no CORS headers (its preflight falls through to the normal 401).
- `Vary: Origin` is on every response. `/ingest` never gets CORS headers.
- Difference from the WebSocket check: there an empty list accepts any Origin; for CORS an empty list
  means no CORS headers at all (same-origin or the vite proxy only).

## Fixing a mis-assignment

```sh
# find the target project id
curl -s -H "Authorization: Bearer $HUB_TOKEN" http://localhost:8787/projects
# move one session (the override wins over every later ingest and survives replay)
curl -s -X PATCH -H "Authorization: Bearer $HUB_TOKEN" -H 'content-type: application/json' \
  -d '{"project_id":"p_0123456789ab"}' http://localhost:8787/sessions/<session_id>/project
# undo: re-infer
curl -s -X PATCH ... -d '{"project_id":null}' .../sessions/<session_id>/project
# rename / recolor a project
curl -s -X PATCH ... -d '{"name":"quant-edge","color":"#3e63dd"}' .../projects/<id>
# set a phase label
curl -s -X PATCH ... -d '{"phase":"Hardening"}' .../sessions/<session_id>/phase
```

UI: the project and phase controls land with the S9 web work (inline edit on the session row and
the project header); they call the same endpoints.

## Search (R5.4)

`GET /search?q=&limit=` (default limit 20, max 50; `q` at most 200 characters; bearer auth and the read
rate limit like every other GET). Response: `{results:[{kind:'session'|'project'|'phase', id, project_id,
title, snippet, state?, score}], took_ms}`. For a phase hit, `id` is the phase label and `project_id` its project.

Index: migration 7 creates `search_fts` (FTS5, `unicode61 remove_diacritics 2`, prefix index `2 3`) and
`search_docs` (maps `(kind, ref_id)` to the FTS rowid and keeps a digest of the indexed text). Documents:

| Kind | Title | Body |
|------|-------|------|
| session | session name, else the directory name | last prompt, last assistant message, `outcome` / `archive.outcome` when the snapshot has one, effective phase, branch, session id |
| project | name | directory name, `vault_collection` |
| phase | the phase label | the project name |

`indexSessionText` (`src/atlas/search.ts`) is the one place that decides what a session contributes; S9b
extends it for archived captures (their `outcome` is already read). The index is maintained off the ingest
transaction: the `upsertSession` UPSERT sets the durable `sessions.search_dirty` flag (migration 8, same statement), and `Store.flushSearchIndex()` (a 200 ms coalescing
timer, before every search read, on `close`, and callable by tests) indexes each flagged session once from its committed row (own savepoint per session; a poisoned row is counted and quarantined for 60 s after 3 failures, never blocking the rest or failing a search) and clears the flag (committed per 500-row page; if a project's phase rebuild fails its sessions stay flagged for the next flush; when only quarantined rows are dirty a search skips the flush; failure and quarantine maps are capped at 4096), rewriting a document only when the digest of its text changed. Phase documents are re-derived once per affected
project per flush, and only when a session's phase or project changed (a capped in-memory cache of the last indexed phase, updated only after commit; a miss takes the safe path). Project PATCH, phase PATCH and project reassignment still index synchronously. Search is therefore
consistent with ingest within one flush interval, and exactly consistent for any search that runs after it. `Store.migrate` indexes anything missing and every row still flagged dirty on open (so a crash before a flush loses nothing; idempotent; migration 8 flags every existing session once so index entries left stale by the earlier in-memory design are repaired, unchanged text being skipped by digest); `hub replay` clears
session and phase documents with the sessions table and the re-inserts rebuild them.

Query handling: the user string is never passed to MATCH. Letters and digits runs are the tokens (max 8, 64
characters each); each is quoted, all must match, and the last is a prefix (`"tok"*`) only when it has at
least 2 characters (a 1-character prefix would scan every term starting with that letter; it is matched as an
exact word after other tokens, and alone it behaves like an empty query and returns recent items). Quotes, `NEAR`, `AND`,
`column:`, parentheses and `*` are therefore plain words or separators. A query with no token (empty, `*`)
returns the most recent sessions and up to 5 projects. Ranking is bm25 (title weighted 8x body); live
sessions (not ended, exited or archived) score 1.5x. Ranking runs on rowids only; `snippet()` is computed
for the top `limit` rows afterwards. A phase document is removed when no session of its project infers or
sets that phase any more, including when ingest renames the phase or moves a session to another project.

Clients must render `title` and `snippet` as text only (never as HTML): both are raw transcript text and the
snippet markers are empty, so the hub adds no markup and does no escaping.

Listeners on the hub emitter (`atlas`, `batch`) must not throw; the stream listener contains its own errors.
