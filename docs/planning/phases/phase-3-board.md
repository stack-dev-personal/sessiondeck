---
id: 'sessiondeck-phase-3'
title: 'Phase 3: Board (web MVP)'
collection: 'sessiondeck'
type: phase
phase: 3
status: planned
depends_on: [0]
soft_depends_on: [2]
---
# Phase 3: Board

## MVP
A browser tab that shows every live session as a card: state, context %, 5h and 7d usage, cost, subagents, task progress, model and effort, branch, elapsed time. A card expands to a detail drawer with the specifics. Sessions waiting on you are impossible to miss. The whole board collapses to a compact strip with one key. Starts on fixture-driven mocks so it can be built before the hub lands, then flips to the live WebSocket.

## Scope
In:
- App shell: header (hosts, connection status, compact toggle), board route, settings route (hub URL, token, notification opt-in).
- Session card per `03-design-system.md`: identity row, state chip, indicator row (context, 5h, 7d, cost), activity line (current tool or last message), subagent dots, task progress bar, footer (model, effort, branch, elapsed).
- Detail drawer: full snapshot, statusline sample sparkline (context over time), subagent list with tokens and context window, task list, last prompt and last assistant message, raw envelope tail (collapsible, for debugging).
- Alerts: `waiting_permission` and `waiting_input` cards pin to the top with an accent; optional browser Notification API and a short sound (opt-in, per state).
- Compact mode: card → one row (state dot, name, context %, 5h %); board → strip.
- Sorting: by attention (waiting first), then last event; filter by host and project.
- Mock mode: `VITE_MOCK=1` replays contract fixtures through the reducer in the browser.
- Playwright smoke suite.
Out:
- Conversation content (Phase 4). Layout presets beyond compact (Phase 6). Projects/archive (Phase 5). Launching sessions (Phase 8).

## Blockers / constraints
- Context % and 5h/7d are null at session start and after a reset until the next statusLine tick; the card must render "n/a" states without layout shift.
- A session with many subagents (10+) must not grow the card; dots overflow to "+n".
- Live updates arrive 5-20/s during tool bursts; render must batch (requestAnimationFrame coalescing in the store).
- No color-only state encoding (design system rule); every state has an icon and a label.
- Local port for visual testing per your workflow (Vite dev server on `localhost:5173`, hub on `:8787`).

## Inputs
- `03-design-system.md` (tokens, card anatomy, states, thresholds).
- `packages/contract` snapshot type and fixtures.
- Hub REST/WS protocol from `01-architecture.md` 3.4 (or the mock).
- ccstatusline widget set (MIT) as a checklist of what people put on status lines: model, context, cost, block timer, git branch, tokens.
- Claude-Code-Usage-Monitor's UI (MIT) for the burn-rate and reset-countdown presentation.

## Instruments
- React 18, Vite, TypeScript, Tailwind (tokens as CSS variables), Zustand, Playwright, Vitest + Testing Library.
- Storybook or a `/dev/cards` route rendering every card state from fixtures (cheaper than Storybook; decide in the session).
- Lighthouse run for accessibility (contrast, focus order) recorded once per phase.

## Requirements
- R3.1 Every live session appears on the board within 1 s of its `SessionStart` reaching the hub.
- R3.2 Card shows all A6 indicators; nulls render as "n/a" with no layout shift.
- R3.3 `waiting_permission` and `waiting_input` sessions move to the top within one render and carry the attention accent; opt-in browser notification fires once per transition.
- R3.4 Compact mode toggles with `c`; state persists in localStorage (try/catch guarded).
- R3.5 Detail drawer opens with `Enter` or click, closes with `Esc`; focus returns to the card.
- R3.6 Board handles 20 live sessions across 2 hosts at 20 deltas/s without dropped frames (Playwright trace, main thread < 50% busy).
- R3.7 All states and thresholds meet WCAG AA contrast in light and dark; no information carried by color alone.
- R3.8 Mock mode runs the full UI with no hub.
- R3.9 WS disconnect shows a banner and auto-reconnects with resync; no stale "working" card persists after reconnect.
- R3.10 (added 2026-10-28 from user feedback) Stable working/idle display: the contract state machine is unchanged (Stop still means idle). A display-level activity with hysteresis: a session shows and sorts as working until continuously idle or waiting for a grace period, default 120 s, configurable in Settings (range 0 to 15 min). Waiting for input (permission, question) surfaces immediately. Board order is stable: a card changes group at most once per grace period, and within a group order does not change on every delta (stable sort key, e.g. last-entered-group time). Tests: Stop then UserPromptSubmit 30 s later never leaves the working group; a session idle for 121 s moves once.
- R3.11 (added 2026-10-28 from user feedback) Session popout replaces the side drawer: click on a card opens a large centered popout (dialog semantics, focus trap, Esc and click-outside close, deep-linkable via a plain `#session-<id>` hash). It shows the session header (state, model, effort, cost, branch) and its subagents as a compact board using the same card component at a compact size. A subagent card with its own subagents expands in place, recursively to the deepest agent, with expand/collapse per node and "expand all". Nesting comes from parent links in hook envelopes (contract: `parent_agent_id`, `parent_known`) and, when S7 lands, transcript subagent attachment. An agent with an unknown parent shows at the first level with an "unlinked" marker, and the gap is recorded in the session log. A content slot is left for S8.
- R3.12 (added 2026-10-28 from user feedback) Usage widget: the 5h and 7d meters are removed from every session card. One square widget shows account usage, 5-hour and 7-day used percentage with reset times, from statusLine `rate_limits` (freshest payload across sessions). It is draggable by pointer and movable by keyboard, its position kept per browser in localStorage (try/catch), snaps inside the viewport on resize, and collapses to a chip. It is a self-contained component with its own data hook so S15 can host it in its own window. Amendment 2026-10-28 (user, decision 28): no Fable 7-day row, estimate or placeholder; only `five_hour` and `seven_day` as statusLine reports them.
- R3.13 (added 2026-10-28 from user feedback) Mock mode covers R3.10 to R3.12: a popout with three nesting levels, the usage widget, and a session flapping Stop/prompt.

## Definition of done
- [ ] All R3.x pass; Playwright smoke green in CI.
- [ ] Used daily by you for three days with real sessions; a `docs/BOARD-FEEDBACK.md` lists what you changed your mind on (feeds Phases 5 and 6).
- [ ] R3.10 to R3.13 Playwright screenshots light/dark at 1440x900 and 390 wide.
- [ ] `/dev/cards` renders every state from fixtures and is screenshot-tested.
- [ ] `sd-reviewer` sign-off; `design:accessibility-review` checklist (your installed skill) run once and findings closed or logged.
