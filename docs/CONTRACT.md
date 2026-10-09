# Contract: envelope and session state machine

Package: `packages/contract` (`@sessiondeck/contract`). Pure TypeScript and zod, no I/O. Claude Code version at scaffold time: 2.1.295. Regions between `BEGIN:` and `END:` markers are generated: run `pnpm -F @sessiondeck/contract gen:doc` (add `-- --check` to only verify). A test fails if they drift.

## Envelope

Every probe-to-hub message is one `Envelope` (`src/envelope.ts`, architecture 3.1).

| Field | Type | Rule |
| --- | --- | --- |
| `v` | `1` | envelope schema version |
| `id` | string | ULID, assigned by the probe at write time |
| `kind` | `hook` `statusline` `subagents` `transcript` `liveness` `probe` | event kind |
| `host` | string | machine name, non-empty |
| `os` | `win32` `linux` `darwin` | host OS |
| `session_id` | string or null | null only for kind `probe` |
| `agent_id` | string, optional | present when the hook ran inside a subagent |
| `hook_event_name` | string, optional | required for kind `hook` |
| `ts` | integer >= 0 | epoch ms at the probe |
| `seq` | integer >= 0 | per-host sequence; the hub orders by `(host, seq)` |
| `payload` | unknown | the raw stdin JSON, never reshaped; the key must be present |

## Liveness payload and the pid (decided in S0, confirm in S1)

The `Envelope` interface has no `pid` field. The pid travels in the payload of `liveness` envelopes, which are our own payload, not Claude Code's: `LivenessPayloadSchema = { pid: positive integer, alive: boolean }`, with the envelope's `session_id` naming the session.

- `alive: true` is the pid report: `reduceLiveness` sets `snapshot.pid`.
- `alive: false` on a session that is not `ended` or `exited` moves it to `exited`.
- Who emits the first report (hook at SessionStart, or the daemon) is Phase 1's choice.
- A new `session_id` under the same host and pid (`/clear`, `--resume`) ends the previous session: `supersedeSamePid(sessions, { host, session_id, pid, ts })` returns the collection with those sessions `ended`, `ended_reason: 'superseded'`.

## State machine

Three pure functions share one frozen table (`TRANSITIONS` in `src/transitions.ts`): `reduce(prev, hookEnvelope)`, `reduceLiveness(prev, livenessEnvelope)`, `supersedeSamePid(...)`. The diagram and the table below are generated from it.

Decisions:

- `reduce` is total and deterministic. Unknown events and malformed payloads only update `last_event_at`. Time comes only from `e.ts`. Inputs are never mutated.
- `state_since` changes only when `state` changes.
- The last tool before `Stop` is kept in `state_detail` as `tool:<name>`. `PostToolUse` leaves it in place (as cctop does); `UserPromptSubmit`, `Stop` and other transitions replace it.
- `ended` accepts only `SessionStart` with the same `session_id` (resume). Everything else just updates `last_event_at`, so the first `ended_reason` is kept.
- `exited` means the pid vanished without `SessionEnd`. A later hook proves the process is alive, so any event with a row from `exited` is applied normally (revival); `SessionStart` moves it to `starting` and `SessionEnd` to `ended`.
- A hook envelope with `agent_id` (the hook ran inside a subagent) never moves the session to `idle`, `waiting_input` or `ended`. A subagent's `PermissionRequest` or permission `Notification` still moves it to `waiting_permission`. `SubagentStart` and `SubagentStop` maintain `subagents` rows and never change `state`.
- A `Notification` of type `permission_prompt` or `elicitation_dialog` is the late fallback for `PermissionRequest`; it does nothing when the state is already `waiting_permission`, and it leaves `waiting_input` alone.
- Fields read defensively (a field of the wrong type leaves the snapshot field as it was): `notification_type`, `tool_name` (PreToolUse), `reason` (SessionEnd, `unknown` if absent), `last_assistant_message` (Stop), `prompt`, `source`, `model` (SessionStart), `agent_id` and `agent_type` (SubagentStart, SubagentStop), `error` (StopFailure).

<!-- BEGIN:state-diagram -->
```mermaid
stateDiagram-v2
    [*] --> starting
    state "any state except ended" as any_except_ended
    state "any state except ended and exited" as any_except_ended_exited
    starting --> starting : SessionStart
    ended --> starting : SessionStart
    exited --> starting : SessionStart
    any_except_ended --> working : UserPromptSubmit
    any_except_ended --> working : PreToolUse
    any_except_ended --> working : PostToolUse
    any_except_ended --> waiting_permission : PermissionRequest
    any_except_ended --> working : PermissionDenied
    starting --> waiting_permission : Notification if permission_prompt or elicitation_dialog
    working --> waiting_permission : Notification if permission_prompt or elicitation_dialog
    idle --> waiting_permission : Notification if permission_prompt or elicitation_dialog
    error --> waiting_permission : Notification if permission_prompt or elicitation_dialog
    exited --> waiting_permission : Notification if permission_prompt or elicitation_dialog
    any_except_ended --> waiting_input : Stop if not inside a subagent and last tool AskUserQuestion
    any_except_ended --> waiting_input : Stop if not inside a subagent and last tool ExitPlanMode
    any_except_ended --> idle : Stop if not inside a subagent
    any_except_ended --> error : StopFailure
    any_except_ended --> working : PostCompact
    any_except_ended --> ended : SessionEnd if not inside a subagent
    any_except_ended_exited --> exited : liveness alive false
    any_except_ended_exited --> ended : same pid, new session_id
```
<!-- END:state-diagram -->

<!-- BEGIN:transition-table -->
| Trigger | From | Condition | To | state_detail |
| --- | --- | --- | --- | --- |
| SessionStart | starting, ended, exited | - | starting | `source:<source>` |
| UserPromptSubmit | any state except ended | - | working | null |
| PreToolUse | any state except ended | - | working | `tool:<tool_name>` |
| PostToolUse | any state except ended | - | working | unchanged |
| PermissionRequest | any state except ended | - | waiting_permission | unchanged |
| PermissionDenied | any state except ended | - | working | null |
| Notification | starting, working, idle, error, exited | permission_prompt or elicitation_dialog | waiting_permission | unchanged |
| Stop | any state except ended | not inside a subagent and last tool AskUserQuestion | waiting_input | needs input |
| Stop | any state except ended | not inside a subagent and last tool ExitPlanMode | waiting_input | awaiting plan |
| Stop | any state except ended | not inside a subagent | idle | null |
| StopFailure | any state except ended | - | error | `<error>` |
| PostCompact | any state except ended | - | working | null |
| SessionEnd | any state except ended | not inside a subagent | ended | null |
| liveness alive false | any state except ended and exited | - | exited | process gone |
| same pid, new session_id | any state except ended and exited | - | ended | superseded |
<!-- END:transition-table -->

A (state, trigger) pair with no row keeps `state`, `state_since` and `state_detail`.

## Provisional pending fixtures

The payload fields of these five events are unverified (phase 0 blockers). Their transitions are not finalized; the reducer does the conservative thing below. Each has a skipped `TODO(fixture)` test in `packages/contract/test/state.test.ts`, as does the golden timeline from a real session (S0b).

<!-- BEGIN:provisional -->
| Event | Behavior now | Intended after fixtures |
| --- | --- | --- |
| PostToolUse | state working, tool_response not read | read tool_response to detect an interrupted or failed result |
| PostToolUseFailure | state unchanged | payload marks an API error: error; a plain tool failure: working |
| TaskCreated | state unchanged | tasks.total + 1 and tasks.last_subject from the payload subject |
| TaskCompleted | state unchanged | tasks.completed + 1 and tasks.last_subject from the payload subject |
| PreCompact | state unchanged | read the compaction trigger (manual or auto) into state_detail |
<!-- END:provisional -->

## Fixtures

- `packages/contract/fixtures/raw/<Event>/`: raw captures. Gitignored. Never loaded by tests.
- `packages/contract/fixtures/<Event>/*.json`: scrubbed, committed. `<Event>` is the hook event name, plus `statusLine/` and `subagentStatusLine/`.
- `packages/contract/fixtures/settings/`: settings-merge test input, not payloads.

## Units

`Window.resets_at` and `prompt_cache.expires_at` are epoch milliseconds in the snapshot and epoch seconds in the statusLine payload. Convert with `epochSecondsToMs` (`src/statusline.ts`).

## Observed payloads

(Empty. S0b fills this in from the scrubbed fixtures.)
