# ADR 0007: Bash allowed project-wide with a guard hook and deny rules

Status: accepted 2026-10-08

## Context
The executor loop runs tests, benches, and git constantly; permission prompts on every command make unattended sessions impossible. A few actions must never happen from an agent: force push, push to main, branch deletion, hard reset, recursive deletes outside the repo, edits to the user-level Claude settings.

## Decision
`.claude/settings.json` allows `Bash` and edits (`acceptEdits`). Deny rules cover the prefix-matchable cases; `.claude/hooks/guard.mjs` (PreToolUse on Bash) covers the rest, including bare `git push` while on main. `.env*` and `probe.json` are unreadable. GitHub branch protection on `main` is the server-side backstop.

## Consequences
- Sessions run without prompts inside the repo.
- The guard is tested (12 cases) and must never throw; a crashing guard would block all Bash.
- Widening for Supabase and Cloudflare MCP is documented per phase.
