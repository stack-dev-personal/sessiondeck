# Session log: p2/hub-core (S3, Phase 2 core)

- Date: 2026-10-20
- Handoff: docs/handoffs/S03-hub-core.md
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4 (in history of sprint/1-mvp at 5b76608)
- Base: sprint/1-mvp @ 5b76608
- Requirements: R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8
- Security gated: yes (auth, validation, SQL parameterization)

## Task list (TaskCreate not available in this headless build; tracked here)

| Unit | Executor | Requirements | Blocked by | Status |
|------|----------|--------------|------------|--------|
| U0 allow better-sqlite3 native build in pnpm-workspace.yaml | sd-executor-contract | infra for all | - | done b8c3ec2 |
| U1 hub scaffold, config, migrations (5.1), store, bearer auth, /health | sd-executor-hub | R2.8 | U0 | done d3b4f88 |
| U2 POST /ingest: validation, 1 MB limit, id+signature dedup, batch txn, reducer wiring all kinds, golden replay | sd-executor-hub | R2.1, R2.2, R2.3, R2.7 | U1 | done 337e5d2 (R2.7 read path in U3) |
| U3 REST routes + WS /stream (initial, deltas, heartbeat) + 5-client WS harness | sd-executor-hub | R2.5, R2.6, R2.7 | U2 | done ba15e04 |
| U7 hub test CPU cut for Windows R0.5 | sd-executor-hub | R0.5 (CI) | U5 | done 0e1810f, 416b3ca |
| U4 Dockerfile (arm64-safe), container smoke harness, docs/HUB.md | sd-executor-hub | R2.8 (container), DoD | U3 | done 93a97d7, edcfd78, ffac2b5, fab329c, d2a3c6a |

## Decisions made

- D-S3-1: schema 5.1 kept in shape with two portability fixes: primary-key columns NOT NULL (transcript_lines.agent_id = '' for the main session) and ms epoch columns BIGINT (Postgres int4 would overflow). 01-architecture.md 5.1 should get the same edit (user, planning doc owner).
- D-S3-2: Bearer scheme matched case-insensitively (RFC 7235); token exact, SHA-256 + timingSafeEqual.
- D-S3-3: no query-string tokens anywhere; request log serializer strips query strings.
- D-S3-5: ingest rate limit = global bucket keyed on token digest + per-host LRU buckets + HUB_MAX_HOSTS (32) cap; host <= 128 chars.
- D-S3-6: ingest response last_seq is the batch's acknowledged max, not a stored max. Accepted risk until per-host tokens: host identity is not bound to a credential, so a token holder can squat (host, seq) pairs or fill the host cap (manual recovery: delete bogus hosts rows). For the user.
- D-S3-7: R2.7 staleness also applied at read and broadcast time (U3) via applyRateLimitStaleness.
- D-S3-8: per batch <= 5000 envelopes, payload depth <= 64, string bounds (host/session_id/agent_id 128, hook_event_name 64, project_dir/cwd truncated to 1024).
- D-S3-9: transcript envelope payload shape defined in the hub as {start_line (required int >= 0), lines: string[]} because packages/contract has none. Cross-session: S2 tailer must emit this; contract owner should add the schema. Open question for the user.
- D-S3-10: claude-watch has no LICENSE file upstream (sd-researcher 2026-10-20, HEAD 1f40b01; README says MIT). Borrow map 9 lists it as MIT. Nothing copied; broadcast written fresh from the ws docs. Open question for the user: fix the borrow map entry or confirm.
- D-S3-11: GET /sessions/:id/events is a raw authenticated audit view; R2.7 applies to rendered snapshots (REST snapshot reads and WS).
- D-S3-12: WS initial and REST ?live=1 share default limit 1000; warn only on real truncation at the cap.
- D-S3-13: transcript paging: after requires agent_id; agent_id '' is the main session.
- D-S3-14: per-principal read rate limit (HUB_READ_RATE 50/s, burst 100) for REST GETs and WS upgrades, keyed on the credential that authenticated.
- D-S3-15: WS auth for browsers: Sec-WebSocket-Protocol `sessiondeck.v1` + `sessiondeck.bearer.<base64url(token)>`; server selects only sessiondeck.v1. Header Authorization also accepted. For S6.
- D-S3-4: default bind 127.0.0.1 (HUB_BIND); LAN bind is an explicit opt-in. Architecture section 7 says the hub binds to the LAN interface; Phase 2 runs on the laptop, so localhost default is the safer reading and is configurable.

- D-S3-16: run interrupted by subscription usage limit (429) at about 03:00Z after U4 was committed (93a97d7) and before its review. Resumed 2026-10-20; working tree clean, U4 kept as committed and sent through /review-loop.

- D-S3-17: root .dockerignore (deny-all allow-list, owned by sd-executor-contract as root config) kept as defense in depth against the legacy builder ignoring Dockerfile.dockerignore. Any future image built with the repo root as context (web, S4 compose) must extend its allow-list. Note for S4 and web owners.

- D-S3-18: sprint container restarted at about 14:20Z and killed the run during U5 fixes (not a session failure). Resumed 14:21Z. Commit 6e80da6 (the U5 iteration-2 optional MINOR) was local and unpushed; U5 reviewer verdict merge at iteration 2. The remaining Windows CI failure is the contract test state-file-merge.test.ts:135, which times out at 5 s once sort: false runs the package suites concurrently. That becomes U6 (sd-executor-contract).

- D-S3-19: PR CI windows node 24 R0.5 step timed out at 61 s (push run on the same SHA green); hub adds about 20 s on Windows. U7 (sd-executor-hub) cut hub test CPU: in-memory stores by default (0e1810f), isolate:false and maxWorkers 2 (416b3ca). CI 39443991770 and 39443984373 green, Windows R0.5 step 36-41 s.
- D-S3-20: at about 15:11Z the Docker Desktop VM ran out of memory (orphaned parallel vitest runs across sessions) and the sprint container froze; the user restarted it and the run was killed during U7 review (not a session failure). Resumed 2026-10-20 after 16:08Z with the conductor memory rule: one foreground test process at a time per session, --maxWorkers=2 or fewer, no background tests, check pgrep before each run, stop and ask if memory runs short.

- infra/docker-compose.yml is S4 scope (R2.10 handoff); S3 proves the container with `docker build` + `docker run` (sd-1-S3-* names).

## Units

### U0 + U1 (b8c3ec2, 454a2ae, f20d509, d3b4f88)
- Files: pnpm-workspace.yaml; packages/hub/{package.json,tsconfig.json,vitest.config.ts,src/{config,server,main}.ts,src/db/{migrations,store}.ts,test/*}; pnpm-lock.yaml.
- Review: iteration 1 fix-then-merge (3 MAJOR, 4 MINOR); security gate pass with 1 MEDIUM, 4 LOW, all fixed. Iteration 2 fix-then-merge (1 MAJOR chmod scope, 2 MINOR guard); security gate pass (2 LOW, fixed). Iteration 3: sd-reviewer verdict merge.
- Verify: R2.8 pass (docs/VERIFY-P2.md, 9521971), 34 tests plus live curl.

### U2 (d529a9a, da7ee76, 7c97d8d, 337e5d2)
- Files: packages/hub/src/ingest/{signature,validate,rate-limit,reduce,ingestor,route}.ts, src/{server,config}.ts, src/db/{store,migrations}.ts (migration 2), scripts/{bundle.mjs,gen-golden.ts}, test/ingest-*.test.ts, test/golden/*.json, NOTICE.
- Borrow: agents-observe event-signature.ts (MIT, Copyright (c) 2025 Joe Johnston, commit b3a7238, verified by sd-researcher), adapted to a literal 5 s window.
- Review: iteration 1 sd-reviewer fix-then-merge (3 MAJOR, 6 MINOR); sd-security-reviewer Gate fail (HIGH rate limit keyed on body.host, 3 MEDIUM, 3 LOW). Iteration 2: sd-reviewer merge; security Gate pass (3 LOW).
- Verify: R2.1, R2.2, R2.3 pass (docs/VERIFY-P2.md, b39c23e). R2.7 out-of-range nulling tested; read-time staleness wired in U3.

### U3 (ff2b14d, f5c3c41, ba15e04)
- Files: packages/hub/src/{stream.ts,snapshots.ts,routes/read.ts,server.ts,config.ts,db/store.ts,ingest/ingestor.ts}, scripts/ws-harness.mjs, test/{stream,read-routes,read-limit,ingest-hostindex}.test.ts, golden all-statuslines.json.
- Borrow: none (D-S3-10).
- Review: iteration 1 sd-reviewer fix-then-merge (1 MAJOR harness gate, 6 MINOR), security Gate pass (1 MEDIUM refused sockets never destroyed, 2 LOW). Iteration 2 reviewer fix-then-merge (1 MAJOR read limiter keyed on unauthenticated header, 1 MINOR), security Gate pass (2 LOW). Iteration 3 reviewer fix-then-merge, no BLOCKING (1 MAJOR: fallback-destroy test does not exercise the timer). Exit condition met per /review-loop; the MAJOR is folded into U4 and re-reviewed there.
- Verify: R2.5, R2.6, R2.7 pass, R2.8 re-run pass (docs/VERIFY-P2.md, 8965728, 32bc47f). Harness: 200 deltas x 5 clients, max 29.49 ms, 0 dup, 0 missing; negative self-test fails the gate as designed.

### U4 (93a97d7, edcfd78, ffac2b5, fab329c, d2a3c6a)
- Files: packages/hub/{Dockerfile,Dockerfile.dockerignore,package.json,scripts/container-smoke.mjs,src/stream.ts,test/read-limit.test.ts,test/ingest-reduce.test.ts}, docs/HUB.md, .dockerignore.
- Review: iteration 1 sd-reviewer merge (4 MINOR); security Gate fail (HIGH: legacy builder ignores Dockerfile.dockerignore, untracked contract fixtures/raw and .env reach runtime image; MEDIUM tag-only base; 3 LOW). Iteration 2 security Gate pass (3 LOW, MEDIUM deferred); reviewer fix-then-merge (BLOCKING root .dockerignore scope, resolved by D-S3-17; 3 MINOR). Iteration 3 reviewer merge, no findings.
- Verify: final run at fab329c, all of R2.1-R2.3, R2.5-R2.8 pass; container smoke pass (817/817 ingest, 14 live sessions, restart persistence, canary clean). docs/VERIFY-P2.md.

### U5 (f6b9603, b6d6133, dde6b3d, 6e80da6) CI: R0.5 budget on Windows
- Files: packages/hub/{vitest.config.ts,test/ingest-golden.test.ts,test/stream.test.ts}, pnpm-workspace.yaml (sort: false).
- Review: iteration 1 fix-then-merge (1 MAJOR hookTimeout, 3 MINOR). Iteration 2 merge (1 optional MINOR, heartbeat check could pass vacuously; fixed in 6e80da6).
- CI at dde6b3d: hub green on all four jobs; windows node 22 failed on contract state-file-merge timeout (U6).

### U6 (e84e7ec, 7425f9e) contract state-file-merge test under concurrent load
- Files: packages/contract/test/state-file-merge.test.ts (test only, no src change).
- Executor: sd-executor-contract. Root cause: 15 writers queued on one lock exceeded the 5 s lock wait and the 5 s test timeout on a loaded Windows runner; Promise.all rejected early and afterEach removed the directory under in-flight merges (ENOTEMPTY).
- Review: iteration 1 fix-then-merge (MAJOR sprint test still Promise.all; MINOR waitMs above LOCK_STALE_MS). Iteration 2 merge, no findings.
- CI run 39439735050 at 7425f9e: 4/4 jobs success; Windows R0.5 step 49 s (node 24), 52 s (node 22).

### U7 (0e1810f, 416b3ca) hub test CPU cut for Windows R0.5
- Files: packages/hub/{vitest.config.ts,test/helpers.ts,test/migrations.test.ts} (test config only).
- Review: iteration 1 sd-reviewer merge (2 MINOR, deferred). Normal and shuffled runs 177/177.
- CI 39443991770 (PR) and 39443984373 (push): 4/4 jobs success, Windows R0.5 step 36-41 s (19 s headroom).
- Verify: sd-verifier final at 416b3ca, R2.1-R2.3, R2.5-R2.8 pass, R0.5 pass by CI; pnpm -r test 10 s, typecheck and lint clean; ws-harness and container smoke pass; no sd-1-S3-* resources left.

### Session close
- sd-verifier final at 7425f9e (d749719): R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8 pass, R0.5 pass by CI; pnpm -r test 17 s, typecheck and lint clean; ws-harness and container smoke pass. R2.4 and R2.10 are S4.
- Notes: hub tests 204 -> 177 from the U5 golden-matrix trim (each golden still replayed in three modes; U5 reviewer accepted). Windows R0.5 headroom is 8 s.

## Deferred findings

- U7 reviewer MINOR: test/support/hub.ts mkEnv counter is shared across files under isolate:false (harmless today; reset per file if a test asserts default seq or ts).
- U7 reviewer MINOR: test/helpers.ts:26 comment is stale; tempStore({file:true}) uses synchronous=OFF, so durability tests must call Store.open directly.
- U4 security MEDIUM: base image node:22-bookworm-slim pinned by tag only; pin by digest before Phase 7 (documented in Dockerfile and docs/HUB.md).
- U4: SMOKE_HOST_PORT mode unverified (fails in nested Docker); needs one run on a real host.
- U4: arm64 image build not exercised (no buildx/qemu in the sprint container).


- U1 sd-reviewer MINOR (packages/hub/test/auth.test.ts:111): no test for unauthenticated malformed-JSON POST returning empty 401. Folded into U2.
- U2 security LOW: HUB_MAX_HOSTS can be filled permanently by a token holder (hosts never age out). Accepted risk with D-S3-6.
- U2 reviewer/security MINOR+LOW: subagents fixtures in all-statuslines golden have no SubagentStart (rows stay empty); hostIndex re-loads each open session; bucket size below 5000 under-charges. Folded into U3.
- U3 security LOW: HUB_ALLOWED_ORIGINS unset by default; token alone blocks CSWSH. Must be set when Access fronts the hub (Phase 7). Documented in docs/HUB.md (U4).
- U3 reviewer MAJOR (iteration 3): read-limit.test.ts:108-135 fallback test does not exercise the 2 s timer. Folded into U4.
- Verifier note: ended sessions show ended_at null in the REST snapshot. Folded into U4 for investigation.
- U1 security LOW: better-sqlite3 prebuilt binary is fetched at install time and not covered by the lockfile hash. Dockerfile (U4) builds from source.
