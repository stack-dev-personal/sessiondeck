# Contract fixtures

Scrubbed Claude Code payloads that the reducer, the envelope walk and the statusLine schema are
tested against (R0.7). Everything outside `raw/`, `settings/`, `synthetic/` was captured from real
sessions and then passed through the default-deny scrub below.

## Provenance

- Claude Code versions seen in the captures: 2.1.295, 2.1.300, 2.1.301 (the statusLine `version` field).
- OS: Windows 11 (the laptop). Capture date: 2026-10-15, several real sessions across more than one project.
- Captured with `node scripts/capture-install.mjs` (hooks, `statusLine` and `subagentStatusLine`
  pointing at `scripts/capture-fixtures.mjs`), then `--uninstall`. Raw files land in `raw/`, which is
  gitignored, never loaded by tests and never reviewed or committed.
- Produced from `raw/` by script only:

```
node scripts/fixture-inventory.mjs            # event -> count -> key sets (names only)
node scripts/fixture-scrub.mjs                # scrub, select, write this directory
node scripts/fixture-leak-check.mjs           # the gate: exit 0 or counts of findings
```

`fixture-scrub.mjs` is deterministic: the same `raw/` gives byte-identical output.

## Layout

```
<Event>/NN-<slug>.json            hook payloads (13 captured events)
statusLine/NN-<tag>.json          20 statusLine stdin samples
subagentStatusLine/NN-<tag>.json  5 subagentStatusLine stdin samples
sessions/golden-session.jsonl     one real session, hook payloads in capture order, one per line
synthetic/<Event>/NN-*.json           NOT captured, see below
settings/                         installer test input, not a payload directory
```

`<Event>/` and `statusLine/` follow the layout `packages/contract/test/helpers.ts` expects. The
golden session is `.jsonl` on purpose: `loadFixtures()` only reads `.json`, so it is not treated as
a one-payload fixture. Each line is the bare payload (no wrapper); order is the capture order
(epoch ms in the raw file name; events in the same millisecond are ordered by cause: SessionStart, UserPromptSubmit, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PreCompact, PostCompact, Notification, SubagentStop, Stop, SessionEnd; two events of the same type in one millisecond are unordered and fall back to the file name, whose last part is random). The file names carry a running number and a
slug made of placeholder-safe values only (tool name, source, reason, tag).

Selection: one representative (the smallest payload) per distinct top-level key set per event. Tool
events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`) are also split by
tool name (all MCP tools count as one), the key set of `tool_input` and, for `PostToolUse`, the
shape of `tool_response`. Notification, SessionStart, SessionEnd, PreCompact and PostCompact are
also split by `notification_type`, `source`, `reason` and `trigger`. Extras: all `PermissionRequest`
captures, the first `Stop` after an `AskUserQuestion`. statusLine: highest context and rate-limit
percentages, a `current_usage: null` sample, one per key set, samples after a compaction, first
tick and mid-session samples across sessions, then evenly spread. subagentStatusLine: distinct
sessions and row counts first.

## Scrub rules

Default deny. A string survives verbatim only if its key path is on the allowlist in
`scripts/lib/fixture-allowlist.mjs` (one line of reason per key) and its value matches that key's
pattern. Numbers, booleans and null are always kept. Every key name is kept, except key names that
are user content (question text under `answers`, keys with spaces or dots), which become
`<TEXT n>`.

Kept verbatim (structural): `hook_event_name`, `permission_mode`, `source`, `reason`, `trigger`,
`notification_type`, `model` (id and display name), `version`, `output_style.name`,
`effort.level`, `prompt_cache.ttl`, status and type enums of background tasks and subagent rows,
`tool_response` kind enums (`type`, `mode`, `status`), image `media_type`, MCP server `source`,
cache miss cause enums, `workspace.repo.host` for public git hosts, built-in `tool_name` and
built-in `agent_type` values.

Placeholder vocabulary:

| Placeholder | Replaces |
|-------------|----------|
| `<HOME>` | the user home directory, in every slash form and drive-letter case; output is always forward slashes |
| `<ROOT>` | an absolute path outside the home directory |
| `<PROJECT_A>`, `<PROJECT_B>`, ... | project directories (the segment after `projects/`, or the first directory under home), lettered in sorted order of the real names; the encoded folder under `.claude/projects/` and `AppData/Local/Temp/claude/` maps to the same letter as its cwd |
| `<DIR_n>`, `<FILE_n>` | other directory and file names, numbered by first use, same name gives same number; the file extension is kept |
| `<TEXT n>` | any other string (prompts, messages, commands, tool inputs and outputs, titles, descriptions, branch names, repo names, session names); n is the original length |
| `<AGENT_n>` | custom agent types and names (built-ins such as `general-purpose` stay) |
| `<MCP_n>`, `<TOOL_n>` | MCP server names; MCP tool names become `mcp__<MCP_n>__<TOOL_m>` |
| `<REDACTED>` | a value that is wholly a token (`sk-`, `ghp_`, `gho_`, `AKIA`, `xox`, `Bearer`, 32+ char hex or base64 runs) |
| `<EMAIL>`, `<ACCOUNT>` | an email-shaped value; an account, org or repo-owner value |

Ids are remapped, not kept: `session_id`, `agent_id`, `tool_use_id`, `prompt_id` and task ids become
a sha256-derived id of the same shape and length. The mapping is the same everywhere (including
inside `transcript_path` and `scratchpad_dir`), so a session reads consistently across files. The
shape of `transcript_path` is kept: `<HOME>/.claude/projects/<PROJECT_x>/<session-id>.jsonl`.

Gate: `node scripts/fixture-leak-check.mjs` scans every file in this directory except `raw/`.
Text checks run on all of them (`settings/` and `.md` included): the user name or a home path in
any slash form and any alphabet, email shapes, token patterns and long token-like runs. A file that
is not `.json`, `.jsonl` or `.md` is also reported as `unscanned-file`. The structure check runs on
every payload (not `settings/`): key names must be in `scripts/lib/fixture-keys.mjs` (a `<KEY_n>`
key is a finding, so a new key needs a reviewed addition there), `<TEXT n>` keys appear only under
user-keyed objects, ids must keep their remapped shape (with a digit when they are only letters and
digits), and every string must be a placeholder or match its allowlist rule. When `raw/` exists it
also derives, at run time, the user name, project names, every other folder name in the raw paths
and the named-field values, and searches all files for them. Without `raw/` (CI) the pattern and
structure checks still run. It prints counts and file names, never values.

## Captured and synthetic

Captured (13 hook events): Notification, PermissionRequest, PostCompact, PostToolUse,
PostToolUseFailure, PreCompact, PreToolUse, SessionEnd, SessionStart, Stop, SubagentStart,
SubagentStop, UserPromptSubmit; plus statusLine and subagentStatusLine.

Not captured, so SYNTHETIC (conductor decisions 7 and 3, 2026-10-15), under
`synthetic/<Event>/`: TaskCreated, TaskCompleted (two files: `01-synthetic.json` and
`02-subagent.json`, a task created by a subagent), PermissionDenied (no permission was refused in
auto mode during the capture), StopFailure (no API failure happened). Task
tools are disabled on this machine. Their common fields are copied from a scrubbed captured
`UserPromptSubmit`.

The event-specific fields were verified against the Claude Code hooks reference,
https://code.claude.com/docs/en/hooks, on 2026-10-15 (sd-researcher). They are still not captured
payloads; the feasibility note `docs/research/2026-10-08-feasibility-and-oss.md` lists these events
only as "unverified at research time". Per the documentation:

| Event | Fields | `permission_mode` |
|-------|--------|-------------------|
| TaskCreated | `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` (deprecated); optional `agent_id` (v2.1.290+); no matcher | absent in the doc example |
| TaskCompleted | same fields; `02-subagent.json` adds `agent_id` and `agent_type` | `default` |
| PermissionDenied | `tool_name`, `tool_input`, `tool_use_id`, `reason` (`mcp_server` for MCP tools only); fires in auto mode only | `auto` |
| StopFailure | `error` (one of 12 values), `error_details`, `last_assistant_message` (the API error string, not Claude's output); whether it carries `agent_id` is undocumented, so main-session only | absent in the doc example |

Three strings are the documentation's own examples and are kept verbatim: `reason`
"[Irreversible Local Destruction]", `error_details` "429 Too Many Requests",
`last_assistant_message` "API Error: Rate limit reached". The leak gate accepts exactly these, in
exactly these synthetic files and key paths (`scripts/lib/fixture-synthetic-doc.mjs`); captured
directories stay strict. Every other string is a placeholder.

`synthetic/` is not a payload directory for `loadFixtures()`; `packages/contract/test/helpers.ts`
excludes `synthetic` and `sessions` from both `loadFixtures()` and `findMisplacedFixtures()`.

## Golden session

`sessions/golden-session.jsonl`: one complete session, SessionStart (source `startup`) to
SessionEnd (reason `clear`), 295 hook events, one `session_id`, no statusLine ticks. Counts by
type: PreToolUse 135, PostToolUse 131, SubagentStop 10, UserPromptSubmit 5, PostToolUseFailure 4,
Stop 4, Notification 2, SessionStart 1, SessionEnd 1, SubagentStart 1, PermissionRequest 1. It was
chosen as the session that starts at SessionStart and ends at SessionEnd, fits under 400 events, and
has the most distinct event types, including a PermissionRequest, a subagent and several Stops. It
contains no AskUserQuestion and no compaction; those are covered by the per-event fixtures.
