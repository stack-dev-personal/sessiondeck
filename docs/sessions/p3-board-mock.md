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
| U4 | /dev/cards route, Playwright suite in container, screenshots to /state/1/screens/S5 | R3.2, R3.4, R3.5, R3.7, R3.8 | sd-executor-web | U3 | reviewed: merge |
| U5 | CI job running the Playwright smoke suite (phase DoD: Playwright smoke green in CI) | R3.2, R3.4, R3.5, R3.7, R3.8 | sd-executor-contract (.github) | U4 | reviewed: merge (CI green pending on final head) |

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

### U4 /dev/cards and Playwright suite
- Commits: 40645ec, 7c61038, fixes dcd58b1, ba70295, minors 17b16dd, d934448. Files: packages/web/src/dev/specimens.ts, routes/DevCards.tsx, mock/{timeline,start,fixtures}.ts, e2e/R3.{2,4,5,7,8}.spec.ts, helpers, summary reporter, playwright.config.ts, e2e/__screenshots__/ baselines; U3 carried minors (focusNearest, inert asserts).
- Review iteration 1 (54bf94f..7c61038): fix-then-merge. 4 MAJOR (mock replay left most cards empty; screenshots taken mid-replay; drawer shot of an empty session; /dev/cards PNGs never compared), 5 MINOR. Fixed in dcd58b1.
- Review iteration 2 (7c61038..dcd58b1): fix-then-merge. 1 MAJOR (placeholder text ignored field: prompt got assistant-style text), 2 MINOR. Fixed in ba70295.
- Review iteration 3 (dcd58b1..ba70295): merge. 2 MINOR fixed in 17b16dd (reply variety; row-1 ellipsis), then 1 MINOR fixed in d934448 (state detail priority in row 1).
- Evidence: Playwright 12/12 in mcr.microsoft.com/playwright:v1.63.0-noble, baselines stable over repeated runs; screenshots in /state/1/screens/S5/. Settled mock board: all 8 states, 7/8 cards with context and 5h/7d, 8 distinct names, 7 branches.
- Decision: /dev/cards is available only in dev and VITE_MOCK=1 builds (fixtures carry a marker id that check:bundle keeps out of production).
- Decision: mock replay has ?replay=fast and a data-replay="done" signal for e2e; interactive pace unchanged.

### U5 CI Playwright job
- Commits: 37de274, fix 3ef73eb. File: .github/workflows/ci.yml (new job e2e-web in the pinned Playwright image so baselines match).
- Review iteration 1 (ba70295..17b16dd): fix-then-merge. 2 MAJOR (screens dir used host path in a container job; uploaded result paths never created). Fixed in 3ef73eb.
- Review iteration 2 (17b16dd..d934448): merge, conditional on green e2e-web on the final head. CI run 39361096443 on 17b16dd: e2e-web success, ubuntu checks success.

### Session close checks (d934448)
- pnpm -r test: scripts 575 pass / 7 skipped, contract 1090 pass / 1 skipped, web 116 pass. pnpm -r typecheck, pnpm -r lint, lint:root, format:check: exit 0.
- Sprint branch unchanged since intake (5b76608): no rebase needed.
- MINI-SPRINT-ORDER integration check for S5 ("web Playwright flows from S5 and S6 against the live hub") is a sprint-gate check run after S3 and S6 merge; S5's flows run on the mock build here.

## Deferred findings
- [MINOR] packages/web/src/components/SessionCard.tsx:176: `where` (project/branch) has shrink-[8] and min-w-0, so on narrow cards (about 400 px) it can collapse to "…"; e2e collapse check covers only the state detail. Add a floor (min-w-[8ch]) and extend the check.
- [MINOR] packages/web/e2e/R3.2.spec.ts:96: collapse threshold 6 x 0.5em is looser than the 10ch CSS floor; compare against a measured 10-character width.
- [contract, for S6 / contract owner] SessionSnapshot has no per-task list; the drawer's "tasks list" (design system 5.2) shows counts and last subject until it does.
- [contract, for S6 / contract owner] Add `context.exceeds_200k` (from statusLine `exceeds_200k_tokens`) to SessionSnapshot; the web-side map in packages/web/src/store/board.ts does not survive once the hub owns snapshots. Also a prompt timestamp would allow "since prompt" in the footer.
- [MINOR, S6] packages/web/src/store/board.ts:47-50: replaceAll (reconnect resync) clears the exceeds200k map, so an idle session above 200k loses its tag until its next statusLine tick; no store tests for set / replaceAll / compaction flip. S6 owns reconnect.

## Resume 2026-10-20T04:46Z (after the usage-limit stop)

- Decision: the previous run stopped at about 03:00Z on the subscription usage limit (429). That is not a failure. At the stop the branch was clean and pushed at 72e7a63 (VERIFY-P3 written, PR #8 open, CI green on 72e7a63), but the blocked exit was never completed: /state/1/questions/S5.md was missing and the status file still said running on U4. No uncommitted work was left, no unit was redone. Sprint branch still at 5b76608, so no rebase was needed. No answer file exists for S5.
- Action: wrote /state/1/questions/S5.md (four contrast tokens, options A/B/C with computed replacement values), set status blocked. On resume with an answer: one web unit (tokens.css, contrast test pinned list, design-system doc, Playwright baselines), then sd-reviewer, sd-verifier on R3.7 and a full re-verify, then update PR #8.

## Resume 2026-10-20 (answer received)

### Decisions made
- 2026-10-20 R3.7 contrast tokens: option A, per /state/1/answers/S5.md (conductor, 2026-10-20T09:15Z). This was the conductor's call under the user's standing rule (decide after two messages without a choice; the user replied "continue, long tailed development overnight (5 hrs)" and "continue" without picking). The user may revise the values before PR #8 merges. New values: dark --state-ended #7f868f, dark --fg-faint #7c8792, light --state-starting #6e757d, light --fg-faint #6e757d. The design-system rule (every --state-* on --surface-1 passes 4.5:1 as text) is unchanged; docs/planning/03-design-system.md gets the new values in this PR.
- U6 added: sd-executor-web, tokens.css, contrast test pinned list emptied, R3.7 e2e made strict, Playwright baselines refreshed, design-system doc section 2 values (doc edit granted to the web executor for this unit only).

| U6 | contrast tokens per answer A | R3.7 | sd-executor-web | U1-U5 | in progress |

## Resume 2026-10-20 (after the container restart at about 14:20Z)

- Decision: the sprint container restarted at about 14:20Z and killed the previous run during U6. Not a failure. State found: working tree clean, no heartbeat running, U6 commits 5edf2af (tokens.css and design-system section 2) and 8dbb110 (contrast unit test and R3.7 e2e strict) present but unpushed; Playwright baselines not yet refreshed. Sprint branch still at 5b76608. U6 continues with the same executor role: refresh baselines, run unit and e2e suites, then review and verify.
