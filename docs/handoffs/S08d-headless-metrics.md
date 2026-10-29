# S8d: metrics for headless sessions and their subagents

Conductor-written handoff (decision 31, 2026-10-28). Copy to docs/handoffs/S08d-headless-metrics.md in your first docs commit.

## User's words (verbatim)
"Headless sessions (and their subagents) are not having their metrics tracked properly. All I can see is the session title and the prompt it was given."

## Diagnosis (conductor, read-only, 2026-10-28T20:30Z)
- Claude Code runs statusLine and subagentStatusLine only in the interactive TUI. A headless `claude -p` session sends hooks but zero statusline payloads (probe spool today: S8c session 589ac84d and FX-T 6680480d have SessionStart, UserPromptSubmit, Pre/PostToolUse, SubagentStart/Stop, but 0 statusline; the interactive conductor session has about 1,600).
- So the hub snapshot for headless sessions has model, effort, context, cost, git.branch, last_assistant_message null, and every subagent's model, tokens and context_window null. State, tool and the subagent list work.
- The hub already has the transcript: GET /sessions/589ac84d.../cost returns tokens, models [claude-opus-5-5, claude-sonnet-5-5] and cost_usd 1.31 from transcript_lines. The data exists; the snapshot never uses it.

## Requirements (add to docs/planning/phases/phase-2-hub.md with a dated note "added 2026-10-28 from user report", add, never renumber)
- R2.12 Transcript-derived snapshot fields. When a session has no statusline value for a field, the hub fills it from the session's transcript lines it already stores: model (last assistant row's message.model), context tokens (last assistant row's usage: input + cache_creation + cache_read) and used % against the model's context window from the pricing table (max_input_tokens; if unknown, show tokens without a percent), cost (the transcript-priced cost the cost route already computes, lifetime), git branch (the rows' gitBranch), last assistant message (last assistant text, capped like today). Statusline values always win when present. Each filled field carries its source (statusline or transcript) in the snapshot so the board can label it. Updates flow through the existing WS deltas as transcript lines arrive.
- R2.13 Subagents of any session (headless or interactive): model, tokens and context from their subagent transcript lines (agentId link), filling the nulls in snapshot.subagents. Effort: only if a transcript or hook row states it; otherwise stays null (measured figures only, decision 28).
- R3.16 Board labels transcript-derived figures (for example a small "from transcript" marker or tooltip on cost and context) and shows cost as "API-equivalent". No estimates.
- Tests: a recorded headless session (hooks plus transcript lines, no statusline; build it from packages/contract/fixtures/transcripts/ and existing hook fixtures) produces a snapshot with model, context, cost, branch and subagent figures; an interactive session's statusline values are never overwritten by transcript values; a harness against this laptop's live data shape (read-only, against your own hub on a separate port fed from a copy of fixtures, never the user's live hub) prints the filled snapshot.

## Overlap
S7 (p4/normalize, in the sprint container) changes packages/hub/src/pricing and usage (1-hour cache-write pricing, unpriced models). Reuse the usage service's public functions; do not edit pricing internals. You merge after S7; conflicts go to a conflict-resolution session.

## Executors and review
hub: sd-executor-hub; web: sd-executor-web; contract (snapshot source markers): sd-executor-contract. sd-reviewer every unit. sd-verifier per unit and at the end (VERIFY-P2, VERIFY-P3).
