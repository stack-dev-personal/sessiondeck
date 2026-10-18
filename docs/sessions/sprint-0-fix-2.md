# Session log: FIX-2 (sprint/0-bootstrap)

- Date: 2026-10-18
- Handoff: FIX-2 integration gate fix: guard timing tests on Windows CI
- Contract SHA: fc0d1d87ec05e8fedbc9df51e0be139571236873
- Base: 97cd63a

## Tasks

- [x] U1 test fix: guard timing tests measure regex matching, not node start (R0.5; guard rows in docs/VERIFY-P0.md)
- [x] U1 fix round 1 (FIX-2): tighten timing tests after review
- [ ] U2 CI evidence and verify
- [ ] U3 guard patch: repeated-anchor quadratic in guard.mjs, delivered as docs/patches/FIX-2-guard.patch with its timing rows

## Decisions made

- Approach A, chosen with sd-reviewer: instrument `RegExp.prototype.exec` in the child process through a preload (`scripts/test/helpers/regexp-timing-preload.mjs`). Every regex call (`test`, `match`, `replace`, `search`, `split`) goes through `exec`, so one wrapper counts all of them once. The bounds are 150 ms of matching time at 100k-character input (lowest of 3 runs) and 4000 ms of whole-process wall time, which is tied to the real 5 s hook timeout.
- Approaches B (subtract a baseline spawn) and C (ratio of a long input to a short one) were rejected: both still measure process start noise.
- The call count is asserted (at least 8, or 9 for bare `git push`) so a refactor that bypasses the wrapper cannot pass with 0 ms.
- A self-test runs a known quadratic regex through the same helper and must exceed the bound; a linear control must not.

## Review round 1

- sd-reviewer: fix then merge. Fixed in U1 round 1: the comparison spawn is gone and each timing row has a fixed expected exit status (three blocked `node ... capture-install --apply` rows, bare `git push` rows derived from one `git rev-parse --abbrev-ref HEAD`); call counts are exact; a timeout kill now throws `guard killed after 4000 ms wall` instead of blaming the timing file; the timing tests use async spawns only, so they stay `it.concurrent`.
- sd-security-reviewer: gate fail. HIGH: repeated-anchor inputs are quadratic in guard.mjs; addressed by patch unit U3 (the rows land with the patch, not here). MEDIUM: only regex time was bounded; added `scriptMs` (preload end to exit) with `MAX_SCRIPT_MS` 300 at 100k input. The guard's `execSync` (git rev-parse) is wrapped in the preload, recorded as `execMs`, and subtracted; `syncBuiltinESMExports()` makes the wrapper visible to guard.mjs's named import, asserted by `execCalls` (1 on bare git push rows, 0 elsewhere).

## Deferred findings

