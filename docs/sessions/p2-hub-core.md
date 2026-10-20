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
| U2 POST /ingest: validation, 1 MB limit, id+signature dedup, batch txn, reducer wiring all kinds, golden replay | sd-executor-hub | R2.1, R2.2, R2.3, R2.7 | U1 | pending |
| U3 REST routes + WS /stream (initial, deltas, heartbeat) + 5-client WS harness | sd-executor-hub | R2.5, R2.6 | U2 | pending |
| U4 Dockerfile (arm64-safe), container smoke harness, docs/HUB.md | sd-executor-hub | R2.8 (container), DoD | U3 | pending |

## Decisions made

- D-S3-1: schema 5.1 kept in shape with two portability fixes: primary-key columns NOT NULL (transcript_lines.agent_id = '' for the main session) and ms epoch columns BIGINT (Postgres int4 would overflow). 01-architecture.md 5.1 should get the same edit (user, planning doc owner).
- D-S3-2: Bearer scheme matched case-insensitively (RFC 7235); token exact, SHA-256 + timingSafeEqual.
- D-S3-3: no query-string tokens anywhere; request log serializer strips query strings.
- D-S3-4: default bind 127.0.0.1 (HUB_BIND); LAN bind is an explicit opt-in. Architecture section 7 says the hub binds to the LAN interface; Phase 2 runs on the laptop, so localhost default is the safer reading and is configurable.

- infra/docker-compose.yml is S4 scope (R2.10 handoff); S3 proves the container with `docker build` + `docker run` (sd-1-S3-* names).

## Units

### U0 + U1 (b8c3ec2, 454a2ae, f20d509, d3b4f88)
- Files: pnpm-workspace.yaml; packages/hub/{package.json,tsconfig.json,vitest.config.ts,src/{config,server,main}.ts,src/db/{migrations,store}.ts,test/*}; pnpm-lock.yaml.
- Review: iteration 1 fix-then-merge (3 MAJOR, 4 MINOR); security gate pass with 1 MEDIUM, 4 LOW, all fixed. Iteration 2 fix-then-merge (1 MAJOR chmod scope, 2 MINOR guard); security gate pass (2 LOW, fixed). Iteration 3: sd-reviewer verdict merge.
- Verify: R2.8 pass (docs/VERIFY-P2.md, 9521971), 34 tests plus live curl.

## Deferred findings

- U1 sd-reviewer MINOR (packages/hub/test/auth.test.ts:111): no test for unauthenticated malformed-JSON POST returning empty 401. Folded into U2.
- U1 security LOW: better-sqlite3 prebuilt binary is fetched at install time and not covered by the lockfile hash. Dockerfile (U4) builds from source.
