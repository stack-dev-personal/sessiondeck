# Session log: p0/sprint-auth (INFRA-1)

- Date: 2026-10-19 (conductor evidence dated 2026-10-20, Sprint 1 container)
- Handoff: conductor prompt for fix session INFRA-1 (PROMPT-BOOK.md section 7 mechanics, branch from main)
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4 (main at session start; unchanged)
- Requirement: R0.8 (sprint tooling)
- Cause: Claude Code removes CLAUDE_CODE_OAUTH_TOKEN by name from Bash tool subprocesses, so every nested `claude -p` in the sprint container exits "Not logged in".

## Tasks

- [ ] U1 (sd-executor-infra): entrypoint.sh exports SPRINT_CLAUDE_OAUTH_TOKEN mirror; claude-stub.sh records mirror equality; check-sprint-image.sh asserts it; README security note, Environment table, headless invocation, "Not verified" line, limits note on untrusted /work
- [ ] U2 (sd-executor-contract): PROMPT-BOOK.md section 2 launch prefix and stdin from /dev/null; sprint-image-static.test.ts checks; `pnpm -F @sessiondeck/scripts test:sprint`
- [ ] U3: container harness run (check-sprint-image.sh, evidence under .sprint/0/screens/INFRA-1)
- [ ] U4: sd-reviewer and sd-security-reviewer, one fix round at most
- [ ] U5: sd-verifier adds R0.8 rows to docs/VERIFY-P0.md
- [ ] U6: commit, push p0/sprint-auth, PR to main, CI green

## Decisions made

- Decision 22 (.sprint/0/answers/decisions.md): user chose option A, an infra fix session; option B (/proc read) ruled out.
- .claude/agents/sd-sprint-orchestrator.md and docs/PERMISSIONS.md do not state the launch command or the token flow (the agent file points to PROMPT-BOOK.md section 2; PERMISSIONS.md covers settings deny rules only), so neither is changed.

## Units
