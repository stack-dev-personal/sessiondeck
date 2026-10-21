# Session log: p3/board-live (S6, Phase 3 live)

- Date: 2026-10-20
- Handoff: docs/handoffs/S06-board-live.md
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4
- Base: sprint/1-mvp 78b3ba8 (S3 merged) plus merge of origin/p3/board-mock (S5, PR #8)
- Requirements: R3.1, R3.3, R3.6, R3.9, re-verify R3.7

## Tasks
- U1 merge S5 into the branch (sd-executor-contract)
- U2 WS client: reconnect, initial resync, rAF-coalesced store, disconnect banner (R3.1, R3.9) (sd-executor-web)
- U3 attention sort, host/project filters, alerts: reorder, accent, opt-in notification and sound (R3.3) (sd-executor-web)
- U4 Playwright smoke in CI and 20-session 20-deltas/s perf trace (R3.6) (sd-executor-web, CI by sd-executor-contract)
- U5 accessibility pass with design:accessibility-review checklist, R3.7 re-verify (sd-executor-web)
- U6 docs/BOARD-FEEDBACK.md template
- U7 close: full suite, integration checks, VERIFY-P3, PR

## Units
### U1 merge S5
- Commits: 0068e0a (merge, conflict only in pnpm-lock.yaml, regenerated with pnpm install), ba2ba68 (session log).
- Tests after merge: hub 177, web 115, contract 1090 (+1 skipped), scripts 575 (+7 skipped); typecheck and lint clean.
- Review: sd-reviewer verdict merge, no findings (merge-tree comparison shows only the lockfile differs from a clean merge).
### U2 live WS client
- Commits: d68326f, c19a6bb. Files: packages/web/src/live/{stream-client,start}.ts, components/ConnectionBanner.tsx, store/board.ts, App.tsx, Header.tsx, main.tsx, vite.config.ts, playwright.config.ts, e2e/R3.1.spec.ts, e2e/R3.9.spec.ts, e2e/live-helpers.ts, scripts/{ws-gate.mjs,e2e-live.sh}.
- Evidence (executor): web vitest 135 pass; mock Playwright 12 pass; live Playwright 2 pass; R3.1 POST-to-visible max 32 ms; screenshots /state/1/screens/S6/R3.1.png, R3.9-banner.png, R3.9.png.
- Notes: liveness is a silent second socket after 60 s of silence; R3.9 e2e cuts the link via a TCP forwarder; drawer history is empty in live mode (hub sends snapshots, not envelopes).
### U2 review and verify
- sd-reviewer: fix-then-merge (2 MAJOR: half-open link never showed banner; e2e "connected" substring matched "disconnected"), then merge after fix 0f67e9a. sd-security-reviewer: Gate pass both rounds (MEDIUM __proto__ ids, MEDIUM dev server 0.0.0.0 proxy; fixed in 0f67e9a). U2 MINORs fixed in fd2ce99.
- CI: 59f20d6 job e2e-web-live, 0c4a56f results artifact.
- sd-verifier at 8b20955: R3.1 PASS (max 62 ms POST to card), R3.9 PASS, R3.8 PASS (mock 12/12); docs/VERIFY-P3.md a74e3ff.
### U3 attention sort, filters, alerts
- Commits: 3bee58e, c0d4850, 8b20955 (8 mock baselines refreshed: toolbar row and attention stripe), fixes 6f47d01, fd2ce99, 07386b2.
- sd-reviewer: fix-then-merge (2 MAJOR: filters hid waiting sessions with no hint; same notification tag silently replaced), then merge at 07386b2.
- Evidence (executor): vitest 185; live R3.1, R3.3, R3.9 pass; reorder 1 frame (15.5 ms); screenshots /state/1/screens/S6/R3.3.png, R3.3-filters.png, R3.3-hidden-attention.png.
### U4 R3.6 perf trace
- Commits: b65c88e (minimal DOM moves on reorder), 9a46471 (load generator, trace analysis, live R3.6 spec). Run 3: main thread busy 16.01%, frame p99 16.8 ms, 20 session msgs/s, 3 Chromium paint long tasks (54-62 ms), longest script task 11.95 ms. Review pending.
### U4 review iterations
- Iteration 1 (8471f84, f64bdaa, 20fbca7, c47d62d, 5879a9d): trace guard and interval merge, reviewer pass rule (a)-(d), generator in-flight Set, focus test, connect timer split (onopen, then 30 s for initial), silent re-create after reload. React keyed variant measured worse (busy 21.6%, 18 dropped vs manual 11.89%, 0).
- Iteration 2 (8a6a943, 25bb584, c30a208, e37f655, ebac57d): shown flag for resume, glow once per attention transition, contain: layout paint style on .sd-card, 8 s warm-up before the idle window, R3.6 report-only in CI. R3.6 with contain: 0 dropped intervals, busy 11.62% and 14.63%, max script 4.1 and 3.87 ms. 7 mock baselines refreshed.
- sd-reviewer: fix-then-merge, fix-then-merge, then merge (third iteration).
### U5 accessibility pass
- Commits cfbf31b, 0d89322, 615631a, b4a7bd0. Substitute WCAG 2.1 AA checklist in docs/A11Y-P3.md (design:accessibility-review is not installed in the sprint container; the user runs it once on the laptop). Fixed: 1.4.10 reflow at 320 px, 1.4.11 control borders, 4.1.3 hidden-attention status region, 4.1.2 header glyph. Logged: infinite working-dot pulse (2.2.2), no screen reader run, zoom approximated by viewport. Mock Playwright 23 pass; vitest 208.
### U6 BOARD-FEEDBACK template
- docs/BOARD-FEEDBACK.md created for the user's three days of use.

## Decisions made
- 2026-10-20: infra/docker-compose.yml does not exist on this base (S4 not merged). Live e2e and the R3.6 trace run against the hub image built from packages/hub/Dockerfile via packages/web/scripts/e2e-live.sh; the sprint gate reruns against compose after S4.
- 2026-10-20: notification text follows the design system (title "<project> needs permission" or "<project> needs input", body session name and tool name); no transcript content.
- 2026-10-20: a session already waiting when first observed notifies once per episode (id, state, state_since); seen episodes persist in sessionStorage and never re-notify after resync or reload.
- 2026-10-20: R3.6 pass definition (reviewer-recommended, recorded in e2e/R3.6.spec.ts header): (a) longest script task < 16.7 ms; (b) dropped-frame intervals (> 1.5x median) under load <= idle window + 0.5% of frames; (c) main thread busy < 50%; (d) frame interval p99 < 33 ms. Gated in the verifier's container run; report-only in CI (shared runners are too noisy for (b)).
- 2026-10-20: manual DOM reorder kept (b65c88e): React keyed order with memoized cards measured 21.6% busy and 18 dropped intervals vs 11.89% and 0 for the manual reorder.
- 2026-10-20: design deviation: the attention arrival glow is an opacity-animated inner-edge glow (::after) instead of an outer border glow, because the card clips overflow and box-shadow animation repainted every frame; plays once per attention transition. 03-design-system.md section 3 should be amended by its owner.
- 2026-10-20 22:55Z, answer to questions/S6.md (conductor, under the user's standing rule): A. GitHub Actions runners are assigned again since 22:50Z; the conductor reran run 39507132891 on PR #10. S6 resumes only to confirm CI and set green; no code changes pending. If CI fails again with 0 steps, ask again.

## Deferred findings
- MINOR packages/web/src/live/stream-client.ts:288: 10 s connect timer spans until initial is parsed and does not grow with attempt; a slow link with a large initial could never connect (U3 re-review).
- MINOR packages/web/src/alerts/start.ts:357: notification handles are memory-only; a notification shown before a reload cannot be closed after it (U3 re-review).
- LOW packages/web/scripts/e2e-live.sh:190: Playwright container runs as root with the whole sprint-1-work volume read-write (documented exception) (security re-review).
- LOW .github/workflows/ci.yml: actions pinned by tag, not commit SHA (security re-review; infra unit later).
- Contract: session_id accepts any non-empty string; the web client rejects __proto__/constructor/prototype, the contract schema could require the UUID form (security review; contract owner).
- MINOR packages/web/src/components/SessionCard.tsx:48: cards that mount already waiting play the arrival glow (page load, reconnect remount, filter change). Opacity only, once. Design owner to confirm.
- MINOR packages/web/src/alerts/start.ts:63: a toast dismissed while the page is closed is re-created once as a silent same-tag replace on next load (non-persistent notifications cannot report this).
- MINOR packages/web/src/styles/index.css:113: under prefers-reduced-motion, sd-arrive is never cleared until the card leaves attention; if the user turns reduced motion off meanwhile, the glow plays late. Cosmetic.
- A11Y: working-dot pulse is infinite with no on-page pause (WCAG 2.2.2); stops under reduced motion; design owner decides whether to cap at 5 s.
- Open: the Windows R0.5 margin is 1 to 5 s. Merging S1, S2 and S4 test growth into the sprint branch will likely exceed it. That is a budget decision for the user, not an S6 code fix.
- Deferred: App.test "c toggles compact" fails under full test-level shuffle (seeds 2, 3). It is an intra-file order dependence that predates U8.

## Stop and restart
- 2026-10-20 19:51Z: subscription usage limit (429) stopped the run during U5 fix iteration 2 (reviewer: 1 MAJOR compact tasks slot unsized, 2 MINOR docs). Uncommitted work at stop: SessionCard.tsx compact state and tasks slots given fixed widths, index.css comment, R3.2.spec compact 320-480 sweep, A11Y-P3.md design-change notes, 4 baselines.
- 2026-10-20 22:04Z+: resumed (conductor addendum). No stale S6.hb-stop, previous heartbeat pid gone. Kept the uncommitted changes; the web executor verifies and commits them, then U5 re-review continues.
### U5 review iterations (after restart)
- Iteration 2 fix 205ffe0: compact state slot w-36 truncate, tasks slot w-16, sweep 320-480 px null to longest. sd-reviewer: fix-then-merge (MAJOR: compact rows silently clip at 481 to ~586 px, fixed items ~528 px but wrap only at <=30rem).
- Iteration 3 fix 15bb2f8: compact wrap breakpoint 40rem, sweep 320..1280 px with content-box and name>0 assertions, 12 subagents. sd-reviewer: merge (vitest 214, Playwright R3.2 + R3.7-live 19/19).
- Deferred: MINOR packages/web/e2e/R3.2.spec.ts:220 name slot asserted only > 0 px; a floor (>= 32 px) would catch future squeeze.
### U7 close
- Final sd-verifier at d4c845f (65aaec5): R3.1, R3.3, R3.6, R3.9, R3.7, R3.2, R3.4, R3.5, R3.8 all PASS. Suites: contract 1090 (+1 skipped), hub 177, web 214, scripts 575 (+7 skipped); typecheck and lint clean; mock Playwright 28/28; live 4/4 (R3.6 busy 7.23%, p99 16.8 ms, 0 dropped).
- origin/sprint/1-mvp (78b3ba8) is already an ancestor; no merge needed. Pushed p3/board-live; PR #10 against sprint/1-mvp.
- CI: every job fails in 2 to 5 s with 0 steps and no runner, repo-wide since about 22:15Z (p1/probe-daemon too). Account-level, not code. Rerun refused (token 403). Blocked: /state/1/questions/S6.md.
- 2026-10-20 23:00Z: resumed with answer A. Rerun 39507132891 (65aaec5) in progress with runners and steps. This log commit pushes a fresh CI run on the branch head.
### U8 Windows CI budget (R0.5)
- With runners back (run 39511481197 on e75da81), both windows check jobs failed. `pnpm -r test` hit the 60 s step cap: the web suite took 33 s on ubuntu and ran past 60 s on Windows. On node 22, App.test "/dev/cards" also failed with a 1000 ms findBy timeout on the lazy route.
- Iteration 1: 2d6a6a2 put 8 pure-logic files on the node environment, switched to the threads pool, and set RTL asyncUtilTimeout 5000. 1ca5cd3 set testTimeout 10000 (reviewer MINOR). sd-reviewer: merge. CI run 39512766631: all tests passed, but the Windows step still timed out by under 1 s (web 50.4 s).
- Iteration 2: f987e0c split vitest into projects, dom (12 files, isolate:false) and node (8). 4ab2297 adds restoreAllMocks, settings reset in App.test, and config comments (4 reviewer MINORs). sd-reviewer: merge. CI run 39514323713: all 6 jobs green. The Windows R0.5 step took 55 s on node 24 and 59 s on node 22.
- sd-verifier 5d5bb54: R0.5 and the R3.x regression pass, 12/0/0 (docs/VERIFY-P3.md addendum).
- Open: the Windows R0.5 margin is 1 to 5 s. Merging S1, S2 and S4 test growth into the sprint branch will likely exceed it. That is a budget decision for the user, not an S6 code fix.
- Deferred: App.test "c toggles compact" fails under full test-level shuffle (seeds 2, 3). It is an intra-file order dependence that predates U8.
