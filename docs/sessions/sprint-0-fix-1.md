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

- [ ] U1 scripts: cut per-test process spawns in the default (R0.5) run, keep one real-spawn smoke per entry script (R0.5; keeps R0.7)
- [ ] U2 contract: cut CLI spawn tests and coverage overhead (R0.5; keeps R0.1-R0.4, coverage DoD)
- [ ] U3 CI proof: push, record Windows R0.5 step times in .sprint/0/gate/fix-1-ci.txt

## Units

## Decisions made

## Deferred findings
