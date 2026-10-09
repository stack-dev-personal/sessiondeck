---
id: 'sessiondeck-phase-0'
title: 'Phase 0: Contract and scaffold'
collection: 'sessiondeck'
type: phase
phase: 0
status: planned
depends_on: []
---
# Phase 0: Contract and scaffold

## MVP
A monorepo that builds and tests in CI, plus a `contract` package containing the envelope schema, the session state reducer, and a fixture suite captured from real Claude Code sessions on your laptop. When this phase is done, three sessions can start Phases 1, 2, and 3 simultaneously and their code will fit together.

## Scope
In:
- pnpm monorepo: `packages/contract`, `packages/probe`, `packages/hub`, `packages/web` (empty shells except contract), `infra/`, `docs/planning/`, `.claude/agents/`.
- `contract`: `Envelope` zod schema, `SessionState` enum, `reduce()` with full unit tests, `SessionSnapshot` type, normalized transcript types, statusLine payload schema (from ccstatusline, MIT).
- Fixture capture script: a throwaway hook + statusLine command that dumps every raw payload to `fixtures/raw/<event>/<n>.json` from your real sessions for a day. These are the ground truth for every later parser.
- CI: lint, typecheck, test on `ubuntu-latest` and `windows-latest`.
- Copy of this planning set into `docs/planning/`.
- Sprint container tooling per `infra/sprint/README.md` (S0c): image, compose, entrypoint, run/status/stop scripts, prompt renderer, state-file helper, smoke test.
Out:
- Any runtime behavior. No daemon, no server, no UI.

## Blockers / constraints
- Hook payload fields for `PostToolUse`, `PostToolUseFailure`, `TaskCreated`, `TaskCompleted`, `PreCompact` are marked unverified in the docs research. The fixture capture resolves this; the reducer must not be finalized until fixtures exist.
- `rate_limits` only appears on Pro/Max after the first API response (A4, A5). The fixture run must include at least one long session so a sample is captured.
- Hooks in exec form on Windows must point at a real executable (`node`), not an npm `.cmd` shim.
- agentic-harness already registers hooks; the capture hook must coexist (same event, parallel execution).

## Inputs
- `01-architecture.md` sections 3 (contract) and 9 (borrow map).
- ccstatusline `src/types/StatusJSON.ts` (MIT) for the statusLine schema.
- ccmon `src/status-writer.ts`, cctop `cctop-hook.sh`, ccmonitor `hook.go` for the reducer logic.
- agents-observe `hooks/hooks.json` for the all-events registration list.
- Official docs: hooks reference, statusLine reference (quoted in `01-architecture.md`).

## Instruments
- `claude --version` recorded in `docs/ENVIRONMENT.md`.
- `pnpm`, Node 22, TypeScript 5 strict, Vitest, ESLint, Prettier, esbuild.
- GitHub Actions matrix (ubuntu, windows).
- Fixture capture: `scripts/capture-fixtures.mjs` registered on all 17 events plus statusLine for one working day, then removed.

## Requirements
- R0.1 `Envelope` schema validates every captured fixture when wrapped; rejects missing `v`, `id`, `host`, `kind`, `ts`, `seq`.
- R0.2 `reduce()` is a pure function; given the fixture sequence of a real session it produces the expected state timeline (test asserts the timeline, hand-verified once).
- R0.3 `reduce()` handles: PermissionRequest → waiting_permission; Notification permission_prompt when already waiting is a no-op; Stop after AskUserQuestion → waiting_input; StopFailure → error; SessionEnd → ended with reason; liveness dead → exited; same-pid new session_id → previous marked ended.
- R0.4 statusLine schema parses fixtures with and without `rate_limits`, with `current_usage` null, and with the #52326 leak (percentage > 100 becomes null).
- R0.5 CI green on both OSes; `pnpm -r test` under 60 s.
- R0.6 `docs/planning/` matches the vault copy; `.claude/agents/` contains the nine `sd-*` agents.
- R0.8 `scripts/sprint/run-sprint.ps1 -Sprint smoke` produces `.sprint/smoke/status.json` with state green within two minutes on Docker Desktop for Windows; the renderer has a test per package block in `MINI-SPRINT-ORDER.md`; tokens enter only through `.sprint/env`.
- R0.7 At least 50 raw fixtures across at least 12 distinct hook events, plus 20 statusLine samples, committed under `packages/contract/fixtures/`, secrets scrubbed (fixtures are reviewed by `sd-security-reviewer` before commit).

## Definition of done
- [ ] All R0.x pass in CI on `main`.
- [ ] `packages/contract` has 100% line coverage on `state.ts` and `envelope.ts`.
- [ ] A one-page `docs/CONTRACT.md` renders the envelope and state machine for humans (the mermaid state diagram is generated from the reducer's transition table, not hand-drawn).
- [ ] Phase 1, 2, 3 handoff prompts (in `04-session-map.md`) each reference commit SHAs of the contract they build against.
- [ ] `sd-reviewer` has signed off the PR; `sd-security-reviewer` has signed off the fixtures and the sprint tooling (tokens, docker socket).
