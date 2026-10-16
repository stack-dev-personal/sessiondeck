# Session log: FIX-1 (sprint/0-bootstrap)

- Date: 2026-10-16
- Handoff: conductor fix-session prompt (PROMPT-BOOK.md section 7), scope "integration gate failure: pnpm -r test on ubuntu and windows CI; the Windows job exceeds the R0.5 60 s budget"
- Evidence read: .sprint/0/gate/ci-242b630.txt, .sprint/0/gate/README.md
- Contract SHA: fc0d1d87ec05e8fedbc9df51e0be139571236873 (sprint branch head at start: 242b630)

## Baseline (before)

Laptop (Windows 11), `pnpm -r test` wall 18 s; contract Duration 11.7 s (1048 tests), scripts Duration 16.4 s (421 tests).
Slowest files on the laptop: scripts capture-fixtures 10.9 s, capture-install 10.3 s, capture-hardening 7.7 s, fixture-tools 6.3 s,
install-deploy 6.0 s, install-recognition 5.8 s, install-guards 5.4 s; contract state-file-cli 2.2 s, state-file-cli-merge 2.2 s.
envelope-walk (176 fixtures) 0.10 s, state-golden 0.07 s: the fixture walks are not the cost.

Windows CI (vitest Duration per package; both packages run concurrently in one step):

| Job | contract | scripts |
|---|---|---|
| 116826601339 (242b630 rerun, node 24) | 30.5 s | 35.8 s |
| 116824231657 (PR #3, node 24) | 32.6 s | 39.8 s |
| 116824231720 (PR #3, node 22) | 33.9 s | 44.6 s |
| 116824361289 (PR #3, node 24) | 28.2 s | 34.7 s |
| 116824361312 (PR #3, node 22) | 30.5 s | 39.0 s |

Reading: scripts is the long pole (real node process spawns per test); contract carries v8 coverage and CLI spawn tests.
The failed attempt (contract 42.6 s, scripts past 60 s) is the same shape under a slower runner.

## Tasks

- [x] U1 scripts: cut per-test process spawns in the default (R0.5) run, keep one real-spawn smoke per entry script (R0.5; keeps R0.7)
- [x] U2 per-file worker overhead: contract threads + isolate:false, scripts maxWorkers (R0.5; keeps R0.1-R0.4, coverage DoD)
- [x] U4 contract CLI spawn-test timeout under load (R0.5; found by sd-verifier)
- [x] U3 CI proof: push, record Windows R0.5 step times in .sprint/0/gate/fix-1-ci.txt

## Units

### U1 scripts (sd-executor-contract)
- Commits: 565ab0d (in-process hook/install calls, overlapped spawns, pool threads), 7237cd5 (review round 1: console spies, static no-print test, 16-way real-process concurrency, win32 junction and lowercased-path entry tests, spawned env pass-through, maxWorkers min(12, cores-1)).
- Laptop: scripts Duration 12.3-12.7 s -> 7.0-7.3 s; tests 421 -> 445 (442 pass, 3 skipped); `pnpm -r test` wall 14.0-14.2 s -> 12.2 s. test:sprint 279 pass; fixture:leak PASS.
- Bite check: console.error in lib/capture-paths.mjs fails 8 tests (reverted).
- Review: round 1 fix-then-merge (1 MAJOR, 3 MINOR, all fixed); round 2 merge (1 MINOR deferred).
- Security review: not run; leak-check and scrub scripts untouched (fixture-leak.test.ts and fixture-tools.test.ts only overlap existing spawns with Promise.all).
- Verification: deferred to one sd-verifier pass after CI (R0.5 proof is the Windows CI step time).

### CI after U1 (run 38861070251, 4399140)
- Green 4/4, but Windows scripts Duration still 29.9-39.4 s. The CI log showed files finishing 0.6-1.5 s apart even for 10-50 ms test files: per-file worker start-up and module loading on a 4-vCPU runner, not test bodies.
- Local stand-in found: `pnpm -r test` pinned to 4 cores (`start /affinity F`) gave 17.3 s, matching about 39 s on CI.

### U2 per-file worker overhead (sd-executor-contract)
- Commits: 1ec6e2c (contract pool threads + isolate:false; scripts maxWorkers min(12, 2 x cores)), 77b493e (review fixes: isolate-guard.test.ts fails on vi.mock/spyOn/stub/fake timers/process.env/chdir in contract tests; wider fd-write patterns in capture-silence.test.ts; both bite-checked).
- 4-core stand-in 17.4 s -> 12.8 s; contract alone 11.9 s -> 3 s; contract 1091 tests (1048 + 43 guard), scripts 467 (464 pass, 3 skipped). Six shuffle seeds pass.
- Tried and dropped: scripts projects split into isolated/non-isolated groups (no gain), contract maxWorkers 2 (noise), scripts maxWorkers at cores (slower).
- Review: merge, 2 MINOR fixed in 77b493e. CI run 38864512395 (1ec6e2c): Windows R0.5 step 24 s and 32 s. CI run 38864962895 (77b493e): 26 s and 31 s.

### Verification round 1 (a14be2b)
- R0.1-R0.4, R0.7 pass; R0.5 fail: 1 of 5 local `pnpm -r test` runs timed out (5 s default) in contract state-file-cli.test.ts (4 spawnSync calls, worker thread blocked).

### U4 spawn-test timeout (sd-executor-contract)
- Commit 543aa73: async execFile with windowsHide, lifecycle test spawns init and read only (merges in process via runCli), 30 s per-test timeout on spawn tests only; same in state-file-cli-merge.test.ts.
- 20/20 local `pnpm -r test` runs green; 4-core stand-in 13.5 s (same-session baseline) -> 13.9 s median, within noise.
- Review: merge, 2 MINOR deferred.

### Final proof
- CI run 38867610820 at 543aa73: 4/4 success; R0.5 step windows node 24 21 s, windows node 22 28 s, ubuntu 11 s and 16 s. Recorded in .sprint/0/gate/fix-1-ci.txt.
- sd-verifier 514e542: R0.5 (CI and 10/10 local runs, median 11.3 s), R0.1-R0.4 pass; 6 pass / 0 fail. R0.7 pass at a14be2b (scripts unchanged since).

## Decisions made

- Root cause differed from the evidence file reading: the 176 fixture walks take 0.1-0.2 s; the cost was per-test node spawns (scripts) and per-file worker start-up on 4 vCPU (both packages). No suite was moved out of the R0.5 step (lever 2 not used); the 60 s budget was not changed.
- Local stand-in targets (7 s scripts, 11 s and 13.5 s 4-core wall) were mine, not requirements; misses accepted because the CI target (40 s or less on Windows) is met with 12-19 s headroom.
- The executor-local cap of 7 s for scripts was my stand-in, not a requirement; 7.0-7.3 s accepted (from 12.5 s) since the target is the Windows CI step at 40 s or less.
- Contract coverage costs nothing measurable locally (Duration 4.7-5.1 s with and without); pushed U1 first to measure CI before deciding on the contract unit.

## Deferred findings

- [MINOR] scripts/test/capture-silence.test.ts:13 (and :19-21; helpers.ts:117-118): static no-print patterns miss direct fd writes (`writeSync(1|2, ...)`, `process.stdout.fd`). Add those two patterns over DEPLOY_FILES. Not a live bug; capture lib has no such calls.
