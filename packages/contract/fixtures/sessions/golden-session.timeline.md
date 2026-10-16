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
| 217 | PreToolUse | subagent | idle -> working | 4 | a subagent is still running tools after the Stop; allowed because the state is `idle`, not `waiting_input` |
| 228 | Stop | main | working -> idle | 12 | as 216 |
| 229 | PreToolUse | subagent | idle -> working | 4 | as 217 |
| 272 | Stop | main | working -> idle | 12 | as 216 |
| 274 | UserPromptSubmit | main | idle -> working | 2 | |
| 291 | Stop | main | working -> idle | 12 | as 216 |
| 294 | SessionEnd | main | idle -> ended | 15 | `ended_reason` = `clear` from the payload `reason` |

Events that fire a row without changing the state: 0 SessionStart (row 1, `starting` stays,
detail `source:startup`), the other UserPromptSubmit, PreToolUse and PostToolUse events while
`working`, the four PostToolUseFailure events (`working` stays `working`, detail kept), the two `idle_prompt` Notifications (not permission types, no row), and every
SubagentStart / SubagentStop (they only maintain `subagents` rows).

## Flagged, not baked in silently

- Events 217 and 229: a subagent's tool use after the top-level Stop turns `idle` back into
  `working`, and nothing returns it to `idle` until the next Stop (228 for the 217 run, 272 for the
  229 run). This follows the table (row 4 is guarded only against
  `waiting_input`) and matches "the session is still busy while a background subagent runs", but it
  also means a Stop is not the last word when subagents outlive it. If the UI should show
  `idle` after Stop whatever the subagents do, row 4 needs a `not idle` guard. Left as is.
- Event 92 keeps `state_detail` `tool:ExitPlanMode` after the prompt is answered (PostToolUse keeps
  detail from `waiting_permission`); the next top-level PreToolUse replaces it. Harmless display text.
- Nine of the ten SubagentStop events (all except 238) have no SubagentStart and an empty
  `agent_type`. The reducer ignores them for `subagents` rows (only `last_event_at` changes), which
  is why the final snapshot has exactly one row, `general-purpose`, started at 189 and ended at 238.
