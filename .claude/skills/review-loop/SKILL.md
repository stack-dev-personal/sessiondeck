---
name: review-loop
description: The review and fix cycle between sd-reviewer (and sd-security-reviewer when the phase requires it) and the executor that produced a sessiondeck work unit. Use after every executor report, before verification.
---
# Review loop

Inputs: base ref, head ref, requirement IDs, executor boundary, phase doc path, and whether the unit is security-gated (S0b, S1, S3, S7, S11, S12, S13: yes).

1. Call sd-reviewer with exactly: `Review <base>..<head> for R<ids>. Boundary: <paths>. Phase doc: <path>.` Expect the findings block and a verdict line, nothing else.
2. If security-gated, call sd-security-reviewer in parallel with the same inputs. Expect the findings block and `Gate: pass | fail`.
3. Decide:
   - Verdict `merge` and gate `pass` (or n/a): done, go to `/verify-dod`.
   - Any BLOCKING, CRITICAL, or HIGH finding: send the full findings block to the same executor (SendMessage to its agent id) with `Fix these, in order, then report.` Do not paraphrase findings; reviewers write failure scenarios for a reason.
   - Only MAJOR, MEDIUM, MINOR, LOW: fix now if the executor is still cheap to reach; otherwise log them in `docs/sessions/<branch>.md` under "Deferred findings" with the file:line and move on.
4. After a fix, re-run step 1 on the new head. Count iterations.
5. Three iterations without reaching `merge`: stop. Report the last findings block to the user with your read on whether the unit's design is wrong (rework) or the executor is thrashing (re-delegate with a narrower unit).

Reviewers never edit. Executors never argue with a finding in prose; they fix it or show the test that proves it wrong.
