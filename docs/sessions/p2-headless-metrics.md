# Session log: p2/headless-metrics (S8d)

- Date: 2026-10-28
- Handoff: docs/handoffs/S08d-headless-metrics.md (conductor-written, decision 31)
- Runs locally on the Windows laptop, headless; state dir .sprint/2/local/ (S8d.json)
- Base: origin/sprint/2-content at f6d396d; contract commit 77a4fa1 (main)
- Requirements: R2.12, R2.13 (phase-2-hub.md), R3.16 (phase-3-board.md)

## Task list

- [x] U1 contract: snapshot field-source markers and subagent figure fields (R2.12, R2.13 schema part) - sd-executor-contract
- [ ] U2 hub: transcript-derived session fields + WS deltas (R2.12) - sd-executor-hub, after U1
- [ ] U3 hub: subagent figures from subagent transcript lines (R2.13) + recorded headless replay test + live-shape harness - sd-executor-hub, after U2
- [ ] U4 web: "from transcript" labels, "API-equivalent" cost, Playwright screenshots (R3.16) - sd-executor-web, after U1
- [ ] Close: full suite, verifier over all IDs, rebase/merge sprint branch, PR to sprint/2-content

## Decisions made

- Context percent for transcript-filled sessions: the bundled pricing table carries no max_input_tokens (0 occurrences in packages/hub/src/pricing/litellm-claude.json; ModelPricingSchema drops it), and the handoff forbids editing pricing internals while S7 changes them. Per R2.12 "if unknown, show tokens without a percent", headless cards show context tokens with window and percent null. Follow-up option for the user after S7 merges: keep max_input_tokens in the trimmed pricing table.
- mergeSource keeps an existing statusline source when a transcript value arrives (statusline wins, enforced in the contract helper).

- Requirement IDs used exactly as the handoff gives them (R2.12, R2.13, R3.16). R2.11 and R3.14/R3.15 do not exist on any branch today; the conductor reserved them. Noted in the phase docs, no renumbering.
- No SendMessage tool in this session: review fixes go to a fresh call of the same executor type with the findings verbatim.

## Units

### U1 contract markers (R2.12, R2.13 contract part)
- Executor sd-executor-contract; commits 5342a57, 6136baa. Files: packages/contract/src/snapshot.ts, packages/contract/test/snapshot-sources.test.ts, docs/CONTRACT.md.
- Review 1: merge with 3 MINOR (unnamed subagent source union, no figures_source test, no subagent effort field); fixed in 6136baa. Review 2: no findings, verdict merge.
- Verification deferred to U3: the contract part alone does not meet R2.12/R2.13; sd-verifier runs once the hub fills the fields.

## Deferred findings
