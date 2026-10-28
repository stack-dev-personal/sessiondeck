# transcripts/05-subagents

Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by
`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not
reproduced here: counts, key names and reasons only.

## Covers

- Rows per file: `session.jsonl` 387; 12 sub-agent file(s) listed below.
  - `subagents/agent-a05f8470ae06023bc.jsonl`: 208
  - `subagents/agent-a074a8b01d718a508.jsonl`: 221
  - `subagents/agent-a1e853a16b3656648.jsonl`: 332
  - `subagents/agent-a2873ee60ceca4bd0.jsonl`: 63
  - `subagents/agent-a34479b832e4212fc.jsonl`: 42
  - `subagents/agent-a78e3c6dc6d3a5f6b.jsonl`: 171
  - `subagents/agent-a85fd8848ffe8e77b.jsonl`: 203
  - `subagents/agent-a9aae49ea2c81b9a1.jsonl`: 145
  - `subagents/agent-aaa5001d41354699d.jsonl`: 615
  - `subagents/agent-ab16e1d8e9db4514b.jsonl`: 716
  - `subagents/agent-abb998eb247a42e9f.jsonl`: 237
  - `subagents/agent-af6d193117d808b05.jsonl`: 719
- Total 4059 rows in 25 file(s) (the `.meta.json` files hold no rows).
- Files: `session.jsonl` and `subagents/agent-<id>.jsonl` with their `.meta.json`.
- Source size 11847057 bytes, scrubbed size 3705889 bytes.
- Claude Code versions seen: 2.1.301.
- Row order and row count equal the source. Ids and parent links are kept verbatim.

## Rows by type

This and the sections below count all jsonl files of the fixture together.

- assistant: 1054
- api-request-blob: 1039
- attachment: 714
- user: 651
- api-request: 487
- agent-setting: 26
- atis-latch: 26
- last-prompt: 26
- queue-operation: 20
- api-request-shape: 13
- system: 2
- cost-state: 1

## System rows by subtype

- api_error: 2

## Attachment rows by attachment type

- total_tokens_reminder: 465
- nested_memory: 40
- deferred_tools_record: 35
- edited_text_file: 26
- prompt_snapshot: 26
- mcp_instructions_delta: 14
- credential_org: 13
- date: 13
- environment: 13
- instructions: 13
- model: 13
- session_context: 13
- remote_session_change: 12
- queued_command: 8
- deferred_tools_delta: 2
- hook_success: 2
- silent_turn_reminder: 2
- agent_listing_delta: 1
- hook_additional_context: 1
- hook_non_blocking_error: 1
- read_truncation_notice: 1

## Content blocks by role and type

- api-request-blob/assistant/tool_use: 637
- assistant/assistant/tool_use: 637
- user/user/tool_result: 637
- api-request-blob/system/text: 477
- assistant/assistant/thinking: 378
- api-request-blob/assistant/thinking: 372
- api-request-blob/user/tool_result: 239
- api-request-blob/user/text: 52
- assistant/assistant/text: 39
- api-request-blob/assistant/text: 25
- user/user/string: 14

## Keys dropped to a `<BLOB n>` placeholder

n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.

- `addedBlocks` (14): MCP server instructions (configuration in bulk, names the user's servers)
- `addedLines` (3): agent and tool listings (configuration: names and descriptions of user agents)
- `entries` (35): deferred tool entries with schemas and descriptions (configuration in bulk)
- `private:content` (1094): base64 payload of an image or document source
- `private:new_string` (138): base64 payload of an image or document source
- `private:old_string` (138): base64 payload of an image or document source
- `private:pattern` (72): base64 payload of an image or document source
- `private:rendered` (81): base64 payload of an image or document source
- `private:snippet` (6): base64 payload of an image or document source
- `private:stderr` (1): base64 payload of an image or document source
- `private:stdout` (2): base64 payload of an image or document source
- `private:toolUseResult` (58): base64 payload of an image or document source
- `schema` (64): tool schema in a tool listing (configuration in bulk)
- `shape` (13): api-request-shape body: structure of the whole request (bulk duplicate)
- `systemPrompt` (26): system prompt text (configuration in bulk)
- `tail` (487): api-request tail: hash list of the request body (wire payload)
- `toolInputCopies` (35): attachment copy of tool inputs (bulk duplicate)
- `wireToolInputs` (637): wire copy of every tool input sent to the API (bulk duplicate)

## Rules applied

- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut
  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.
- `thinking` and `signature` become `<REDACTED-THINKING>`.
- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.
- Emails, account and organization ids, request ids and token-shaped strings become
  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.
- Strings at key paths not classified become `<TEXT n>` (n = original length): 0 in this fixture.
