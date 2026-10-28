# transcripts/04-compaction

Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by
`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not
reproduced here: counts, key names and reasons only.

## Covers

- Rows per file: `session.jsonl` 4561.
- Total 4561 rows in 1 file(s).
- Files: `session.jsonl`.
- Source size 7114662 bytes, scrubbed size 3642345 bytes.
- Claude Code versions seen: 2.1.295.
- Row order and row count equal the source. Ids and parent links are kept verbatim.

## Rows by type

This and the sections below count all jsonl files of the fixture together.

- attachment: 1190
- assistant: 1036
- user: 779
- queue-operation: 272
- system: 263
- last-prompt: 183
- agent-setting: 181
- atis-latch: 181
- mode: 181
- permission-mode: 181
- pr-link: 58
- file-history-snapshot: 54
- cost-state: 2

## System rows by subtype

- turn_duration: 176
- away_summary: 77
- informational: 4
- stop_hook_summary: 4
- compact_boundary: 2

## Attachment rows by attachment type

- total_tokens_reminder: 476
- batching_reminder_sent: 255
- deferred_tools_record: 238
- bash_output_audience_note: 120
- environment: 24
- silent_turn_reminder: 14
- file: 9
- date: 8
- queued_command: 7
- prompt_snapshot: 6
- mcp_instructions_delta: 5
- deferred_tools_delta: 4
- model: 4
- remote_session_change: 4
- agent_listing_delta: 3
- credential_org: 3
- instructions: 3
- session_context: 3
- compact_file_reference: 1
- hook_additional_context: 1
- hook_success: 1
- plan_mode_exit: 1

## Content blocks by role and type

- assistant/assistant/tool_use: 589
- user/user/tool_result: 589
- assistant/assistant/thinking: 243
- assistant/assistant/text: 204
- user/user/string: 189
- user/user/text: 1

## Keys dropped to a `<BLOB n>` placeholder

n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.

- `addedBlocks` (5): MCP server instructions (configuration in bulk, names the user's servers)
- `addedLines` (7): agent and tool listings (configuration: names and descriptions of user agents)
- `diagnostics` (26): request diagnostics (wire detail)
- `entries` (238): deferred tool entries with schemas and descriptions (configuration in bulk)
- `hookAdditionalContext` (4): context injected by hooks (user configuration)
- `private:content` (525): base64 payload of an image or document source
- `private:pattern` (8): base64 payload of an image or document source
- `private:rendered` (13): base64 payload of an image or document source
- `private:stdout` (1): base64 payload of an image or document source
- `private:toolUseResult` (489): base64 payload of an image or document source
- `schema` (15): tool schema in a tool listing (configuration in bulk)
- `serverClassifierContext` (494): classifier context incl. git state, paths and remotes (request body)
- `serverClassifierRequest` (1030): server-side classifier request reference (request body)
- `systemPrompt` (6): system prompt text (configuration in bulk)
- `toolInputCopies` (238): attachment copy of tool inputs (bulk duplicate)
- `trackedFileBackups` (54): file-history backup map keyed by user file paths
- `wireIngestContext` (290): wire copy of the ingested conversation context (bulk duplicate)
- `wireToolInputs` (589): wire copy of every tool input sent to the API (bulk duplicate)

## Rules applied

- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut
  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.
- `thinking` and `signature` become `<REDACTED-THINKING>`.
- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.
- Emails, account and organization ids, request ids and token-shaped strings become
  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.
- Strings at key paths not classified become `<TEXT n>` (n = original length): 0 in this fixture.
