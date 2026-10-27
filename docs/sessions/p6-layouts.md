# Session log: p6/layouts (S10, Phase 6 layouts)

- Date: 2026-10-27
- Handoff: docs/handoffs/S10-layouts.md (sprint 3 organize, headless, concurrency 1)
- Contract SHA: cde5b026db72d70942a7fb57d9db214e9593bb53 (branch created from sprint/3-organize at the same commit; main has not moved)

## Task list

| # | Unit | Executor | Requirements | Depends on |
|---|------|----------|--------------|------------|
| U1 | Layout engine: spec types, JSON round-trip, split tree renderer, typed panes, seven presets, reload persistence, preset screenshots | sd-executor-web | R6.1 | none |
| U2 | Hub layouts API: migration (hotkey slot, host pin), GET/PUT/DELETE /layouts, validation | sd-executor-hub | R6.3 (hub half) | none |
| U3 | Saved layouts client, hotkeys 1-9, switch timing; Shift+C compact-all with exact restore | sd-executor-web | R6.3, R6.5 | U1, U2 |
| U4 | Auto-fit by count and by project; drag and keyboard pane assignment, one content pane per session | sd-executor-web | R6.2, R6.6 | U1 |
| U5 | Session content pane (virtualized, unmount when hidden) and six-pane 20 deltas/s trace | sd-executor-web | R6.4 | U1 |
| U6 | Session close: rebase, full suite, integration checks, VERIFY-P6.md and docs/LAYOUTS.md | sd-verifier | all | U1-U5 |

## Decisions made

1. R6.3 says layouts persist in the hub; packages/hub is owned by sd-executor-hub, so the hub half is its own unit (U2) although the handoff names only sd-executor-web. The `layouts` table already exists (migration 1); U2 adds columns through a new migration.
2. The Phase 4 content view (S8, sprint 2) is not on this base. The `session` pane in U5 renders a minimal virtualized live activity list fed by the board store, behind a single component seam that S8's content view replaces on rebase. R6.4 is measured against this pane. Recorded as an open question for the user.
3. Layout spec types live in packages/web (not packages/contract) so the pinned contract commit is untouched; the hub stores the spec as validated opaque JSON with a size cap.
4. react-resizable-panels: npm registry reports 4.15.0, license MIT (checked from the orchestrator shell, `npm view`).

## Units

### U1 layout engine (R6.1): done, re-verify at close
- Commits ff36d9f, b21f9e6, ef80999, fix 29fe34e; verify 1c3a118.
- Files: packages/web/src/layout/*, store/layout.ts, components/layout/*, routes/Layout.tsx, e2e/R6.1.spec.ts; header link added (R3 baselines regenerated, reviewer diffed them pixel by pixel: header-only change).
- react-resizable-panels 4.15.0 (MIT) kept; ratios live in the spec, library gets defaultLayout and setLayout.
- Review: iteration 1 fix-then-merge (3 SHOULD, 4 NIT, all fixed); iteration 2 merge.
- Verifier: R6.1 pass (289 vitest, 15 Playwright), screenshots /state/3/screens/S10/R6.1-*.png.
- Deferred to U4: "+N more" hidden-project count (reviewer SHOULD, Layout.tsx:41); by-project cards clipped in narrow columns at 1440x900 (verifier flag, orchestrator looked at the PNG). Solo strip overflow is intended (design 5.4: strip horizontally scrollable).
