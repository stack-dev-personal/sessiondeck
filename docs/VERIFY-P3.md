# Final verification, branch p3/board-live, HEAD d4c845f

Verified 2026-10-20T22:20:00Z by sd-verifier. Nothing was fixed. Partial is fail. Earlier sections below are history.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.1 Live session on board within 1 s of SessionStart reaching the hub | `SD_E2E_WORK_VOLUME=sprint-1-work bash packages/web/scripts/e2e-live.sh` (hub container built from packages/hub/Dockerfile; e2e/R3.1.spec.ts) | "R3.1 latency ms, 5 samples: 82, 41, 43, 18, 21"; max 82 ms vs 1000 ms; spec passed. R3.1.png | PASS | 2026-10-20T22:15Z |
| R3.3 Attention sessions sort to top within one render, accent, one notification per transition | same live script (e2e/R3.3.spec.ts) | "R3.3 reorder latency: 11.9 ms, 1 frames, index 0"; spec passed (sort, accent, one notification per transition, filters). R3.3.png, R3.3-filters.png, R3.3-hidden-attention.png | PASS | 2026-10-20T22:16Z |
| R3.6 20 sessions, 2 hosts, 20 deltas/s, no dropped frames, main thread < 50% busy | same live script, R3.6 not skipped (e2e/R3.6.spec.ts, rule (a)-(d)) | Load window: busy 7.23% (idle baseline 2.2%), frame p99 16.8 ms (max 16.8), 0 dropped-frame intervals of 1800 frames (idle 0), longest script task 2.78 ms (idle 2.45), 20.07 session msgs/s, 700 posts sent, 0 failed, 0 long tasks, longest top-level task 21.16 ms. Spec passed (1.3m). R3.6.png, R3.6-trace.json | PASS | 2026-10-20T22:17Z |
| R3.9 WS disconnect banner, auto-reconnect with resync, no stale working card | same live script (e2e/R3.9.spec.ts) | spec passed (2.8s). R3.9-banner.png, R3.9.png | PASS | 2026-10-20T22:17Z |
| R3.7 WCAG AA contrast light and dark; no color-only information (handoff re-verify, incl. live a11y specs) | mock Playwright suite (e2e/R3.7.spec.ts, e2e/R3.7-live.spec.ts); `pnpm -F @sessiondeck/web contrast` | contrast: "Text failures (0)", all other pairs pass; e2e "0 of 280 measured" fail dark and light; axe none on /board, /dev/cards, live connection, settings, error boundary, both themes; keyboard walk, 320 px reflow, text spacing, reduced motion, tones off by default all pass | PASS | 2026-10-20T22:14Z |
| R3.2 Card indicators, n/a nulls, no layout shift (no regression) | mock Playwright suite (e2e/R3.2.spec.ts, R3.2 320 px null-to-value in R3.7-live.spec.ts); web unit | 28/28 Playwright pass; unit 214/214 | PASS | 2026-10-20T22:14Z |
| R3.4 Compact toggle with `c`, persisted (no regression) | mock Playwright suite (e2e/R3.4.spec.ts); web unit | pass. R3.4-compact.png | PASS | 2026-10-20T22:14Z |
| R3.5 Drawer Enter/click open, Esc close, focus returns (no regression) | mock Playwright suite (e2e/R3.5.spec.ts); web unit | pass. R3.5-drawer.png | PASS | 2026-10-20T22:14Z |
| R3.8 Mock mode runs full UI with no hub (no regression) | mock Playwright suite (e2e/R3.8.spec.ts); `vite build --outDir /tmp/sd-s6-nomock-<pid>` then `node scripts/check-bundle.mjs <outDir> nomock` | e2e pass (8 states); "nomock: 1 js files, 280911 bytes, fixture marker absent, __sd absent". R3.8.png | PASS | 2026-10-20T22:15Z |
| R3.10 Stable working/idle display: contract unchanged, grace 120 s default (Settings 0 to 900 s), waiting immediate, at most one group change per grace, stable in-group order (unit range 3940dc6..HEAD, c4981b8) | `git diff --stat 3940dc6..HEAD -- packages/contract` (empty); `pnpm -F @sessiondeck/web exec vitest run --pool=forks --poolOptions.forks.maxForks=2` | contract diff empty. Web: 24 files, 243/243 passed. Cases: display-activity.test.ts "Stop then UserPromptSubmit 30 s later never leaves the working group", "a session idle for 121 s moves exactly once", "waiting surfaces immediately...", "a Stop/prompt flapper every 30 s never leaves working", "working, Stop, auto-idle at 121, prompt at 122 stays idle until 241", "within-group order ignores last_event_at across repeated deltas", "clamps to 0..900"; Board.hysteresis.test.tsx (same two handoff cases at board level, "waiting shows at once and sorts first; grace 0 is raw"); Settings.grace.test.tsx "defaults to 120, changes, clamps, and persists". Source: DEFAULT_GRACE_SEC=120, MAX_GRACE_SEC=900. Screens (produced in mcr.microsoft.com/playwright:v1.63.0-noble at e4eb205; cfeb135 changed only /dev/cards baselines and hook internals; executor ran 44/44 passed twice at cfeb135, not re-run here): /state/2/screens/S8b/R3.10-{light,dark}-{1440,390}.png all four present; opened R3.10-light-1440.png: working group holds the deep session (Working, 4 agents, under 1m in state) and harvest; no card flagged as the flapper, so the visual claim rests on the tests above and mock.test.ts flapper case. | PASS | 2026-10-29 |
| R3.11 Session popout replaces drawer: centered dialog, focus trap, Esc/click-outside close, `#session-<id>` deep link, header (state, model, effort, speed, API-equivalent cost, branch), recursive compact subagent cards, unlinked marker, S8 content slot (unit range 4ede2c8..HEAD; web dd60c66 e7ae771 e5b82eb 0362bcb 84d8e15, contract 2bfef4f, hub 5459b86) | `pnpm -F @sessiondeck/{contract,hub,web} exec vitest run --pool=forks --poolOptions.forks.maxForks=2` | contract 30 files 1119 pass/1 skip; hub 22 files 290/290; web 26 files 280/280. Cases (SessionPopout.test.tsx unless noted): dialog+aria-modal+no drawer+close focused "is a modal dialog labelled by its header, replacing the drawer on card click"; "traps Tab and Shift+Tab"; "focus trap covers inputs and summary in contentSlot..."; "Esc closes and focus returns...", "backdrop click closes", "close button closes"; hash: "opening sets it, closing clears it", "loading with the hash opens the popout", "Esc after a card open pops the pushed entry", "closing a popout opened from the hash uses replaceState", "unknown id...", "later arrives", "removing the hash (Back) closes"; header "shows reported fields and n/a for absent ones" (model, effort, cost text contains API-equivalent, branch), "speed shows fast, standard, or n/a from fast_mode"; fast_mode chain: contract/test/fast-mode.test.ts (statusline + snapshot, 5 cases), hub/test/fast-mode.test.ts "false, then true, then absent or null keeps true" and "REST snapshots include fast_mode", web statusline-adapter.test.ts "copies fast_mode like effort"; rollup: "shows first level only; unlinked rows carry the marker", "expands per node through three levels and collapses again", "Expand all and Collapse all", "cycle and missing-parent rows render without hanging", agent-tree.test.ts (5); slot: "renders contentSlot inside the content region" (data-slot=content). Re-verify at 82b5022 closes both prior gaps: (1) describe "header state" it.each working/waiting_permission asserts [data-slot=state] text equals STATE_VOCAB label and header contains the glyph, plus a test that the two differ; (2) parse() exported; "an over-long decoded id is rejected (decoded cap)" tests the boundary at 256/257 and short-raw/long-decoded; "an over-long raw hash is rejected before decodeURIComponent runs (raw cap)" spies decodeURIComponent (not called for 15000-char raw, called once for a normal hash, so the spy is live). The vacuous replaceState assertion was removed. Executor reports mutation-checked; not repeated here. Accepted deviation: subagent cards are AgentCard on the shared compact card shell (sd-card, data-density=compact, --card-compact-h), since subagents have no SessionSnapshot. Data gap: live hook data is all unlinked until S7 (option B); record in session log. Screens (produced in mcr.microsoft.com/playwright:v1.63.0-noble at e4eb205; cfeb135 changed only /dev/cards baselines and hook internals; executor ran 44/44 passed twice at cfeb135, not re-run here): /state/2/screens/S8b/R3.11-{light,dark}-{1440,390}.png all four present; opened R3.11-dark-1440.png and R3.11-light-1440.png: centered dialog with header (state, model, effort, speed, cost, branch), Collapse all, three nesting levels (s1 > s2 > s3, s5) and mock-agent-s4 with UNLINKED marker. | PASS | 2026-10-29 |
| R3.12 Usage widget (incl. decision 28 amendment): 5h/7d meters off every card; one square draggable, keyboard-movable, collapsible widget; five_hour and seven_day used % and resets from statusLine rate_limits, freshest per window; no Fable (unit range 9f12326..HEAD: 8a63eee 9181388 c189783 27cbdb6) | `pnpm -F @sessiondeck/web exec vitest run --pool=forks --poolOptions.forks.maxForks=2`; `grep -rni fable packages/web/src` | web 27 files, 305/305 passed (UsageWidget.test.tsx 30). Clauses: cards without meters: SessionCard.test.tsx "cards carry no 5h or 7d meter (R3.12...)" (no data-meter five_hour/seven_day, no 41%/63%). One square widget: WIDGET_SIZE=176 used for both w and h (UsageWidget.tsx sizeOf), mounted once in App.tsx; no test asserts squareness directly (source check only). Data and freshness: "pickFreshestRateLimits picks the newest captured_at across sessions...", "per-window freshness takes each window from the freshest payload that has it", "renders percent, meter and reset times for both windows", "shows a stale window as n/a", "empty state ... no invented numbers", "ticks past resets_at to n/a", thresholds it.each. No Fable: grep of src finds only the test file (lines 174-188), none in non-test source; test "never mentions fable or any per-model window". Pointer: "pointer drag moves the widget and persists on release", "drag cannot leave the viewport", "a click on the handle without movement does not persist". Keyboard: "arrow keys move by a step, Shift by a larger step, and persist". localStorage: "restores a stored position after remount", malformed it.each (5 cases), "storage that throws on read and write still works". Resize: "snaps back inside the viewport when the window shrinks", "an out-of-range stored position snaps inside the viewport on load", "fits at 390 px wide". Chip: "collapses to a chip, expands back, and persists the state", "chip shows numbers, not color alone...", "chip constants meet the content-fit minimum...". Self-contained: UsageWidget.tsx + useAccountUsage.ts own hook, no props needed (`<UsageWidget />`). Caveat: DetailDrawer.tsx still renders per-session 5h/7d "Rate limits" rows, but it is not mounted anywhere (replaced by popout, R3.11); it is dead code, not a card. Screens (produced in mcr.microsoft.com/playwright:v1.63.0-noble at e4eb205; cfeb135 changed only /dev/cards baselines and hook internals; executor ran 44/44 passed twice at cfeb135, not re-run here): /state/2/screens/S8b/R3.12-{light,dark}-{1440,390}.png  Also R3.12-chip-*.png (chip state), 4 files, all four present; opened R3.12-dark-1440.png: cards carry no 5h/7d meters; USAGE widget shows 5h 6% resets in 2h 10m and 7d 20% resets Fri 12:00, drag handle and collapse button, no Fable row. Session-end re-run: web 28 files 312/312; `grep -rniE fable packages/web/src` excluding *.test.* returns nothing. | PASS | 2026-10-29 |
| R3.13 Mock mode covers R3.10 to R3.12: popout with three nesting levels, usage widget (with and without data), a session flapping Stop/prompt | `pnpm -F @sessiondeck/web exec vitest run --pool=forks --poolOptions.forks.maxForks=2 src/mock/mock.test.ts --reporter=verbose`; e2e/R3.13.spec.ts (Playwright, 4 screenshots: light/dark x 1440/390) | mock.test.ts 16/16 pass, incl. "one session has subagents linked three levels deep and one unlinked", "the no-usage variant never reports a rate limit (empty widget)", "?usage=none selects the no-usage variant", "the flapper alternates Stop and prompt every 30 s and stays in the working group", "replay=fast does not flap unless asked...", "flapEnvelope builds Stop and UserPromptSubmit hooks", "?flap=0 turns the ticker off". e2e/R3.13.spec.ts present (one test per theme x viewport); not re-run here (Playwright cannot be bind-mounted from this path), executor ran the full mock suite 44/44 twice at cfeb135. Screens /state/2/screens/S8b/R3.13-{light,dark}-{1440,390}.png all four present; opened R3.13-light-1440.png: popout open over the board with three levels, UNLINKED row, usage widget visible (flapper not individually identifiable on screen; covered by mock.test.ts) | PASS | 2026-10-29 |

## Session-end gates, S8b, branch p3/board-feedback at cfeb135 (2026-10-29)

Environment: node v22.23.3, Linux 6.18.33.2 WSL2, AMD Ryzen AI 9 465. Nothing was fixed. Run one package at a time.

- `pnpm -r --workspace-concurrency=1 typecheck`: clean in all packages. `pnpm -r --workspace-concurrency=1 lint`: clean in all packages. `pnpm format:check`: "All matched files use Prettier code style!".
- Tests, `pnpm -F <pkg> exec vitest run --pool=forks --poolOptions.forks.maxForks=2`: contract 30 files, 1119 passed + 1 skipped; hub 22 files, 290/290; probe 13 files, 332 passed + 1 skipped; web 28 files, 312/312; scripts 27 files + 1 skipped, 535 passed + 3 skipped. No failures.
- Note: `pnpm -F sessiondeck exec vitest run` (the root package, which has no tests of its own) walks the whole repo with one config and reports 348 failed (probe process tests, web jsdom tests) because per-package environments are not applied; it is not a gate (root script is `pnpm -r test`) and was not investigated further.
- R3.10 named tests, pass: src/lib/display-activity.test.ts "Stop then UserPromptSubmit 30 s later never leaves the working group", "a session idle for 121 s moves exactly once"; src/routes/Board.hysteresis.test.tsx "Stop then a prompt 30 s later never leaves the working group", "moves to idle once, 121 s after Stop, with no further delta" (4/4).
- R3.12 no Fable: `grep -rniE fable packages/web/src` excluding *.test.* returns no lines.

## Suites at d4c845f

- `pnpm -r test -- --maxWorkers=2`: contract 28 files, 1090 passed + 1 skipped (1091); hub 15 files, 177/177; web 20 files, 214/214; scripts 28 files + 1 skipped, 575 passed + 7 skipped (582). No failures.
- `pnpm -r typecheck`: contract, hub, web, scripts all clean. `pnpm -r lint`: all four clean.
- Mock Playwright (pinned image, command in the task): 28 passed (44.4s).
- Live script: 4 passed (1.5m): R3.1, R3.3, R3.6, R3.9.
- Substitute note: infra/docker-compose.yml does not exist on this base (S4 not merged); e2e-live.sh building packages/hub/Dockerfile is the recorded substitute.
- CI wiring: .github/workflows/ci.yml has jobs `e2e-web` (mock build, pinned Playwright container) and `e2e-web-live` (runs e2e-live.sh with SD_E2E_SKIP_PERF=1, then a continue-on-error R3.6 report-only step). R3.6 is therefore not a blocking CI gate; it is gated here. Branch trigger not separately checked.
- Environment: node v22.23.3, Linux 6.18 WSL2, 20 CPUs (browserHardwareConcurrency 20).
- Screenshots in /state/1/screens/S6/ (listing includes some earlier files): R3.1.png, R3.2.png, R3.2-board.png, R3.2-2560.png, R3.3.png, R3.3-filters.png, R3.3-hidden-attention.png, R3.4-compact.png, R3.5-drawer.png, R3.6.png, R3.6-trace.json, R3.6-trace.raw.json.gz, R3.7-dark.png, R3.7-light.png, R3.7-board-light.png, R3.7-320.png, R3.7-banner(-light).png, R3.7-live-(dark|light).png, R3.7-settings-(dark|light).png, R3.8.png, R3.9.png, R3.9-banner.png, summary.json.
- Containers sd-1-S6-*: none remain (`docker ps -a --filter name=sd-1-S6` empty).

# History: earlier sections

# VERIFY P3 (branch p3/board-mock, HEAD e816b7c)

Re-verified 2026-10-20T14:33:16Z by sd-verifier after U6 (four tokens raised to 4.5:1). Nothing was fixed. Partial is fail.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.2 Card shows all A6 indicators; nulls render "n/a" with no layout shift | `pnpm --filter web test`; Playwright e2e/R3.2.spec.ts | 115/115 unit pass; e2e 3/3 pass (8 states, glyph+label, null card same geometry, 2560x1440, 7 of 8 with context/limits/branch). Screenshot /state/1/screens/S5/R3.2.png | PASS | 2026-10-20T14:33:16Z |
| R3.4 Compact toggles with `c`; persists in localStorage (guarded) | same unit run (SessionCard.test compact toggle); e2e/R3.4.spec.ts | unit pass; e2e pass. R3.4-compact.png | PASS | 2026-10-20T14:33:16Z |
| R3.5 Drawer opens with Enter or click, closes with Esc; focus returns to card | same unit run (DetailDrawer.test, 23 tests); e2e/R3.5.spec.ts | unit pass; e2e 2/2 pass. R3.5-drawer.png | PASS | 2026-10-20T14:33:16Z |
| R3.7 WCAG AA contrast light and dark; no color-only information | `pnpm -F @sessiondeck/web contrast`; e2e/R3.7.spec.ts (5 tests) | contrast report "Text failures (0)"; e2e: 0 of 280 measured elements fail in dark and in light; axe none on /board and /dev/cards both themes; no-color-only test pass. R3.7-dark.png, R3.7-light.png | PASS | 2026-10-20T14:33:16Z |
| R3.8 Mock mode runs the full UI with no hub | e2e/R3.8.spec.ts; `vite build --outDir /tmp/sd-s5-nomock` then `node scripts/check-bundle.mjs /tmp/sd-s5-nomock nomock` | e2e pass (8 states, no network beyond preview server); "nomock: 1 js files, 262977 bytes, fixture marker absent". R3.8.png | PASS | 2026-10-20T14:33:16Z |

## Live board verification (branch p3/board-live, HEAD 8b20955)

Verified 2026-10-20T17:23:18Z by sd-verifier. Nothing was fixed. Partial is fail. The S5 rows above (branch p3/board-mock, e816b7c) are unchanged.

| Requirement | Command | Key output | Result | Timestamp | Commit |
|---|---|---|---|---|---|
| R3.1 Every live session appears on the board within 1 s of its SessionStart reaching the hub | `SD_E2E_WORK_VOLUME=sprint-1-work bash packages/web/scripts/e2e-live.sh` (real hub container from packages/hub/Dockerfile; e2e/R3.1.spec.ts); unit `pnpm -F @sessiondeck/web test -- --maxWorkers=2` (stream-client.test.ts) | "R3.1 latency ms (POST sent to card visible), 5 samples: 62, 18, 21, 16, 17"; max 62 ms vs 1000 ms threshold; spec passed. Unit: 16 files, 173/173 pass. R3.1.png | PASS | 2026-10-20T17:23:18Z | 8b20955 |
| R3.9 WS disconnect shows a banner and auto-reconnects with resync; no stale working card after reconnect | same live script (e2e/R3.9.spec.ts); unit stream-client.test.ts (resync, backoff, liveness) and App.test.tsx banner | Spec passed (2.8s): banner on gate down, card geometry unchanged, card stays working while cut off, after gate up connected, banner cleared, session a idle, b ended, 0 working cards. 173/173 unit pass. R3.9-banner.png, R3.9.png | PASS | 2026-10-20T17:23:18Z | 8b20955 |
| R3.8 Mock mode runs the full UI with no hub (no regression) | `docker run --rm --name sd-1-S6-verify-pw --volumes-from sprint-1 -w /work/wt/S6/packages/web --ipc=host -e HOME=/root -e SCREENS_DIR=/state/1/screens/S6 -e CI=1 mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test` (same as CI job e2e-web, re-run, not recorded) | 12 passed (29.7s), incl. R3.8 "mock build runs the full board with no network beyond the preview server" (8 states). Mock baselines (toHaveScreenshot) pass. Bundle check (check-bundle.mjs nomock) not re-run | PASS | 2026-10-20T17:23:18Z | 8b20955 |

Also run in the same live script: R3.3 (attention sort, filters) passed, reorder latency 9.4 ms; not graded here. Live script total: 3 passed (13.6s). Screenshots in /state/1/screens/S6/: R3.1.png, R3.3.png, R3.3-filters.png, R3.9-banner.png, R3.9.png, summary.json. Test containers: the live script cleaned up its own; sd-1-S6-verify-pw ran with --rm; none remain. Not verified: infra/docker-compose.yml path (absent on this base; the script is the substitute).

## Evidence at e816b7c

- Unit: `pnpm --filter web test`: Test Files 9 passed (9), Tests 115 passed (115). The earlier run counted 116; the count differs by one, consistent with the contrast test rewrite in U6 (not investigated further).
- Playwright: `docker run --name sd-1-S5-verify --volumes-from sprint-1 -w /work/wt/S5/packages/web --ipc=host -e HOME=/root -e SCREENS_DIR=/state/1/screens/S5 -e CI=1 mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test` (same invocation as CI job e2e-web, run as root like CI; container removed afterwards). Result: 12 passed (43.3s). A first attempt with `-u 1000` failed on a root-owned packages/web/dist/e2e-mock/assets left by an earlier run; it is not a product failure.
- Bundle check used a separate outDir because `pnpm build` into dist hits root-owned files under dist/e2e-mock (gitignored, created by the root container run).
- Contrast: all 20 token rows and 12 other pairs pass; changed tokens: dark state-ended #7f868f 4.75, dark fg-faint 4.78, light state-starting #6e757d 4.66, light fg-faint 4.66.
- Screenshots in /state/1/screens/S5/: R3.2.png, R3.2-board.png, R3.2-2560.png, R3.4-compact.png, R3.5-drawer.png, R3.7-dark.png, R3.7-light.png, R3.7-board-light.png, R3.8.png, summary.json.

# History: earlier verification at df360b5 (72e7a63 doc), superseded

## (earlier) VERIFY P3 (branch p3/board-mock, HEAD df360b5)

Verified 2026-10-20T02:58:24Z by sd-verifier. Nothing was fixed. Partial is fail.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.2 Card shows all A6 indicators; nulls render "n/a" with no layout shift | `pnpm -F @sessiondeck/web test`; Playwright suite (e2e/R3.2.spec.ts, 3 tests) | 116/116 unit pass; R3.2 e2e 3/3 pass (glyph+label per state, null card same geometry, 2560x1440 geometry, settled board: 8 states, 7 with context/limits/branch) | PASS | 2026-10-20T02:58:24Z |
| R3.4 Compact toggles with `c`; persists in localStorage (guarded) | same unit run (SessionCard.test "c toggles full and compact ... persists"); e2e/R3.4.spec.ts | unit pass; e2e pass: compact rows and choice survives reload | PASS | 2026-10-20T02:58:24Z |
| R3.5 Drawer opens with Enter or click, closes with Esc; focus returns to card | same unit run (DetailDrawer.test, 23 tests); e2e/R3.5.spec.ts (2 tests) | unit pass; e2e 2/2 pass: focus returns to same card; busiest-session drawer shows sparkline, timeline, subagents, limits | PASS | 2026-10-20T02:58:24Z |
| R3.7 WCAG AA contrast in light and dark; no color-only information | `pnpm -F @sessiondeck/web contrast`; e2e/R3.7.spec.ts (5 tests, axe + computed contrast + DOM cue check) | 4 text tokens below 4.5:1 on --surface-1 (table below); all pass 3:1 as icons; axe color-contrast violations are only those four token colors; no-color-only test passes | FAIL (pending user decision on four tokens) | 2026-10-20T02:58:24Z |
| R3.8 Mock mode runs the full UI with no hub | e2e/R3.8.spec.ts (network guard, mock build); `pnpm -F @sessiondeck/web build && pnpm -F @sessiondeck/web check:bundle` | e2e pass: full board, 8 states, no network beyond the preview server; production bundle: "nomock: 1 js files, 262977 bytes, fixture marker absent" | PASS | 2026-10-20T02:58:24Z |

## Unit tests

`pnpm -F @sessiondeck/web test`: Test Files 9 passed (9), Tests 116 passed (116).

## Playwright (pinned image mcr.microsoft.com/playwright:v1.63.0-noble)

Command: `docker run --rm --name sd-1-S5-verify-pw --volumes-from "$HOSTNAME" -w /work/wt/S5/packages/web -u 1000 --ipc=host -e SCREENS_DIR=/state/1/screens/S5 -e CI=1 mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test`

Result: 12 passed (26.9s). Summary: /state/1/screens/S5/summary.json. Note: summary.json reports R3.7 as "pass" because the tests assert and record failures instead of failing; this verification grades R3.7 FAIL per the contrast table.

Screenshots in /state/1/screens/S5/:
- R3.2: R3.2.png, R3.2-board.png, R3.2-2560.png
- R3.4: R3.4-compact.png
- R3.5: R3.5-drawer.png
- R3.7: R3.7-dark.png, R3.7-light.png, R3.7-board-light.png (plus R3.7-axe-dark.json, R3.7-axe-light.json, R3.7-contrast-dark.json, R3.7-contrast-light.json)
- R3.8: R3.8.png

## R3.7 evidence

Output of `pnpm -F @sessiondeck/web contrast`:

```
WCAG 2.x contrast against --surface-1 (text >= 4.5, icon >= 3)
theme token           value    ratio   text  icon
dark  state-starting  #8b949e  5.68    pass  pass
dark  state-working   #58a6ff  6.92    pass  pass
dark  state-waiting   #f0b429  9.38    pass  pass
dark  state-idle      #3fb950  6.88    pass  pass
dark  state-error     #f85149  5.21    pass  pass
dark  state-ended     #6e7681  3.80    FAIL  pass
dark  state-exited    #a371f7  5.21    pass  pass
dark  meter-ok        #3fb950  6.88    pass  pass
dark  meter-warn      #f0b429  9.38    pass  pass
dark  meter-high      #f85149  5.21    pass  pass
light state-starting  #8c959f  3.04    FAIL  pass
light state-working   #0969da  5.19    pass  pass
light state-waiting   #9a6700  4.87    pass  pass
light state-idle      #1a7f37  5.08    pass  pass
light state-error     #cf222e  5.36    pass  pass
light state-ended     #6e7781  4.55    pass  pass
light state-exited    #8250df  5.05    pass  pass
light meter-ok        #1a7f37  5.08    pass  pass
light meter-warn      #9a6700  4.87    pass  pass
light meter-high      #cf222e  5.36    pass  pass

Note: ended/exited cards dim the surface only (border, meter bars); text keeps full opacity, so the ratios above apply to them unchanged.

Other pairs
dark  fg / surface-1              14.79  pass
dark  fg-muted / surface-1        7.12  pass
dark  fg-faint / surface-1        3.83  FAIL
dark  meter-ok / meter-track      4.96  pass
dark  meter-warn / meter-track    6.76  pass
dark  meter-high / meter-track    3.76  pass
light fg / surface-1              15.80  pass
light fg-muted / surface-1        6.11  pass
light fg-faint / surface-1        3.04  FAIL
light meter-ok / meter-track      3.50  pass
light meter-warn / meter-track    3.35  pass
light meter-high / meter-track    3.69  pass

Text failures (4):
  dark state-ended #6e7681 3.80
  light state-starting #8c959f 3.04
  dark fg-faint #6b7784 3.83
  light fg-faint #8c959f 3.04
```

Browser evidence (e2e/R3.7.spec.ts): 160 of 280 measured elements fail 4.5:1 in each theme. Axe color-contrast nodes, by foreground color:
- dark /board: #6b7784 (fg-faint) x56, #6e7681 (state-ended) x1; /dev/cards: #6b7784 x182, #6e7681 x2
- light /board: #8c959f (fg-faint and state-starting share this value) x57; /dev/cards: x184
- No other axe violation ids or colors in either theme.

Everything else passes: all other state and meter tokens, fg and fg-muted, meter-vs-track at 3:1, and the no-color-only-encoding test (glyph, label and text cues in the DOM). Failing tokens are left verbatim pending a user decision.

## Phase DoD: "/dev/cards renders every state from fixtures and is screenshot-tested"

- Unit: src/routes/DevCards.test.tsx, 4 tests pass (includes "renders every named specimen").
- Playwright: R3.2 "every state shows glyph and label" and "/dev/cards at 2560x1440" pass; R3.2.png and R3.2-2560.png captured; R3.7 axe and contrast runs cover /dev/cards in both themes (R3.7-dark.png, R3.7-light.png).
- Result: PASS. R3.2.png and R3.2-2560.png (the /dev/cards shots) are asserted with toHaveScreenshot baselines (e2e/R3.2.spec.ts lines 56 and 67), and the suite passed against them.

## CI

- Latest run on HEAD df360b5: run 39361666374, in progress at check time (all five jobs in_progress, no conclusions).
- Latest completed run: 39361475112, SHA d934448, cancelled (superseded by a later push). Its e2e-web job: success. Its check jobs: all four cancelled.
- Earlier run 39361096443, SHA 17b16dd: e2e-web success; check ubuntu node 22 and 24 success; windows checks cancelled.
- No completed CI run on HEAD exists yet.

# FIX-3 re-confirmation (merge p3/board-mock)

Staged, uncommitted merge of p3/board-mock (S5) into sprint/1-mvp (base 88d9c07), lockfile regenerated (patch drift in browserslist 4.29.4, postcss-selector-parser 6.1.5, baseline-browser-mapping 2.11.30). Verified 2026-10-21T01:59:45Z by sd-verifier. Nothing was fixed. Partial is fail. Evidence: /state/1/gate/FIX-3/verify-*.txt; screenshots /state/1/screens/FIX-3/.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.2 | `pnpm -F @sessiondeck/web test -- --maxWorkers=2`; Playwright e2e/R3.2.spec.ts | unit Tests 115 passed (115), 9 files; e2e 3/3 pass (8 states, 7 with context/limits/branch). verify-unit.txt, verify-e2e.txt; R3.2.png, R3.2-board.png, R3.2-2560.png | PASS | 2026-10-21T01:59:45Z |
| R3.4 | same unit run; e2e/R3.4.spec.ts | unit pass; e2e pass. R3.4-compact.png | PASS | 2026-10-21T01:59:45Z |
| R3.5 | same unit run; e2e/R3.5.spec.ts | unit pass; e2e 2/2 pass. R3.5-drawer.png | PASS | 2026-10-21T01:59:45Z |
| R3.7 | `pnpm -F @sessiondeck/web contrast`; e2e/R3.7.spec.ts | "Text failures (0)" (verify-contrast.txt); e2e 5/5: 0 of 280 failing in dark and light, axe none on /board and /dev/cards in both themes. R3.7-dark.png, R3.7-light.png | PASS | 2026-10-21T01:59:45Z |
| R3.8 | e2e/R3.8.spec.ts; `vite build --outDir /tmp/sd-fix3-nomock-<pid>` then `node scripts/check-bundle.mjs <dir> nomock` | e2e pass; "nomock: 1 js files, 262977 bytes, fixture marker absent" (identical to S5 size). verify-bundle.txt; R3.8.png | PASS | 2026-10-21T01:59:45Z |

- Playwright command: `docker run --rm --name sd-1-FIX-3-e2e --volumes-from sprint-1 -w /work/packages/web --ipc=host -e HOME=/root -e SCREENS_DIR=/state/1/screens/FIX-3 -e CI=1 mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test` (same image and invocation as CI job e2e-web). Result: 12 passed (32.2s), exit 0, all visual baselines matched on the merged tree and regenerated lockfile. Container removed (--rm; none listed afterwards).
- Screenshot names follow the spec files (R3.7-dark.png and R3.7-light.png rather than a single R3.7.png).
- Tests were run one process at a time, --maxWorkers=2 for vitest; no vitest process left running.

## Addendum: U8 Windows CI budget (4ab2297)

Scope: U8 changed only packages/web test configuration (vite.config.ts dom/node projects, isolate:false for dom, src/test-setup.ts resets, 8 node-env docblocks, App.test beforeEach). No app code changed. Verified 2026-10-20 from /work/wt/S6 at HEAD 4ab2297.

CI run 39514323713 on 4ab2297: conclusion success, all 6 jobs success. R0.5 step ("test (R0.5 budget 60 s)") timings from step startedAt/completedAt:

| Job | Start | End | Duration |
|-----|-------|-----|----------|
| ubuntu node 24 | 23:21:07 | 23:21:39 | 32 s |
| ubuntu node 22 | 23:21:27 | 23:22:14 | 47 s |
| windows node 24 | 23:21:49 | 23:22:44 | 55 s |
| windows node 22 | 23:22:06 | 23:23:05 | 59 s |

Windows margin against the 60 s budget is 1 s (node 22) to 5 s (node 24). This is thin: a slower runner can fail it. Timing is at step granularity (1 s resolution).

Local (Linux, one foreground process, no vitest running beforehand): `pnpm -r test` exit 0. web 214 passed (20 files), hub 177 passed (15 files), contract 1090 passed + 1 skipped (28 files), scripts 575 passed + 7 skipped (28 files + 1 skipped). `pnpm -r typecheck` exit 0, `pnpm -r lint` exit 0.

| ID | Command | Output | Result |
|----|---------|--------|--------|
| R0.5 (CI green both OSes) | `gh run view 39514323713 --json conclusion,jobs` | conclusion success; 4 check jobs (ubuntu/windows x node 22/24) and both e2e jobs success | pass |
| R0.5 (`pnpm -r test` under 60 s) | same, step timings | windows 55 s (node 24), 59 s (node 22); ubuntu 32 s, 47 s; all under 60 s, Windows margin 1 to 5 s | pass |
| R0.5 local suite | `pnpm -r test`, `pnpm -r typecheck`, `pnpm -r lint` | counts above, all exit 0 | pass |
| R3.1, R3.2, R3.3, R3.4, R3.5, R3.6, R3.7, R3.8, R3.9 (web unit regression) | `pnpm -r test` (packages/web) | 20 files, 214 tests passed, 0 failed; same count as expected | pass |

Limits: the regression rows rest on the whole web unit suite passing at the expected count; per-ID test selection was not run separately. Playwright evidence for these IDs was not rerun (U8 touched no app code or e2e). The R3.7 contrast failures recorded above are unchanged and not part of this addendum.

# FIX-4 re-confirmation (merge p3/board-live)

Staged, uncommitted merge of p3/board-live (S6) into sprint/1-mvp (base fb803a6, which contains S1 to S5). Verified 2026-10-21T02:12:20Z by sd-verifier. Nothing was fixed. Partial is fail. Evidence: /state/1/gate/FIX-4/verify-*.txt; screenshots /state/1/screens/FIX-4/.

Runs on the merged tree:
- Web unit: reused /state/1/gate/FIX-4/test.txt (orchestrator, sequential, maxWorkers=2): web 20 files, 214 passed, exit 0.
- Mock e2e: `docker run --rm --name sd-1-FIX-4-e2e --volumes-from sprint-1 -w /work/packages/web --ipc=host -e SCREENS_DIR=/state/1/screens/FIX-4 -e CI=1 mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test --workers=1`: 28 passed (50.0s), exit 0 (/state/1/gate/FIX-4/verify-e2e-mock.txt).
- Live e2e: `SD_E2E_PREFIX=sd-1-FIX-4 SD_E2E_WORK_VOLUME=sprint-1-work SD_E2E_SCREENS_OUT=/state/1/screens/FIX-4 packages/web/scripts/e2e-live.sh` (hub image built from packages/hub/Dockerfile, ws-gate, pinned Playwright v1.63.0-noble): 4 passed (1.8m), exit 0 (/state/1/gate/FIX-4/verify-e2e-live.txt). Containers and network sd-1-FIX-4-* removed by the script (none listed afterwards).
- Also: `pnpm -F @sessiondeck/web contrast` "Text failures (0)" (/state/1/gate/FIX-4/verify-contrast.txt); no-mock build + `check-bundle.mjs <dir> nomock`: "1 js files, 280911 bytes, fixture marker absent, __sd absent" (/state/1/gate/FIX-4/verify-bundle.txt).

| Requirement | Command | Result | Evidence |
|---|---|---|---|
| R3.1 | live e2e R3.1.spec.ts (POST /ingest to card visible, under 1 s) | PASS: 5 samples 55, 42, 19, 18, 18 ms, max 55 ms | verify-e2e-live.txt; R3.1.png |
| R3.2 | web unit + mock e2e R3.2.spec.ts | PASS: 8 states, glyph and label, 2560 px, baselines matched | verify-e2e-mock.txt; R3.2.png, R3.2-board.png, R3.2-2560.png |
| R3.3 | web unit + live e2e R3.3.spec.ts (attention sort, one notification per transition, filters) | PASS (2.6s) | verify-e2e-live.txt; R3.3.png, R3.3-filters.png, R3.3-hidden-attention.png |
| R3.4 | web unit + mock e2e R3.4.spec.ts | PASS | verify-e2e-mock.txt; R3.4-compact.png |
| R3.5 | web unit + mock e2e R3.5.spec.ts | PASS | verify-e2e-mock.txt; R3.5-drawer.png |
| R3.6 | live e2e R3.6.spec.ts (20 sessions, 2 hosts, 20 deltas/s, 4 criteria a to d) | PASS: busy 2.23% and 8.22% (limit 50), max script task 5.09 and 7.43 ms (limit 16.7), frame p99 16.8 ms, 0 intervals over 1.5x median, 0 failed posts | verify-e2e-live.txt; R3.6.png, R3.6-trace.json |
| R3.7 | mock e2e R3.7.spec.ts + R3.7-live.spec.ts, contrast report | PASS: 0 of 280 failing dark and light, axe none, keyboard, reflow, text spacing, motion; Text failures (0) | verify-e2e-mock.txt, verify-contrast.txt; R3.7-*.png |
| R3.8 | mock e2e R3.8.spec.ts + check-bundle nomock | PASS: full board with no network beyond preview; fixture marker absent in no-mock build | verify-e2e-mock.txt, verify-bundle.txt; R3.8.png |
| R3.9 | live e2e R3.9.spec.ts (TCP gate cut, banner, resync, no stale working card) | PASS (2.8s) | verify-e2e-live.txt; R3.9-banner.png, R3.9.png |

Count: 9 pass / 0 fail / 0 unverifiable. Tests were run one process at a time (vitest maxWorkers=2, Playwright workers=1); no test process left running.

# FIX-5 (R3.1 spec change), HEAD dbb1e33, range 03ddab7..dbb1e33

Verified 2026-10-21T18:46Z by sd-verifier. Not re-run by me (live run needs a hub plus a build; the evidence below was produced by the orchestrator against live hubs). Raw evidence: /state/1/gate/FIX-5/f4-e2e-live-seeded.log, f4-e2e-live-empty.log.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.1 spec change | `git diff 03ddab7..dbb1e33 -- packages/web/e2e/R3.1.spec.ts` | Removed the `session-card count 0` and `count 5` assertions (broke on a hub that already holds sessions); now asserts visible plus `data-state` for each of this spec's own 5 session ids. Latency check unchanged: 5 samples, `card(...).waitFor({ state: "visible", timeout: 5_000 })`, `expect(Math.max(...samples)).toBeLessThan(1000)` | pass (inspection) | 2026-10-21T18:46Z |
| R3.1 live, seeded hub (20 sessions) | read f4-e2e-live-seeded.log | samples 36, 33, 12, 38, 11 ms; "R3.1 max 38 ms"; 1 passed, EXIT=0 | pass (orchestrator evidence) | 2026-10-21 |
| R3.1 live, empty hub | read f4-e2e-live-empty.log | samples 35, 34, 13, 37, 11 ms; "R3.1 max 37 ms"; 1 passed, EXIT=0 | pass (orchestrator evidence) | 2026-10-21 |

Count: 3 pass / 0 fail / 0 unverifiable. The web unit suite (214 tests) passes at HEAD (see VERIFY-P0 FIX-5).

## FIX-5 resume (R0.5 option A), HEAD 45ec370

Verified 2026-10-21T19:28:06Z by sd-verifier. `git diff --stat dbb1e33..45ec370 -- packages/web packages/hub infra` is empty (no web, hub or infra change since the R3.1 spec change). Raw: /state/1/gate/FIX-5/verify2-f4-live-seeded.txt, verify2-cleanup.txt.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R3.1 live on a hub that already holds sessions | Copy of packages/web/scripts/e2e-live.sh (kept in /tmp, not in the repo) with one added step: after the hub is healthy, POST 20 sessions (5 live, 15 ended) to /ingest. Run with `SD_E2E_PREFIX=sd-1-fix5-f4 SD_E2E_ARGS=R3.1 SD_E2E_SKIP_PERF=1 SD_E2E_WORK_VOLUME=sprint-1-work`: hub image built from packages/hub/Dockerfile, ws-gate and pinned Playwright container on a private network | "seed ingest 200 20 sessions, 5 live"; "R3.1 latency ms, 5 samples: 84, 24, 27, 20, 37"; "R3.1 max 84 ms" against the unchanged < 1000 ms check; "1 passed (15.4s)", exit 0 | pass | 2026-10-21T19:28:06Z |
| Web unit suite | `pnpm -r test` (VERIFY-P0 FIX-5 resume) | web 20 files, 214 tests pass | pass | 2026-10-21T19:28:06Z |
| Cleanup | listing of containers, images, volumes, networks named *fix5* | none remain (verify2-cleanup.txt) | pass | 2026-10-21T19:28:06Z |

Count: 3 pass / 0 fail / 0 unverifiable.
