# ADR 0006: Supabase is the database backend; SQLite stays local for Phase 2

Status: accepted 2026-10-08

## Context
The default stack for this user's projects is Supabase. The box will host database and RAG services. Phase 2 needs a store that runs in one process on the laptop with no setup.

## Decision
Phase 2 uses SQLite (better-sqlite3) with a Postgres-portable schema. Phase 7 moves the hub's store to Supabase Postgres: self-hosted on the box via Supabase's Docker distribution, or a cloud project; the choice is made at S11 with the trade-off written into the session log. The Supabase MCP server is granted full permissions in project settings when that work starts (`docs/PERMISSIONS.md`).

## Consequences
- Migrations are written to run on both SQLite and Postgres from day one.
- Supabase Auth and RLS are not used for the hub in Phase 7 (single user behind Cloudflare Access); the hub talks to Postgres directly. Revisit if multi-user ever matters.
- `docs/planning/phases/phase-7-harbor.md` targets Supabase, not plain Postgres.
