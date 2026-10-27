# VERIFY P5 (Atlas), S9 session-end verification

Branch p5/atlas-core, HEAD acd2556 (rebased on origin/sprint/3-organize 18a5871), clean tree. Run 2026-10-27 (20:18Z to 20:40Z). Node v22.23.3, Linux 6.18.33.2-microsoft-standard-WSL2 (WSL2), AMD Ryzen AI 9 465 (20 threads). R5.2 and R5.3 belong to S9b.

## Requirements

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R5.1 Every live session belongs to exactly one project; worktree sessions roll up to the repo project. | `pnpm -r test` (hub atlas.R5.1, atlas.fix1; web atlas.test.ts); mock Playwright `e2e/R5.1.spec.ts` in container sd-3-S9-final-pw-mock | hub 30 files / 419 tests pass; mock R5.1: 3 passed (worktree session under repo project, keyboard reassign + undo, light theme). Screens R5.1.png, R5.1-light.png exist | pass | 2026-10-27T20:30Z |
| R5.4 Search returns results in < 100 ms for your data size; palette navigates with keyboard only. | `pnpm -F @sessiondeck/hub test:bench`; `node packages/hub/scripts/bench-search.mjs`; mock `e2e/R5.4.spec.ts`; live `e2e-live.sh` (R5.4-live) | test:bench 1 passed, worst class p95 common-multi 22.97 ms. bench-search (n=400, 2000 sessions, 2336 docs): route p50 5.34 p95 17.57 max 25.59 ms; worst class p95 common-multi 39.53 ms; `PASS route p95 < 100 ms overall and per class`. Mock R5.4: 7 passed (keyboard-only). Live R5.4-live passed: hub tookMs max 1.18 ms, browser round trip median 12.1 ms max 14.9 ms, typed-to-results median 55.4 ms max 56.8 ms. Screens R5.4-palette, -results, -sessions, -live .png and latency JSONs exist | pass | 2026-10-27T20:40Z |
| R5.5 Phase labels are editable inline and survive hub restart. | mock `e2e/R5.5.spec.ts`; live R5.5-live (hub container restarted by the host poller) | Mock R5.5: 2 passed. Live R5.5-live: 1 passed (manual label survives hub restart and reload). R5.5-live.png viewed: row shows "Hardening 35641 manual" on the live project view. R5.5.png exists | pass | 2026-10-27T20:40Z |
| R5.6 Project view shows: live sessions, last 20 archived, totals (sessions, hours, cost from history), active branches. | web vitest ProjectView.test.tsx (13), hub atlas.R5.6; mock `e2e/R5.6.spec.ts` | Mock R5.6: 3 passed (dark, light, phases and projects list; axe none on all). R5.6-projects.png viewed: 8 projects, named, colored, session and live counts. R5.6.png and R5.6-light.png exist (dated 19:55, not regenerated: the mock container writes screenshots to its /tmp, not copied out; the spec passed again) | pass | 2026-10-27T20:30Z |
| R5.2, R5.3 | n/a | belong to S9b | S9b | n/a |

## Full suite (repo root)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline` | FAILED offline: `ERR_PNPM_NO_OFFLINE_META: Failed to resolve @csstools/css-color-parser in package mirror`. node_modules already present, nothing changed; all commands below ran fine against it |
| `pnpm -r test` | exit 0. contract 28 files, 1090 passed, 1 skipped; hub 30 files, 419 passed; probe 13 files, 332 passed, 1 skipped; scripts 18 passed + 1 skipped file, 324 passed, 3 skipped; web 30 files, 302 passed |
| `pnpm -r typecheck` | exit 0 (contract, hub, probe, scripts, web) |
| `pnpm -r lint` | exit 0 |

Skips (not failures): scripts/test/install-shortpath.test.ts (2 tests) is Windows-only (needs 8.3 short paths, `process.platform !== "win32"`); install-paths has 1 skip. Probe and contract 1 skip each. I did not trace these individually beyond the shortpath file. Probe Bun exe was not built here and no probe test failed.

## Sprint 3 integration check ("search < 100 ms on the fixture data; palette keyboard-only flow (Playwright)")

- Hub bench: worst class p95 22.97 ms (test:bench), 39.53 ms (bench-search); overall route p95 17.57 ms. Limit 100 ms: pass.
- Mock Playwright, all specs (container sd-3-S9-final-pw-mock, image mcr.microsoft.com/playwright:v1.63.0-noble, volume sprint-3-work holding this worktree at HEAD acd2556): 43 passed, 0 failed (R3.x, R5.1, R5.4, R5.5, R5.6).
- Live suite `SD_E2E_PREFIX=sd-3-S9-final SD_E2E_WORK_VOLUME=sprint-3-work packages/web/scripts/e2e-live.sh`, all live specs including R3.6 perf: 6 passed (R3.1 max 69 ms, R3.3, R3.6 0 long tasks and 0 failed posts, R3.9, R5.4-live, R5.5-live). Screens copied to /state/3/screens/S9/.
- Palette keyboard-only: R5.4 specs contain no click, hover or mouse calls (verified earlier by grep); 7 mock plus 1 live pass.

## Phase DoD

| Item | Result |
|---|---|
| docs/ATLAS.md explains how projects and phases are inferred and how to fix a mis-assignment | pass on content: sections on project key (project_dir, cwd, Unassigned; worktree path-shape roll-up rules), phase inference (manual, name, branch), "Fixing a mis-assignment" with curl for PATCH project, undo, rename/recolor, phase. Minor staleness: the last paragraph says the UI controls "land with the S9 web work" although the UI now exists |
| Real projects (bb2dash, quant-edge, agentic-harness, this one) appear named and colored with archives attached | needs laptop confirmation (needs the laptop and S9b archives) |

## Cleanup

All sd-3-S9-final* containers, network and image removed (docker ps, network ls, images checked: none left). Nothing committed.
