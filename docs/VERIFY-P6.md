# Verify P6 (layouts)

Branch p6/layouts, HEAD 29fe34e. Verified 2026-10-27 by sd-verifier.

| Requirement | Command | Output excerpt | Result | Evidence |
|-------------|---------|----------------|--------|----------|
| R6.1 "All seven builtin presets render correctly at both test resolutions and survive reload." (unit part: spec golden round-trip, presets, store persistence) | `pnpm -F @sessiondeck/web test` | `Test Files 25 passed (25)`, `Tests 289 passed (289)`; includes layout/spec.test.ts 41, store/layout.test.ts 8, layout/ops.test.ts 3, LayoutView.test.tsx 4, routes/Layout.test.tsx 16 | pass | terminal output, 2026-10-27 16:26 UTC |
| R6.1 (browser part: 7 presets x 1440x900 and 2560x1440, plus keyboard menu and reload persistence) | `docker run --name sd-3-S10-verify-* --shm-size=1g -v sprint-3-work:/work -w /work/wt/S10/packages/web -e CI=1 -e SCREENS_DIR=/tmp/screens mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'node node_modules/@playwright/test/cli.js test R6.1'` (container removed afterward; mock build, VITE_MOCK=1, via playwright.config.ts webServer) | `Running 15 tests using 1 worker`, 14 preset/size tests plus `R6.1 menu is reachable by keyboard and a chosen preset survives reload`, `15 passed (41.0s)` | pass | /state/3/screens/S10/R6.1-<preset>-<w>x<h>.png (14 files, regenerated 16:27 UTC) |
| R6.1 visual review of the 14 PNGs | read each image | No zero-size panes, no overlapping chrome, every pane has its 28 px header. Flags below. | pass, with flags | same PNGs |
| R6.2 | - | - | pending | - |
| R6.3 | - | - | pending | - |
| R6.4 | - | - | pending | - |
| R6.5 | - | - | pending | - |
| R6.6 | - | - | pending | - |

## Visual flags for R6.1 (not covered by the spec's assertions)

- by-project (both sizes): cards are wider than their 180 px (1440) or 250 px (2560) columns and are clipped at the right edge; text such as the cost field and project name is cut off in most columns.
- solo (both sizes): the Board pane is a single short row of cards that overflows horizontally, so only 3 of 8 sessions are visible at 1440 and 5 at 2560. Intended behaviour for "1 content + strip" is not stated in the phase doc.

Screenshots: solo, pair, quad, focus, grid6, by-project, strip, each at 1440x900 and 2560x1440.
