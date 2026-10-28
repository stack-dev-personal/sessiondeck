# Session log: p4/normalize (S7, Phase 4 data side, sprint 2)

- Date: 2026-10-28
- Handoff: docs/handoffs/S07-normalizer-and-redaction.md, plus conductor addition R2.10 (decision 25)
- Branch: p4/normalize from sprint/2-content (ea045d3)
- Contract commit: 2426e6d089fb0ae9339e8e3fc5001eccc5cb191e
- Task tools are disabled in this headless session; the task list lives here.

## Task list

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|-----------|-------|
| U1 normalizer (contract/normalize.ts, golden tests) | R4.1, R4.2, R4.3 | sd-executor-hub | none | pending |
| U2 redaction filter, corpora, probe.json rules | R4.7 | sd-executor-probe | none | pending |
| U3 pricing 1h/5m cache-write split, unpriced models | R2.10 | sd-executor-hub | none | done (563e177) |
| U4 hub transcript API (normalized, ?after=) and WS transcript deltas | R4.1, R4.4 (hub side) | sd-executor-hub | U1 | pending |
| U5 transcript tail end-to-end harness (Linux daemon to hub within 2 s) | R4.4 | sd-executor-hub | U2, U4 | pending |
| U6 close: full suite, TRANSCRIPT-FORMAT.md, VERIFY-P4.md, PR | all | sd-verifier | U1-U5 | pending |

## Intake notes

- Fixture survey (all 5 transcripts, main and subagent files): about 90 row and attachment kinds. Each has a
  sensible rendering: conversation (user/assistant blocks), system info (system/* subtypes, compact
  boundary, selected attachments), or internal bookkeeping hidden from the message list but kept and
  countable (api-request*, atis-latch, cost-state, queue-operation, last-prompt, mode, agent-setting,
  file-history-*, ...). No stop-and-ask condition on row types.
- Pricing table packages/hub/src/pricing/litellm-claude.json has no 1-hour cache-write field; the 1h rate
  is derived as 2x input. Opus 5.5 entries match official prices (input 4, 5m write 5 USD/MTok).
- Concurrency for this process is 1: executor units run one at a time; reviewers run in parallel (read-only).

## Units

### U3 pricing (R2.10), resumed after container stop
- Resume: uncommitted follow-up on top of 076660a was finished by sd-executor-hub as 2771a1c (exact-match lookup
  with matchKind, official-price tests for Opus 5.5 and Fable 5.1, fast factor, thinking tokens, unpriced models).
- Review 1 (sd-reviewer): fix-then-merge. MAJOR expected.json provenance claimed ccusage but ccusage never ran
  (reference missing); MINOR split > total token report; MINOR independentDelta not independent; MINOR decision 25
  absent from 00-open-decisions.md (orchestrator item, see Deferred).
- Orchestrator fetched ccusage 19.0.3 with `npm pack` into /tmp/sd-s4-refs/ccusage-npm; compare PASS.
- Fix 1 (4f3c993): expected.json regenerated with --write-expected (only provenance.generated changed);
  cache_creation_tokens reports max(total, h+f) when h > 0; independentDelta per-token.
- Review 2: fix-then-merge. MAJOR harness delta not tiered at 200k; MINOR rate fallbacks differ from hub.
- Fix 2 (52abd9d): oneHourDelta with marginal tiering and hub fallbacks; tests (i) 1.35 USD, (ii), (iii).
- Review 3: merge. Verifier (563e177): R2.10 amended pass, 7/7 points; hub 309 tests; ccusage PASS with
  delta 0.002250 residual 0 on the one 1h row. Evidence: docs/VERIFY-P2.md, /state/2/screens/S7/R2.10-ccusage-compare.txt.

## Decisions made

- 2026-10-28 resume: R2.10 expanded by the conductor (decision 25): exact model match, fast factor, thinking tokens,
  Fable prices, official-price tests. Table values for claude-opus-5-5 and claude-fable-5-1 match official prices; no stop.

- Ownership: sd-executor-hub owns packages/contract/src/normalize.ts; for U1 it is also allowed the
  provisional types in packages/contract/src/transcript.ts (marked "finalized in Phase 4 (S7)"), the
  normalize tests, a new golden directory, and one export line in packages/contract/src/index.ts.
- The planning doc note for R2.10 (phase-2-hub.md) is written by sd-executor-hub inside U3 (single dated note).

## Deferred findings

- U3 (non-blocking): harness oneHourDelta mirrors the hub's proportional rule; "mixed h and f" test could pin a hand
  value (0.36). Dead fallback in hiRate (compare-hub.ts:213). No test for the 5m-above-200k-without-1h-above asymmetry.
- U3: "decision 25" is cited in phase-2-hub.md but not recorded in 00-open-decisions.md; recording it is the
  conductor's call (conductor numbering), reported in the final report.
