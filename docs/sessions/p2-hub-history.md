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
