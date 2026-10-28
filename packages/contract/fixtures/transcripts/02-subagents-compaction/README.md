# transcripts/02-subagents-compaction

Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by
`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not
reproduced here: counts, key names and reasons only.

## Covers

- Rows per file: `session.jsonl` 1681; 1 sub-agent file(s) listed below.
  - `subagents/agent-a6597ad776bf58296.jsonl`: 73
- Total 1754 rows in 3 file(s) (the `.meta.json` files hold no rows).
- Files: `session.jsonl` and `subagents/agent-<id>.jsonl` with their `.meta.json`.
- Source size 4480723 bytes, scrubbed size 1354979 bytes.
- Claude Code versions seen: 2.1.304.
- Row order and row count equal the source. Ids and parent links are kept verbatim.

## Rows by type

This and the sections below count all jsonl files of the fixture together.

- attachment: 388
- assistant: 281
- api-request-blob: 241
- user: 179
- api-request: 171
- last-prompt: 83
- agent-setting: 82
- atis-latch: 82
- mode: 82
- permission-mode: 82
- system: 35
- queue-operation: 32
- file-history-snapshot: 12
- api-request-shape: 2
- cost-state: 2

## System rows by subtype

- turn_duration: 23
- away_summary: 8
- informational: 3
- compact_boundary: 1

## Attachment rows by attachment type

- total_tokens_reminder: 112
- batching_reminder_sent: 94
- deferred_tools_record: 68
- bash_output_audience_note: 56
- prompt_snapshot: 6
- silent_turn_reminder: 6
- environment: 5
- file: 5
- date: 4
- mcp_instructions_delta: 4
- credential_org: 3
- instructions: 3
- model: 3
- queued_command: 3
- session_context: 3
- agent_listing_delta: 2
- hook_cancelled: 2
- remote_session_change: 2
- ultra_effort_enter: 2
- deferred_tools_delta: 1
- hook_additional_context: 1
- hook_success: 1
- plan_mode_exit: 1
- thinking_drop: 1

## Content blocks by role and type

- assistant/assistant/tool_use: 150
- user/user/tool_result: 150
- api-request-blob/assistant/tool_use: 149
- api-request-blob/system/text: 109
- assistant/assistant/thinking: 102
- api-request-blob/assistant/thinking: 91
- api-request-blob/user/tool_result: 33
- api-request-blob/user/text: 30
- assistant/assistant/text: 29
- user/user/string: 29
- api-request-blob/assistant/text: 6
- api-request-blob/system/string: 1

## Keys dropped to a `<BLOB n>` placeholder

n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.

- `addedBlocks` (4): MCP server instructions (configuration in bulk, names the user's servers)
- `addedLines` (3): agent and tool listings (configuration: names and descriptions of user agents)
- `diagnostics` (6): request diagnostics (wire detail)
- `entries` (68): deferred tool entries with schemas and descriptions (configuration in bulk)
- `private:content` (180): base64 payload of an image or document source
- `private:pattern` (6): base64 payload of an image or document source
- `private:rendered` (9): base64 payload of an image or document source
- `private:stdout` (1): base64 payload of an image or document source
- `private:toolUseResult` (131): base64 payload of an image or document source
- `schema` (16): tool schema in a tool listing (configuration in bulk)
- `serverClassifierContext` (114): classifier context incl. git state, paths and remotes (request body)
- `serverClassifierRequest` (279): server-side classifier request reference (request body)
- `shape` (2): api-request-shape body: structure of the whole request (bulk duplicate)
- `systemPrompt` (6): system prompt text (configuration in bulk)
- `tail` (171): api-request tail: hash list of the request body (wire payload)
- `toolInputCopies` (68): attachment copy of tool inputs (bulk duplicate)
- `trackedFileBackups` (12): file-history backup map keyed by user file paths
- `wireIngestContext` (83): wire copy of the ingested conversation context (bulk duplicate)
- `wireToolInputs` (150): wire copy of every tool input sent to the API (bulk duplicate)

## Rules applied

- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut
  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.
- `thinking` and `signature` become `<REDACTED-THINKING>`.
- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.
- Emails, account and organization ids, request ids and token-shaped strings become
  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.
- Strings at key paths not classified become `<TEXT n>` (n = original length): 0 in this fixture.
