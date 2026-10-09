---
name: sprint-loop
description: The project-manager loop for one sessiondeck session (orchestrator). Use at the start of every development session after pasting the handoff prompt, and whenever the orchestrator is unsure what to do next.
---
# Sprint loop

You run this loop once per session. Each step has an exit condition; do not move on without it.

## 0. Intake (exit: task list exists)
1. Read the handoff's listed docs in order, then `docs/planning/00-open-decisions.md`.
2. `git fetch origin && git status && git log --oneline -5`. Create or check out the branch named in the handoff (`p<phase>/<slug>`). If `main` moved since the handoff's contract SHA, note it in the session log.
3. Create tasks with TaskCreate, one per work unit, each tagged with its requirement IDs. A work unit is one package, one route group, one component family, or one script: something an executor finishes in one context. Add `blockedBy` edges for real dependencies only.
4. Write `docs/sessions/<branch>.md` with: date, handoff name, contract SHA, task list, and an empty "Decisions made" section. Append to it as you go; it is the session log the user reads.

## 1. Delegate (exit: executor report received)
For each unblocked task, call the executor named in `.claude/agents/README.md` for the directory, with the delegation template from `/work-unit` (requirement IDs, allowed paths, borrow sources with license, proving test, report format). Run independent tasks in parallel. Never read large files yourself; ask for summaries.

## 2. Review (exit: reviewer verdict is merge or fix-then-merge with no BLOCKING findings)
Run `/review-loop` for the unit. Maximum three fix iterations; on the third failure, stop and report to the user with the findings.

## 3. Verify (exit: sd-verifier reports every requirement ID as pass)
Run `/verify-dod` with the unit's IDs. Partial is fail. A fail returns to step 1 with a new fix task.

## 4. Close the unit
Mark the task completed. Append to the session log: unit, files, verdict, evidence pointer, decisions made.

## 5. Close the session (exit: report sent)
1. All tasks completed or explicitly deferred with a reason in the log.
2. Commit on the branch with a message naming the requirement IDs. Push the branch (never main). Open a PR with the template filled.
3. Final report, in order: PR URL; DoD checklist from the phase doc with one evidence pointer per line; open questions; what the user must do before the next session (`04-session-map.md` section 4).

## Interrupts
- Context getting large (you have delegated five or more units, or you have read more than ten files): run `/session-handoff` and stop.
- Any stop-and-ask condition from `CLAUDE.md`: write the question and the options into the session log, tell the user, stop.
- Executor reports it needs changes outside its boundary: create a task for the owning executor; do not let the first executor cross the line.
