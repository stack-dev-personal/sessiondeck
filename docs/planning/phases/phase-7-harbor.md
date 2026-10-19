---
id: 'sessiondeck-phase-7'
title: 'Phase 7: Harbor (hosting on the box)'
collection: 'sessiondeck'
type: phase
phase: 7
status: planned
depends_on: [2, 4, 5, 6, 8]
---
# Phase 7: Harbor

## MVP
The same compose stack from Phase 2 runs on the dedicated box (an always-on M2 Pro laptop that stays on macOS, decision 15), reachable from the laptop on the LAN and from anywhere through Cloudflare Tunnel + Access, with Supabase Postgres replacing SQLite (ADR 0006) and nightly backups. No inbound ports on the box. The probe on the laptop points at the box and keeps working when the box is down. This is the last stage (ADR 0010): it starts after Phases 4, 5, 6 and 8 work on the laptop.

## Scope
In:
- Box provisioning runbook: macOS host: automatic security updates, sleep disabled so it stays on (pmset), a macOS Docker runtime (OrbStack suggested) running linux/arm64 containers, a non-root deploy user, firewall default-deny inbound (macOS application firewall or pf).
- Port to arm64: every image in the box compose stack is multi-arch or linux/arm64 (hub, web, cloudflared, Postgres or Supabase services).
- Runner re-review: sd-security-reviewer re-runs the Phase 8 runner (S13) review with the hub reachable through Cloudflare Access, before harbor merges.
- Supabase Postgres: decide at S11 between self-hosted Supabase on the box (its Docker distribution; keeps everything local and lets the RAG services share it) and a cloud project (less to operate, data off-box). Migrate the hub schema (the SQLite schema was written to be portable; `node-pg-migrate` or `drizzle` migrations), one-shot SQLite → Postgres import of the laptop history, connection pooling through Supabase's pooler. The hub talks to Postgres directly; Supabase Auth and RLS are not used for the single-user hub.
- Supabase MCP: granted full permissions in `.claude/settings.json` and added to `sd-executor-hub` and `sd-executor-infra` tool lists at the start of this phase (`docs/PERMISSIONS.md`).
- Cloudflare Tunnel (`cloudflared` as a compose service) with Cloudflare Access policies: your identity for the web origin; a service token for `/ingest` used by the probe; no origin exposed without Access.
- TLS everywhere outside the box (Cloudflare edge); hub still enforces its own bearer token.
- Backups: nightly `pg_dump` to local disk plus one off-box copy (object storage of your choice); restore tested.
- Observability: hub logs to files with rotation, a `/metrics` endpoint (Prometheus format) for later; optional OTel sink for Claude Code's own metrics as history.
- Hardening checklist (your infosec concentration; write it the way you would hand it to an auditor): SSH keys only, fail2ban or equivalent, Docker socket not exposed, images pinned by digest, secrets in env files with 600 perms, dependency audit in CI.
Out:
- RAG and DB services for other projects (they will share the box and, if self-hosted, the same Supabase instance; leave headroom and a compose network they can join). Multi-user auth (single user). Kubernetes (no).

## Blockers / constraints
- Host is macOS: containers run in the Docker runtime's Linux VM; firewall and "Docker socket not exposed" checks cover the macOS host and the VM; R7.1's nmap targets the host.
- Self-hosted Supabase images need arm64 builds; S11 verifies with sd-researcher before choosing self-hosted.
- Cloudflare Access service tokens for the probe: the probe daemon sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers; token rotation must not require reinstalling hooks (daemon config only).
- WS through Cloudflare works but has idle timeouts; the hub's 25 s heartbeat must be under the edge limit (100 s) and the client must reconnect transparently.
- Box may be off; probe spool already handles this (R1.5), verify with the real network path.
- LAN path should bypass Cloudflare when at home (split DNS or a direct `http://box.lan:8787` override in probe and web settings) so a Cloudflare outage never blocks local use.

## Inputs
- Phase 2 compose stack and schema.
- Phase 8 runner and its S13 security review (re-run here).
- Cloudflare Tunnel and Access docs (current at build time; the executor verifies against the docs, no memory).
- Your ITS internship Docker/security program notes if applicable (you decide what to reuse).

## Instruments
- Docker Compose v2, cloudflared, Supabase (self-hosted compose or cloud), `pg_dump`, `trivy` image scan in CI, `npm audit` in CI, Supabase MCP for schema and advisor checks.
- Restore drill script: restore last backup into a scratch container and run the hub's smoke test against it.
- Latency check: probe → box RTT on LAN and via Tunnel recorded in `docs/HARBOR-BENCH.md`.

## Requirements
- R7.1 No inbound ports open on the box other than SSH (and SSH is key-only); `nmap` from the laptop confirms.
- R7.2 Web origin unreachable without Cloudflare Access login; `/ingest` unreachable without the service token and the hub bearer.
- R7.3 Supabase Postgres migration applies cleanly; SQLite history imported with row counts matching; Supabase advisors report no security or performance findings on the hub schema.
- R7.4 Backup runs nightly; restore drill passes in CI-like script (manual trigger acceptable).
- R7.5 Probe survives 30 minutes of box downtime with zero loss (re-run R1.5 on the real path).
- R7.6 WS stays connected through the tunnel for 1 hour idle (heartbeat verified) and reconnects after a forced drop.
- R7.7 Hardening checklist complete with evidence lines (command + output) in `docs/HARDENING.md`.
- R7.8 LAN override works with Cloudflare unreachable.
- R7.9 Every image in the box compose stack is multi-arch or linux/arm64 (docker buildx imagetools inspect, or docker image inspect, shows linux/arm64 for each); the hub smoke test passes on the box.
- R7.10 Runner (S13) security review re-run with the hub reachable through Cloudflare Access; sd-security-reviewer pass before harbor merges.

## Definition of done
- [ ] All R7.x pass with evidence in docs.
- [ ] Laptop probe pointed at the box for one week; board used from the laptop and once from a phone through Access.
- [ ] `docs/HARBOR.md`: provisioning, deploy, rotate tokens, restore.
- [ ] `sd-security-reviewer` sign-off is the gate for this phase (the general reviewer is secondary).
