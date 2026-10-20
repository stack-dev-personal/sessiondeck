# Session log: p0/sprint-auth (INFRA-1)

- Date: 2026-10-19 (conductor evidence dated 2026-10-20, Sprint 1 container)
- Handoff: conductor prompt for fix session INFRA-1 (PROMPT-BOOK.md section 7 mechanics, branch from main)
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4 (main at session start; unchanged)
- Requirement: R0.8 (sprint tooling)
- Cause: Claude Code removes CLAUDE_CODE_OAUTH_TOKEN by name from Bash tool subprocesses, so every nested `claude -p` in the sprint container exits "Not logged in".

## Tasks

- [x] U1 (sd-executor-infra): entrypoint.sh exports SPRINT_CLAUDE_OAUTH_TOKEN mirror; claude-stub.sh records mirror equality; check-sprint-image.sh asserts it; README security note, Environment table, headless invocation, "Not verified" line, limits note on untrusted /work
- [x] U2 (sd-executor-contract): PROMPT-BOOK.md section 2 launch prefix and stdin from /dev/null; sprint-image-static.test.ts checks; `pnpm -F @sessiondeck/scripts test:sprint`
- [x] U3: container harness run (check-sprint-image.sh, evidence under .sprint/0/screens/INFRA-1)
- [x] U4: sd-reviewer and sd-security-reviewer, one fix round at most
- [ ] U5: sd-verifier adds R0.8 rows to docs/VERIFY-P0.md
- [ ] U6: commit, push p0/sprint-auth, PR to main, CI green

## Decisions made

- Decision 22 (.sprint/0/answers/decisions.md): user chose option A, an infra fix session; option B (/proc read) ruled out.
- .claude/agents/sd-sprint-orchestrator.md and docs/PERMISSIONS.md do not state the launch command or the token flow (the agent file points to PROMPT-BOOK.md section 2; PERMISSIONS.md covers settings deny rules only), so neither is changed.

## Units

- U1 (sd-executor-infra), 8099d67: entrypoint.sh exports SPRINT_CLAUDE_OAUTH_TOKEN after the token checks; stub writes mirror-token=equal|differs|missing; harness asserts equal; README notes. bash -n OK, test:sprint 279/279.
- U2 (sd-executor-contract), d6e8efd: PROMPT-BOOK.md section 2 launch prefixed and stdin from /dev/null; 4 static tests (RED 1 fail, GREEN 283/283); typecheck and lint clean.
- U3 harness on d6e8efd: bash infra/sprint/test/check-sprint-image.sh .sprint/0/screens/INFRA-1 --i-have-the-go, "result: 0 failure(s)", exit 0; mirror check PASS on both runs; evidence .sprint/0/screens/INFRA-1/u2-container-check.txt. entrypoint.sh and check-sprint-image.sh unchanged after it (git diff d6e8efd..HEAD empty for them); the stub changed in comments only.
- U4 review: sd-reviewer fix-then-merge (MAJOR: level-2 tee log is unredacted and would receive the mirror; MINOR x2). sd-security-reviewer Gate: pass (MEDIUM same finding, corrected fix: shell-prefix assignment then env -u, so the value never reaches argv; LOW x4). One fix round: 2262401 (env -u in the launch, mirror in TOKEN_NAMES, unconditional-export test; 284/284) and 2f9ceae (README limits, unverified guard wording, stub header).

## Deferred findings

- infra/sprint/test/claude-stub.sh header says "yes/no verdict"; the stub records equal, differs or missing. Comment wording only (one fix round used).
- scripts/test/sprint-image-static.test.ts: the precheck not.toContain assertion is vacuous (precheck accepts SPRINT_* by pattern); the new unconditional-export test covers the intent. Left in place.
- Security LOW, accepted residual risk: level 1 Bash holds the mirror; recorded in infra/sprint/README.md. Optional: env -u for level-1 gate commands (PROMPT-BOOK.md section 3).
- Security follow-up: ship redact_stream as an image script and pipe level-2 output through it before tee.
- Security LOW: deny rules and guard.mjs never exercised in the container (/work untrusted, stub claude). Check at the Sprint 1 relaunch with one blocked guard command. Trust pre-acceptance not applied (security reviewer advised against).

## Decisions made (review round)

- The launch command gained env -u SPRINT_CLAUDE_OAUTH_TOKEN between the prefix assignment and claude -p (both reviewers; form per the security reviewer). The rest of the command is unchanged.
