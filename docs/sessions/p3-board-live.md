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
### U6 BOARD-FEEDBACK template
- docs/BOARD-FEEDBACK.md created for the user's three days of use.

## Decisions made
- 2026-10-20: infra/docker-compose.yml does not exist on this base (S4 not merged). Live e2e and the R3.6 trace run against the hub image built from packages/hub/Dockerfile via packages/web/scripts/e2e-live.sh; the sprint gate reruns against compose after S4.
- 2026-10-20: notification text follows the design system (title "<project> needs permission" or "<project> needs input", body session name and tool name); no transcript content.
- 2026-10-20: a session already waiting when first observed notifies once per episode (id, state, state_since); seen episodes persist in sessionStorage and never re-notify after resync or reload.
- 2026-10-20: R3.6 pass definition (reviewer-recommended, recorded in e2e/R3.6.spec.ts header): (a) longest script task < 16.7 ms; (b) dropped-frame intervals (> 1.5x median) under load <= idle window + 0.5% of frames; (c) main thread busy < 50%; (d) frame interval p99 < 33 ms. Gated in the verifier's container run; report-only in CI (shared runners are too noisy for (b)).
- 2026-10-20: manual DOM reorder kept (b65c88e): React keyed order with memoized cards measured 21.6% busy and 18 dropped intervals vs 11.89% and 0 for the manual reorder.
- 2026-10-20: design deviation: the attention arrival glow is an opacity-animated inner-edge glow (::after) instead of an outer border glow, because the card clips overflow and box-shadow animation repainted every frame; plays once per attention transition. 03-design-system.md section 3 should be amended by its owner.

## Deferred findings
- MINOR packages/web/src/live/stream-client.ts:288: 10 s connect timer spans until initial is parsed and does not grow with attempt; a slow link with a large initial could never connect (U3 re-review).
- MINOR packages/web/src/alerts/start.ts:357: notification handles are memory-only; a notification shown before a reload cannot be closed after it (U3 re-review).
- LOW packages/web/scripts/e2e-live.sh:190: Playwright container runs as root with the whole sprint-1-work volume read-write (documented exception) (security re-review).
- LOW .github/workflows/ci.yml: actions pinned by tag, not commit SHA (security re-review; infra unit later).
- Contract: session_id accepts any non-empty string; the web client rejects __proto__/constructor/prototype, the contract schema could require the UUID form (security review; contract owner).
