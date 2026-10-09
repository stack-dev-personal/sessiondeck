---
name: session-handoff
description: Write or resume a mid-phase handoff for sessiondeck when a session's context is getting large or the user wants to stop. Use when the orchestrator has delegated five or more units, read more than ten files, or is told to wrap up; and at the start of a session that resumes from docs/HANDOFF-*.md.
---
# Session handoff

## Writing one (stop here afterwards)
Write `docs/HANDOFF-<branch>.md`:

```
# Handoff <branch> <date>
Contract SHA: <sha>
Phase doc: <path>   Session: S<n>   Handoff file: docs/handoffs/<file>

## Done (with evidence pointers)
- <unit>: merged into branch at <commit>, VERIFY rows R..

## In progress
- <unit>: executor <agent id if still alive>, last report summary, what remains

## Next
- <ordered list of remaining tasks with requirement IDs>

## Decisions made this session
- <decision>: <why>; affects <doc>

## Open questions for the user
- ...

## Resume commands
git fetch origin && git checkout <branch> && git log --oneline -5
pnpm install && pnpm -r test
```

Commit it on the branch. Final message to the user: the file path, one line on state, and `start a fresh session with: claude --agent sd-orchestrator, then paste docs/handoffs/<file> and say "resume from docs/HANDOFF-<branch>.md"`.

## Resuming from one
1. Read the HANDOFF file first, then the handoff prompt's docs only as needed.
2. Run the resume commands. If tests fail on a clean checkout, that is the first task.
3. Recreate the task list from "In progress" and "Next" with TaskCreate. Do not redo "Done" units; trust the evidence pointers, spot-check one.
4. Continue `/sprint-loop` from step 1.
5. When the phase closes, delete the HANDOFF file in the same PR (it is a bookmark, not a record; the session log and VERIFY files are the record).
