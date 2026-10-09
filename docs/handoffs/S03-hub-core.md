# S3 - Hub core

Phase 2. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 2 (core) of sessiondeck. Read docs/planning/phases/phase-2-hub.md, docs/planning/01-architecture.md sections 3.4, 5.1, 5.2, 7, and packages/contract at <sha>.

Goal: packages/hub (Fastify, better-sqlite3, ws): POST /ingest with bearer auth, zod validation, id and signature dedup, per-batch transaction; reducer wiring for all envelope kinds; migrations for the schema in 5.1; REST routes for sessions, hosts, projects; WS /stream with initial resync and heartbeat; Dockerfile. Requirements R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8.

Branch p2/hub-core. Delegate to sd-executor-hub. Borrow claude-watch broadcast and agents-observe event-signature with attribution; treat claudecodeui as spec only (AGPL). Golden tests: replay contract fixture sequences and compare snapshots. sd-reviewer per unit; sd-security-reviewer on auth, validation, and SQL parameterization. sd-verifier runs the WS harness with 5 clients.

Keep the hub stateless apart from the DB; Phase 7 copies it to another machine unchanged. Stop and ask me before adding any outbound network call. End with PR URL and evidence.
