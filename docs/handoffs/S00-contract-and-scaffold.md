# S0 - Contract and scaffold

Phase 0. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 0 of sessiondeck. Read, in order: docs/planning/00-open-decisions.md, docs/planning/01-architecture.md (sections 3, 8, 9), docs/planning/phases/phase-0-contract.md, docs/planning/03-design-system.md (section 2 only, for the tokens file location).

Goal: a pnpm monorepo that builds and tests in CI on ubuntu and windows, with packages/contract implemented and unit-tested (envelope schema, state machine reducer, snapshot type, statusLine schema from ccstatusline's StatusJSON.ts), a scripts/capture-fixtures.mjs that registers on all 17 hook events plus statusLine and dumps raw payloads to packages/contract/fixtures/raw/<event>/, and .claude/agents/ populated from docs/agents/.

Work on branch p0/scaffold. Create a task list from the phase doc's Requirements (R0.1 to R0.7). Delegate implementation to sd-executor-contract in work units no larger than one package or one CI workflow each. After each unit, run sd-reviewer on the diff; when fixtures are produced, run sd-security-reviewer on them before any commit. Finish with sd-verifier executing every R0.x check and producing docs/VERIFY-P0.md with command and output per requirement.

Constraints: hooks in exec form on Windows must use "command": "node" with "args"; the capture hook must merge into ~/.claude/settings.json without touching existing hooks; nothing writes stdout from a hook. Do not finalize reduce() transition cases that depend on unverified payload fields; mark them with a TODO(fixture) and a failing-skipped test.

Stop and ask me if: any decision in 00-open-decisions.md looks wrong in practice, a license differs from the borrow map, or you need to push to main. End with: PR URL, DoD checklist with evidence, and the list of fixture events still missing so I can run S0b.
