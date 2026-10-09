# ADR 0003: Cloudflare Tunnel and Access front the box

Status: accepted 2026-10-08

## Context
The box will be reachable from outside the LAN. Opening inbound ports on a home network to a service that stores transcripts and later triggers process launches is not acceptable.

## Decision
`cloudflared` runs as a compose service; the web origin sits behind Cloudflare Access (identity), the ingest path behind an Access service token. The hub keeps its own bearer check. A LAN override bypasses Cloudflare at home.

## Consequences
- No inbound ports on the box other than SSH (key-only).
- Token rotation must not require reinstalling hooks.
- WebSocket heartbeat must stay under Cloudflare's idle timeout.
