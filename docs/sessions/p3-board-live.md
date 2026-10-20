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

## Decisions made
- 2026-10-20: infra/docker-compose.yml does not exist on this base (S4 not merged). Live e2e and the R3.6 trace run against the hub image built from packages/hub/Dockerfile via packages/web/scripts/e2e-live.sh; the sprint gate reruns against compose after S4.

## Deferred findings
