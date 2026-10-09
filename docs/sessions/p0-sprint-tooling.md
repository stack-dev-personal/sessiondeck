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

## Research findings (sd-researcher, Claude Code and GitHub docs fetched 2026-10-09)

Used by U2 and U6. Quotes and URLs are in the researcher's report; the points below are what the tooling depends on.

- `claude setup-token` is interactive, opens the same browser flow as `/login`, prints the token and saves nothing. Needs Pro, Max, Team or Enterprise. Lifetime is one year. Replacing an expired token is documented; revoking one is not documented.
- The variable is `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `apiKeyHelper` rank above it, and in `-p` mode an API key is always used when present. `--bare` does not read the token and skips subagent discovery.
- `--dangerously-skip-permissions` is refused as root or under sudo on Linux. The documented answer is a non-root user. No escape variable is documented.
- All five flags of the planned command line exist as spelled. `--agent` together with `-p` and a project-scoped agent is not documented either way. It is a live-run confirmation, not a contradiction.
- `-p` shows no workspace trust dialog. Onboarding behavior of a fresh config directory in `-p` is not documented.
- Install in a Dockerfile: `npm install -g @anthropic-ai/claude-code@X.Y.Z` with `DISABLE_AUTOUPDATER=1` (devcontainer page).
- GitHub fine-grained token: Contents read and write, Pull requests read and write, Actions read, Metadata read (implicit). "Checks" cannot be granted to a fine-grained token, so `gh pr checks` may not work with it; `gh run list` needs only Actions read. Commit statuses read covers the status endpoints. "Workflows" is a separate write permission; that a push touching `.github/workflows/` needs it is community-sourced only. Maximum lifetime 366 days or none; the resource owner must be the account that owns the repository (`stack-dev-personal`, by the redirect).
- The GitHub quotes came through a summarizer and should be checked against the page when the user creates the token.
