# S0c - Sprint container tooling

Phase 0. Branch: `p0/sprint-tooling` (depends on S0 merged into `sprint/0-bootstrap`).

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for the sprint-tooling slice of Phase 0 of sessiondeck. Read, in order: CLAUDE.md, PROMPT-BOOK.md (all sections), MINI-SPRINT-ORDER.md (sections 1, 2, and the Sprint 0 package), CONDUCTOR.md, infra/sprint/README.md (the specification you are implementing), docs/planning/phases/phase-0-contract.md.

Goal: the files infra/sprint/README.md lists under "What S0c must produce", working end to end: Dockerfile; docker-compose.yml; entrypoint.sh; scripts/sprint/run-sprint.ps1 (-Sprint, -Resume), status.ps1, stop-sprint.ps1; scripts/sprint/render-prompt.mjs that renders a level-1 prompt from PROMPT-BOOK.md section 3 plus a package block parsed out of MINI-SPRINT-ORDER.md, with unit tests against every package block in that file; the .sprint/ state layout from PROMPT-BOOK.md section 6 with an atomic-write helper the orchestrator and phase managers can import (packages/contract/src/state-file.ts, small, tested); the smoke package (`-Sprint smoke`).

Work on branch p0/sprint-tooling. Create tasks from these units: (1) renderer + tests; (2) Dockerfile + compose + entrypoint, built and run locally with a dummy prompt; (3) PowerShell scripts, tested with Pester or at least a scripted dry run; (4) state-file helper; (5) smoke test; (6) docs: update infra/sprint/README.md from specification to documentation, including the exact `claude setup-token` procedure and token lifetime (have sd-researcher verify against the current Claude Code docs before you write it), and the GitHub fine-grained token scopes.

Delegate (1), (4) to sd-executor-contract; (2), (3), (5), (6) to sd-executor-infra. sd-reviewer per unit. sd-security-reviewer on the whole branch at the end: tokens only via .sprint/env (gitignored, 600), never baked into the image or echoed; docker socket mount risks stated in the README; entrypoint never logs env. sd-verifier runs the smoke test and writes docs/VERIFY-P0.md rows for it.

Constraints: the container must work with Docker Desktop on Windows (bind mounts with Windows paths, CRLF-safe scripts, `#!/usr/bin/env bash` with LF endings enforced by .gitattributes); the renderer must fail loudly on a missing placeholder; nothing in this slice touches packages/probe, hub, or web.

Stop and ask me if `claude setup-token` or headless `--agent` invocation does not behave as the docs describe on the installed version, or if the docker socket mount is unacceptable to me after reading the security note (the alternative, docker-in-docker, costs more and is a decision for me). End with PR URL against sprint/0-bootstrap and evidence.
