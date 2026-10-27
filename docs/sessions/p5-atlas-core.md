# Session log: S9, p5/atlas-core

- Date: 2026-10-27
- Handoff: docs/handoffs/S09-s9b-atlas.md (S9 part only: R5.1, R5.4, R5.5, R5.6)
- Sprint: 3 (organize), base branch sprint/3-organize at cde5b02
- Contract SHA: cde5b026db72d70942a7fb57d9db214e9593bb53 (main has not moved since)
- Note: TaskCreate is disabled in this headless session; this log is the task list.

## Task list

| Unit | Requirements | Executor | Paths | Blocked by | Status |
|------|--------------|----------|-------|------------|--------|
| U1 hub projects, roll-up, phases, project view API | R5.1, R5.5, R5.6 | sd-executor-hub | packages/hub/**, docs/ATLAS.md | - | done (merge; verifier 3 pass hub side) |
| U2 hub FTS5 search + latency bench (+U2b perf fix) | R5.4 | sd-executor-hub | packages/hub/**, docs/HUB-BENCH.md | U1 | done (merge; R5.4 hub side pass) |
| U3 web project view, inline phase + project edit | R5.1, R5.5, R5.6 | sd-executor-web | packages/web/** | U1 | pending |
| U4 web session list + Ctrl+K palette | R5.4 | sd-executor-web | packages/web/** | U2, U3 | pending |
| U5 close: full suite, integration checks, VERIFY-P5, PR | all | sd-verifier | docs/VERIFY-P5.md | U1-U4 | pending |

Concurrency allowed: 1, so units run sequentially.

## Units

## Decisions made

- 2026-10-27: Security reviewer run on hub units although the handoff does not gate S9, because the units add write endpoints and change ingest.
- 2026-10-27: The R5.4 hard latency threshold moved out of the default test suite into `test:bench` (contended runners made it flaky); evidence comes from the bench command recorded in docs/HUB-BENCH.md and VERIFY-P5.

## Deferred findings

- U2b [MINOR] packages/hub/src/db/store.ts:487-534: per-page commit clears search_dirty before the post-page phase rebuild; a kill between them leaves a stale phase doc until the project changes. Fix: keep the flag set until the project's rebuild commits.
- U2b [MINOR] packages/hub/src/db/store.ts:481: `dirty <= quarantined.size` compares counts; stale quarantine ids (deleteAllSessions does not clear them) can delay a new session's indexing up to 60 s. Fix: clear maps in deleteAllSessions or count non-quarantined dirty rows.
- U2 [MINOR] store.ts:522-535: optional EXPLAIN QUERY PLAN assertion for the outer snippet query.

- U1 [MINOR] packages/hub/src/atlas/infer.ts:134: "P95  latency" (two spaces) bypasses the metric-word exclusion via \s+ backtracking. Folded into U2.
- U1 [MINOR] packages/hub/src/routes/atlas.ts:131-139: an earlier-registered throwing "atlas" listener would stop later listeners; only stream.ts listens today. Folded into U2 (stream.ts listener catches its own errors).

### U1 hub projects, roll-up, phases, project view API (R5.1, R5.5, R5.6 hub side)
- Executor: sd-executor-hub. Commits 732b780 (feature), 7d25f17 (fix 1), e7d23b4 (fix 2).
- Files: packages/hub/src/atlas/infer.ts, src/routes/atlas.ts, src/db/{migrations,store}.ts, src/stream.ts, src/server.ts, src/ingest/ingestor.ts, test/atlas.*.test.ts, docs/ATLAS.md.
- Review: iteration 1 fix-then-merge (MAJOR: WS deltas unannotated); iteration 2 fix-then-merge (MAJOR: PATCH pushed archived sessions to live board); iteration 3 merge.
- Security review (not gated by handoff; run because the unit adds write endpoints and ingest changes): Gate pass both rounds; MEDIUMs (48-bit id collision stalls ingest, unbounded PATCH, per-read full project scan) fixed in 7d25f17.
- Hub tests: 339 passed.

### U2 hub FTS5 search + latency bench (R5.4 hub side)
- Executor: sd-executor-hub. Commits 95b2ea3 (U1 minors), 53fb380 (search), 55b2029 (atlas harness), 7facd61 (fix 1).
- Review: iteration 1 fix-then-merge (MAJOR: 1-char prefix ~100 ms on realistic corpus, bench blind to it; MAJOR: stale phase docs); iteration 2 merge.
- Security: Gate pass. Carry-over to U4: palette must render title/snippet as text nodes only.
- Verifier: R5.4 hub side pass (route p95 20 ms overall, worst class 26.6 ms). R2.4 A/B: head ingest p95 73-84 ms vs base 40-53 ms, regression. Fix unit U2b opened.

### U2b ingest p95 regression fix (R2.4 protection, R5.4)
- Executor: sd-executor-hub. Commits 899facb (deferred indexing), 2c2c050 (durable dirty flag, migration 8, savepoints, quarantine), 3b311f4 (bench out of default suite, caps, per-page commit).
- Profile: upsertSession 2923 ms -> 314-342 ms per 20 s load run; dominant cost was reindexProjectPhases re-parsing a project inside the ingest transaction.
- A/B after fix: head and base p95 distributions overlap (medians 51.3 vs 53.8 ms); both miss the 20 ms R2.4 limit on this contended host (pre-existing, FIX-5). Needs laptop/quiet host.
- Review: iteration 1 fix-then-merge (MAJOR: in-memory dirty set lost on crash); iteration 2 merge; follow-up 3b311f4 (flaky hard-threshold bench in default suite) reviewed: merge.
- Security: Gate pass both rounds.
- Decision: R5.4 latency is proven by `pnpm -F @sessiondeck/hub test:bench` and `node packages/hub/scripts/bench-search.mjs`, not by the default CI suite, because shared runners are contended. Verification of U2b folded into the session-end verifier run.
