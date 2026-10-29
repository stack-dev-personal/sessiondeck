# Session log: p2/headless-metrics (S8d)

- Date: 2026-10-28
- Handoff: docs/handoffs/S08d-headless-metrics.md (conductor-written, decision 31)
- Runs locally on the Windows laptop, headless; state dir .sprint/2/local/ (S8d.json)
- Base: origin/sprint/2-content at f6d396d; contract commit 77a4fa1 (main)
- Requirements: R2.12, R2.13 (phase-2-hub.md), R3.16 (phase-3-board.md)

## Task list

- [x] U1 contract: snapshot field-source markers and subagent figure fields (R2.12, R2.13 schema part) - sd-executor-contract
- [x] U2 hub: transcript-derived session fields + WS deltas (R2.12) - sd-executor-hub, after U1
- [x] U3 hub: subagent figures from subagent transcript lines (R2.13) + recorded headless replay test + live-shape harness - sd-executor-hub, after U2
- [ ] U4 web: "from transcript" labels, "API-equivalent" cost, Playwright screenshots (R3.16) - sd-executor-web, after U1
- [ ] Close: full suite, verifier over all IDs, rebase/merge sprint branch, PR to sprint/2-content

## Decisions made

- Context percent for transcript-filled sessions: the bundled pricing table carries no max_input_tokens (0 occurrences in packages/hub/src/pricing/litellm-claude.json; ModelPricingSchema drops it), and the handoff forbids editing pricing internals while S7 changes them. Per R2.12 "if unknown, show tokens without a percent", headless cards show context tokens with window and percent null. Follow-up option for the user after S7 merges: keep max_input_tokens in the trimmed pricing table.
- mergeSource keeps an existing statusline source when a transcript value arrives (statusline wins, enforced in the contract helper).

- Requirement IDs used exactly as the handoff gives them (R2.12, R2.13, R3.16). R2.11 and R3.14/R3.15 do not exist on any branch today; the conductor reserved them. Noted in the phase docs, no renumbering.
- No SendMessage tool in this session: review fixes go to a fresh call of the same executor type with the findings verbatim.
- Subagent effort (U3): taken only from the subagent's own assistant rows that state a string effort; the SubagentStop hook effort.level is a session-wide common field (fixture: hook xhigh vs transcript medium) and is not used. Decision 28 (measured only) holds.

## Units

### U1 contract markers (R2.12, R2.13 contract part)
- Executor sd-executor-contract; commits 5342a57, 6136baa. Files: packages/contract/src/snapshot.ts, packages/contract/test/snapshot-sources.test.ts, docs/CONTRACT.md.
- Review 1: merge with 3 MINOR (unnamed subagent source union, no figures_source test, no subagent effort field); fixed in 6136baa. Review 2: no findings, verdict merge.
- Verification deferred to U3: the contract part alone does not meet R2.12/R2.13; sd-verifier runs once the hub fills the fields.

### U2 hub session figures (R2.12)
- Executor sd-executor-hub; commits 647d4c5, bc8f33a, 0c67214. New packages/hub/src/derive/*; edits to ingestor, engine, reduce, replay, server, store; goldens gain sources keys only (55 lines, 2 files).
- Review 1: fix-then-merge. 4 MAJOR (cost fill refresh on ingest path can trigger full usage-index rebuild; load harness has no usage rows so R2.4 unproven and no debounce; replay prices with bundled table not the serve pricing; replay budget R2.9 untimed with usage rows), 6 MINOR (hook message displaced forever, unbounded backward rebuild, closed re-check after await, duplicated HUB.md section, weak last-message test, live-shape harness missing: moved to U3). Sent back for fix iteration 1.
- Fix iteration 1: commits 625883f, 9fcb98c, 48e87c0, d1407ee, 220c624 (debounced cost fill, deferred index rebuild, replay uses serve pricing, bounded rebuild scan, exact tests, HUB-BENCH rows). Executor run took about 2 h 12 min, mostly load and replay benches on a loaded host.
- Review 2: verdict merge, 5 MINOR. Replay-vs-ingest divergence from the 2000-line cap and the per-flush sessions scan are folded into U3 (same executor, cheap). The rest are deferred below.
- Verifier (6064aa5): 6 pass, 0 fail, 1 unverifiable (used % clause; no window data, see decision), live-shape harness pending in U3. R2.12 partial until U3.

### U3 hub subagent figures (R2.13) + harness (R2.12)
- Run 1 stopped on the 5-hour usage limit with uncommitted work; resumed 2026-10-29 with the same brief. Executor sd-executor-hub; commits e5b40e6, 7e6d1d5 (subagent figures, replay full scan, cost-filler projectsVersion check, null-percent test, packages/hub/scripts/headless-harness.mjs).
- Incident (executor-reported): while killing its own harness runs it used a broad process-name match that stopped a few unrelated processes. Checked after: SessionDeckProbeDaemon task state Running, sessiondeck-hub-1 and sessiondeck-web-1 up. Next brief forbade name-matched kills.
- Review 1: fix-then-merge, 4 MAJOR (subagent effort never filled though fixture rows state it; cost-filler cache retained the old usage index; partial subagentStatusLine task kept transcript values under statusline label; full replay scan unmeasured), 3 MINOR (no subagent lines in synth-spool; model id uncapped; harness teardown lacks SIGHUP/SIGBREAK).
- Fix iteration 1: d682ff6, d527ac0, 328b15e, 92e0d42, 2dced8c. Replay stress bench 14.2 s vs 60 s (loaded host), row in docs/HUB-BENCH.md.
- Review 2: verdict merge, 2 MINOR (deferred below).
- Verifier (73f2d7f): R2.12 and R2.13 6 pass / 0 fail / 0 unverifiable; harness on compose project sd-2-s8d port 28787 printed all figures, containers removed.

## Deferred findings

- packages/hub/src/ingest/engine.ts keepTranscriptFigures: once a transcript fills last_assistant_message or model, a later Stop/SessionStart hook never replaces it, so a stalled transcript tailer leaves an old message showing. Fix needs a per-field timestamp or a hook source value in the contract (SnapshotSources). Owner: a follow-up contract+hub unit after S7 merges. Documented in docs/HUB.md Known gap.
- packages/hub/src/derive/cost-filler.ts:136: the index rebuild waits for 2 s of quiet ingest, capped at 60 s; with steady interactive statusline traffic the wait usually runs out, delaying headless cost fills up to 60 s once per new interactive project. Real fix is per-session rebuild inside packages/hub/src/usage (S7 territory).
- docs/HUB-BENCH.md: R2.4 (p95 < 20 ms) not met before or after this branch on the loaded laptop (no regression: after is faster); R2.9 replay 53.6 s vs 60 s budget at ~96% host CPU. Both need a quiet-host run before closing R2.4/R2.9 for the record.
- packages/hub/src/derive/cost-filler.ts:139: WeakRef plus generation counter has no test that swaps the index object at the same version. Owner: next hub unit.
- packages/hub/src/derive/figures.ts:168: subagent figures count as complete only once effort is found, so rows that state no effort make a cold-cache derive read up to 2000 lines inside the ingest transaction. R2.4 load bench with --stress not run; belongs to the deferred quiet-host bench run.
- Leftover temp data the guard refused to delete: Git Bash /tmp/sd-2-S8d-bench5 (about 1.6 GB) and /tmp/sd-2-S8d-bench5.log (Windows: %LOCALAPPDATA%/Temp). User or conductor deletes.
