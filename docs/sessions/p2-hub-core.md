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
| U0 allow better-sqlite3 native build in pnpm-workspace.yaml | sd-executor-contract | infra for all | - | pending |
| U1 hub scaffold, config, migrations (5.1), store, bearer auth, /health | sd-executor-hub | R2.8 | U0 | pending |
| U2 POST /ingest: validation, 1 MB limit, id+signature dedup, batch txn, reducer wiring all kinds, golden replay | sd-executor-hub | R2.1, R2.2, R2.3, R2.7 | U1 | pending |
| U3 REST routes + WS /stream (initial, deltas, heartbeat) + 5-client WS harness | sd-executor-hub | R2.5, R2.6 | U2 | pending |
| U4 Dockerfile (arm64-safe), container smoke harness, docs/HUB.md | sd-executor-hub | R2.8 (container), DoD | U3 | pending |

## Decisions made

- infra/docker-compose.yml is S4 scope (R2.10 handoff); S3 proves the container with `docker build` + `docker run` (sd-1-S3-* names).

## Units

## Deferred findings
