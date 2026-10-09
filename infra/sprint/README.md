# Sprint containers

The contract between `CONDUCTOR.md`, `MINI-SPRINT-ORDER.md`, and the tooling that S0c builds here. Until S0c lands, this file is the specification; after it lands, it is the documentation and the files beside it are the implementation.

## What S0c must produce

```
infra/sprint/Dockerfile            node 22, pnpm, git, gh, docker CLI, Claude Code CLI, Playwright system deps
infra/sprint/docker-compose.yml    service "sprint": image above, env from .sprint/env, volumes below, docker socket mounted
infra/sprint/entrypoint.sh         clone or fetch the repo into /work, checkout the sprint branch, run the level-1 prompt headless, tee logs to /state
scripts/sprint/run-sprint.ps1      -Sprint <id> [-Resume]: render the prompt (PROMPT-BOOK section 3 + package block), write .sprint/<id>/, start the container detached as sprint-<id>
scripts/sprint/status.ps1          print every .sprint/*/status.json as one table (what the conductor runs on each poll)
scripts/sprint/stop-sprint.ps1     -Sprint <id>: stop and remove the container, keep .sprint/<id>/
scripts/sprint/render-prompt.mjs   the prompt renderer used by run-sprint.ps1 (so it is testable)
```

## Container contract

| Path in container | Host | Purpose |
|-------------------|------|---------|
| `/work` | named volume `sprint-<id>-work` | fresh clone of the repo; worktrees under `/work/wt/<session>` |
| `/state/<id>` | bind mount `.sprint/<id>/` | status, prompts, questions, answers, logs, reports, screens, gate (PROMPT-BOOK section 6) |
| `/var/run/docker.sock` | host socket | lets executors start sibling test containers (hub compose, Playwright, Postgres or Supabase). Sibling containers are named `sd-<sprint>-<session>-*` and removed at session end |

Environment (from `.sprint/env`, gitignored, mode 600, written once by the user):

| Var | Purpose | How |
|-----|---------|-----|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude auth for headless sessions on a Pro/Max subscription | `claude setup-token` on the laptop (S0c verifies the exact command and expiry with sd-researcher and records it here) |
| `GH_TOKEN` | push branches, open PRs, read checks | a fine-grained GitHub token scoped to this repo: contents read/write, pull requests read/write, actions read; no admin |
| `SPRINT_ID` | which package to run | set by run-sprint.ps1 |

Nothing else. No SSH keys, no Cloudflare, no Supabase, no probe tokens. Sprint 4's box work runs from the conductor session on the laptop.

## Headless invocation

```
claude -p "$(cat /state/$SPRINT_ID/sprint-prompt.md)" --agent sd-sprint-orchestrator \
  --dangerously-skip-permissions --output-format stream-json --verbose \
  | tee /state/$SPRINT_ID/logs/sprint.jsonl
```

Phase managers inside are launched by the orchestrator with the command in `PROMPT-BOOK.md` section 2. `--dangerously-skip-permissions` is acceptable because the container is the sandbox; the project deny rules and `guard.mjs` still run inside it.

## Resume

`run-sprint.ps1 -Sprint <id> -Resume` starts a new container against the same `.sprint/<id>/` and the existing remote sprint branch. The orchestrator's setup step detects the existing branch and status file and continues from them; sessions with state green are not relaunched.

## Smoke test (Sprint 0 gate)

`run-sprint.ps1 -Sprint smoke` renders a one-line prompt (`write /state/smoke/status.json with state green and exit`) and must produce that file within two minutes. This proves auth, clone, the socket mount, and the state mount before any real sprint runs.

## Limits to know

- Every headless session counts against the subscription's 5h and 7d windows; the conductor's `MAX_SPRINT_CONTAINERS` and each package's `max_parallel` are the throttle.
- Windows-only code (probe hook, runner pty) cannot be exercised in the Linux container; the windows-latest CI job and the conductor's laptop checks cover it.
- A container that loses network mid-session leaves the session's branch pushed up to its last commit; `-Resume` picks up from the session log and `docs/HANDOFF-*.md`.
