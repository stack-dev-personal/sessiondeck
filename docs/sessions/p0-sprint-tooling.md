# Session log: p0/sprint-tooling (S0c)

- Date: 2026-10-09
- Handoff: `docs/handoffs/S00c-sprint-tooling.md`
- Sprint: 0 (bootstrap), joined branch `sprint/0-bootstrap` at 3702f2c (S0 merged)
- Contract SHA: n/a (Sprint 0)
- Mode: headless, local on the Windows laptop (worktree `C:/Users/stack/projects/wt/S0c`), state directory `.sprint/0/` in the main checkout
- Requirement: R0.8 (phase doc `docs/planning/phases/phase-0-contract.md`), plus the Definition of Done line "sd-security-reviewer has signed off the sprint tooling (tokens, docker socket)"

## Intake facts

- Tools on this laptop: Docker 29.8.1, Node v24.19.0, pnpm 12.10.1, Claude Code 2.1.295, gh 2.101.0, Windows PowerShell 5.1 with Pester 3.4.0. PowerShell 7 (`pwsh`) is not installed.
- `.gitattributes` already enforces `* text=auto eol=lf`.
- `.gitignore` already ignores `.sprint/`.
- No tokens exist for this session. `.sprint/env` is absent and is not created here. The live `-Sprint smoke` run is a laptop confirmation for the conductor and the user.
- CI budget: `pnpm -r test` has a one minute step timeout (R0.5). Docker-backed checks must stay out of the default test run.

## Task list

| Unit | What | Executor | Blocked by | Status |
|------|------|----------|------------|--------|
| R | Docs research: `claude setup-token`, headless flags, CLI install in a Linux image, GitHub fine-grained token permissions | sd-researcher | none | in progress |
| U1 | `scripts/sprint/render-prompt.mjs` and tests (one per package block, loud failure on a missing placeholder, smoke prompt) | sd-executor-contract | none | in progress |
| U4 | `packages/contract/src/state-file.ts` atomic write helper and tests | sd-executor-contract | none | pending |
| U2 | `infra/sprint/Dockerfile`, `docker-compose.yml`, `entrypoint.sh`, built and run locally with a dummy prompt | sd-executor-infra | R | pending |
| U3 | `scripts/sprint/run-sprint.ps1`, `status.ps1`, `stop-sprint.ps1`, with a scripted dry run test | sd-executor-infra | U1, U2 | pending |
| U5 | Smoke package and harness (`-Sprint smoke`), evidence under `.sprint/0/screens/S0c/` | sd-executor-infra | U2, U3 | pending |
| U6 | `infra/sprint/README.md` from specification to documentation (token procedure, token scopes, socket risk) | sd-executor-infra | R, U2, U3, U5 | pending |
| SEC | sd-security-reviewer on the whole branch | sd-security-reviewer | U1 to U6 | pending |
| VER | sd-verifier on R0.8, rows added to `docs/VERIFY-P0.md` | sd-verifier | SEC | pending |

## Decisions made

1. Executors do not commit. The orchestrator commits each unit's paths after the executor reports, so two executors in one worktree cannot race on the git index.
2. U3 (PowerShell scripts under `scripts/sprint/`) goes to sd-executor-infra as the handoff says, although `.claude/agents/README.md` lists `scripts` under sd-executor-contract. The handoff is the more specific instruction. The delegation names the exact files.
3. The level-1 template contains `{SESSION_ID}` and `{SESSION_BRANCH}` as generic references the sprint orchestrator fills per session. The renderer passes exactly those two through and fails on any other unfilled placeholder.
4. `state-file.ts` uses `node:fs`, so it is exposed as its own subpath and is not re-exported from the contract index, which the web bundle imports.

## Units

(appended as units close)

## Deferred findings

(none yet)

## Open questions

(none yet)
