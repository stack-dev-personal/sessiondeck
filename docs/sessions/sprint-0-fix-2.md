# Session log: FIX-2 (sprint/0-bootstrap)

- Date: 2026-10-18
- Handoff: FIX-2 integration gate fix: guard timing tests on Windows CI
- Contract SHA: fc0d1d87ec05e8fedbc9df51e0be139571236873
- Base: 97cd63a

## Tasks

- [x] U1 test fix: guard timing tests measure regex matching, not node start (R0.5; guard rows in docs/VERIFY-P0.md)
- [x] U1 fix round 1 (FIX-2): tighten timing tests after review
- [x] U1 fix round 2 (FIX-2): Linux self-kill, stdin wait, self-test size, file split
- [ ] U2 CI evidence and verify
- [ ] U3 guard patch: repeated-anchor quadratic in guard.mjs, delivered as docs/patches/FIX-2-guard.patch with its timing rows

## Decisions made

- Approach A, chosen with sd-reviewer: instrument `RegExp.prototype.exec` in the child process through a preload (`scripts/test/helpers/regexp-timing-preload.mjs`). Every regex call (`test`, `match`, `replace`, `search`, `split`) goes through `exec`, so one wrapper counts all of them once. The bounds are 150 ms of matching time at 100k-character input (lowest of 3 runs) and 4000 ms of whole-process wall time, which is tied to the real 5 s hook timeout.
- Approaches B (subtract a baseline spawn) and C (ratio of a long input to a short one) were rejected: both still measure process start noise.
- The call count is asserted (exact: 8, or 9 for bare `git push` and the quotes row) so a refactor that bypasses the wrapper cannot pass with 0 ms.
- A self-test runs a known quadratic regex through the same helper and must exceed the bound; a linear control must not.

## Review round 1

- sd-reviewer: fix then merge. Fixed in U1 round 1: the comparison spawn is gone and each timing row has a fixed expected exit status (three blocked `node ... capture-install --apply` rows, bare `git push` rows derived from one `git rev-parse --abbrev-ref HEAD`); call counts are exact; a timeout kill now throws `guard killed after 4000 ms wall` instead of blaming the timing file; the timing tests use async spawns only, so they stay `it.concurrent`.
- sd-security-reviewer: gate fail. HIGH: repeated-anchor inputs are quadratic in guard.mjs; addressed by patch unit U3 (the rows land with the patch, not here). MEDIUM: only regex time was bounded; added `scriptMs` (preload end to exit) with `MAX_SCRIPT_MS` 300 at 100k input. The guard's `execSync` (git rev-parse) is wrapped in the preload, recorded as `execMs`, and subtracted; `syncBuiltinESMExports()` makes the wrapper visible to guard.mjs's named import, asserted by `execCalls` (1 on bare git push rows, 0 elsewhere).

## Review round 2

- sd-reviewer: fix then merge. BLOCKING: `runTimed` treated any kill signal as a timeout, so the `skip-exit-handlers` self-kill (SIGKILL, reported as a signal on Linux) failed CI on ubuntu node 22 and 24. Now a timeout is reported only when the helper own timeout fired (`child.killed` or wall >= timeout); any other signal falls through to the timing file check.
- MAJOR: `scriptMs` included the stdin wait, which the parent controls (spawn blocks its event loop 80 to 114 ms per child). The preload records `stdinWaitMs` (preload end to stdin `end`, `end` listener only) and tests bound `scriptMs - stdinWaitMs - execMs`; a missing `end` is an error, never 0. A self-test delays stdin by 1200 ms to prove the subtraction. The fixture now reads stdin through the stream so `end` fires.
- MAJOR: self-test `QUADRATIC_RUN` 30k down to 24k, and the self-test runs get a 10 s timeout option, so a slow runner cannot turn the regex into a kill.
- MINOR: the `hang` case uses a 500 ms timeout; functional rows moved to `scripts/test/guard-rules.test.ts` (assertions unchanged) so the timing file runs in its own worker; `windowsHide` added to the fixture `execSync`.
- Timing table is `timingInputs` in `scripts/test/guard.test.ts`; U3 adds its repeated-anchor rows there.

## Deferred findings
