# sessiondeck

Self-hosted dashboard for parallel Claude Code sessions. Sessions run on the laptop (probe); the hub and web UI run on a dedicated box. MVP is observe-only. Full context: `docs/planning/01-architecture.md`.

## Read before doing anything

1. `docs/planning/00-open-decisions.md` (assumptions; do not silently change them)
2. The phase doc for the work at hand: `docs/planning/phases/phase-<n>-*.md`
3. `docs/planning/04-session-map.md` section 1 (operating model) and the session's handoff in `docs/handoffs/`

## Operating model

- A session is the project manager for one slice. Start it as `claude --agent sd-orchestrator`; it delegates to `sd-executor-*` agents, reviews with `sd-reviewer` (and `sd-security-reviewer` where the phase says so), verifies with `sd-verifier`. Agent roster and directory ownership: `.claude/agents/README.md`.
- Branch per session: `p<phase>/<slug>` (table in `04-session-map.md` section 2). Never push to `main`, never force-push, never delete branches. Open a PR; the user merges.
- Local ports for visual checks: web `localhost:5173`, hub `localhost:8787`.
- Requirement IDs `R<phase>.<n>` are the unit of work, review, and verification. A task is done when `sd-verifier` has evidence for its IDs in `docs/VERIFY-P<phase>.md`.
- Stop and ask when: a decision in `00-open-decisions.md` is contradicted by reality; a borrowed snippet's license differs from `01-architecture.md` section 9; a Claude Code payload differs from the fixtures in `packages/contract/fixtures/`; anything would change `~/.claude/settings.json` beyond the probe's own keys, run against another machine, or delete data.

## Repo layout

```
.claude/agents/     sd-* subagents (project-scoped)
docs/planning/      decisions, architecture, roadmap, design system, session map, phases/
docs/handoffs/      one paste-ready prompt per session
docs/decisions/     ADRs (numbered, immutable once accepted)
docs/research/      dated research notes
docs/sessions/      session logs written by the orchestrator (one per branch)
.claude/skills/     the guided loops listed below
.claude/hooks/      guard.mjs (PreToolUse guard for Bash)
packages/           contract, probe, hub, web (created in S0; ownership map in packages/README.md)
infra/              docker compose, cloudflared, postgres (Phase 2 and 7)
```

## Guided loops (project skills in `.claude/skills/`)

These are the procedures, not suggestions. Each one has exit conditions; do not move past a step without meeting them.

| Skill | Who runs it | When |
|-------|-------------|------|
| `/sprint-loop` | orchestrator | start of every session, and whenever unsure what to do next |
| `/work-unit` | orchestrator (delegation template) and executors (execution loop) | every delegation |
| `/review-loop` | orchestrator with sd-reviewer and sd-security-reviewer | after every executor report |
| `/verify-dod` | orchestrator with sd-verifier | before any task is marked complete; at phase close |
| `/session-handoff` | orchestrator | context getting large, or told to stop; and when resuming from `docs/HANDOFF-*.md` |
| `/borrow-code` | executors | any time code is copied from another project |
| `/fixture-capture` | S0 and S0b | building and scrubbing the contract fixtures |

Session log: `docs/sessions/<branch>.md`, written by the orchestrator as it goes (intake, units, verdicts, decisions, deferred findings). Verification evidence: `docs/VERIFY-P<phase>.md`. Benches: `docs/<PACKAGE>-BENCH.md`.

## Permissions

`.claude/settings.json` allows Bash and edits without prompts; a `PreToolUse` guard hook plus deny rules block force pushes, pushes to `main`, branch deletion, `reset --hard`, recursive deletes outside the repo, and any command touching `~/.claude/settings.json`. Secrets (`.env*`, `probe.json`) are unreadable to sessions. Details and how to widen per phase (Supabase MCP in Phase 7): `docs/PERMISSIONS.md`.

## Conventions

- TypeScript strict, pnpm workspaces, Vitest, ESLint + Prettier (set up in S0).
- Borrowed code carries a header comment: source repo, path, license, what changed. MIT and Apache-2.0 only; AGPL sources (claudecodeui) are read as specification, never copied. Attributions go in `NOTICE`.
- Commit messages: imperative subject under 72 chars, body says which requirement IDs the change serves.
- No em dashes in prose or docs.
- Windows is the first-class target for `packages/probe` and `packages/runner`; Linux for `packages/hub`; both for `packages/web`.

## Environment facts (fill in S0)

See `docs/ENVIRONMENT.md`: Claude Code version, Node version, OS of each host, Git Bash present or not, plan type.
