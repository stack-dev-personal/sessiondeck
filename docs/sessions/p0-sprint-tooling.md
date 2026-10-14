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
| R | Docs research: `claude setup-token`, headless flags, CLI install in a Linux image, GitHub fine-grained token permissions | sd-researcher | none | done (findings below) |
| U1 | `scripts/sprint/render-prompt.mjs` and tests (one per package block, loud failure on a missing placeholder, smoke prompt) | sd-executor-contract | none | committed c8ce896; iteration 1 fixes committed 2376112; review 2 fix-then-merge (0 blocking, 1 major, 4 minor); iteration 2 fixes committed 076c5f3; review 3 merge (0 blocking, 0 major, 4 minor); minor-fix round interrupted, audited and finished on resume 4 |
| U4 | `packages/contract/src/state-file.ts` atomic write helper and tests | sd-executor-contract | none | committed 87c0b2a; review 1 fix-then-merge (0 blocking, 3 major, 9 minor); iteration 1 fixes committed 399ac86; review 2 interrupted, rerun on resume 4 |
| U2a | `infra/sprint/Dockerfile`, `docker-compose.yml`, `entrypoint.sh` authored as files, with tests that do not need Docker | sd-executor-infra | R | pending |
| U2b | Image built and run locally with a dummy prompt | sd-executor-infra | U2a, go-file | on hold (decision 7) |
| U3 | `scripts/sprint/run-sprint.ps1`, `status.ps1`, `stop-sprint.ps1`, with a scripted dry run test | sd-executor-infra | U1, U2a | pending |
| U5 | Smoke package and harness (`-Sprint smoke`), evidence under `.sprint/0/screens/S0c/` | sd-executor-infra | U2b, U3, go-file | on hold (decision 7) |
| U6 | `infra/sprint/README.md` from specification to documentation (token procedure, token scopes, socket risk) | sd-executor-infra | R, U2a, U3 (evidence lines added after U5) | pending |
| SEC | sd-security-reviewer on the whole branch | sd-security-reviewer | U1 to U6 | pending |
| VER | sd-verifier on R0.8, rows added to `docs/VERIFY-P0.md` | sd-verifier | SEC | pending |

## Decisions made

1. Executors do not commit. The orchestrator commits each unit's paths after the executor reports, so two executors in one worktree cannot race on the git index.
2. U3 (PowerShell scripts under `scripts/sprint/`) goes to sd-executor-infra as the handoff says, although `.claude/agents/README.md` lists `scripts` under sd-executor-contract. The handoff is the more specific instruction. The delegation names the exact files.
3. The level-1 template contains `{SESSION_ID}` and `{SESSION_BRANCH}` as generic references the sprint orchestrator fills per session. The renderer passes exactly those two through and fails on any other unfilled placeholder.
4. `state-file.ts` uses `node:fs`, so it is exposed as its own subpath and is not re-exported from the contract index, which the web bundle imports.
5. Resume note from the conductor (`.sprint/0/answers/S0c.md`, read 2026-10-09T12:00Z): the first run was killed by the laptop memory-pressure reaper at about 06:18Z while the U1 review fixes and the U2 image build were both in flight. No user question was pending. Constraint from the conductor: at most one `docker build` at a time, and no image build while a second executor runs. Consequence: the U1 fix round and U4 run in parallel (neither uses Docker), then U2 runs alone, then U3, U5 and U6 in sequence.
6. Work found uncommitted on resume (U1 fix edits under `scripts/`, U2 draft under `infra/sprint/`) is not assumed complete. Each goes to a fresh executor of the owning type with the original findings or specification verbatim, to audit and finish before anything is committed. The U1 reviewer findings were recovered verbatim from `.sprint/0/logs/S0c.jsonl`.
7. Second resume note from the conductor (`.sprint/0/answers/S0c.md`, written 2026-10-09T12:25Z, read 12:26Z): the conductor stopped this session at 12:24Z on purpose because the laptop is short on memory. No user question was pending. HOLD RULE from the user, via the conductor: no `docker build`, `docker compose build`, `docker compose up`, `docker run` of the sprint image, and no `run-sprint.ps1` against a real container, until the file `.sprint/0/answers/S0c-u2-go.md` exists. The file is checked immediately before any step that needs the image. Once allowed: one build at a time and no second executor during a build. Work is re-ordered so everything that does not need the image comes first: U1 and U4 review and verification; U2 authored as files with tests that do not need Docker; U3 with scripted dry runs; U6 docs; then the U2 build and run and the U5 smoke run. If that work runs out and the go-file is still absent, the session writes the question file, sets status blocked, commits as `wip: blocked on image build hold`, and exits 0.
8. State found on this resume: U1 fix iteration 2 left uncommitted edits under `scripts/` (five modified files, one new test file); U4 fix iteration 1 left nothing on disk. Neither is assumed complete. U1 goes to a fresh executor to audit the edits against the findings and finish; the U4 fix round is redone from the same delegation. Both reviewer findings blocks were recovered verbatim from `.sprint/0/logs/S0c-resume1.jsonl`.
9. Decisions that went with the U4 review findings (made in the previous run, recorded here): `green` is accepted as a sprint state for the smoke package, because R0.8 and `infra/sprint/README.md` require `.sprint/smoke/status.json` with state green while PROMPT-BOOK.md section 6 does not list it (listed under Open questions); the CLI merges `sessions` per session id under an exclusive lock file with a stale-lock takeover; the U4 boundary is extended to one option in `tsconfig.base.json` and the root `engines.node` value for the eleventh finding.
10. `pnpm-lock.yaml` changed in c8ce896 (adds `yaml` for `scripts`). The reviewer flagged it as outside the U1 boundary and not blocking. Accepted as the mechanical result of the in-boundary `scripts/package.json` change.
11. Third resume note from the conductor (`.sprint/0/answers/S0c.md`, written 2026-10-09T17:58Z, read 18:00Z; the file calls it resume 4). No user question was pending. Cause of the previous exit, from stderr: headless `claude -p` stops background tasks ten minutes after the main turn goes idle and then exits; two background subagents (the U1 minor-fix executor and the U4 second review) and a background heartbeat timer were running. Rules taken from the note: every subagent call runs in the foreground and is waited for; heartbeats are short foreground status writes between units, with no background timers. The conductor now sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` when it launches this session, and this session does not depend on it. The HOLD RULE of decision 7 is unchanged: no image build or run until `.sprint/0/answers/S0c-u2-go.md` exists.
12. Finding from the same note, applied to this session's own deliverables: a headless orchestrator inside the sprint container has the same ten-minute ceiling. `infra/sprint/entrypoint.sh` exports `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (U2a), `infra/sprint/README.md` documents the variable and the reason (U6), and the level-1 and level-2 prompts should tell sessions to keep subagent calls in the foreground. PROMPT-BOOK.md is outside this handoff's file list, so the prompt wording is proposed in the report and listed under Open questions instead of being edited here.
13. State found on this resume: commits up to 399ac86, not pushed. Uncommitted: four files under `scripts/sprint/` and one new test file (`scripts/test/sprint-render-review3.test.ts`) from the U1 minor-fix round; the U2 draft under `infra/sprint/` from the first run. Nothing from the U4 second review, which is read-only. Neither set is assumed complete. The U1 edits go to a fresh executor with the four review 3 findings verbatim, to audit and finish. The U4 second review is rerun from the same prompt. Both prompts were recovered verbatim from `.sprint/0/logs/S0c-resume2.jsonl`.

14. Fourth resume note from the conductor (`.sprint/0/answers/S0c.md`, written 2026-10-09T18:19Z, read 2026-10-14T18:02Z; the file calls it resume 5). Cause: the user paused all orchestration (travelling, weak network); no user question was pending. Rules kept: subagent calls in the foreground, no long background timers, the HOLD RULE of decision 7 (the go-file `.sprint/0/answers/S0c-u2-go.md` was absent at resume). Image-free work first; if only image work remains, block per PROMPT-BOOK.md section 5. The entrypoint finding (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, foreground subagents) is recorded in U2 and U6.
15. State found on this resume: commits up to aa0e4f7; uncommitted U1 minor-fix edits (four files plus `scripts/test/sprint-render-review3.test.ts`) and the U2 draft under `infra/sprint/`. The U1 minor-fix executor had finished before the stop; its report was recovered from `.sprint/0/logs/S0c-resume3.jsonl` (all four findings fixed, each seen red), the scripts suite was re-run here (344 passed, 3 skipped), and the edits were committed as 469ea5a. The U4 second review had not returned; it was rerun.
16. U2 is split: U2a authors the container files with static tests, `bash -n`, shellcheck and `docker compose config` only (stock-image `docker run --rm` allowed for socket inspection and shellcheck, never the sprint image); U2b builds and runs the harness once the go-file exists.
17. The docker socket is a user decision named in the handoff's stop conditions. The security reviewer passed U2a but requires the README to state that the socket is root-equivalent (the container is not a sandbox) and the user to accept it before the smoke run. This is asked in `questions/S0c.md` together with the go-file once U6 has written the note.

## Units

(appended as units close)

## Deferred findings

(none yet)

## Open questions

1. PROMPT-BOOK.md section 6 lists the sprint states without `green`; R0.8 and `infra/sprint/README.md` require the smoke status file to say green. The helper accepts both (decision 9). Which document should change is for the user.

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
