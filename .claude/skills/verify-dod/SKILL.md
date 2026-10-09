---
name: verify-dod
description: How sessiondeck requirements are verified with evidence by sd-verifier and recorded in docs/VERIFY-P<phase>.md, and how the orchestrator closes a phase against its Definition of Done. Use before marking any task complete and at the end of every session.
---
# Verify against the Definition of Done

## Per unit (orchestrator → sd-verifier)
Call sd-verifier with: `Verify R<ids> on branch <name>. Phase doc: <path>.` It runs the proving command for each ID, records command, key output, pass/fail, timestamp in `docs/VERIFY-P<phase>.md`, and returns the table plus `N pass / M fail / K unverifiable`.

- `fail`: create a fix task for the owning executor with the verifier's output attached. The unit is not done.
- `unverifiable`: the requirement has no runnable proof in the repo. Either the unit was supposed to add one (fix task) or the requirement is a manual check (log it in the session log as "manual, pending user" and tell the user at close).

## Per phase (orchestrator, at the end of the last session of a phase)
1. Open the phase doc's Definition of Done. For each checkbox, find the evidence: a VERIFY table row, a doc file, a bench file, a reviewer verdict in the session log, or a user confirmation.
2. Items that need the user (install for two days, use the board for three days, confirm the box host) are listed under "What the user must do" in the final report, not ticked.
3. Tick only what has evidence. Copy the checklist with evidence pointers into the PR description.
4. Benches: numbers go to `docs/<PACKAGE>-BENCH.md` with machine description and command; a bench without the command that produced it is not evidence.

## What counts as evidence
- Test output with counts, from this branch, today.
- A harness script's output with the threshold stated and met.
- A reviewer's verdict line from this session.
- A file that exists in the repo at the path the DoD names.
Not evidence: "implemented", "should work", a description of the code, output from another branch.
