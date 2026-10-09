# ADR 0002: Observe-only MVP; session hosting is Phase 8

Status: accepted 2026-10-08

## Context
Hosting sessions inside the app (spawning `claude` in a pty, rendering xterm.js panes) gives the richest data but changes the daily workflow and is the riskiest piece (ConPTY layering, Claude Code's own mouse handling, a process launcher that is remote code execution by design).

## Decision
The MVP observes sessions started normally in the terminal. Launching and hosting from the app is the last phase, after the hosting and auth story exists.

## Consequences
- Metrics come from statusLine and hooks, content from transcript tailing.
- The board must be useful without input capability.
- Phase 8 is gated by the security reviewer.
