# Session log: p0/fixtures (S0b)

- Date: 2026-10-15
- Handoff: docs/handoffs/S00b-fixtures-and-reducer-finalization.md
- Branch: p0/fixtures from sprint/0-bootstrap at 6baa15c (origin/sprint/0-bootstrap is also 6baa15c at intake)
- Contract SHA at start: 6baa15c (no contract commit for Sprint 0; this session produces it)
- Capture: Claude Code 2.1.301, Windows 11 Home 10.0.26200, one working day (2026-10-15), 3807 raw files, five sessions in five project directories. Raw copy at packages/contract/fixtures/raw/ (gitignored, never committed, never quoted).
- Requirements: R0.1, R0.2, R0.3, R0.4, R0.7 (handoff names R0.2, R0.3, R0.4, R0.7; R0.1 has a "pending S0b" row)

## Task list

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 fixture inventory, scrub, select (scripts plus scrubbed set, README) | R0.7 | sd-executor-contract | none | review round 3 |
| U2 captured-fixture walks (envelope, statusLine) and CONTRACT.md observed payloads | R0.1, R0.4, R0.7 | sd-executor-contract | U1 | pending |
| U3 reducer TODO(fixture) finalization and golden timeline | R0.2, R0.3 | sd-executor-contract | U1 | pending |
| U4 conductor decisions: ADR docker socket, PROMPT-BOOK section 6, entrypoint export, capture path docs, guard rule, Read deny rules | decisions 1, 3, 4, 5 | sd-executor-contract (widened scope) | none | review round 3; .claude items blocked (see below) |
| Close: rebase, full suite, VERIFY-P0 rows incl. laptop confirmations, PR | all | sd-verifier | U1-U4 | pending |

## Decisions made

Conductor decisions (<sessiondeck>/.sprint/0/answers/decisions.md, recorded 2026-10-15T14:14:37Z):
1. Docker socket mount accepted by the user. Sibling-container model stays. ADR to be written in this session (U4).
2. R0.5 scope confirmed: sprint tooling tests stay in their own CI step. No change.
3. Docs unit folded into S0b (U4): PROMPT-BOOK section 6 gains the green sprint state; headless prompts say subagent calls stay in the foreground; session status heartbeat at least every 15 minutes; infra/sprint/entrypoint.sh exports CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 before the headless claude call, with a test.
4. S0 open questions at defaults: keep SessionSnapshot.tracking; keep pid in liveness payloads (envelope unchanged); raw captures default to the capture tool's directory under local app data (handoff updated in U4; fixture-capture skill blocked, see U4, with the real file name shape: epoch-ms, short session id, random suffix); hub host check and 400 semantics deferred to S3.
5. Guard rule blocking capture-install.mjs --apply from any session, and Read deny rules for the capture directory in the project settings (U4).
6. Capture day done (2026-10-15).
7. Task-list fixtures synthetic: TaskCreated and TaskCompleted were not captured (task tools disabled on this machine). Also synthetic by decision: PermissionDenied (default permission mode), StopFailure. Stated in the fixture README and docs/VERIFY-P0.md.

Scope widening for this session (conductor): sd-executor-contract may edit .claude/hooks/guard.mjs (with test), the deny list of .claude/settings.json, .claude/skills/fixture-capture/SKILL.md, docs/handoffs/S00b-fixtures-and-reducer-finalization.md, PROMPT-BOOK.md, docs/decisions/, infra/sprint/entrypoint.sh (with test). sd-security-reviewer gates every diff under .claude/ and infra/.

Laptop confirmations handed to this session (to record in docs/VERIFY-P0.md): R0.8 live smoke PASS 2026-10-15 (green 16.2 s after container start, evidence .sprint/0/gate/smoke-evidence-run2.txt); capture installer real install and uninstall from a plain terminal, backups beside the user-level settings file, exec-form hooks fire, no _capture-errors.log; project guard hook still fires with the capture hook installed.

## Units

## Deferred findings
(Units are appended below in order; "Deferred findings" is at the end of the file.)

### U1 fixture inventory, scrub, select (R0.7)
- Executor sd-executor-contract. Commits b6d7158 (scripts), 3899726 (scrubbed set, committed only after the security gate passed), fix round 1 b0f153f, 6ccdd5e; fix round 2 f9775be.
- Set: 176 hook fixtures over 13 events, 20 statusLine (17 with rate_limits, 3 without, 8 with current_usage null, max used_percentage 96), 5 subagentStatusLine, golden session 295 events (SessionStart startup to SessionEnd clear, one session id), synthetic TaskCreated, TaskCompleted (2), PermissionDenied, StopFailure.
- Inventory gap explained: 3807 files minus 12 in _state, _usage.log and .gitignore = 3793 payloads.
- Raw cwd values hold 9 real project directory names, not five; the leak gate derives every path segment.
- sd-security-reviewer: iteration 1 at 3899726 "Gate: pass" (4 MEDIUM, 3 LOW on the controls, data clean); iteration 2 at a6984c2 "Gate: pass" (1 MEDIUM, 4 LOW); iteration 3 pending at f9775be.
- sd-reviewer: iteration 1 at b6d7158 fix-then-merge (3 MAJOR); iteration 2 at a6984c2 fix-then-merge (2 MAJOR; the "no security verdict" MAJOR was a stale-log false positive, the verdicts are logged here); iteration 3 pending.
- Observed payload notes (key names only) for CONTRACT.md: mcp_server is an object {name, source}; effort is an object {level}; SessionStart sources startup, compact, clear (no resume); SessionEnd reasons other, clear; permission_mode auto and plan only; SubagentStop agent_type empty in 256 of 269, 7 lack last_assistant_message; Notification never carries agent_id; agent_type without agent_id on main-thread events of --agent sessions; PermissionRequest has no tool_use_id and no agent_id; PreCompact {trigger, custom_instructions}, PostCompact {trigger, compact_summary}; PostToolUseFailure {error, is_interrupt, duration_ms}; tool_response shape varies (object, array, string); statusLine adds agent, session_name, prompt_cache, fast_mode, thinking, exceeds_200k_tokens, workspace.repo, workspace.git_worktree. None contradicts 01-architecture.md section 3 (envelope and state enum unchanged; these are parsing details), so no stop condition.
- Note: in fix round 2 the executor briefly moved fixtures/raw to simulate CI and moved it back; file count re-checked at 3807, nothing tracked.

### U4 conductor decisions (decisions 1, 3, 4, 5)
- Executor sd-executor-contract. Commits 305b96a (ADR 0009, PROMPT-BOOK section 6 green state and foreground rule, entrypoint test tightened, S00b handoff raw path), a6984c2 and c5cb856 (heartbeat wording: background shell heartbeat, capped, stop file, killed on every exit path).
- entrypoint.sh already exported CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 before the claude call (S0c); the test now asserts the export, its value, and its position.
- BLOCKED by Claude Code's own permission check (edits under .claude/ refused as sensitive in this non-interactive session; not circumvented): guard.mjs rule for capture-install.mjs --apply with its test, Read deny rule for the capture directory, fixture-capture SKILL.md raw path. These go to the user as a ready patch.
- sd-security-reviewer on U4: covered in the iteration 2 and 3 reviews (PROMPT-BOOK, scripts/test); nothing under .claude/ or infra/ changed.
