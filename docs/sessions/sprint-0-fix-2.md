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
- [x] U3 fix round 1 (FIX-2): guard patch option and continuation backtracking, growth rows
- [x] U3 guard patch: repeated-anchor quadratic in guard.mjs, delivered as docs/patches/FIX-2-guard.patch with its timing rows (not applied; the user applies it, see docs/patches/README.md)

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

## Review round 3

- sd-reviewer verdict merge on cc53b60; CI cc53b60 push 39163412975 and pull_request 39163417212 green on all four jobs. Minors fixed here: ELU idle subtraction (the preload records the raw stdin window as `stdinWaitMs` and the event loop idle time inside it as `stdinIdleMs`; only the idle part is subtracted, so CPU in a stdin `data` handler counts; new `cpu-in-data` self-test), stdin delay 2500 ms with the 10 s self-test timeout, and the comment now names QUADRATIC_RUN (24k kept).

## U3 guard repeated-anchor patch

- Built in a temporary detached worktree on cc4302a (offline install), patch generated from it, worktree removed. `.claude/` in this worktree untouched; `git apply --check` passes.
- Same quadratic class as the HIGH finding, found while proving it and fixed in the same patch: `rm -` plus 100k `r` (6.3 s, rm rule), 100k `{` before `capture-install --apply` (the unquoted path prefix allowed `{`, which is also an anchor), and `node -x ` runs (the option chain, 1.4 s). The option chain is capped at 32 options, which is the only verdict change by design.
- Design choice: push rules keep one regex each (first `git push` per segment found in an atomic lookahead) so the exact call counts stay 8 and 9; the capture-install rule now makes 2 regex calls when it blocks, so the three existing blocked timing rows expect 9 instead of 8.
- Differential check: 3000 random fragment commands, old versus new guard, 0 differing exit codes.
- Residual, not fixed: a quoted node path whose prefix contains `;` and also contains the `--apply` flag inside the quotes could be matched differently by the segment skip. Contrived, not reachable by a plain command line.
- Not done here (no access to the user terminal): applying the patch, and a CI run on it. The user applies it to sprint/0-bootstrap, then CI must show the same four jobs green.

## U3 review round 1

- sd-security-reviewer on the patch: 2 HIGH, 4 LOW. Both HIGH reproduced and fixed in `docs/patches/FIX-2-guard.patch` (rebuilt in a temporary detached worktree on 839604d, removed afterwards; `.claude/` here untouched).
- HIGH 1 (option backtracking): `--?[\w.-]+` read `--a` two ways, so 33 options was 2^33 paths inside the new `OPTION{0,32}` lookahead, run at every node anchor before the `--apply` check. `node` plus `--a b` x33 then `; node scripts/capture-install.mjs --apply` was killed at 20 s with the first patch version (4000 ms in the test); the hook timeout counts as allow. Fixed with `-[\w.-]+`.
- Found while proving it: option values had the same kind of ambiguity (`-a x\<LF>`: value takes the backslash or SEP takes the backslash-newline). 24 options 0.4 s, 32 options 82 s, in the previous patch version and in the current guard. Fixed with a value class that excludes a backslash starting a backslash-newline.
- Honest note on the cross-segment row: on the current guard (839604d) that command is fast (the `--apply` lookahead fails first, 5 ms), so its RED is the call count only; the regression was in the first version of the patch. The one-segment shapes are the ones the current guard cannot survive.
- HIGH 2 (continuations): `SEGMENT_REST` tried `[^|;&\n]` first and stopped at the newline after a backslash, so every candidate rescanned the logical segment. Fixed with continuation first. Rows for LF and CRLF (99k: 650 ms and 601 ms on the current guard, 3 to 4 ms patched).
- LOW growth: header no longer claims linearity in general; each rule names the test row. New growth rows (N versus 4N, best of 3, ratio under 8, 5 ms floor) for `git push `, the continuation shape, `--x=node`, option count k=16 vs 64, backslash-value k=16 vs 64. Ratios 1.0 to 2.7. guard.test.ts 26 to 29 s, whole scripts suite 31 to 34 s on Windows (was 24 s).
- LOW accepted, listed as known gaps (rows in `guard-rules.test.ts`): more than 32 options before the script is allowed; `node capture-install "x;)/node" capture-install --apply` is allowed (blocked by the old guard only by luck).
- Fuzz old versus new: 6000 cases, 0 differing exit codes.

## U3 review round 2

- Commit A (test only, R0.5): the real critical path was `guard-rules.test.ts` (78 sequential `spawnSync` calls, 24.6 to 26.7 s inside the suite on the review run). `runGuard` is now an async `spawn` (`runGuardRaw` for raw stdin) and the blocked, allowed, false-positive and gap tables use `it.concurrent.each`; assertions unchanged. Measured after: guard-rules 13.6 to 15.2 s, guard.test.ts 11.8 to 13.5 s, whole scripts suite 15.0 to 18.4 s wall (3 runs).
- Timing rows no longer use best of 3. `firstWithinBounds` runs until the first attempt is within the match, script and wall bounds, at most 3. A status or call-count mismatch ends on the first attempt. The attempt count is in the evidence line. `guard-timing-helper.test.ts` proves: one attempt when in bounds, retry on a violation, fail after 3, no retry on a mismatch, plus the existing quadratic self-test still exceeding the bound.
- Found by running the patched suite while the laptop was loaded (70 percent CPU from Docker): a guard process killed at the 4000 ms wall limit threw out of the row on its first attempt. A wall-timeout kill (`GuardKilledError`) now counts as a bound violation and is retried; a guard that really hangs is killed on all 3 attempts and the row fails with the kill error. Other errors (spawn failure, missing timing file) are not retried.
- Commit B (patch `docs/patches/FIX-2-guard.patch` regenerated on 5da35f6 in a temporary detached worktree under `.sprint/tmp`, removed afterwards; `.claude/` here untouched). The growth rows moved to a new `scripts/test/guard-growth.test.ts` (own worker) with a new `scripts/test/helpers/guard-growth.ts`: ratio on `matchMs` with a 1 ms floor (workMs was noise: 41 to 61 ms while matchMs stayed 0.4 to 1.5 ms), 100k versus 400k characters (option shapes k=16 versus 64), the 150 and 300 ms limits on the 100k run only, first passing attempt of at most 3. Two new rows put `node` anchors inside the 32-option window as option values; on the current guard they are linear (ratios 0.64 and 0.96), so they are regression guards only. 7 growth shapes, 14 spawns; guard.test.ts spawns 17 without the patch and 35 with it (27 timing rows plus 8 self-test spawns).
- Numbers with the patch: scripts suite 20.7 to 23.2 s wall (3 runs, 601 passed, 3 skipped), `pnpm -r test` 27 s; the previous estimate was 41 to 51 s and the previous patch version measured 31 to 34 s; the Windows step budget is 60 s. Without the patch on the same commit: 16.5 to 19.4 s. README fixes: "two of the three rows" wording, the worktree path and `git branch --show-current`, the commit subject under 72 characters with a body, and an ordered copy-paste command list with every file added by path (two are new), never `commit -a`.

## Deferred findings

- [LOW, security] The rm rule allows `rm -Rf /`, `rm -r -f ~` and `rm --recursive --force ~`. Pre-existing, not touched by the patch. Track in a later unit.

- [LOW] Push rules are pattern based and bypassable: `git -C dir push -f`, `git push origin +feature`, `git push origin HEAD:refs/heads/main`. Pre-existing, not weakened by the patch. Track in a later unit.
