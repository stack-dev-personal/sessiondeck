# transcripts/03-compaction

Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by
`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not
reproduced here: counts, key names and reasons only.

## Covers

- Rows per file: `session.jsonl` 3548.
- Total 3548 rows in 1 file(s).
- Files: `session.jsonl`.
- Source size 5979974 bytes, scrubbed size 2813364 bytes.
- Claude Code versions seen: 2.1.304.
- Row order and row count equal the source. Ids and parent links are kept verbatim.

## Rows by type

This and the sections below count all jsonl files of the fixture together.

- assistant: 524
- attachment: 518
- api-request: 492
- api-request-blob: 441
- user: 357
- system: 278
- queue-operation: 250
- atis-latch: 134
- last-prompt: 134
- mode: 134
- permission-mode: 134
- ai-title: 133
- file-history-snapshot: 12
- api-request-shape: 5
- cost-state: 1
- file-history-delta: 1

## System rows by subtype

- turn_duration: 131
- scheduled_task_fire: 100
- away_summary: 39
- informational: 7
- compact_boundary: 1

## Attachment rows by attachment type

- total_tokens_reminder: 215
- deferred_tools_record: 140
- batching_reminder_sent: 79
- bash_output_audience_note: 33
- environment: 10
- file: 5
- queued_command: 5
- deferred_tools_delta: 3
- hook_success: 3
- mcp_instructions_delta: 3
- model: 3
- agent_listing_delta: 2
- date: 2
- prompt_snapshot: 2
- remote_session_change: 2
- skill_listing: 2
- auto_mode: 1
- command_permissions: 1
- credential_org: 1
- edited_text_file: 1
- hook_additional_context: 1
- instructions: 1
- invoked_skills: 1
- plan_mode_exit: 1
- session_context: 1

## Content blocks by role and type

- assistant/assistant/tool_use: 221
- user/user/tool_result: 221
- api-request-blob/assistant/tool_use: 219
- api-request-blob/system/text: 186
- api-request-blob/user/text: 172
- assistant/assistant/text: 172
- user/user/string: 135
- assistant/assistant/thinking: 131
- api-request-blob/assistant/thinking: 64
- api-request-blob/assistant/text: 62
- api-request-blob/user/tool_result: 11
- api-request-blob/system/tool_addition: 3
- api-request-blob/system/string: 1
- api-request-blob/user/string: 1
- user/user/text: 1

## Keys dropped to a `<BLOB n>` placeholder

n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.

- `addedBlocks` (3): MCP server instructions (configuration in bulk, names the user's servers)
- `addedLines` (5): agent and tool listings (configuration: names and descriptions of user agents)
- `backup` (1): file-history backup record (user file path and backup name)
- `definition` (3): tool definition incl. schema and description (configuration in bulk)
- `diagnostics` (8): request diagnostics (wire detail)
- `entries` (140): deferred tool entries with schemas and descriptions (configuration in bulk)
- `private:content` (222): base64 payload of an image or document source
- `private:rendered` (12): base64 payload of an image or document source
- `private:snippet` (1): base64 payload of an image or document source
- `private:stdout` (3): base64 payload of an image or document source
- `private:toolUseResult` (196): base64 payload of an image or document source
- `schema` (16): tool schema in a tool listing (configuration in bulk)
- `serverClassifierContext` (187): classifier context incl. git state, paths and remotes (request body)
- `serverClassifierRequest` (449): server-side classifier request reference (request body)
- `shape` (5): api-request-shape body: structure of the whole request (bulk duplicate)
- `surfacedDefinitions` (2): surfaced tool definitions (configuration in bulk)
- `systemPrompt` (2): system prompt text (configuration in bulk)
- `tail` (492): api-request tail: hash list of the request body (wire payload)
- `toolInputCopies` (136): attachment copy of tool inputs (bulk duplicate)
- `trackedFileBackups` (12): file-history backup map keyed by user file paths
- `wireIngestContext` (137): wire copy of the ingested conversation context (bulk duplicate)
- `wireToolInputs` (221): wire copy of every tool input sent to the API (bulk duplicate)

## Rules applied

- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut
  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.
- `thinking` and `signature` become `<REDACTED-THINKING>`.
- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.
- Emails, account and organization ids, request ids and token-shaped strings become
  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.
- Strings at key paths not classified become `<TEXT n>` (n = original length): 5 in this fixture.
