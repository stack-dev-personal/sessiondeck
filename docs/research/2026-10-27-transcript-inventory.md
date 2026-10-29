# Transcript inventory (2026-10-27)

Unit U1 of session FX-T (R0.7, transcript extension). Counts and key names only; no transcript values appear here.
Produced by `node scripts/transcript-inventory.mjs --dir <project dir>... --exclude <live session> --copy-to packages/contract/fixtures/raw/transcripts` (read-only on sources).

## Scope

- Candidates: 21 transcripts (sessiondeck project folder plus headless worktree sessions), 217 sub-agent files.
- Skipped because modified in the last 30 minutes: 1. Excluded by instruction: 1 (the live conductor session, never read).
- Labels below (c01..c21) are the script's ordinal labels; they carry no id.
- Totals: 48056 rows, 37.8 MB main files, 109.3 MB sub-agent files, 0 unparsable lines.

## Aggregate findings

- Top-level row types (count): assistant 13370, attachment 9594, user 8676, api-request-blob 7433, api-request 3955, atis-latch 829, last-prompt 823, queue-operation 716, agent-setting 695, system 591, mode 397, permission-mode 397, pr-link 187, api-request-shape 157, ai-title 133, file-history-snapshot 78, cost-state 17, tools-used 7, file-history-delta 1.
- 128 distinct (type, top-level key set) combinations; most are optional-key variants (agentId, slug, session_id, requestRef, thinkingDisplay, wireToolInputs, serverClassifierRequest, and so on).
- system subtypes: turn_duration 330, away_summary 124, scheduled_task_fire 100, api_error 15, informational 14, compact_boundary 4, stop_hook_summary 4.
- Attachment types: 33 distinct (largest: total_tokens_reminder 4570, deferred_tools_record 761, nested_memory 633, prompt_snapshot 482, batching_reminder_sent 428). Rare: hook_non_blocking_error 1, read_truncation_notice 3, auto_mode 1, skill_listing 4, invoked_skills 1, compact_file_reference 1, command_permissions 1, thinking_drop 1.
- Rows with a `message`: roles assistant and user on assistant/user rows; api-request-blob rows also carry a `message` with role system, assistant or user.
- Content blocks per role: assistant: tool_use 12431, thinking 6656, text 1395; user: tool_result 9327, text 812, plain string 597; api-request-blob system: text 3436, tool_addition 6, string 2. No image, document, or redacted_thinking blocks anywhere.
- tool_result.content: string 9097, array[text] 222, array[tool_reference] 8.
- `toolUseResult` sidecar present on user rows; key sets differ per tool (Bash, Read, Agent, Grep, Glob, WebFetch, ToolSearch, SendMessage, Monitor, Skill, Write, and string-only forms for Edit, Skill, TaskCreate, Agent, Read, Write, Bash).
- Tool use counts: Bash 7450, Read 2209, Edit 1225, Grep 654, Write 357, Agent 354, WebFetch 88, Glob 38, Monitor 14, WebSearch 11, SendMessage 8, ToolSearch 8, Skill 5, TaskCreate 3, other 7, mcp 0. Distinct custom agent types: 9.
- Flags: isSidechain=true 23071 (sub-agent files), repeated message.id 7247 (streaming splits), isMeta 115, compact_boundary 4, isCompactSummary 4, logicalParentUuid 4, parentUuid null beyond the first 4.
- Slash commands (structural tag): /model 5, other 1, /clear 0, /compact 0, /resume 0.
- Rows whose sessionId differs from the file name: 0. Distinct sessionIds per file: 1 (21 total).
- Versions: 2.1.295, 2.1.296, 2.1.300, 2.1.301, 2.1.302, 2.1.303, 2.1.304, 2.1.311.
- Models: claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-1, claude-haiku-5-5, plus 38 assistant rows with a non-id model value (reported as `<other>`).

## Not present in any candidate

- A `/clear` command row, a resume (sessionId differing from file name), a `/compact` or `/resume` command tag. Compaction itself exists (compact_boundary plus isCompactSummary, 4 each, in 3 transcripts).
- image, document, and redacted_thinking blocks.

## Selection

Exhaustive search over all 5-subsets of the 21 candidates: must include a sub-agent transcript and a compaction; maximise distinct structural features (row type, system subtype, attachment type, content block type, tool_result shape, sidecar shape, tool, command, flag; weight 100 each), then key-set variants (weight 1); ties go to the smaller total size.

| Dir | Label | Size (main + sub) | Sub-agent jsonl | Why |
|-----|-------|-------------------|-----------------|-----|
| 01-subagents | c04 | 2.16 MB | 4 | smallest sub-agent transcript; only source of `tools-used` rows |
| 02-subagents-compaction | c03 | 4.48 MB | 1 | smallest with compaction; hook_cancelled, thinking_drop, ultra_effort_enter |
| 03-compaction | c01 | 5.98 MB | 0 | ai-title, file-history-delta, scheduled_task_fire, tool_reference results, tool_addition, skill_listing, auto_mode, invoked_skills, command_permissions |
| 04-compaction | c02 | 7.11 MB | 0 | pr-link, stop_hook_summary, compact_file_reference, an "other" slash command |
| 05-subagents | c14 | 11.85 MB | 12 | only source of hook_non_blocking_error and read_truncation_notice; api_error system rows |

05 is the largest; it is the cheapest way to cover the two rare attachment types and api_error.

## Coverage (feature -> which of the five)

Common to all five: row types assistant, user, attachment, queue-operation, last-prompt, atis-latch, cost-state; blocks assistant text/thinking/tool_use, user string/text/tool_result; tool_result string; flag repeated message.id.

| Feature | Covered by |
|---------|------------|
| row: tools-used | 01 |
| row: ai-title, file-history-delta | 03 |
| row: pr-link | 04 |
| row: agent-setting | 01, 02, 04, 05 |
| row: api-request, api-request-blob, api-request-shape | 01, 02, 03, 05 |
| row: mode, permission-mode, file-history-snapshot | 02, 03, 04 |
| row: system | 02, 03, 04, 05 |
| system: turn_duration, away_summary, informational, compact_boundary | 02, 03, 04 |
| system: scheduled_task_fire | 03 |
| system: stop_hook_summary | 04 |
| system: api_error | 05 |
| block: system/text | 01, 02, 03, 05 |
| block: system/string | 02, 03 |
| block: system/tool_addition | 03 |
| tool_result: array[text] | 01, 02, 03, 05 |
| tool_result: array[tool_reference] | 03 |
| attachment: hook_cancelled, thinking_drop, ultra_effort_enter | 02 |
| attachment: auto_mode, command_permissions, invoked_skills, skill_listing | 03 |
| attachment: compact_file_reference | 04 |
| attachment: hook_non_blocking_error, read_truncation_notice | 05 |
| attachment: nested_memory | 01, 05 |
| flags: compact_boundary, isCompactSummary, logicalParentUuid, isMeta, parentUuid null (non-first) | 02, 03, 04 |
| flags: isSidechain=true, sub-agent files | 01, 02, 05 |
| command: /model | 02, 03, 04 |
| command: other | 04 |
| command: /clear, /compact, /resume; resume marker | none exist |

Every other attachment type is covered by at least one of the five (the script prints the full per-feature table).

## Uncovered

- Structural features: none among those that exist. /clear, /resume, resume marker, image, document, redacted_thinking do not exist in any candidate.
- Key-set variants: 116 of 128 covered. The 12 uncovered are optional-key variants of rows already covered (user rows with `sandboxed` or `turnCompanion`, assistant rows with differing optional keys such as `thinkingDisplay`, `attributionAgent`, `requestRef`, `apiError*`). Covering them would cost more files for no new row type, subtype or block type.

## Key names not in scripts/lib/fixture-keys.mjs

282 names; the transcript vocabulary is almost entirely new to the allowlist. The script prints the full list under "keys not in fixture-keys.mjs"; the scrub unit reviews it before admitting any. Groups: row envelope (parentUuid, uuid, isSidechain, isMeta, isCompactSummary, logicalParentUuid, promptId, requestId, sessionId, slug, userType, entrypoint, gitBranch, timestamp, version), message (stop_reason, usage, context_management, diagnostics, input_transformations), api-request rows (params, base, tail, shapeHash, requestDigest, cacheControl), attachment (attachment, rendered, renderedRole, and others), sidecar (stdout, stderr, interrupted, filenames, numFiles, toolStats, totalTokens, and others). `userEmail` is a key name only; check its value when scrubbing.

## Raw copies

Copied (gitignored, `git check-ignore` confirmed) to `packages/contract/fixtures/raw/transcripts/01-subagents`, `02-subagents-compaction`, `03-compaction`, `04-compaction`, `05-subagents` as `session.jsonl` plus `subagents/<original names>` including `.meta.json`. Never commit anything under `raw/`.
