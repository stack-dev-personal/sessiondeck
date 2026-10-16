# Golden session timeline

Expected reducer output for `golden-session.jsonl` (295 hook events, one session, SessionStart
`startup` to SessionEnd `clear`), asserted by `packages/contract/test/state-golden.test.ts`.
`golden-session.timeline.json` is the machine-readable form. Both were written by hand from the
transition table (`TRANSITIONS` in `src/transitions.ts`, rendered in `docs/CONTRACT.md`), not copied
from reducer output. Event index is 0-based line number in the jsonl. The test delivers event `i` at
`ts = 1760000000000 + (i + 1) * 1000` to a snapshot created at `1760000000000`.

Row numbers count `TRANSITIONS` from 1: 2 UserPromptSubmit, 4 PreToolUse in a subagent, 5
PostToolUse, 7 PermissionRequest, 12 Stop (idle), 15 SessionEnd.

## State changes (11)

| # | Event | Context | From -> To | Row | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | UserPromptSubmit | main | starting -> working | 2 | any live state to working on a prompt |
| 91 | PermissionRequest | main | working -> waiting_permission | 7 | `tool:ExitPlanMode`; requester recorded as the top-level session |
| 92 | PostToolUse | main | waiting_permission -> working | 5 | the requesting context finished the tool (`permission_free`); detail kept |
| 216 | Stop | main | working -> idle | 12 | last top-level tool was Bash, so neither AskUserQuestion nor ExitPlanMode row applies |
| 221 | UserPromptSubmit | main | idle -> working | 2 | any live state to working on a prompt; the subagent tool events at 217 to 219 did not leave `idle` |
| 228 | Stop | main | working -> idle | 12 | as 216 (the session was `working` again since 221) |
| 239 | UserPromptSubmit | main | idle -> working | 2 | as 221; the subagent PreToolUse at 229 did not leave `idle` |
| 272 | Stop | main | working -> idle | 12 | as 216 |
| 274 | UserPromptSubmit | main | idle -> working | 2 | |
| 291 | Stop | main | working -> idle | 12 | as 216 |
| 294 | SessionEnd | main | idle -> ended | 15 | `ended_reason` = `clear` from the payload `reason` |

Events that do nothing because of the guard `not_subagent_over_input` (a subagent tool event while
the state is `idle` or `waiting_input`): every subagent PreToolUse, PostToolUse and PostToolUseFailure
between a Stop and the next UserPromptSubmit, including 217 and 229, which used to turn `idle` into
`working`. Only `last_event_at` moves.

Events that fire a row without changing the state: 0 SessionStart (row 1, `starting` stays,
detail `source:startup`), the other UserPromptSubmit, PreToolUse and PostToolUse events while
`working`, the four PostToolUseFailure events (`working` stays `working`, detail kept), the two `idle_prompt` Notifications (not permission types, no row), and every
SubagentStart / SubagentStop (they only maintain `subagents` rows).

## Flagged, not baked in silently

- Events 217 and 229 (resolved in U3 fix round 1): a subagent tool event no longer turns `idle` back
  into `working`; the decision recorded in the session log is that `idle` is protected like `waiting_input`. The session
  stays `idle` until a top-level event (here the UserPromptSubmit at 221 and 239) moves it. Background
  work shows in the `subagents` rows. The change count stays 11: the two subagent changes became the
  two UserPromptSubmit changes that were previously no-ops (the session was already `working`).
- Event 92 keeps `state_detail` `tool:ExitPlanMode` after the prompt is answered (PostToolUse keeps
  detail from `waiting_permission`); the next top-level PreToolUse replaces it. Harmless display text.
- Nine of the ten SubagentStop events (all except 238) have no SubagentStart and an empty
  `agent_type`. The reducer ignores them for `subagents` rows (only `last_event_at` changes), which
  is why the final snapshot has exactly one row, `general-purpose`, started at 189 and ended at 238.
