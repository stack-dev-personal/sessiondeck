---
id: 'sessiondeck-phase-2'
title: 'Phase 2: Hub (ingest, store, API)'
collection: 'sessiondeck'
type: phase
phase: 2
status: planned
depends_on: [0]
---
# Phase 2: Hub

## MVP
A single Node service that accepts envelope batches, reduces them into session snapshots, stores everything, and pushes deltas to connected browsers. Runs in Docker on the laptop in this phase; moves to the box unchanged in Phase 7.

## Scope
In:
- `POST /ingest` with bearer auth, zod validation, dedup (id + signature), per-batch transaction.
- Reducer wiring: `hook` → `reduce()`; `statusline` → context/cost/rate_limits + sample; `subagents` → subagent rows; `transcript` → normalize + store; `liveness` → exited.
- SQLite via better-sqlite3 with versioned migrations; schema from `01-architecture.md` 5.1.
- REST: sessions (live, by id, events after seq, transcript after line), projects, hosts.
- WS `/stream` with `initial` resync, deltas, heartbeat.
- Retention: events older than 30 days compacted to snapshots (configurable).
- Replay command: rebuild snapshots from events (recovery and reducer upgrades).
- Dockerfile + `infra/docker-compose.yml` (hub + web static).
Out:
- UI. Postgres (Phase 7). Cloudflare (Phase 7). Any outbound calls except LiteLLM pricing fetch (cached, optional).

## Blockers / constraints
- Must stay stateless apart from the DB so Phase 7 is a copy, not a port.
- Phase 7 (last, ADR 0010) runs the stack on a macOS M2 Pro box with linux/arm64 containers (R7.9): keep Dockerfiles free of amd64-only assumptions (base images with arm64 builds, no amd64-only native binaries) so the move stays a copy.
- Ingest must be cheap: a busy session emits 5-20 envelopes/s during tool bursts; two machines, several sessions each. Target 1k envelopes/s sustained on the laptop.
- Snapshot materialization means the reducer runs on ingest; a reducer bug corrupts snapshots, hence the replay command and the Phase 0 fixtures as regression tests.
- Transcript lines are stored raw; normalization is computed on read or lazily cached, so a normalizer fix never requires re-ingest.

## Inputs
- `packages/contract` at the Phase 0 SHA; Phase 1 spool samples (or synthesized from fixtures if Phase 1 is still in flight).
- claude-watch `src/server/websocket.ts`, `routes/events.ts` (MIT) for the broadcast and ingest shape.
- agents-observe `app/server/src/utils/event-signature.ts`, `storage/sqlite-adapter.ts` (MIT).
- ccusage v19.0.3 `adapter/claude/data-loader.ts` (`usageDataSchema`, `createUniqueHash`, cost modes) and `packages/internal/src/pricing.ts` (MIT) for history aggregation.
- claudecodeui `provider-token-usage.service.ts` rules (AGPL, spec only): skip `isSidechain`, skip all-zero synthetic usage.
- Claude-Code-Usage-Monitor `output/official.py` (MIT) for rate-limit staleness and leak guard.

## Instruments
- Fastify, better-sqlite3, ws, zod, pino.
- Load harness: `scripts/load-ingest.mjs` replays a day of spool at 10x speed; records ingest p95 and DB size.
- WS harness: 5 browser clients, assert every delta reaches all within 100 ms of ingest.
- Vitest integration tests against a temp DB; contract fixtures as golden tests for snapshots.

## Requirements
- R2.1 Ingest validates and rejects malformed envelopes with 400 and a reason; accepts batches up to 1 MB.
- R2.2 Duplicate `id` or identical signature within 5 s is accepted (200) but not stored twice.
- R2.3 Replaying Phase 0 fixture sequences yields snapshots equal to golden files.
- R2.4 Ingest p95 < 20 ms per batch of 100 at 1k envelopes/s on the laptop.
- R2.5 WS clients receive `initial` on connect and every snapshot delta thereafter; reconnecting clients resync without duplicates.
- R2.6 `GET /sessions?live=1` excludes `ended` and `exited` older than 10 minutes.
- R2.7 Rate-limit windows past `resets_at` render as null; `used_percentage` outside 0..100 is nulled and logged.
- R2.8 Bearer token required on every route except `/health`; missing token → 401, no body detail.
- R2.9 `hub replay` rebuilds all snapshots from events in under 60 s for 30 days of your typical volume.
- R2.10 Cost history per session and per day matches ccusage `session` output for the same transcripts within 1%.

Added 2026-10-28 from user report (session S8d, handoff docs/handoffs/S08d-headless-metrics.md). R2.11 is left for another session; add, never renumber.
- R2.12 Transcript-derived snapshot fields. When a session has no statusline value for a field, the hub fills it from the transcript lines it already stores: model (last assistant row message.model), context tokens (last assistant row usage: input + cache_creation + cache_read) and used % against the model context window from the pricing table (max_input_tokens; if unknown, tokens without a percent), cost (the transcript-priced lifetime cost the cost route computes), git branch (the rows gitBranch), last assistant message (last assistant text, capped as today). Statusline values always win when present. Each filled field carries its source (statusline or transcript) in the snapshot. Updates flow through the existing WS deltas as transcript lines arrive.
- R2.13 Subagents of any session (headless or interactive): model, tokens and context from their subagent transcript lines (agentId link), filling the nulls in snapshot.subagents. Effort only if a transcript or hook row states it; otherwise null (measured figures only, decision 28).

## Definition of done
- [ ] All R2.x pass; load numbers in `docs/HUB-BENCH.md`.
- [ ] `docker compose up` on the laptop serves `/health` and accepts the Phase 1 daemon.
- [ ] A week of real spool ingested with zero reducer exceptions (exceptions are logged with the envelope id, count must be 0).
- [ ] `docs/HUB.md`: env vars, migrations, replay, retention.
- [ ] `sd-reviewer` and `sd-security-reviewer` sign-off (auth, input validation, SQL parameterization, rate limiting per host).
