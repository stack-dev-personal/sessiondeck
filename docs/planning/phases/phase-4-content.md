---
id: 'sessiondeck-phase-4'
title: 'Phase 4: Content (session view)'
collection: 'sessiondeck'
type: phase
phase: 4
status: planned
depends_on: [1, 2, 3]
---
# Phase 4: Content

## MVP
Open a session and read what it is doing: the conversation as messages, tool calls with their inputs and results, edits as diffs, subagent threads nested under the call that spawned them, and a "files touched" list. Updates live as the transcript grows.

## Scope
In:
- Hub: transcript normalizer (`contract/normalize.ts`) from raw JSONL rows to `UnifiedMessage[]`, with `parentUuid` branch pruning (edited or forked prompts), `isSidechain` separation, subagent transcript attachment by `agent_id`, compaction boundaries rendered as a divider.
- Hub: `GET /sessions/:id/transcript?after=` paginated; WS `transcript` deltas.
- Probe: redaction filter before shipping transcript lines (A14): `.env`-style assignments, bearer/API key prefixes (`sk-`, `ghp_`, `AKIA`, `xox`), configurable allow/deny regex list; redacted spans replaced with `[redacted:<rule>]`.
- Web: session view route with the message list (virtualized), tool call views (Edit/MultiEdit as unified diff, Bash with stdout/stderr, Read as excerpt, Grep/Glob as results, Agent as collapsible thread, TodoWrite/TaskCreate/TaskUpdate as task snapshots, AskUserQuestion as the question card), thinking blocks collapsed by default, raw-row fallback for unknown types.
- Files touched panel: derived from Edit/Write/NotebookEdit calls, with counts and last-change time; click scrolls to the call.
- Split view: board strip on top, content below (first use of the layout engine; Phase 6 generalizes it).
Out:
- Editing or sending input (Phase 8). Full-text search across sessions (Phase 5). Syntax highlighting beyond diffs (nice-to-have, note in backlog).

## Blockers / constraints
- Transcript format is undocumented and unstable. Every row type seen in fixtures gets a normalizer case and a test; unknown rows render raw, never throw.
- Streaming assistant rows repeat the same `message.id` with growing content; the normalizer must replace, not append (ccusage dedup rule).
- Large tool results are stored in `<session>/tool-results/` on the laptop, not inline; the tailer ships a pointer and the view shows "large output, n KB" with on-demand fetch (Phase 8 territory if it needs a laptop file read; in Phase 4 show the truncation note only).
- Redaction cannot be perfect; the UI labels transcripts as "shipped from laptop, redaction best-effort" in settings.

## Inputs
- Crystal `frontend/src/components/panels/ai/transformers/{MessageTransformer,ClaudeMessageTransformer}.ts` and `panels/ai/components/{ToolCallView,ToolCallGroup,MessageSegment,TodoListDisplay}.tsx` (MIT): port as the renderer seed.
- vibe-kanban `crates/executors/src/logs/mod.rs` `NormalizedEntryType` (Apache-2.0) as the schema reference; `packages/web-core/.../NormalizedConversation/EditDiffRenderer.tsx` for the diff presentation.
- claudecodeui `src/modules/chat/tools/configs/toolConfigs.ts`, `server/shared/message-unification.ts`, `claude-sessions.provider.ts` `dropSupersededPromptBranches` (AGPL): spec only, for the list of tools needing custom views and the branch-pruning algorithm.
- cctop `reference/transcript-format.md` (MIT) as the community format notes.
- simonw/claude-code-transcripts (Apache-2.0) as a second opinion on rendering choices.
- Phase 0 fixtures and a fresh capture of 5 full transcripts from your sessions (including one with subagents and one with a compaction).

## Instruments
- `react-virtuoso` or `@tanstack/virtual` for the list; `diff` + a small unified-diff component; `shiki` optional.
- Normalizer golden tests: each fixture transcript → expected `UnifiedMessage[]` JSON.
- Redaction test corpus: 200 synthetic lines with known secrets, 0 leaks; 200 benign code lines, < 2% false positives.

## Requirements
- R4.1 Normalizer covers every row type present in fixtures; unknown types render raw with a visible label.
- R4.2 Edited/forked prompt branches are pruned the same way Claude Code's own resume shows them.
- R4.3 Subagent threads nest under their spawning `Agent` call and show the subagent's own token/context figures.
- R4.4 New transcript lines appear in the open view within 2 s of being written on the laptop.
- R4.5 Diff view for Edit/MultiEdit/Write shows added/removed lines with line numbers and file path; copy button for the path.
- R4.6 Files touched panel is accurate against `git status` for a fixture session (manual check once, then golden).
- R4.7 Redaction: 0 leaks on the secret corpus, < 2% false positives on the benign corpus; rules configurable in `probe.json`.
- R4.8 A 5 MB transcript opens and scrolls without jank (virtualized; initial render < 500 ms).

## Definition of done
- [ ] All R4.x pass; golden normalizer tests in CI.
- [ ] You can follow a live session end to end from the browser without opening the terminal, for one real phase of another project.
- [ ] `docs/TRANSCRIPT-FORMAT.md` documents every row type you handle, with a fixture reference, so the next Claude Code release can be diffed against it.
- [ ] `sd-reviewer` and `sd-security-reviewer` sign-off (security covers redaction and the raw-row fallback not leaking more than the normalized view).
