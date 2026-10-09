# ADR 0001: Sessions on the laptop, hub on the box

Status: accepted 2026-10-08

## Context
Claude Code sessions and the repositories they work on live on the laptop. A dedicated box is planned to host the dashboard and, later, RAG and database services. Three models were considered: sessions on the box, sessions on the laptop with the dashboard on the box, or both with a per-machine agent.

## Decision
Sessions stay on the laptop. A probe on the laptop forwards telemetry to a hub on the box. A later phase adds a laptop-side runner so the box can trigger launches without hosting them.

## Consequences
- The probe must tolerate the box being unreachable (spool and forward, never block a hook).
- Transcript content leaves the laptop; redaction and transport auth are requirements, not options.
- Two laptops are supported by a `host` field in every envelope.
