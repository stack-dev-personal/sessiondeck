# Session log: p0/scaffold (S0)

- Date: 2026-10-08 (local), started 2026-10-09T03:03:21Z
- Handoff: docs/handoffs/S00-contract-and-scaffold.md
- Sprint: 0 (bootstrap), base branch sprint/0-bootstrap at 3e8178c
- Contract SHA: n/a (this session creates the contract)
- Mode: headless phase manager, local laptop (Windows 11), worktree C:/Users/stack/projects/wt/S0

## Intake facts

- Claude Code 2.1.295 (A5 needs 2.1.251 or later: holds)
- Node v24.19.0 locally (phase doc names Node 22; CI pins 22, engines allow 22 and later)
- pnpm absent at intake; installed in U1
- Git Bash present (A2 holds), Docker 29.8.1, gh 2.101.0 authenticated as emstacho-su
- Vault copy of the planning set: C:/Users/stack/vault/projects/sessiondeck

## Task list

| Unit | Scope | Requirements | Executor | Security gated | Blocked by | Status |
|------|-------|--------------|----------|----------------|------------|--------|
| U0 | License and borrow-source research (network) | borrow map check | researcher (general-purpose) | no | none | in progress |
| U1 | Monorepo scaffold, CI workflow, ENVIRONMENT.md | R0.5, R0.6 | sd-executor-contract | no | none | in progress |
| U2a | contract: envelope, snapshot, transcript types, statusLine schema | R0.1, R0.4 | sd-executor-contract | no | U0, U1 | pending |
| U2b | contract: state reducer, transition table, docs/CONTRACT.md | R0.2, R0.3 | sd-executor-contract | no | U2a | pending |
| U3 | scripts: capture-fixtures, capture-install, settings merge tests | R0.7 (tooling share) | sd-executor-contract | yes | U0, U1 | pending |

Out of this session by plan: R0.8 (S0c), the captured fixture set and golden timeline of R0.7 and R0.2 (S0b, after the capture day).

## Decisions made

1. Package shells for probe, hub, web are not created here. Those directories belong to other executors (.claude/agents/README.md) and sd-executor-contract is told not to edit them. The workspace glob packages/* picks each package up when S1, S3, S5 create it. Deviation from the phase doc Scope line "empty shells"; no R0.x depends on it.
2. The handoff says .claude/agents is populated from docs/agents. docs/agents does not exist and .claude/agents already holds twelve sd-* agents (the nine in R0.6 plus sd-researcher, sd-conductor, sd-sprint-orchestrator). Nothing to copy; R0.6 is checked as "contains the nine".
3. Unit tests may use synthetic inputs built inline in test files for documented payload fields. The fixtures directory is reserved for captured data, with one labeled exception: fixtures/settings/with-harness-hooks.json, the synthetic settings file the merge test needs (fixture-capture skill).
4. Commit messages: conventional prefix plus imperative subject under 72 chars, body names requirement IDs. No attribution trailers (user git-workflow rule).
5. sd-researcher is not offered as an agent type in this session; a general-purpose agent does the network lookups and saves sources under .sprint/0/research/S0/ for executors to read.

## Units

## Deferred findings

## Open questions

### U0 research (done)
- Licenses: 6 of 6 MATCH the borrow map (ccstatusline, ccmon, cctop, ccmonitor, agents-observe, Claude-Code-Usage-Monitor, all MIT). ccmonitor LICENSE was added upstream on 2026-02-17 (commit 64a9a4a), which explains the note "clone lacked it". Crystal checked separately: MIT, "Copyright (c) 2024 Stravu", HEAD 1e18e0b. GitHub reports stravu/crystal as not archived (borrow map says archived Feb 2026; not a license matter).
- Sources and official doc pages saved under .sprint/0/research/S0/ (sources/, docs/). FINDINGS.md was not written by the researcher (harness blocked it); the facts were passed inline to executors.
- Official docs list 33 hook events; all 17 planned ones are documented. Exec form (`command` + `args`) is documented. `statusLine` and `subagentStatusLine` are shell strings only (no exec form).

### U1 scaffold and CI (R0.5, R0.6)
- Commits 764fcf7, 9ea5a43, fa3784c; fixes 1ebff5b, 17fc8f9, b66f15e, c6189b5.
- sd-reviewer iteration 1: fix-then-merge, 1 MAJOR (root .prettierignore dead for package lint) and 8 MINOR. All nine fixed. Re-review pending.
- CI run 37878703574 green on ubuntu-latest and windows-latest at fa3784c.
- pnpm 12.10.1 installed globally with npm; versions in docs/ENVIRONMENT.md.

### U2a contract schemas (R0.1, R0.4)
- Commits 1497682, 45b53e5; fixes b5de96e, 136bc0c.
- sd-reviewer iteration 1: fix-then-merge, 2 MAJOR (fixture walk could stay skipped under another layout; Crystal types without borrow header) and 10 MINOR. Eleven fixed, one deferred (below). Re-review pending.

### U3 capture tooling (R0.7 tooling share), security gated
- Commits e2471af, 15cf12f, 382fa4c. 85 tests.
- sd-security-reviewer iteration 1: Gate fail. 1 HIGH (uninstall recognizes entries only by exact script path; a mismatch is a silent no-op that deletes the restore state), 3 MEDIUM (hook is live code in a mutable worktree; one ignore rule is the only thing keeping raw captures out of git; no interlock against a bare run on the real settings), 9 LOW. Fix iteration 1 in progress.
- sd-reviewer: pending (runs on the post-fix head).

### U2b reducer and CONTRACT.md (R0.2, R0.3)
- Commits 85c6757, 88a90a9, e859bd3. 125 passed, 10 skipped (TODO(fixture)). Review pending.

## Decisions made (continued)

6. Envelope: `hook_event_name` is required when kind is `hook`; `session_id` must be non-empty and is null only for kind `probe`; a missing or undefined `payload` is rejected, `payload: null` is accepted.
7. Snapshot time units: `Window.resets_at` and `prompt_cache.expires_at` are epoch ms (statusLine payload sends epoch seconds). A rate-limit `used_percentage` outside 0..100 becomes null (no clamp).
8. Fixture layout: raw captures in packages/contract/fixtures/raw/<Event>/ (gitignored, never loaded by tests); scrubbed committed fixtures in packages/contract/fixtures/<Event>/*.json, plus statusLine/ and subagentStatusLine/; fixtures/settings/ is merge-test input. A non-skipped test fails on any other layout. S0b must follow this.
9. Pid transport: the Envelope interface of architecture 3.1 is unchanged. The pid travels in `liveness` payloads `{ pid, alive }`; `alive: true` reports the pid, `alive: false` moves a live session to `exited`. Same-pid supersede is a pure function over a snapshot collection. Marked "decided in S0, confirm in S1" in docs/CONTRACT.md. Open question for the user (below).
10. Capture uninstall is surgical (removes only our entries, restores the status line from recorded state) instead of restoring the whole backup, so settings the user changed during the capture day survive. The backup stays for manual recovery.
11. CI matrix runs Node 22 and 24 (laptop runs 24.19.0).
12. Not changed by this session, on purpose: .claude/hooks/guard.mjs and .claude/settings.json. The security reviewer recommends a guard rule for capture-install and a Read deny for fixtures/raw; both are project controls for the user to change.

## Deferred findings

- packages/contract/src/wire.ts:7 (sd-reviewer, MINOR): the ingest schema is all-or-nothing and does not tie body `host` to each envelope's `host`. One bad envelope fails a 200-envelope batch; under R2.1 that is a 400 and a daemon with a persisted cursor could retry forever (R1.5). Matches architecture 3.4 as written. Needs a decision in S3 (hub ingest) and S2 (daemon retry): host-equality refine, and whether a 400 means drop or retry.

## Open questions

1. Pid transport (decision 9): keep `liveness { pid, alive }` or add an optional `pid` to the envelope? Affects S1 (probe hook) and S3 (hub).
2. origin points at github.com/emstacho-su/sessiondeck, which GitHub redirects to stack-dev-personal/sessiondeck (private). PR links use the second name.

## Progress update (after review round 2)

- U3 capture tooling: security fix iteration 1 at cfa0297, c70ecc2 (deployed hook copy outside any work tree, marker-based recognition that fails closed, dry-run default with `--apply`, refusal under CLAUDECODE, nested `.gitignore` in the raw dir, byte budget). sd-security-reviewer iteration 2: Gate pass; 12 of 13 earlier findings closed, 1 partially closed, 10 new LOW. LOW fixes in progress (iteration 2). sd-reviewer on U3: pending.
- U2b reducer: sd-reviewer iteration 1: fix-then-merge, 2 MAJOR (another agent context could clear a pending permission prompt; a superseded session could not be revived) and 10 MINOR. All fixed at 81aaeed..47b0cab (211 tests, 12 skipped TODO(fixture), 100% coverage on reducer files). Re-review pending.

## Decisions made (continued 2)

13. Replaces decision 3. `SessionSnapshot` gains one additive field beyond architecture 3.3: `tracking: { last_tool, permission: { tool, agent_id } | null }` (reducer bookkeeping). `state_detail` is display text only. Reason: the reviewer showed that keeping the last tool and the permission requester inside `state_detail` misclassifies sessions when subagents run. Documented in docs/CONTRACT.md as "confirm before S3 and S5". Open question 3.
14. Only the context that asked for a permission may leave `waiting_permission` through tool events; UserPromptSubmit, main-thread Stop, StopFailure, SessionEnd, and a non-compact SessionStart leave it regardless.
15. `ended` with reason `superseded` is revivable by any hook for that session; a normal `ended` accepts only SessionStart.
16. PostCompact moves only `starting`, `working`, `exited`, and superseded sessions to `working`; from idle, waiting, and error it only counts the compaction (narrows architecture line 99 to the mid-turn case).
17. `reduce` and `reduceLiveness` return the previous snapshot untouched when the envelope's session_id or host differs. `last_prompt` and `last_assistant_message` are capped at 2000 characters, `state_detail` at 120.
18. Capture hook deploy location: `%LOCALAPPDATA%/sessiondeck/capture/` (XDG data dir elsewhere), the app-data directory the architecture already assigns to the probe. Raw output default stays packages/contract/fixtures/raw of the checkout the installer runs from, as the handoff says.
19. The orchestrator kept working past the sprint-loop "five units" context heuristic because the session is headless and the log is committed after every round; this file plus git history is the resume state if the process dies.

## Open questions (continued)

3. Confirm the `tracking` field on SessionSnapshot (decision 13) before S3 and S5 build on the contract.
4. Recommended project-control changes the session did not make (outside every executor's boundary): a guard.mjs rule that blocks `capture-install` from agent sessions, and `Read(./packages/contract/fixtures/raw/**)` in the deny list of .claude/settings.json before capture day. Until the Read deny exists, capture with `--out` pointing outside the repository is the safer choice.

## Final state (2026-10-09, HEAD 16ff347 plus this log and docs/VERIFY-P0.md)

| Unit | Requirements | sd-reviewer | sd-security-reviewer | sd-verifier | Status |
|------|--------------|-------------|----------------------|-------------|--------|
| U0 research | borrow map | n/a | n/a | n/a | done; 7 licenses checked, all MIT as claimed |
| U1 scaffold and CI | R0.5, R0.6 | merge (iteration 2) | n/a | pass | done |
| U2a contract schemas | R0.1, R0.4 | merge (iteration 2) | n/a | pass for S0 clauses | done |
| U2b reducer and CONTRACT.md | R0.2, R0.3 | merge (iteration 3) | n/a | pass for S0 clauses | done |
| U3 capture tooling | R0.7 tooling share | merge (iteration 2 at ce22da8; confirmed at 16ff347) | Gate pass (iteration 2 at c70ecc2; confirmed at ce22da8, bb5d8b9, 16ff347) | pass for S0 clauses | done |

- Verification: docs/VERIFY-P0.md, 22 pass, 0 fail, 4 pending S0b, 1 out of scope (R0.8, session S0c).
- CI: run 37890035505 at 16ff347, success on ubuntu-latest and windows-latest, Node 22 and 24. Test step 10 to 35 s against the 60 s limit.
- Local: `pnpm -r test` 8.9 s; contract 238 passed, 13 skipped (TODO(fixture) placeholders); scripts 227 passed, 3 skipped (POSIX-only mode tests on Windows).
- Review loop note for U3: sd-reviewer reached merge at ce22da8. A polish pass for the remaining LOW and MINOR findings (af98c80 to bb5d8b9) introduced a Linux-only failure in a new test; sd-reviewer returned fix-then-merge on that delta, 16ff347 fixed it, and both reviewers confirmed. The orchestrator counted the post-merge delta as a new, short loop instead of a fourth iteration of the first one. No test containers are left running (one throwaway node:22-slim run, removed).

## Decisions made (continued 3)

20. Replaces the second sentence of decision 18. Default raw capture directory is `%LOCALAPPDATA%/sessiondeck/capture/raw` (XDG data dir elsewhere), outside every work tree, because a transient worktree would take the gitignored raw directory with it and the fixture session reads its own checkout. The uninstaller prints the exact commands that copy the captures into packages/contract/fixtures/raw/ of the fixture session's checkout, which is where the S0b handoff expects them. The handoff text and .claude/skills/fixture-capture/SKILL.md still name the in-repo path as the capture location; neither file was edited by this session.
21. Capture installer: dry-run by default, `--apply` writes; refuses the real config directory when CLAUDECODE is set; per-event cap 3000 files, 256 MiB total; status line shows `sessiondeck capture on`, `full`, or `error` during the capture day.
22. S0 status is reported green with four requirement clauses marked "pending S0b" in docs/VERIFY-P0.md (captured-fixture clauses of R0.1, R0.2, R0.4, R0.7). They need the user's capture day and are the stated scope of the S0b handoff. Nothing was marked pass that was not proven.

## Deferred findings (continued)

For S0b (reducer finalization, needs captured payloads):
- packages/contract/src/transitions.ts:130-134 (MINOR, needs fixture): a subagent that holds the permission prompt and ends without a tool event pins `waiting_permission` until the main Stop. Proposed: a SubagentStop from the holder leaves the state.
- packages/contract/src/transitions.ts:216 with 211-214 (MINOR, needs fixture): main thread in `waiting_input`, then a subagent PermissionRequest and PostToolUse, ends in `working`; the needs-input signal is lost. Proposed: remember the state to return to.
- docs/CONTRACT.md:52 and :45 (MINOR): a wrong-typed `reason` or `agent_type` is written as `unknown` (doc says left as it was); PostToolUseFailure from the main thread does not leave `waiting_input` (doc says tool events do).
- All TODO(fixture) placeholders: packages/contract/test/state.test.ts (PostToolUseFailure, TaskCreated, TaskCompleted, PreCompact, subagent StopFailure, PostToolUse tool_response, golden timeline), state-permission.test.ts (parallel tool calls in the requesting context), state-review2.test.ts (permission Notification with or without agent_id), envelope.test.ts and statusline.test.ts (captured fixture walks).

For the capture tooling (scripts/), none blocks capture day per sd-security-reviewer:
- scripts/lib/uninstall-flow.mjs:29 (LOW): the PowerShell copy command doubles only ASCII single quotes; a raw path containing a typographic quote prints a broken or injectable command. Needs a planted state file or an unusual `--out`.
- scripts/lib/uninstall-flow.mjs:75-81 (LOW): `confirmedOutDir` compares two fields of the state file with each other instead of with the settings entries removed.
- scripts/lib/install-flow.mjs:88-91 (LOW): `settingsRunHookFrom` is a substring test over the settings JSON; with a planted state file plus a planted string, install deletes manifest-named files in another directory (non-recursive, hash-matched).
- scripts/lib/printable.mjs:3 (LOW): the control-character filter does not cover bidi and zero-width characters.
- scripts/README.md:47 (MINOR): `error` with no log file means the raw directory itself cannot be created or read; say so.
- scripts/README.md:48 (MINOR): after moving a full raw directory, the moved copy must also be copied to the fixture session and then deleted; say so.
- scripts/test/capture-hardening.test.ts:193 (MINOR): the directory-limit test uses 10,000 names against a limit of 64 and would not catch an off-by-one.

For the user (project controls outside every executor's boundary):
- .claude/hooks/guard.mjs has no rule for `capture-install`; an agent that unsets CLAUDECODE could run the installer against the real settings. Add a rule before capture day.
- .claude/settings.json: add Read deny rules for the raw capture directory and the deploy directory under %LOCALAPPDATA%/sessiondeck/capture/.

## Needs laptop confirmation (user, plain terminal, not inside a Claude Code session)

1. `node scripts/capture-install.mjs` (preview), check the "Target settings file" and "Raw capture directory" lines, then `node scripts/capture-install.mjs --apply`. This is the first run against the real settings file; the session only ran it in temp sandboxes.
2. Confirm the exec-form hooks fire on this Windows build (a file appears under the raw directory after the first prompt) and that the guard hook still fires (docs/PERMISSIONS.md, sprint needs_laptop item).
3. Work a normal day following scripts/README.md step 3, then `node scripts/capture-install.mjs --uninstall --apply`, read its output, and run the copy command it prints into the checkout used for S0b.

## Fixture events still missing (for S0b)

All of them: no payload has been captured yet. Targets: the 17 hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, PreCompact, PostCompact, SessionEnd), statusLine (20 samples, at least one with rate_limits), subagentStatusLine (5 samples). The README checklist reaches 15 of the 17 on a normal day; PermissionDenied needs auto mode and StopFailure needs an API error, so those two may stay missing.
