# Session log: p3/board-mock (S5, Phase 3 mock)

- Date: 2026-10-20
- Handoff: docs/handoffs/S05-board-on-mocks.md
- Sprint: 1 (mvp), base branch sprint/1-mvp at 5b76608
- Contract commit: 256d2604b86ff12cc080df546792cc430b89e5a4 (ancestor of base, verified)
- Requirements: R3.2, R3.4, R3.5, R3.7, R3.8

## Tasks

| # | Unit | Requirements | Executor | Blocked by | Status |
|---|------|--------------|----------|------------|--------|
| U1 | tokens and shell (scaffold, tokens.css, Tailwind, Zustand store, VITE_MOCK fixture replay through reduce(), theme toggle, contrast test) | R3.7, R3.8 | sd-executor-web | none | reviewed: merge; verification after U4 (IDs span units) |
| U2 | session card (6-row and compact 1-row, attention accent, n/a without layout shift, subagent +n, compact `c` with localStorage) | R3.2, R3.4, R3.7 | sd-executor-web | U1 | reviewed: merge; verification after U4 |
| U3 | detail drawer (Enter/click open, Esc close, focus return, sections per design system 5.2) | R3.5 | sd-executor-web | U2 | reviewed: merge; verification after U4 |
| U4 | /dev/cards route, Playwright suite in container, screenshots to /state/1/screens/S5 | R3.2, R3.4, R3.5, R3.7, R3.8 | sd-executor-web | U3 | pending |
| U5 | CI job running the Playwright smoke suite (phase DoD: Playwright smoke green in CI) | R3.2, R3.4, R3.5, R3.7, R3.8 | sd-executor-contract (.github) | U4 | pending |

## Decisions made

- 2026-10-20 Contrast pre-check (node, WCAG formula) against --surface-1: dark --state-ended #6e7681 = 3.80:1, light --state-starting #8c959f = 3.04:1. Both fail the design system's 4.5:1 text rule; both pass 3:1 for icons. All other state, meter, fg tokens pass; meter fills vs --meter-track pass 3:1. This is the handoff's stop condition. Tokens are NOT changed: units build with the spec values verbatim, the contrast test names exactly these two as pending decision, and the session ends blocked with the question in /state/1/questions/S5.md. Rationale: the answer changes two hex values; everything else is independent of it.
- 2026-10-20 TaskCreate is unavailable in this runtime; this table is the task list.
- 2026-10-20 /dev/cards route chosen over Storybook (phase doc Instruments leaves it to the session; cheaper, no extra toolchain).

## Units

### U1 tokens and shell
- Commits: 838ab27, 0eb65d6, fix 9a07104. Files: packages/web/** (scaffold, tokens.css verbatim with two prettier-ignore lines, contrast test and report script, shell, store with rAF coalescing, mock replay of 8 sessions on 2 hosts, statusline adapter), pnpm-lock.yaml.
- Review iteration 1 (117d37c..0eb65d6): fix-then-merge. 1 MAJOR (fg-faint text contrast untested), 5 MINOR. All fixed in 9a07104.
- Review iteration 2 (0eb65d6..9a07104): merge. 2 MINOR carried into U2 (check:bundle args; meters must render through windowAt).
- Tests: 33/33 pass. Contrast report: 4 pinned text failures (dark state-ended 3.80, light state-starting 3.04, dark fg-faint 3.83, light fg-faint 3.04).
- Decision: react-router-dom v6 (route params for later /session/:id); vite 7 (matches vitest 3).
- Decision: fg-faint stays on host and footer text per the design system and joins the pending contrast question; state-colored and faint text only on bg-surface-1 (the surface the design system's contrast rule names).

### U2 session card
- Commits: 3c9d7b0, d028fba, fix 460edc1. Files: packages/web/src/components/{SessionCard,Meter}.tsx, lib/format.ts, hooks/useNow.ts, routes/Board.tsx, store/board.ts, statusline-adapter.ts, styles/index.css, tests.
- Review iteration 1 (9a07104..d028fba): fix-then-merge. 1 MAJOR (opacity 0.6 on ended/exited dimmed text below AA), 7 MINOR. Fixed in 460edc1.
- Review iteration 2 (d028fba..460edc1): merge. 1 MINOR deferred (below).
- Tests: 78/78 pass.
- Decision: "card dims" (design system section 3) implemented as border and meter bars faded, text at full contrast. Not a token or threshold, so not the stop condition; it keeps R3.7. Mentioned to the user in the question.
- Decision: contract is frozen for S5; `exceeds_200k_tokens` is carried web-side from the statusLine payload (store map), no heuristic; unknown shows no tag.
- Decision: compact board is a dense single-column list of 36 px rows; the scrolling strip (section 5.4) is left to Phase 6 layouts.
- Decision: footer reads "in state <duration>" because the snapshot has no prompt timestamp; reset countdown in the meter title, visible in the drawer.

### U3 detail drawer and keyboard
- Commits: 46e1308, c866961, fix 54bf94f. Files: packages/web/src/store/history.ts, components/{DetailDrawer,DrawerHost}.tsx, lib/keys.ts, SessionCard.tsx, Board.tsx, ui.ts, tests.
- Review iteration 1 (460edc1..c866961): fix-then-merge. 1 MAJOR (board keys and Tab trap depended on focus inside drawer), 3 MINOR. Fixed in 54bf94f.
- Review iteration 2 (c866961..54bf94f): merge; reviewer proved the new tests fail against the old code in a scratch copy. 2 MINOR folded into U4 (focusNearest focuses first card; inert-cleared asserts on switch and vanish).
- Tests: 105/105 pass.
- Decision: tasks section shows counts plus last subject (snapshot has no per-task list); j/k clamp; no ?session= URL.

## Deferred findings
- [contract, for S6 / contract owner] SessionSnapshot has no per-task list; the drawer's "tasks list" (design system 5.2) shows counts and last subject until it does.
- [contract, for S6 / contract owner] Add `context.exceeds_200k` (from statusLine `exceeds_200k_tokens`) to SessionSnapshot; the web-side map in packages/web/src/store/board.ts does not survive once the hub owns snapshots. Also a prompt timestamp would allow "since prompt" in the footer.
- [MINOR, S6] packages/web/src/store/board.ts:47-50: replaceAll (reconnect resync) clears the exceeds200k map, so an idle session above 200k loses its tag until its next statusLine tick; no store tests for set / replaceAll / compaction flip. S6 owns reconnect.
