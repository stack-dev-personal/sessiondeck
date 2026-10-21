# Session log: p2/hub-history (S4)

- Date: 2026-10-20
- Handoff: docs/handoffs/S04-hub-history-replay-compose.md
- Sprint: 1 (mvp), base sprint/1-mvp at 78b3ba8 (S3 merged)
- Contract commit: 256d2604b86ff12cc080df546792cc430b89e5a4
- Requirements: R2.4, R2.9, R2.10 (plus phase-2 scope items: statusline_samples retention, 30-day compaction, replay command, compose hub + web static, docs/HUB.md)

## Task list

| Unit | Executor | Requirements | Scope | Blocked by |
|------|----------|--------------|-------|------------|
| U1 cost history | sd-executor-hub | R2.10 | ccusage v19.0.3 dedup + LiteLLM pricing (snapshot, file, optional cached fetch), per-session and per-day cost REST, ccusage comparison harness | none |
| U2 compose | sd-executor-infra | DoD "docker compose up serves /health" | infra/docker-compose.yml (hub + web static), infra/web/ | none |
| U3 retention + replay | sd-executor-hub | R2.9 | statusline_samples retention, 30-day event compaction, `hub replay`, replay bench | U1 (same package) |
| U4 load harness + HUB.md | sd-executor-hub | R2.4 | scripts/load-ingest.mjs, docs/HUB.md | U3 (same package) |
| Final | sd-verifier | R2.4, R2.9, R2.10 | docs/VERIFY-P2.md, docs/HUB-BENCH.md | all |

Hub units run one after another (one package, and the memory rule allows one test process per session). U2 runs beside U1 because it runs no vitest.

## Decisions made

- 2026-10-20 Borrow sources staged by the orchestrator (executors have no network): ccusage tag v19.0.3 cloned to /tmp/sd-s4-refs/ccusage-src (LICENSE: MIT, verified), npm ccusage@19.0.3 at /tmp/sd-s4-refs/ccusage-npm/package (license MIT), LiteLLM model_prices_and_context_window.json fetched 2026-10-20T16:43Z to /tmp/sd-s4-refs/litellm (sha256 5a5243a5...eed8).
- 2026-10-20 Cost comparison runs ccusage 19.0.3 with its pricing fetch served from the same LiteLLM file the hub uses (fetch shim), so a difference cannot come from a pricing-table version.
- 2026-10-20 packages/web is not on sprint/1-mvp yet (S5 merges after S4). The compose web service builds packages/web from the repo; it is proven in a scratch worktree with origin/p3/board-mock merged, and the hub service stays usable on its own.
- 2026-10-20 No real transcript fixtures exist in packages/contract/fixtures. Committed tests use synthetic transcripts; the bench additionally runs on real Claude Code transcripts in this container (~/.claude/projects, read only, copied to a temp dir, never committed; only aggregate numbers are recorded).

## Units

### U1 cost history (R2.10): done
- Commits: 4dec17e, 04982a0 (fix 1), 2f776b2 (fix 2), 695c605 (fix 3). Files: packages/hub/src/{usage,pricing,routes/cost.ts}, store, config, main, server; scripts ccusage-compare.mjs, compare-hub.ts, bench-history; test/usage-cost.test.ts + synthetic transcripts; NOTICE (ccusage, LiteLLM).
- Review: sd-reviewer fix-then-merge x3 (dedup scope, sync scan, late project_dir tie order, HEAD bypass, format:check), final verdict merge. sd-security-reviewer pass (minors fixed: streamed body cap, finite/nonnegative, memo cap, /history limit).
- Verify: sd-verifier R2.10 pass, cc8ba51: fixtures and real transcripts (5 sessions, 25.502192 USD) delta 0.000000% vs ccusage 19.0.3. Evidence docs/HUB-BENCH.md, docs/VERIFY-P2.md section S4.
- Deferred: one full usage-index rebuild per session whose usage rows are indexed before its first statusLine (service.ts comment); index never evicts (~248 B per usage row).
- REST: GET /sessions/:id/cost, /history/daily, /history/sessions (limit), env HUB_PRICING_FILE, HUB_PRICING_FETCH (default on, 5 s, cached next to DB), HUB_TIMEZONE, HUB_HISTORY_RATE/BURST.

### U2 compose: reviewed, final verification at session close
- Commits: 6bfa984, 7f9af01 (fix 1), b616faa (fix 2); root .dockerignore by sd-executor-contract ba470fd, 5e45a46.
- Review: sd-reviewer fix-then-merge (HUB_PORT overload, placeholder token), fixed. sd-security-reviewer pass after fix 2.
- Deferred (LOW): SD_WEB_CONNECT_SRC regex allows `*` and scheme-only tokens (operator-set); validate hook depends on the git exec bit (COPY --chmod fails under the legacy builder).
- Open question for S6: hub has no CORS; web and hub are separate origins, REST from the browser needs hub CORS or a same-origin proxy.
- Note: /tmp/sd-1-S4-hub (git archive copy, no secrets) could not be deleted by the executor (guard).

### U3 retention + replay (R2.9): done
- Commits: 07710c7, d02c41e (fix 1). Migrations 3 (session_baselines, compaction_state) and 4 (baseline host/state index, hub_lease). CLI `node dist/main.mjs replay|compact [--db] [--force] [--init]`; `pnpm -F @sessiondeck/hub replay --db <path>`.
- Review: sd-reviewer fix-then-merge (BLOCKING far-future ts stops compaction; MAJOR silent drop of pre-cut envelopes, concurrent compaction race, batch stalls) then merge. sd-security-reviewer fail (HIGH far-future ts) then pass.
- Verify: sd-verifier R2.9 pass, e3efbac: 1,020,000 events replay 12.7 s, 0 reducer exceptions (docs/HUB-BENCH.md "R2.9 replay bench").
- Deferred minors: whole batch 400 on one far-future ts (probe moves the batch to rejected/); skew config has no range clamp; hub startup does not check an existing live lease and CLI does not hold the lease while running; supersede-by-pid scan inside compaction batches; events rely on SQLite rowid order (Phase 7 needs a sequence column).
- Observation: compaction batch max 578 ms on this WSL2 disk, attributed to WAL autocheckpoint (affects every writer); measured against R2.4 in U4.

## Stop and restart (2026-10-20)
- 19:51Z the subscription usage limit (429) stopped the previous run mid-U4 (conductor addendum 22:04Z, not a failure).
- 2026-10-20T22:04:15Z resumed. Worktree held uncommitted U4 work: scripts/load-ingest.mjs, scripts/synth-spool.ts, src/checkpoint.ts (WAL checkpointer), migration 5 (dedup index events_session_ts_sig), canonicalJson hot-path rewrite and crypto.hash, compaction rest pacing, skew range clamp (U3 deferred minor), far-future batch log line, tests checkpoint/signature-canonical. Decision: keep it; the executor re-checks it, runs the proving tests and the load harness, and finishes docs/HUB.md before review.
- No stale S4.hb-stop and no heartbeat from the previous run was running.

### U4 load harness + HUB.md (R2.4): reviewed
- Commits: 5060769, 950858a, 5c8d24f, 55a57e4, d92dddc (inherited work from the stopped run, finished); fix 1 7e44fcf..996b81e (9 commits); fix 2 01b6e01.
- Review 1: sd-reviewer fix-then-merge (BLOCKING executor wrote HUB-BENCH.md evidence; MAJOR R2.4 not shown under compaction; minors: hot-session dedup walk, checkpoint log flood, untested fallbacks, harness checkpoint interval differs from serve, stale HUB.md). sd-security-reviewer fail (HIGH canonicalJson key cache retained unbounded-length wire keys, ~8 GiB DoS; MEDIUM harness --url https sent bearer in plaintext; LOWs).
- Decision (orchestrator): R2.4 must hold while compaction runs, no exemption. Fix: compaction yields to authenticated ingest activity (15 ms quiet, 250 ms bound), per-pass cap HUB_COMPACT_MAX_EVENTS (default 1,000,000), 150 ms pause per 100 batches so the checkpoint worker catches up.
- Review 2: sd-reviewer merge (minors fixed in 01b6e01: tracker after auth, abort test, CLI capped, HUB.md table, fallback test). sd-security-reviewer pass. Review 3 on 01b6e01: merge.
- Executor results (quiet host): sustained p95 12.26 ms; with-retention 600k x3 p95 during compaction 11.45 / 10.40 / 10.67 ms, backlog drained 39 to 42 s; hot session p95 12.88 ms. Busy host (load 1.7 to 3.7, other sessions building) gave 16.8 to 30.2 ms overall, slow outside compaction too.
- Deferred: Fastify requestTimeout/connectionTimeout unset (token holder can trickle a body; bounded by the 250 ms yield) -> S3 owner / Phase 7 hardening; checkpoint test does not assert worker terminate (MINOR); compose-container harness not re-run after fix 1 (verifier runs it).

### U4 verify and session close
- R2.4 pass at e25cef3 (sd-verifier): sustained p95 10.91 ms, with-retention x3 11.30 / 11.23 / 11.68 ms, hot session 12.76 ms, compose container 12.89 ms, 0 failures. docs/HUB-BENCH.md "R2.4 ingest load".
- Session close (sd-verifier, 8fb55cd): pnpm -r test/typecheck/lint exit 0; R2.9 replay 8.7 s; R2.10 delta 0.000000% (fixtures; real-transcript row from 695c605 stands, cost code unchanged); integration check 1 on compose hub pass (53 sessions, live=1 returns 6); compose web pass via scratch merge with origin/p3/board-mock (pnpm-lock.yaml conflicts, regenerate at merge).
- PR #12 opened against sprint/1-mvp.

### CI fix: R0.5 Windows budget
- PR CI at 8fb55cd: windows-latest node 24 test step timed out at 60 s twice. Cause: S4 hub tests (hub suite 5.8 s on base, 33 s on this branch on that runner).
- Fixes by sd-executor-hub, test-only: f7724f5 (fixture cache, in-memory replay ingest, synchronous=OFF test setup), 7990481 (one ingest per sequence per worker, image copies). 9cff0ca and c187737 (review fixes) followed.
- Production fix 68d3c1f: Store.open sets synchronous = NORMAL explicitly. Found by sd-reviewer; effective level was already NORMAL after the first transaction.
- Reviews: f7724f5 merge; 68d3c1f..9cff0ca fix-then-merge (pragma test did not pin the fix, 200 ms heartbeat flake risk, image header, cache test order); c187737 merge.
- CI at c187737 green, 8/8 jobs (runs 39524443261, 39524449217); Windows R0.5 step 38 to 52 s vs 33 to 45 s on base. Margin is thin, a sprint-level concern once S1/S2/S6 tests join.
- Re-confirmation (sd-verifier, 3e6dd1e): suite exit 0, R2.4 sustained p95 12.28 ms.
