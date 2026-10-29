# Session log: p3/board-feedback (S8b)

- Date: 2026-10-28
- Handoff: docs/handoffs/S08b-board-feedback.md
- Sprint: 2 (content), base branch sprint/2-content
- Contract SHA: 77a4fa1ddafdc54d8e4e18e3101e654a642e767d (branch base 62d85a5 merges it)
- Note: TaskCreate is disabled in this headless session; this table is the task list.

## Tasks

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 contract: subagent parent links; phase doc R3.10 to R3.13 | R3.11 (data) | sd-executor-contract | none | pending |
| U2 web: display activity hysteresis, stable order, grace setting | R3.10 | sd-executor-web | none | pending |
| U3 web: SessionPopout and AgentRollup replace the drawer | R3.11 | sd-executor-web | U1 | pending |
| U4 web: UsageWidget, meters off cards, Fable estimate | R3.12 | sd-executor-web | none | pending |
| U5 web: mock mode and Playwright evidence | R3.13 (+ screens R3.10 to R3.12) | sd-executor-web | U2, U3, U4 | pending |

Fable estimate source: hub GET /history/daily already returns per-day model_breakdowns, so no hub change is planned.

## Units

## Decisions made

## Deferred findings

## Resume 2026-10-28 (after exit 137)

- Previous run was OOM-killed during U1 hub tests. Executors since run vitest with --pool=forks, maxForks=2, one package at a time; no further kills.
- Conductor amendment (decision 28, 2026-10-28T20:18Z) found uncommitted in the handoff: no Fable row in R3.12. Committed c14d298; phase doc R3.12 follows it (f72a951). The "Fable estimate source" note above is void.

### U1 contract parent links (sd-executor-contract): e3e96dd, 2d431ad, e3c9144
### U1b hub read path (sd-executor-hub, new unit): 55e1000, 8e67272, 08d3280, d26ad6b
- Contract 1119 tests pass (1 skipped); hub 286 pass; typecheck, lint, prettier clean in both. Web typecheck fails on the new required fields (to fix in U2).
- Fixtures: main-thread PreToolUse Agent (21-agent.json) has no agent_id; subagent hooks carry agent_id; no fixture shows a subagent spawning a subagent, so nested cases are synthetic (marked PROVISIONAL in CONTRACT.md).
- Review iteration 1: reviewer fix-then-merge (MAJOR wrong parent after ambiguous set); security pass (MEDIUM loops/missing parents, LOWs). Fixed.
- Review iteration 2: reviewer fix-then-merge (MAJOR from the failure-drop fix); security pass (MEDIUM eviction loop). Fixed.
- Review iteration 3: reviewer fix-then-merge (MAJOR spawn queued after an ambiguous start; MINOR); security pass (2 LOWs). Cap of three iterations reached: session BLOCKED. Question and verbatim findings: /state/2/questions/S8b.md.

## Decisions made
- 2026-10-28 PostToolUseFailure on a spawn tool marks the pending list ambiguous rather than removing an entry (unknown is acceptable, wrong-but-known is not).
- 2026-10-28 Stored subagent rows are normalized through contract readSubagentRows (one function for write and read).
- 2026-10-28 Blocked on the attribution design after three review iterations; recommended option A (conservative window rule).

## Resume 2026-10-28 (after answer)
### Decisions made
- 2026-10-28 Answer to /state/2/questions/S8b.md (conductor, under the user's standing rules): option A, conservative window rule. A parent link is "known" only if every spawn queued between two moments when the pending queue was empty came from one context; any mix, failure, or cap drop in that window marks every start in that window "unlinked". Also apply the MINOR (failed Agent call marks ambiguous only when new Set(pending).size > 1) and both security LOWs (dedupe rows by agent_id keeping the first; cap at SUBAGENT_ROWS_MAX before normalizing). One more fix and review round; if the reviewer still finds a wrong-but-known case, switch the hook path to option B (unlinked until S7 transcript links) and record it, without asking again.
- 2026-10-28 Decision 28 (no Fable row, no estimates in the usage widget) confirmed applied: handoff c14d298, phase doc R3.12 and R3.13. U4 drops the Fable item.
- 2026-10-28 Review iteration 4 (window rule, 2fff86e): reviewer fix-then-merge with three wrong-but-known cases (failure after start, cap drop clearing taint, prompt reset); security pass. Per the answer's fallback, switched the hook path to option B without asking again: every hook-built subagent row is parent_agent_id null, parent_known false ("unlinked", first level) until S7 transcript links (5c494e7, hub ab83dc1).

### U1/U1b closed
- Option B review: reviewer fix-then-merge, minors only (CONTRACT.md wording, hub parseStoredSnapshot tracking normalize, two NITs); security pass (one pre-existing LOW, deferred). Fixed in 0ed8e05 (contract) and 39d6e14 (hub). Contract 1112 pass / 1 skip, hub 287 pass.
- Gap recorded (R3.11): live hook data gives no nesting; the popout shows all subagents at the first level with an "unlinked" marker until S7 attaches transcript links. Nesting is exercised through mock data (R3.13) and stored links.

### Deferred findings
- [LOW, security, pre-existing] packages/contract/src/tracking.ts:64-67 readTracking/readHolder do not length-cap stored last_tool/permission strings; only reachable with DB write access.

## Resume 2026-10-29 (after the 5-hour usage limit at 23:31Z)

### U2 hysteresis (sd-executor-web): bffb565, a429250, a8b1c8d, c4981b8
- Found uncommitted review-style fixes in the worktree; the executor checked them, fixed a contradictory reorder assertion and a timer test, committed a429250.
- Review iteration 1: fix-then-merge (MAJOR idle to working not held, so a card could change group twice in 1 s; MINORs held state_since, first-sight clock skew, waiting to idle shown working). Fixed in a8b1c8d.
- Review iteration 2: merge, with two MINORs (held card shown as literal idle; no grace-change-mid-hold test). Fixed in c4981b8.
- Verifier: R3.10 behavior PASS, web 243/243; screens pending U5 (docs/VERIFY-P3.md).

### Decisions made
- 2026-10-29 "At most one group change per grace period" applies both ways: idle to working shows idle until one grace since the last group change (the timer moves it). Attention is never held.
- 2026-10-29 Waiting to idle shows working for the grace (spec says "continuously idle or waiting"); kept as specified.
- 2026-10-29 First-sight idle start is clamped to min(max(state_since, now - grace), now), so hub/browser clock skew can never hold a card longer than one grace.
