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
### U2 hub layouts API (R6.3 hub half): reviewed, verify with U3
- Commits f57bebb, fixes acfbf41, 3762d82, 6d1e3f7.
- Files: packages/hub/src/db/layouts.ts, src/routes/layouts.ts (new), src/db/migrations.ts (appended v6 layouts_slots; renumber at rebase over S9's v6), src/server.ts (registration + write-limiter closure), test/layouts.test.ts, test/migrations.test.ts.
- Routes: GET /layouts?host=, PUT /layouts/:id, DELETE /layouts/:id; global bearer auth; route-level write limiter 2/s burst 10 per principal; spec opaque JSON, depth 16, 32 KiB; 200-row cap; builtin rows read-only and never hold hotkeys.
- Review: sd-reviewer fix-then-merge x2, then clean; sd-security-reviewer gate pass all three rounds (MEDIUMs closed: depth stack overflow, write limiter, percent-encoded bypass). Three iterations used.
- Decision: hotkey scope is per host pin; a pinned layout wins over an unpinned one on its host, exposed as `active_hotkey` on GET and PUT rows.
- GET /layouts p95 1.56 ms in-process with 50 rows.
- Deferred: pre-existing `/history` and `/ingest` raw-URL prefix checks in server.ts can be bypassed with percent-encoding (security LOW, predates this branch; S9 edits that file); hub-side spec validation looser than web's (LOW, web validates every row); Phase 7 Postgres notes (READ COMMITTED slot race, BIGINT as string) in db/layouts.ts.
### U2b hub CORS for browser REST (R6.3): reviewed
- Found by the U3 executor: the hub sent no CORS headers, so the web app (:5173) could not call /layouts on the hub (:8787). The web only used WS before this phase.
- Commits 99dcb87, 91eefe9. Files: packages/hub/src/cors.ts (new), src/server.ts (one line before the bearer hook), src/config.ts (HUB_ALLOWED_ORIGINS validated at startup), test/cors.test.ts, test/config.test.ts, docs/HUB.md.
- Behavior: on only when HUB_ALLOWED_ORIGINS is non-empty (compose default is the two localhost:5173 origins); exact-origin reflection, Vary: Origin, no credentials; preflight GET/HEAD/PUT/DELETE with Authorization/Content-Type on /layouts and read routes; /ingest and /stream never CORS-enabled.
- Review: sd-reviewer merge; sd-security-reviewer gate pass twice.
- Deferred to rebase: S9 adds GET /search and PATCH /projects/:id, /sessions/:id/project, /sessions/:id/phase; add them to the CORS scope when rebasing (sd-reviewer SHOULD). Optional LOWs: suggest the normalized origin in the config error; IPv6 and uppercase-host test cases.

### U3 saved layouts client, hotkeys 1-9, Shift+C (R6.3, R6.5): reviewed, verify with U4
- Commits 596ce83, 25a888a, ddd7807, b6e7afd, 756562e; fixes 9561744, 6b78e12, edcd31f, 9748caa.
- Review: iteration 1 fix-then-merge (6 MAJOR, 5 MINOR, all fixed); iteration 2 merge.
- Decision: the viewer host is an explicit Settings value (default none = only unpinned layouts answer 1-9); not inferred from session activity.
- Decision: Shift+C rules: switching layout discards the snapshot; manual expand of one pane and resizes while compacted keep it (restore wins); the snapshot persists across reload; saving while compacted saves the pre-compact layout.
- Switch timing (keydown to next frame with new panes): fake hub max 31-64 ms, live hub (real CORS, no relay) max 48.3 ms. One unreproduced full-suite failure of the per-sample 100 ms assertion.
- Carry-over to U4: re-load after a write cancels an in-flight fetch; warm-up press before timing samples; keyboard test that reaches row 149's Open.
