# Session log: p3/board-feedback (S8b)

- Date: 2026-10-28
- Handoff: docs/handoffs/S08b-board-feedback.md
- Sprint: 2 (content), base branch sprint/2-content
- Contract SHA: 77a4fa1ddafdc54d8e4e18e3101e654a642e767d (branch base 62d85a5 merges it)
- Note: TaskCreate is disabled in this headless session; this table is the task list.

## Tasks

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 contract: subagent parent links; phase doc R3.10 to R3.13 | R3.11 (data) | sd-executor-contract | none | done |
| U2 web: display activity hysteresis, stable order, grace setting | R3.10 | sd-executor-web | none | done |
| U3 web: SessionPopout and AgentRollup replace the drawer | R3.11 | sd-executor-web | U1 | done |
| U4 web: UsageWidget, meters off cards, Fable estimate | R3.12 | sd-executor-web | none | done |
| U5 web: mock mode and Playwright evidence | R3.13 (+ screens R3.10 to R3.12) | sd-executor-web | U2, U3, U4 | done |

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

### U3 popout (sd-executor-web): dd60c66, e7ae771, e5b82eb, 0362bcb, 84d8e15, 82b5022
### U3b fast_mode (new unit; sd-executor-contract 2bfef4f, sd-executor-hub 5459b86)
- Review iteration 1: fix-then-merge (MAJOR prototype-key hash crash `#session-toString`; MAJOR "Speed: n/a" although statusLine reports fast_mode; MINORs focus trap selector, history entry left behind on close, AgentCard vs SessionCard).
- U3b added: statusLine fast_mode (optional, non-boolean reads null) to SessionSnapshot.fast_mode (boolean | null), hub applies it like effort, stored rows read null; hub goldens regenerated (fast_mode lines only).
- Review iteration 2: merge (MINOR stale pushed flag); security pass on fast_mode ingest and hash input (LOW no hash length cap). Both fixed in 84d8e15.
- Verifier first run FAIL (header state not asserted; raw hash cap unproven), test gaps closed in 82b5022 (mutation-checked); re-verify PASS on tests, screens pending U5. Web 280, hub 290, contract 1119/1 skip.

### Decisions made
- 2026-10-29 Subagent cards are AgentCard on the shared compact card shell (sd-card, data-density="compact", --card-compact-h), not SessionCard: subagents have no SessionSnapshot, and building one would invent session data. Risk: drift if Sprint 3 changes the compact card.
- 2026-10-29 Popout header shows the raw contract state (truthful), while board cards show the display state (R3.10 hysteresis).
- 2026-10-29 Speed shows "fast" / "standard" from statusLine fast_mode, "n/a" when never reported.
- Gap (R3.11, restated): live hook data gives no nesting; all subagents show at the first level with an "unlinked" marker until S7 transcript links.

### U4 usage widget (sd-executor-web): 8a63eee, 9181388, c189783, 27cbdb6
- Review iteration 1: fix-then-merge (MAJOR collapsed chip clipped its 7d number and focus ring; MINORs drag save timing, click-without-move pinning, whole-payload freshness, z-index above the popout scrim, aria-controls/ids, lost threshold tests). Fixed.
- Review iteration 2: merge; MINORs carried into U5 (hook equality/comment, captured_at always null, clamp test without release, rendered chip-fit check in Playwright).
- Verifier: R3.12 PASS on tests (web 305/305), screens pending U5. No "fable" in packages/web/src outside the test that asserts its absence.

### Decisions made
- 2026-10-29 Usage freshness is per window: each of five_hour and seven_day comes from the freshest payload that carries it (rate limits are account-wide; a newer payload missing one window must not hide valid data).
- 2026-10-29 DetailDrawer.tsx is no longer mounted (popout replaced it) and still renders per-session rate-limit rows; delete in U5 if the diff stays small, else defer.

## Resume 2026-10-29 (after the network outage at 02:05Z)

### U5 mock mode and Playwright evidence (sd-executor-web): 662cd34, 1560cd7, 0218d5a, 9d3dac1, d433d68, e4eb205, cfeb135
- Found uncommitted DetailDrawer removal and e2e retargeting in the worktree; the executor finished it (0218d5a) and added e2e R3.10 to R3.13 specs with screenshots (9d3dac1). Playwright ran in mcr.microsoft.com/playwright:v1.63.0-noble with the sprint-2-work volume (Docker Desktop cannot see the worktree path), 44/44.
- Review iteration 1: fix-then-merge (MAJOR deleted DetailDrawer.test.tsx took live popout behaviour tests with it; MAJOR mock flap timer on by default made baselines time-dependent; MINORs usage identity on captured_at, vacuous R3.10 e2e, empty flap param, subagent id truncated at 390). Fixed in d433d68 and e4eb205 (tests restored as DrawerHost.test.tsx).
- Review iteration 2: merge; three MINORs (dev/cards baselines shot mid-replay, widget still re-rendered on captured_at, no test for id truncation) fixed in cfeb135, three baselines regenerated, Playwright 44/44 twice.
- Session-end verifier: R3.10, R3.11, R3.12, R3.13 PASS (docs/VERIFY-P3.md). Gates: typecheck, lint, format:check clean; contract 1119/1 skip, hub 290, probe 332/1 skip, web 312, scripts 535/3 skip.

### Decisions made
- 2026-10-29 The e2e "no fable" check is scoped to the usage widget: fixture cards legitimately show the model label "fable·xhigh", which is not usage (decision 28 is about the usage row).
- 2026-10-29 The R3.2 settled-board state mix no longer expects idle under the frozen e2e clock (the 120 s grace holds it as working); idle stays covered by specimens and Board.hysteresis.test.tsx.
- 2026-10-29 Mock flapping is off under replay=fast unless the URL opts in with flap=<ms>, so baselines do not depend on runner speed.

### Deferred findings
- Root `pnpm -F sessiondeck exec vitest run` sweeps the repo without per-package configs and reports failures; not a gate (per-package runs are), noted in VERIFY-P3.md.

### CI fix after PR #20 opened: 2815c8d (sd-executor-web)
- First CI run failed: root `eslint .` has no react-hooks plugin, so two `react-hooks/exhaustive-deps` disable comments errored (useDisplayActivity.ts, useSessionHash.ts); live e2e R3.9 expected idle right after resync while R3.10 holds a just-idled card as working.
- Fix: both hooks restructured with refs (no disable comments, behaviour identical); R3.9 live spec sets idle grace 0 with a comment citing R3.10. Review: merge. CI on 2815c8d: all check jobs (ubuntu and windows, node 22 and 24), e2e-web and e2e-web-live pass.

### Decisions made
- 2026-10-29 R3.9 live spec runs with grace 0: the hysteresis is intended; R3.9 proves the resync brings hub truth.

### Deferred findings
- [MINOR, reviewer, R3.10] packages/web/src/lib/display-activity.ts:70-73: for a session already tracked, an idle run that the browser learns about at resync starts at resync time, not at the hub's state_since, so after a long disconnect a card can show working up to one full grace after reconnect. Candidate fix: start the run from the clamped state_since as the first-sight branch does, with a unit test. Not a spec violation for a live link; deferred to the next web session.
