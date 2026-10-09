# S11 / S12 - Harbor

Phase 7. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 7 of sessiondeck. Read docs/planning/phases/phase-7-harbor.md, docs/planning/01-architecture.md section 7, and infra/.

Goal (S11): box provisioning runbook (Linux, Docker, deploy user, default-deny firewall), the compose stack on the box, Supabase Postgres (self-hosted on the box or cloud; decide and record the trade-off at the start of S11) with migrations ported from SQLite, one-shot history import with row-count verification, nightly pg_dump with an off-box copy, restore drill script. Requirements R7.3, R7.4.
Goal (S12, after S11): cloudflared as a compose service, Cloudflare Access policies (identity for web, service token for /ingest), probe and web LAN override, WS heartbeat verified through the tunnel, hardening checklist with command-and-output evidence in docs/HARDENING.md, trivy and npm audit in CI. Requirements R7.1, R7.2, R7.5, R7.6, R7.7, R7.8.

Branches p7/box and p7/edge. Delegate to sd-executor-infra (and sd-executor-hub for the Postgres port; both get the Supabase MCP tool for this phase per docs/PERMISSIONS.md). sd-security-reviewer is the gate for both sessions; sd-reviewer secondary. Verify every Cloudflare step against current docs with sd-researcher before executing; do not rely on memory. Nothing in these sessions runs against the box without me confirming the host and the SSH key first. End with PR URL and evidence.
