# transcripts/01-subagents

Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by
`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not
reproduced here: counts, key names and reasons only.

## Covers

- Rows per file: `session.jsonl` 234; 4 sub-agent file(s) listed below.
  - `subagents/agent-a0521282f787974c4.jsonl`: 97
  - `subagents/agent-a34c7010c6c881f7d.jsonl`: 35
  - `subagents/agent-a83f43fff7f36e4ce.jsonl`: 133
  - `subagents/agent-aad72b831771ef7f4.jsonl`: 107
- Total 606 rows in 9 file(s) (the `.meta.json` files hold no rows).
- Files: `session.jsonl` and `subagents/agent-<id>.jsonl` with their `.meta.json`.
- Source size 2163218 bytes, scrubbed size 628751 bytes.
- Claude Code versions seen: 2.1.311.
- Row order and row count equal the source. Ids and parent links are kept verbatim.

## Rows by type

This and the sections below count all jsonl files of the fixture together.

- assistant: 173
- user: 115
- api-request-blob: 102
- api-request: 75
- attachment: 73
- agent-setting: 17
- atis-latch: 17
- last-prompt: 17
- tools-used: 7
- api-request-shape: 5
- queue-operation: 4
- cost-state: 1

## System rows by subtype

- none

## Attachment rows by attachment type

- prompt_snapshot: 10
- credential_org: 5
- date: 5
- edited_text_file: 5
- environment: 5
- instructions: 5
- mcp_instructions_delta: 5
- model: 5
- nested_memory: 5
- session_context: 5
- deferred_tools_record: 4
- remote_session_change: 4
- silent_turn_reminder: 4
- hook_success: 2
- agent_listing_delta: 1
- deferred_tools_delta: 1
- hook_additional_context: 1
- queued_command: 1

## Content blocks by role and type

- api-request-blob/assistant/tool_use: 110
- assistant/assistant/tool_use: 110
- user/user/tool_result: 110
- assistant/assistant/thinking: 48
- api-request-blob/user/tool_result: 47
- api-request-blob/assistant/thinking: 46
- api-request-blob/user/text: 24
- assistant/assistant/text: 15
- api-request-blob/system/text: 14
- api-request-blob/assistant/text: 10
- user/user/string: 5

## Keys dropped to a `<BLOB n>` placeholder

n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.

- `addedBlocks` (5): MCP server instructions (configuration in bulk, names the user's servers)
- `addedLines` (2): agent and tool listings (configuration: names and descriptions of user agents)
- `entries` (4): deferred tool entries with schemas and descriptions (configuration in bulk)
- `private:content` (185): base64 payload of an image or document source
- `private:new_string` (28): base64 payload of an image or document source
- `private:old_string` (28): base64 payload of an image or document source
- `private:pattern` (6): base64 payload of an image or document source
- `private:rendered` (17): base64 payload of an image or document source
- `private:snippet` (5): base64 payload of an image or document source
- `private:stdout` (2): base64 payload of an image or document source
- `private:toolUseResult` (29): base64 payload of an image or document source
- `schema` (27): tool schema in a tool listing (configuration in bulk)
- `shape` (5): api-request-shape body: structure of the whole request (bulk duplicate)
- `systemPrompt` (10): system prompt text (configuration in bulk)
- `tail` (75): api-request tail: hash list of the request body (wire payload)
- `toolInputCopies` (4): attachment copy of tool inputs (bulk duplicate)
- `wireToolInputs` (110): wire copy of every tool input sent to the API (bulk duplicate)

## Rules applied

- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut
  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.
- `thinking` and `signature` become `<REDACTED-THINKING>`.
- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.
- Emails, account and organization ids, request ids and token-shaped strings become
  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.
- Strings at key paths not classified become `<TEXT n>` (n = original length): 0 in this fixture.
