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
transcripts/NN-<slug>/                five scrubbed session transcripts, see Transcripts
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

The gate also scans `docs/CONTRACT.md` with the text checks (the notes about the captures live
there, and the run with the default directory is the only one that includes it). Each
`sessions/*.timeline.json` is checked against a schema instead of the payload structure check:
exact key sets at the top level, in every change and in `final`; `state_detail` null or
`tool:|source:|compact:` plus letters; `model_id`, `agent_type`, `ended_reason` and `last_tool` from
closed lists; free-text fields null. A stray field or a free-text value is a `timeline-schema`
finding.

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

## Transcripts

`transcripts/<NN>-<slug>/`: five scrubbed Claude Code session transcripts (`session.jsonl`, plus
`subagents/agent-<id>.jsonl` and `.meta.json` where the session ran sub-agents), input for the S7
normalizer. Each directory has a generated `README.md` with its own counts. The directory is not a
payload directory: `packages/contract/test/helpers.ts` excludes it from `loadFixtures()`.

### Sources

- Only sessiondeck's own development sessions were used (user decision 2026-10-27). Nothing from
  another project. Candidates: 21 transcripts, 217 sub-agent files (inventory:
  `docs/research/2026-10-27-transcript-inventory.md`).
- Claude Code versions in the sources: 2.1.295 to 2.1.311 (installed: 2.1.311).
- Session ids (kept verbatim, see below), in fixture order:

| Fixture | Session id | Claude Code | Source size |
|---------|------------|-------------|-------------|
| 01-subagents | 64504051-6a66-4050-809e-a952e025a5ff | 2.1.311 | 2.16 MB |
| 02-subagents-compaction | f3b2c970-1043-46a3-8ed4-af8077d43c97 | 2.1.304 | 4.48 MB |
| 03-compaction | 00685f0b-505e-4fd2-9f65-df2c309861f5 | 2.1.304 | 5.98 MB |
| 04-compaction | 7364adf0-5d6c-49d7-a939-cf4fd4db66a9 | 2.1.295 | 7.11 MB |
| 05-subagents | ebfc00cb-a1cc-4730-a561-73b9a1846375 | 2.1.301 | 11.85 MB |

### Why these five

Chosen by an exhaustive search over all 5-subsets of the 21 candidates: the set must hold sub-agents
and a compaction, then it maximises distinct structural features (row types, system subtypes,
attachment types, content block types, tool_result shapes, sidecar shapes, tools, flags), and ties
go to the smaller size.

| Fixture | Reason |
|---------|--------|
| 01-subagents | smallest sub-agent transcript (4 sub-agents); only source of `tools-used` rows |
| 02-subagents-compaction | smallest with a compaction (1 sub-agent); `hook_cancelled`, `thinking_drop`, `ultra_effort_enter` |
| 03-compaction | `ai-title`, `file-history-delta`, `scheduled_task_fire`, `tool_reference` results, `tool_addition`, `skill_listing`, `auto_mode`, `invoked_skills`, `command_permissions` |
| 04-compaction | `pr-link`, `stop_hook_summary`, `compact_file_reference`, an "other" slash command |
| 05-subagents | 12 sub-agents; only source of `hook_non_blocking_error` and `read_truncation_notice`; `api_error` system rows. The largest, but the cheapest way to cover those |

Known gaps. No candidate holds a `/clear`, `/compact` or `/resume` command, or a resume marker (a
`sessionId` that differs from the file name). No candidate holds an `image`, `document` or
`redacted_thinking` block. The scrub handles images, documents and redacted thinking by rule
(below) and is tested on synthetic input only (`scripts/test/transcript-scrub.test.ts`). 12 of 128
key-set variants (optional keys on row types that are covered) are not in any fixture.

### Scrub rules

Run by `node scripts/fixture-scrub.mjs --transcripts`; rules live in
`scripts/lib/transcript-scrub-*.mjs`. Default deny, like the hook payloads above, with these
differences.

- Key classification (`transcript-scrub-rules.mjs`). A string is kept only if its key is classified
  as a closed enum, an id, a timestamp, a model id, a version and so on, and its value matches that
  key's pattern. Numbers, booleans and null are kept. Anything else becomes `<TEXT n>` (n is the
  original length) unless it sits under a free-text root (`message`, `toolUseResult`,
  `attachment`, `content`, `lastPrompt`, `aiTitle` and similar). A key name not in the vocabulary
  fails the run.
- Free text: paths, tokens, emails and accounts are replaced, then the string is cut to the first 120
  characters plus `<TRUNCATED n>` (n is the original length).
- `thinking` and `signature` become `<REDACTED-THINKING>`, as does `redacted_thinking` `data`.
- Base64 `data` of image and document sources becomes `<BLOB n>` (n is the string length).
- Absolute paths become `<HOME>/...` or `<ROOT>/...`, with `<PROJECT_x>`, `<DIR_n>` and `<FILE_n>`
  as in the table above. The encoded project folder form used under `.claude/projects/` maps to the same letter.
- Tokens (`sk-`, `ghp_`, `AKIA`, `xox`, `Bearer`, JWTs, private keys, 32+ character hex, mixed-case
  base64 runs, long lowercase-and-digit runs, `key=value` secrets such as `access_token=`, Supabase and
  Cloudflare token shapes, credentials inside URLs) become `<REDACTED>`. Emails become `<EMAIL>`.
- Account, organization and git owner names become `<ACCOUNT>`. Names are discovered from the raw
  data at run time and held in memory only. Pieces of those names of 5 or more characters, and every
  substring of 5 or more characters of each handle, are matched case-insensitively inside longer
  words too (ordinary words and schema words are exempt), and the whole word that contains a match
  becomes `<ACCOUNT>`, so no leftover letters show which part was removed. A discovered literal is
  used only if it has the shape of a handle (one token of letters, digits and `. _ @ + -`, at most
  40 characters) or, for emails, of a plain address; a sentence or blob found in an account field is
  not swept.
- Local deny-list: `raw/deny-words.txt` (gitignored with `raw/`; one word per line, `#` comments)
  holds words that must never survive (private repo names, health and school terms). The scrub
  replaces each, case-insensitively and inside words, with `<DENY>`; the leak check fails on any
  survivor. Without the file (CI) both run without it. Hashes of the words are deliberately not
  committed: short words with a public salt can be guessed, which would itself be a leak.
- Private content: an object whose path field (`path`, `filename`, `file_path`, `filePath`,
  `displayPath`) points outside the session's own project (the user-level `.claude` folder, another
  repo, a temp folder) has its `content`, `snippet`, diffs, `pattern` and similar fields dropped to
  `<BLOB n>`. The same goes for the output (result block and `toolUseResult`) of a tool use that read,
  searched or wrote such a path, or ran a shell command naming one (or `gh api`, `gh repo`).
- Outside the project means: any `<HOME>` or `<ROOT>` path that is not under the session's own
  project folder (`<PROJECT_A>`), the user-level `.claude` folder, and the gitignored `.sprint/`
  folder. A shell command that names `.sprint`, the `.claude` folder, another home path, `gh api`
  or `gh repo` makes its output private as well.
- `rendered[]` of an attachment row (the text copy Claude Code keeps next to it) is dropped to
  `<BLOB n>` when the attachment names an outside path, is a hook row, or is a skill listing.
- Label cuts in message text, in the scrub and in the check alike: the text after `Contents of
  <outside path>`, after a hook label (`<Event> hook success:`, `SessionStart hook additional
  context:`) and after `Result of calling the X tool:` that follows a private `Called the X tool
  with the following input` is cut to the label plus `<BLOB n>`.
- Home paths whose separators were lost (`C:Users<name>...`) are scrubbed like the normal forms and
  flagged by the check. Tool names of the form `mcp__<server>__<tool>` that were not mapped to
  `<MCP_n>` are a leak-check category (`transcript-mcp-tool-name`).
- MCP server names (from tool names and server lists in the raw data, and after the words "MCP
  server" in prose) become `<MCP_n>` in free text, with the same numbering as in tool names.
- Repository names found in GitHub URLs, `repos/<owner>/<repo>` API paths, `--repo` flags and `gh`
  loops, unless already public words in this repository, are swept like folder names.
- Folder names from the raw paths that also occur in prose, and that are not already public words in
  this repository's tracked files, become `<DIR>`.
- `requestId` and `deliveryId` become `<REQUEST_ID>`; content digests become `<REDACTED>`;
  `userEmail` becomes `<EMAIL>`; `organizationUuid`, `accountUuid`, `organizationName` and `owner`
  become `<ACCOUNT>`. Git branches survive only if they match this repository's public shapes.
- `hookName` survives as `<HookEvent>` or `<HookEvent>:<built-in tool>`; anything else is
  `<NAME_n>`. Custom agent names (also in `addedTypes` and `querySource`), skill and recipient names are numbered, MCP tools become
  `mcp__<MCP_n>__<TOOL_m>`.
- Dropped to `<BLOB n>` (n is the JSON length of the subtree), whole subtree, by key:
  `wireToolInputs`, `wireIngestContext`, `shape`, `toolInputCopies` (bulk duplicates);
  `serverClassifierRequest`, `serverClassifierContext` (request bodies, git state, paths);
  `systemPrompt`, `input_schema`, `definition`, `entries`, `surfacedDefinitions`, `schema`,
  `addedBlocks` (MCP instructions), `addedLines` (agent and tool listings) (configuration in bulk);
  `hookAdditionalContext` (hook-injected context); in attachments, `stdout`, `stderr` and `content`
  of hook rows (`hook_*` or any `hookEvent`) and `content` of `skill_listing`; `rawContent` (raw file
  contents); `diagnostics`; `trackedFileBackups`, `backup` (file-history records with user file
  paths); `tail` (request hash list); `base64`.
- Ids are kept verbatim, not remapped as in the hook payloads: `uuid`, `parentUuid`, `sessionId`,
  `message.id`, `tool_use_id`, `agentId` and the like are random identifiers with no personal data
  (key `id` only keeps a prefixed random id or a uuid),
  and the normalizer needs every cross-file link intact, including links in fields the scrub does
  not list. Account, organization and request ids are placeholders.
- Row order and row count equal the source. The scrub is deterministic: the same `raw/` gives
  byte-identical output (checked by hashing the tree after two runs).

The kept 120-character prefixes of free text are the main residual risk: the sweeps cover known
names and shapes, not every possible name. The security gate samples them.

### Regenerate and check

```
node scripts/fixture-scrub.mjs --transcripts     # raw/transcripts/ -> transcripts/
node scripts/fixture-leak-check.mjs              # exit 0 and "transcript findings: 0"
```

The scrub fails closed in two more ways, each exit 1 with a message that names the source, never a
value:

- Git lookups. Account names come partly from `git config user.email`, `git config user.name` and
  the owner in the `origin` URL. If any of the three is empty (for example in a container without a
  git identity) the scrub exits 1 before writing and prints which source was empty, because the
  leak check derives the same set and could not catch what the scrub missed. The leak check applies
  the same rule, but only when `raw/` is present, so CI is unaffected. `--no-git-literals` on either
  command allows empty lookups (the scrub prints a warning).
- Own project. `<PROJECT_A>` is the project the private-content rules treat as "inside". The scrub
  seeds this repository's own folder name first, so it is always `<PROJECT_A>`, and exits 1 if it
  cannot. The name defaults to the folder that holds the shared `.git` directory (the main checkout,
  also from a worktree); pass `--own-project <folder name>` when git cannot tell, for example in a
  container whose checkout folder has another name than the one in the raw `cwd` values.

`raw/` (including `raw/transcripts/`) is gitignored, never read by tests and never committed. The
leak check's raw-derived literal search and the deny-list check run only where `raw/` exists; CI runs
the pattern and structure checks, which include: no live content next to a path outside the project,
no live `addedBlocks`, `addedLines`, skill listing, hook output, `rendered[]` of such rows or private
tool output, no private text after the label cuts above, no glued `C:Users...` path, and no MCP
server name after "MCP server" in free text or unmapped `mcp__` tool name. The leak check also scans this session's notes
(`docs/sessions/p0-transcript-fixtures.md`, `docs/research/2026-10-27-transcript-inventory.md`).

### Row-type coverage

Counts per fixture, all jsonl files of the fixture together (session plus sub-agents), produced by
`scripts/lib/transcript-inventory-core.mjs` (`analyzeFile`) over the scrubbed files. Counts only.
Rows per file are in each fixture's own `README.md`.


#### Row type

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `agent-setting` | 17 | 82 | 0 | 181 | 26 |
| `ai-title` | 0 | 0 | 133 | 0 | 0 |
| `api-request` | 75 | 171 | 492 | 0 | 487 |
| `api-request-blob` | 102 | 241 | 441 | 0 | 1039 |
| `api-request-shape` | 5 | 2 | 5 | 0 | 13 |
| `assistant` | 173 | 281 | 524 | 1036 | 1054 |
| `atis-latch` | 17 | 82 | 134 | 181 | 26 |
| `attachment` | 73 | 388 | 518 | 1190 | 714 |
| `cost-state` | 1 | 2 | 1 | 2 | 1 |
| `file-history-delta` | 0 | 0 | 1 | 0 | 0 |
| `file-history-snapshot` | 0 | 12 | 12 | 54 | 0 |
| `last-prompt` | 17 | 83 | 134 | 183 | 26 |
| `mode` | 0 | 82 | 134 | 181 | 0 |
| `permission-mode` | 0 | 82 | 134 | 181 | 0 |
| `pr-link` | 0 | 0 | 0 | 58 | 0 |
| `queue-operation` | 4 | 32 | 250 | 272 | 20 |
| `system` | 0 | 35 | 278 | 263 | 2 |
| `tools-used` | 7 | 0 | 0 | 0 | 0 |
| `user` | 115 | 179 | 357 | 779 | 651 |

#### System subtype

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `api_error` | 0 | 0 | 0 | 0 | 2 |
| `away_summary` | 0 | 8 | 39 | 77 | 0 |
| `compact_boundary` | 0 | 1 | 1 | 2 | 0 |
| `informational` | 0 | 3 | 7 | 4 | 0 |
| `scheduled_task_fire` | 0 | 0 | 100 | 0 | 0 |
| `stop_hook_summary` | 0 | 0 | 0 | 4 | 0 |
| `turn_duration` | 0 | 23 | 131 | 176 | 0 |

#### Attachment type

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `agent_listing_delta` | 1 | 2 | 2 | 3 | 1 |
| `auto_mode` | 0 | 0 | 1 | 0 | 0 |
| `bash_output_audience_note` | 0 | 56 | 33 | 120 | 0 |
| `batching_reminder_sent` | 0 | 94 | 79 | 255 | 0 |
| `command_permissions` | 0 | 0 | 1 | 0 | 0 |
| `compact_file_reference` | 0 | 0 | 0 | 1 | 0 |
| `credential_org` | 5 | 3 | 1 | 3 | 13 |
| `date` | 5 | 4 | 2 | 8 | 13 |
| `deferred_tools_delta` | 1 | 1 | 3 | 4 | 2 |
| `deferred_tools_record` | 4 | 68 | 140 | 238 | 35 |
| `edited_text_file` | 5 | 0 | 1 | 0 | 26 |
| `environment` | 5 | 5 | 10 | 24 | 13 |
| `file` | 0 | 5 | 5 | 9 | 0 |
| `hook_additional_context` | 1 | 1 | 1 | 1 | 1 |
| `hook_cancelled` | 0 | 2 | 0 | 0 | 0 |
| `hook_non_blocking_error` | 0 | 0 | 0 | 0 | 1 |
| `hook_success` | 2 | 1 | 3 | 1 | 2 |
| `instructions` | 5 | 3 | 1 | 3 | 13 |
| `invoked_skills` | 0 | 0 | 1 | 0 | 0 |
| `mcp_instructions_delta` | 5 | 4 | 3 | 5 | 14 |
| `model` | 5 | 3 | 3 | 4 | 13 |
| `nested_memory` | 5 | 0 | 0 | 0 | 40 |
| `plan_mode_exit` | 0 | 1 | 1 | 1 | 0 |
| `prompt_snapshot` | 10 | 6 | 2 | 6 | 26 |
| `queued_command` | 1 | 3 | 5 | 7 | 8 |
| `read_truncation_notice` | 0 | 0 | 0 | 0 | 1 |
| `remote_session_change` | 4 | 2 | 2 | 4 | 12 |
| `session_context` | 5 | 3 | 1 | 3 | 13 |
| `silent_turn_reminder` | 4 | 6 | 0 | 14 | 2 |
| `skill_listing` | 0 | 0 | 2 | 0 | 0 |
| `thinking_drop` | 0 | 1 | 0 | 0 | 0 |
| `total_tokens_reminder` | 0 | 112 | 215 | 476 | 465 |
| `ultra_effort_enter` | 0 | 2 | 0 | 0 | 0 |

#### Content block (role/type)

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `assistant/text` | 25 | 35 | 234 | 204 | 64 |
| `assistant/thinking` | 94 | 193 | 195 | 243 | 750 |
| `assistant/tool_use` | 220 | 299 | 440 | 589 | 1274 |
| `system/string` | 0 | 1 | 1 | 0 | 0 |
| `system/text` | 14 | 109 | 186 | 0 | 477 |
| `system/tool_addition` | 0 | 0 | 3 | 0 | 0 |
| `user/string` | 5 | 29 | 136 | 189 | 14 |
| `user/text` | 24 | 30 | 173 | 1 | 52 |
| `user/tool_result` | 157 | 183 | 232 | 589 | 876 |

#### tool_result shape

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `array[text]` | 4 | 2 | 3 | 0 | 11 |
| `array[tool_reference]` | 0 | 0 | 8 | 0 | 0 |
| `string` | 153 | 181 | 221 | 589 | 865 |

#### Flag

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `compact_boundary` | 0 | 1 | 1 | 2 | 0 |
| `isCompactSummary` | 0 | 1 | 1 | 2 | 0 |
| `isMeta` | 0 | 3 | 107 | 3 | 0 |
| `isSidechain=true` | 252 | 47 | 0 | 0 | 2238 |
| `logicalParentUuid` | 0 | 1 | 1 | 2 | 0 |
| `parentUuid=null (non-first)` | 0 | 1 | 1 | 2 | 0 |
| `repeated message.id` | 99 | 155 | 189 | 435 | 576 |

#### Tool used

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `Agent` | 8 | 2 | 0 | 0 | 24 |
| `Bash` | 92 | 224 | 393 | 498 | 714 |
| `Edit` | 28 | 0 | 0 | 0 | 138 |
| `Glob` | 0 | 0 | 0 | 0 | 2 |
| `Grep` | 6 | 12 | 3 | 12 | 70 |
| `Monitor` | 0 | 0 | 3 | 0 | 0 |
| `Read` | 30 | 50 | 17 | 76 | 240 |
| `SendMessage` | 0 | 0 | 8 | 0 | 0 |
| `Skill` | 2 | 0 | 2 | 0 | 0 |
| `TaskCreate` | 0 | 0 | 0 | 3 | 0 |
| `ToolSearch` | 0 | 0 | 8 | 0 | 0 |
| `WebFetch` | 42 | 10 | 0 | 0 | 10 |
| `WebSearch` | 6 | 0 | 0 | 0 | 2 |
| `Write` | 6 | 0 | 2 | 0 | 74 |
| `other` | 0 | 1 | 4 | 0 | 0 |

#### Slash command

| Name | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `/model` | 0 | 2 | 2 | 1 | 0 |
| `other` | 0 | 0 | 0 | 1 | 0 |
