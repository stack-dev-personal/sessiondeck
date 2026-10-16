/*
 * Ported from appaquet/ccmon src/status-writer.ts @ 0758fa23e477fba8f6e9bfb419195aa7fc097511
 *   (MIT, Copyright (c) 2026 Andre-Philippe Paquet)
 * Changes: the switch in mapHookEventToState and the Notification insurance rule are expressed as
 *   rows of a frozen data table with sessiondeck's state names; the insurance rule becomes a
 *   guarded row that does nothing when the state is already waiting_permission.
 *
 * Ported from DeanLa/cctop plugin/scripts/cctop-hook.sh @ 6ec6256781f78ebd50e6a662e2a6e9a338b7ac35
 *   (MIT, Copyright (c) 2025 Dean Langsam)
 * Changes: the Stop sub-states chosen from the last tool (AskUserQuestion, ExitPlanMode) become
 *   guarded rows; the last tool is carried in snapshot.tracking.last_tool (main-thread PreToolUse
 *   only) instead of a file field.
 */
import { STATE_DETAIL_MAX_CHARS, truncate } from "./limits";
import type { PayloadRecord } from "./payload";
import { readString } from "./payload";
import type { SessionSnapshot } from "./snapshot";
import { isUnknownRequester } from "./snapshot";
import type { HookEventName, RowState, SessionState } from "./state-names";
import { ROW_STATES, SESSION_STATES, SUPERSEDED_REASON } from "./state-names";

/** What can fire a transition: a hook event, or one of the two non-hook triggers. */
export type TransitionTrigger = HookEventName | "liveness_dead" | "superseded";

/** Named predicates a row may require. All guards of a row must hold. */
export type GuardId =
  | "main_thread"
  | "subagent"
  | "last_tool_ask_user"
  | "last_tool_exit_plan"
  | "permission_notification"
  | "permission_free"
  | "not_subagent_over_input"
  | "source_not_compact";

/** How a row sets state_detail (display text only; no logic reads it). */
export type DetailRule =
  | "keep_if_working"
  | "keep_if_active"
  | "clear"
  | "tool"
  | "source"
  | "needs_input"
  | "awaiting_plan"
  | "error_type"
  | "pid_gone"
  | "superseded";

export interface Transition {
  readonly trigger: TransitionTrigger;
  readonly from: readonly RowState[];
  readonly guards: readonly GuardId[];
  readonly to: SessionState;
  readonly detail: DetailRule;
}

export interface TransitionContext {
  readonly prev: SessionSnapshot;
  /** The envelope's agent_id; null for the main thread (and for non-hook triggers). */
  readonly agentId: string | null;
  readonly payload: PayloadRecord;
}

const TOOL_DETAIL_PREFIX = "tool:";
const ASK_USER_TOOL = "AskUserQuestion";
const EXIT_PLAN_TOOL = "ExitPlanMode";
const COMPACT_SOURCE = "compact";
const PERMISSION_NOTIFICATION_TYPES: readonly string[] = [
  "permission_prompt",
  "elicitation_dialog",
];

/** The row state of a snapshot: `ended` with reason superseded is its own, revivable, row state. */
export function rowState(s: SessionSnapshot): RowState {
  return s.state === "ended" && s.ended_reason === SUPERSEDED_REASON ? "ended_superseded" : s.state;
}

/** States that are not final. */
export const NON_TERMINAL_STATES: readonly RowState[] = Object.freeze(
  SESSION_STATES.filter((s) => s !== "ended" && s !== "exited"),
);

/**
 * Every row state except a normal `ended`. `exited` and `ended_superseded` are included on purpose:
 * a hook arriving after the pid was declared gone, or after a supersede, proves the process is
 * alive, so the event is applied as if from a live state.
 */
export const LIVE_STATES: readonly RowState[] = Object.freeze(
  ROW_STATES.filter((s) => s !== "ended"),
);

/** States a permission Notification may move to waiting_permission (waiting_input is left alone). */
const PERMISSION_FALLBACK_FROM: readonly RowState[] = Object.freeze([
  "starting",
  "working",
  "idle",
  "error",
  "exited",
  "ended_superseded",
]);

/** PostCompact moves these to working; every other live state only counts the compaction. */
const POST_COMPACT_TO_WORKING: readonly RowState[] = Object.freeze([
  "starting",
  "working",
  "exited",
  "ended_superseded",
]);

/** States whose state_detail still describes current activity (a tool or the open prompt). */
const ACTIVE_DETAIL_STATES: readonly SessionState[] = Object.freeze([
  "working",
  "waiting_permission",
]);

/** The main turn is over and it is the user's move; background subagents must not reopen it. */
const TURN_OVER_STATES: readonly SessionState[] = Object.freeze(["idle", "waiting_input"]);

/** Human text for each guard; also used in the generated diagram and table. */
export const GUARD_DESCRIPTIONS: Readonly<Record<GuardId, string>> = Object.freeze({
  main_thread: "not inside a subagent",
  subagent: "inside a subagent",
  last_tool_ask_user: "last tool AskUserQuestion",
  last_tool_exit_plan: "last tool ExitPlanMode",
  permission_notification: "permission_prompt or elicitation_dialog",
  permission_free: "no other context holds the permission prompt",
  not_subagent_over_input: "not a subagent while the session is idle or waits for input",
  source_not_compact: "source is not compact",
});

/** True unless a permission prompt is open and was asked by a known, different agent context. */
function permissionFree(ctx: TransitionContext): boolean {
  const held = ctx.prev.tracking.permission;
  if (ctx.prev.state !== "waiting_permission" || held === null) return true;
  return isUnknownRequester(held) || held.agent_id === ctx.agentId;
}

const GUARDS: Readonly<Record<GuardId, (ctx: TransitionContext) => boolean>> = {
  main_thread: (ctx) => ctx.agentId === null,
  subagent: (ctx) => ctx.agentId !== null,
  last_tool_ask_user: (ctx) => ctx.prev.tracking.last_tool === ASK_USER_TOOL,
  last_tool_exit_plan: (ctx) => ctx.prev.tracking.last_tool === EXIT_PLAN_TOOL,
  permission_notification: (ctx) =>
    PERMISSION_NOTIFICATION_TYPES.includes(readString(ctx.payload, "notification_type") ?? ""),
  permission_free: permissionFree,
  not_subagent_over_input: (ctx) =>
    ctx.agentId === null || !TURN_OVER_STATES.includes(ctx.prev.state),
  source_not_compact: (ctx) => readString(ctx.payload, "source") !== COMPACT_SOURCE,
};

const DETAIL_RULES: Readonly<Record<DetailRule, (ctx: TransitionContext) => string | null>> = {
  keep_if_working: (ctx) => (ctx.prev.state === "working" ? ctx.prev.state_detail : null),
  keep_if_active: (ctx) =>
    ACTIVE_DETAIL_STATES.includes(ctx.prev.state) ? ctx.prev.state_detail : null,
  clear: () => null,
  tool: (ctx) => `${TOOL_DETAIL_PREFIX}${readString(ctx.payload, "tool_name") ?? "unknown"}`,
  source: (ctx) => {
    const source = readString(ctx.payload, "source");
    return source === null ? null : `source:${source}`;
  },
  needs_input: () => "needs input",
  awaiting_plan: () => "awaiting plan",
  error_type: (ctx) => readString(ctx.payload, "error") ?? "error",
  pid_gone: () => "process gone",
  superseded: () => "superseded",
};

function row(
  trigger: TransitionTrigger,
  from: readonly RowState[],
  to: SessionState,
  detail: DetailRule,
  guards: readonly GuardId[] = [],
): Transition {
  return Object.freeze({
    trigger,
    from: Object.freeze([...from]),
    guards: Object.freeze([...guards]),
    to,
    detail,
  });
}

/**
 * THE state machine. reduce(), reduceLiveness(), supersedeSamePid() and the diagram generator all
 * read this one table; there is no second copy. Rows are tried in order, first match wins. A
 * (row state, trigger) pair with no matching row leaves state, state_since and state_detail
 * unchanged; for a normal `ended` that also means nothing else changes except last_event_at.
 *
 * Terminal states:
 *  - `ended` accepts only SessionStart (resume) with a source other than compact.
 *  - `ended_superseded` (ended with reason superseded) and `exited` are revived by any hook that
 *    has a row from them (the process is evidently alive); SessionEnd moves them to `ended`.
 * Subagents: a hook inside a subagent (envelope.agent_id) never reaches idle, waiting_input or
 * ended (rows with the main_thread guard). It may still reach waiting_permission.
 * Permission: tool events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied) leave
 * waiting_permission only from the context that asked (tracking.permission.agent_id); when a
 * Notification without agent_id announced the prompt the requester is unknown and any context may
 * leave. A subagent tool event (any hook with agent_id: PreToolUse, PostToolUse, PostToolUseFailure,
 * PermissionDenied) never leaves idle or waiting_input; background work shows in `subagents`.
 *
 * Not in the table on purpose (they never change state; event-fields.ts handles their fields):
 * TaskCreated, TaskCompleted, PreCompact, SubagentStart, SubagentStop. See PROVISIONAL_BEHAVIOR
 * for what is still unconfirmed against a capture.
 */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  row("SessionStart", ROW_STATES, "starting", "source", ["source_not_compact"]),
  row("UserPromptSubmit", LIVE_STATES, "working", "clear"),
  row("PreToolUse", LIVE_STATES, "working", "tool", ["permission_free", "main_thread"]),
  row("PreToolUse", LIVE_STATES, "working", "keep_if_working", [
    "permission_free",
    "subagent",
    "not_subagent_over_input",
  ]),
  row("PostToolUse", LIVE_STATES, "working", "keep_if_active", [
    "permission_free",
    "not_subagent_over_input",
  ]),
  row("PostToolUseFailure", LIVE_STATES, "working", "keep_if_active", [
    "permission_free",
    "not_subagent_over_input",
  ]),
  row("PermissionRequest", LIVE_STATES, "waiting_permission", "tool"),
  row("PermissionDenied", LIVE_STATES, "working", "clear", [
    "permission_free",
    "not_subagent_over_input",
  ]),
  row("Notification", PERMISSION_FALLBACK_FROM, "waiting_permission", "keep_if_active", [
    "permission_notification",
  ]),
  row("Stop", LIVE_STATES, "waiting_input", "needs_input", ["main_thread", "last_tool_ask_user"]),
  row("Stop", LIVE_STATES, "waiting_input", "awaiting_plan", [
    "main_thread",
    "last_tool_exit_plan",
  ]),
  row("Stop", LIVE_STATES, "idle", "clear", ["main_thread"]),
  row("StopFailure", LIVE_STATES, "error", "error_type"),
  row("PostCompact", POST_COMPACT_TO_WORKING, "working", "clear"),
  row("SessionEnd", LIVE_STATES, "ended", "clear", ["main_thread"]),
  row("liveness_dead", NON_TERMINAL_STATES, "exited", "pid_gone"),
  row("superseded", NON_TERMINAL_STATES, "ended", "superseded"),
]);

/** First row for this trigger whose from-set and guards match, or undefined (no transition). */
export function selectTransition(
  trigger: TransitionTrigger,
  ctx: TransitionContext,
): Transition | undefined {
  const from = rowState(ctx.prev);
  return TRANSITIONS.find(
    (t) => t.trigger === trigger && t.from.includes(from) && t.guards.every((g) => GUARDS[g](ctx)),
  );
}

/** The state_detail this row produces in this context, capped at STATE_DETAIL_MAX_CHARS. */
export function resolveDetail(t: Transition, ctx: TransitionContext): string | null {
  const detail = DETAIL_RULES[t.detail](ctx);
  return detail === null ? null : truncate(detail, STATE_DETAIL_MAX_CHARS);
}

/** Behavior no capture has confirmed (synthetic payloads or cases that did not occur). */
export interface ProvisionalBehavior {
  readonly event: HookEventName;
  readonly current: string;
  readonly intended: string;
}

export const PROVISIONAL_BEHAVIOR: readonly ProvisionalBehavior[] = Object.freeze(
  (
    [
      {
        event: "StopFailure",
        current: "any context, including a subagent, gives error (synthetic payload only)",
        intended:
          "confirm against a captured StopFailure, and whether a subagent's carries agent_id",
      },
      {
        event: "Notification",
        current:
          "a permission Notification without agent_id records an unknown requester; any context's tool event leaves waiting_permission",
        intended:
          "a captured sandbox or subagent permission Notification must confirm whether agent_id is present, then scope to the requester",
      },
      {
        event: "PermissionRequest",
        current:
          "any PostToolUse from the requesting context ends the prompt, whichever parallel tool call it belongs to",
        intended:
          "a capture with parallel tool calls in the asking context must show whether the prompt stays open for the other call",
      },
      {
        event: "TaskCreated",
        current:
          "state unchanged; tasks.total + 1 and tasks.last_subject from task_subject (documented payload, synthetic fixtures only)",
        intended: "confirm the field names against a captured payload",
      },
      {
        event: "TaskCompleted",
        current:
          "state unchanged; tasks.completed + 1 (total follows if lower) and tasks.last_subject from task_subject (synthetic fixtures only)",
        intended: "confirm the field names against a captured payload",
      },
    ] satisfies ProvisionalBehavior[]
  ).map((p) => Object.freeze(p)),
);
