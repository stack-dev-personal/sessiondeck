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
| `<parent>/<repo>-wt/<name>[/...]` or `<repo>-worktrees/<name>` | `<parent>/<repo>` |

Normalization: backslashes to `/`, duplicate and trailing slashes removed, `/mnt/c/...` to `c:/...`,
drive letter lower-cased; a Windows path (drive letter) is lower-cased entirely for the key (the
display name keeps its case). Posix paths are case-sensitive.

The project is created on first sight (`projects` row): name = basename of the repo root, color = a
deterministic hex from a fixed palette (hash of the key). The id is `p_` plus 12 hex of the key hash.
The project is re-derived only for a new session or when its `project_dir` changes.

Sibling directories that are not named `<repo>-wt` are NOT rolled up (the payload carries no main
repo path; `worktree.original_cwd` is not stored in the snapshot). Fix those by hand (below).

## Phases

A phase is a label on a session. The effective phase is:

1. the manual label, if set; else
2. inferred: `\bP(?:hase)?\s*(\d+)\b` in `session_name` (case-insensitive), else a `p<n>/` branch prefix; shown as `P<n>`; else
3. none.

Manual labels (and manual project assignments) live in `session_overrides`, outside `sessions`, so
`hub replay` and restarts keep them.

## API (all routes need the same bearer token as ingest and reads)

| Call | Purpose |
|------|---------|
| `GET /projects` | projects with `id`, `project_dir`, `name`, `color`, `vault_collection`, `sessions`, `live` |
| `GET /projects/:id` | `{project, live[], archived[<=20], totals{sessions,hours,cost_usd}, branches[{branch,sessions}]}` |
| `PATCH /projects/:id` | `{name?<=80, color? "#rrggbb" or token name, vault_collection? string\|null}` |
| `GET /projects/:id/phases` | `{phases:[{phase,sessions}]}` effective phases of the project |
| `PATCH /sessions/:id/project` | `{project_id: string\|null}` manual reassignment; `null` clears it and re-infers |
| `PATCH /sessions/:id/phase` | `{phase: string(1..60)\|null}`; `null` restores the inferred default |

`GET /sessions`, `/sessions/:id` and the WS initial message carry the additive fields `project_id`,
`project_name`, `project_color`, `phase`, `phase_source` (`manual`, `inferred` or null).

Totals: `sessions` and `hours` come from the sessions table (end = `ended_at`, else `last_event_at`);
`cost_usd` is the ccusage-equivalent history cost of the project's sessions (not statusLine).
Archived sessions are rows with `state = 'archived'`; branches are those of sessions that are not
ended, exited or archived.

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
