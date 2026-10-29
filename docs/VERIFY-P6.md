# Verify P6 (layouts)

Final run for session S10. Branch p6/layouts, HEAD 955d182 (rebased on origin/sprint/3-organize 7c5f3d4). Run 2026-10-29 14:34 to 14:45 UTC by sd-verifier.

Host: Linux 6.18.33.2-microsoft-standard-WSL2 (WSL2, Debian 12 container), AMD Ryzen AI 9 465 (20 logical CPUs), node v22.23.3, load average about 5.2 during the run (shared with other sprints). Playwright image mcr.microsoft.com/playwright:v1.63.0-noble. Test containers sd-3-S10-verify-* were removed afterwards (`docker ps -a | grep S10` is empty).

Result: 5 pass / 0 fail / 1 needs quiet-host confirmation (R6.4).

## Requirements

| ID | Requirement (phase doc) | Command | Key output | Verdict | Evidence |
|----|-------------------------|---------|------------|---------|----------|
| R6.1 | "All seven builtin presets render correctly at both test resolutions and survive reload." | web unit: `pnpm -r test`; mock e2e (see Playwright below) specs R6.1 | unit: `Test Files 46 passed (46)`, `Tests 589 passed (589)` (web). e2e: 14 preset/size tests plus `R6.1 menu is reachable by keyboard and a chosen preset survives reload`, all passed; whole mock suite `78 passed, 1 skipped` | pass | 14 PNGs `/state/3/screens/S10/R6.1-<preset>-<w>x<h>.png`, regenerated 14:36 to 14:38 UTC by this run |
| R6.2 | "Auto-fit picks the expected preset for 1-6 live sessions (table-driven test)." | `npx vitest run src/layout/autofit.test.ts` (inside the full run); e2e R6.2 | `autoFit by count (R6.2)`: 0 live -> strip, 1 -> solo, 2 -> pair, 3 -> focus, 4 -> quad, 5, 6, 7, 8 -> grid6, all passed (15 tests in file). e2e `R6.2 0..8 live` and by-project and reload cases passed | pass | `packages/web/src/layout/autofit.test.ts`, `/state/3/screens/S10/R6.2-autofit-{0..8}.png` |
| R6.3 | "Saved layouts persist in the hub, switch in < 100 ms, hotkeys 1-9 work." | `pnpm -r test` (hub 440, web 589); mock e2e R6.3; live `SD_E2E_PREFIX=sd-3-S10-verify SD_E2E_WORK_VOLUME=sprint-3-work SD_E2E_SCREENS_OUT=<dir> SD_E2E_SKIP_PERF=1 SD_E2E_ARGS="R3.1 R3.3 R3.9 R5.4-live R5.5-live R6.3" packages/web/scripts/e2e-live.sh` | mock: `R6.3 switch ms: n=15 max=23 p95=23 mean=17.8 first_after_reload=25`. live (real hub image): `R6.3 switch ms-live: n=15 max=21.9 p95=21.9 mean=12.6 first_after_reload=18.9`; `6 passed, 4 skipped` (the 4 are the mock-only describes) | pass | `/state/3/screens/S10/R6.3-saved-{1,2,3}[-live].png`, `R6.3-timing*.json` (limit 100 ms) |
| R6.4 | (frame-rate requirement: six panes at 20 deltas/s, 0 dropped frames) | NOT RUN, per the user's decision (answer A, `/state/3/answers/S10.md`). Gate unchanged. | See "R6.4: needs quiet-host confirmation" below | needs quiet-host confirmation (not pass, not fail) | unit tests below; `/state/3/screens/S10-gate3b/R6.4-trace-summary-mock.json` |
| R6.5 | "`Shift+C` compacts all panes; `Shift+C` again restores the previous layout exactly." | `npx vitest run src/store/layout.test.ts` (inside the full run); e2e R6.5 | `Shift+C compact all (R6.5) > compacts every pane, then restores the previous spec exactly (deep-equal)` passed, plus 7 sibling tests (reload, manual expand, resize, layout switch). e2e `R6.5 Shift+C compacts all panes, Shift+C restores the layout exactly`, `the restore is exact across a reload between the two presses`, `a manual expand keeps the restore...` passed | pass | `/state/3/screens/S10/R6.5-{compacted,restored,restored-after-reload}.png` |
| R6.6 | "Drag-assign and keyboard-assign both work; a session can appear in at most one content pane." | web unit (ops.test.ts, layout.test.ts, Layout.assign.test.tsx) in the full run; e2e R6.6 | unit: `never puts a session in two panes`, `one session in at most one pane, whatever the source (R6.6)` passed. e2e `drag a card onto pane 2, then the same session onto pane 3` and `keyboard only: Tab to a pane, Enter, filter, Enter` passed | pass | `/state/3/screens/S10/R6.6-{drag,keyboard,invariant}.png` |

## R6.4: needs quiet-host confirmation

Not a pass and not a fail. Per the user's decision (answer A) the trace gate was not run and not changed. Evidence short of the gate:

- Unit tests, this run, `npx vitest run src/routes/Layout.render.test.tsx src/store/activity.test.ts` (4 files with the layout store and autofit tests: `Test Files 4 passed (4)`, `Tests 50 passed (50)`):
  - `Layout re-renders (R6.4) > deltas that reorder the projects do not re-render the layout route` passed
  - `... > with six filled panes a delta commits only the pane that owns it` passed
  - `... > the hidden-project note appears when a live project has no column`, `... > a project that arrives after mount updates the hidden count; plain deltas do not re-render` passed
  - `src/store/activity.test.ts` (9 tests, ring buffer cap, one `set()` per frame) passed
- Latest gate evidence, `/state/3/screens/S10-gate3b/R6.4-trace-summary-mock.json` (written 2026-10-29 01:22 UTC, host load 5.7): board-20 app-attributed drops per board window 15 (w2), 6 (w3), 0, 0; previously 115 to 146. That run's gate verdict was still `pass: false` (window 2: 15 app drops, 1 long task, a non-app gap of 2.16 vsyncs vs limit 2.1; window 3: 6 app drops; non-app drops board 22 > control 5 + 1). Reviewer opinion in `docs/sessions/p6-layouts.md`: host CPU steal plus seed-fill GC, not steady-state app cost. Not proven.
- Confirmation command, to run on an idle host (other sprints stopped):

```
pnpm --filter web exec playwright test e2e/R6.4.spec.ts
```

Process note: my first live run (`e2e-live.sh` without `SD_E2E_ARGS`) also executed the R6.4 live spec before I noticed that script includes it (`BOTH_SPECS` in playwright.config.ts). It failed (window 2: 5, window 3: 12, window 6: 9, window 7: 13 app-attributed drops; non-app gap 6.83 vsyncs) on this loaded host. That run's outputs went to a /tmp directory, not to /state, and are not used as evidence; the live suite was rerun with R6.4 excluded (above).

## Suite counts

| Command | Result |
|---------|--------|
| `pnpm -r test` | exit 0. contract 28 files, 1090 passed, 1 skipped. hub 31 files, 440 passed. probe 13 files, 332 passed, 1 skipped. scripts 27 files (1 skipped), 535 passed, 3 skipped. web 46 files, 589 passed |
| `pnpm -r typecheck` | exit 0 (contract, probe, hub, web, scripts) |
| `pnpm -r lint` | exit 0 (contract, probe, hub, web, scripts) |
| Playwright, mock mode, all specs except R6.4: `docker run --name sd-3-S10-verify-mock --shm-size=1g -v sprint-3-work:/work -w /work/wt/S10/packages/web -e CI=1 -e HOME=/root -e SCREENS_DIR=/tmp/screens mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'node node_modules/@playwright/test/cli.js test e2e/R3.1.spec.ts ... e2e/R6.6.spec.ts'` (every e2e/*.spec.ts but R6.4) | exit 0. `78 passed (1.8m)`, 1 skipped (R6.3 real-hub describe; live-only specs are in testIgnore in mock mode). Screens copied out with `docker cp`, container removed |
| Live, `e2e-live.sh` with `SD_E2E_SKIP_PERF=1` and the six non-R6.4 live specs | exit 0. `6 passed`, 4 skipped. R3.1 max 116 ms; R3.3, R3.9, R5.4-live (warm typed-to-results median 61.6 ms), R5.5-live, R6.3 live passed. R3.6 (perf) skipped by SD_E2E_SKIP_PERF=1, not run |

## Sprint integration checks for S10

| Check | Result |
|-------|--------|
| Seven presets at 1440x900 and 2560x1440 | pass. 14 R6.1 PNGs exist in `/state/3/screens/S10/`; they were written by this run's R6.1 tests (generated 14:36 to 14:38 UTC, after run start 14:36:18Z) and copied into place at 14:38 UTC. Visual flags from the earlier run (by-project clipped cards, solo overflow) were not re-reviewed by eye this run |
| Auto-fit table test | `src/layout/autofit.test.ts` > `autoFit by count (R6.2)` (it.each over 0..8 live): passed, 9 table rows plus 6 other tests, 15 of 15. e2e `R6.2 N live -> preset` for N = 0..8: passed |
| Shift+C restore exact | `src/store/layout.test.ts` > `Shift+C compact all (R6.5) > compacts every pane, then restores the previous spec exactly (deep-equal)`: passed. e2e `R6.5 Shift+C compacts all panes, Shift+C restores the layout exactly`: passed |

## Definition of done (phase-6-layouts.md)

| Item | Status | Evidence |
|------|--------|----------|
| All R6.x pass; preset screenshots in `docs/LAYOUTS.md` | PARTIAL: R6.1, R6.2, R6.3, R6.5, R6.6 pass; R6.4 needs quiet-host confirmation, so "All R6.x pass" stays open. Preset screenshots MET: commit 4c9dd12 added 7 PNGs (solo, pair, quad, focus, grid6, by-project, strip), each a valid 1440x900 PNG, and the Gallery in `docs/LAYOUTS.md` links all 7 and every link resolves (checked 2026-10-29) | `docs/LAYOUTS.md` section "Gallery"; `docs/images/layouts/R6.1-<preset>-1440x900.png` |
| You use a saved layout for a real multi-project evening and record what was missing in `docs/BOARD-FEEDBACK.md` | NOT MET: user task. The Phase 6 section 6 of the file is still "(fill in)" | `docs/BOARD-FEEDBACK.md` lines 95 to 96 |
| `sd-reviewer` sign-off | MET for code (merge verdicts after the three U5 iterations, U6a and the final U6 review, with sd-security-reviewer gate pass); the sign-off does not cover the R6.4 gate, which stays open | `docs/sessions/p6-layouts.md` (U5 iteration 3, U6a, U6 review entries) |

## Previous runs

- 2026-10-27, HEAD b21e533, sd-verifier: R6.1 (15 e2e tests, 14 PNGs), R6.2, R6.3 (mock max 23, 23, 33 ms over 3 runs; live max 24 ms), R6.5, R6.6 passed; R6.4 pending. Web unit 447 passed then. Visual flags recorded then: by-project cards wider than their columns (clipped at the right edge), solo Board pane overflows horizontally with only 3 of 8 (1440) or 5 of 8 (2560) cards visible, R6.5 shots show only unassigned panes (compaction of populated panes covered by unit tests only), R6.2 focus right-hand cards touch the pane edge.
- 2026-10-29 01:22 UTC, gate run `S10-gate3b`: R6.4 board-20 failed with the app-attributed drop counts above.
