# ADR 0008: Three-level agentic workflow with containerized mini-sprints

Status: accepted 2026-10-08

## Context
Phases contain sessions that can run in parallel, and sprints of sessions can run in parallel with each other. Running them by hand in terminals is the problem this project exists to solve. Headless Claude Code sessions cannot ask the user anything, yet the user must stay in the loop for decisions and for every merge to main.

## Decision
Three levels. Level 0, the conductor (`CONDUCTOR.md`, `sd-conductor`), runs locally and interactively; it assesses state, launches, monitors, relays questions, and merges to main only on the user's explicit yes. Level 1, one mini-sprint orchestrator per sprint (`MINI-SPRINT-ORDER.md`, `sd-sprint-orchestrator`), runs headless in its own container, launches phase managers in worktrees, merges green branches onto the sprint branch, runs the integration gate, and opens the PR. Level 2, phase managers (`sd-orchestrator`), run headless from `PROMPT-BOOK.md` section 2 wrapping a handoff. Questions flow up as `questions.md` plus a `blocked` status; answers flow down as `answers/*.md` and a relaunch. Workers may start test containers and must automate the user's testing with Playwright flows and harness output.

## Consequences
- Sprint 0 runs locally because it builds the container tooling (S0c).
- Containers hold exactly two tokens (Claude auth, GitHub push) and the docker socket; no SSH, Cloudflare, or Supabase secrets. Box-side work in Sprint 4 runs from the conductor session.
- Every headless session consumes subscription rate-limit windows; the conductor throttles with `MAX_SPRINT_CONTAINERS` and each package's `max_parallel`.
- `--dangerously-skip-permissions` is used only inside containers; the project deny rules and the guard hook still apply there.
