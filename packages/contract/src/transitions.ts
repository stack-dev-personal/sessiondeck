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
 *   guarded rows; the last tool is carried in state_detail ("tool:<name>") instead of a file field.
 */
import type { PayloadRecord } from "./payload";
import { readString } from "./payload";
import type { SessionSnapshot } from "./snapshot";
import type { HookEventName, SessionState } from "./state-names";
import { SESSION_STATES } from "./state-names";

/** What can fire a transition: a hook event, or one of the two non-hook triggers. */
export type TransitionTrigger = HookEventName | "liveness_dead" | "superseded";

/** Named predicates a row may require. All guards of a row must hold. */
export type GuardId =
  "main_thread" | "last_tool_ask_user" | "last_tool_exit_plan" | "permission_notification";

/** How a row sets state_detail. */
export type DetailRule =
  | "keep"
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
  readonly from: readonly SessionState[];
  readonly guards: readonly GuardId[];
  readonly to: SessionState;
  readonly detail: DetailRule;
}

export interface TransitionContext {
  readonly prev: SessionSnapshot;
  /** True when the hook ran inside a subagent (envelope.agent_id present). */
  readonly subagent: boolean;
  readonly payload: PayloadRecord;
}

const TOOL_DETAIL_PREFIX = "tool:";
const ASK_USER_TOOL = "AskUserQuestion";
const EXIT_PLAN_TOOL = "ExitPlanMode";
const PERMISSION_NOTIFICATION_TYPES: readonly string[] = [
  "permission_prompt",
  "elicitation_dialog",
];

/** States that are not final. */
export const NON_TERMINAL_STATES: readonly SessionState[] = Object.freeze(
  SESSION_STATES.filter((s) => s !== "ended" && s !== "exited"),
);

/**
 * Every state except `ended`. `exited` is included on purpose: a hook arriving after the pid was
 * declared gone proves the process is alive, so the event is applied as if from a live state.
 */
export const LIVE_STATES: readonly SessionState[] = Object.freeze(
  SESSION_STATES.filter((s) => s !== "ended"),
);

/** States a permission Notification may move to waiting_permission (waiting_input is left alone). */
const PERMISSION_FALLBACK_FROM: readonly SessionState[] = Object.freeze([
  "starting",
  "working",
  "idle",
  "error",
  "exited",
]);

/** Human text for each guard; also used in the generated diagram and table. */
export const GUARD_DESCRIPTIONS: Readonly<Record<GuardId, string>> = Object.freeze({
  main_thread: "not inside a subagent",
  last_tool_ask_user: "last tool AskUserQuestion",
  last_tool_exit_plan: "last tool ExitPlanMode",
  permission_notification: "permission_prompt or elicitation_dialog",
});

const GUARDS: Readonly<Record<GuardId, (ctx: TransitionContext) => boolean>> = {
  main_thread: (ctx) => !ctx.subagent,
  last_tool_ask_user: (ctx) => ctx.prev.state_detail === `${TOOL_DETAIL_PREFIX}${ASK_USER_TOOL}`,
  last_tool_exit_plan: (ctx) => ctx.prev.state_detail === `${TOOL_DETAIL_PREFIX}${EXIT_PLAN_TOOL}`,
  permission_notification: (ctx) =>
    PERMISSION_NOTIFICATION_TYPES.includes(readString(ctx.payload, "notification_type") ?? ""),
};

const DETAIL_RULES: Readonly<Record<DetailRule, (ctx: TransitionContext) => string | null>> = {
  keep: (ctx) => ctx.prev.state_detail,
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
  from: readonly SessionState[],
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
 * (state, trigger) pair with no matching row leaves state, state_since and state_detail unchanged.
 *
 * Terminal states:
 *  - `ended` accepts only SessionStart (resume); every other event only updates last_event_at.
 *  - `exited` is revived by any hook that has a row from it (the process is evidently alive);
 *    SessionStart moves it to `starting`, SessionEnd to `ended`.
 * Subagents: a hook inside a subagent (envelope.agent_id) never reaches idle, waiting_input or
 * ended (rows with the main_thread guard). It may still reach waiting_permission.
 *
 * Not in the table on purpose (fixtures pending, see PROVISIONAL_BEHAVIOR): PostToolUseFailure,
 * TaskCreated, TaskCompleted, PreCompact. SubagentStart and SubagentStop change rows, not state.
 */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  row("SessionStart", ["starting", "ended", "exited"], "starting", "source"),
  row("UserPromptSubmit", LIVE_STATES, "working", "clear"),
  row("PreToolUse", LIVE_STATES, "working", "tool"),
  row("PostToolUse", LIVE_STATES, "working", "keep"),
  row("PermissionRequest", LIVE_STATES, "waiting_permission", "keep"),
  row("PermissionDenied", LIVE_STATES, "working", "clear"),
  row("Notification", PERMISSION_FALLBACK_FROM, "waiting_permission", "keep", [
    "permission_notification",
  ]),
  row("Stop", LIVE_STATES, "waiting_input", "needs_input", ["main_thread", "last_tool_ask_user"]),
  row("Stop", LIVE_STATES, "waiting_input", "awaiting_plan", [
    "main_thread",
    "last_tool_exit_plan",
  ]),
  row("Stop", LIVE_STATES, "idle", "clear", ["main_thread"]),
  row("StopFailure", LIVE_STATES, "error", "error_type"),
  row("PostCompact", LIVE_STATES, "working", "clear"),
  row("SessionEnd", LIVE_STATES, "ended", "clear", ["main_thread"]),
  row("liveness_dead", NON_TERMINAL_STATES, "exited", "pid_gone"),
  row("superseded", NON_TERMINAL_STATES, "ended", "superseded"),
]);

/** First row for this trigger whose from-set and guards match, or undefined (no transition). */
export function selectTransition(
  trigger: TransitionTrigger,
  ctx: TransitionContext,
): Transition | undefined {
  return TRANSITIONS.find(
    (t) =>
      t.trigger === trigger &&
      t.from.includes(ctx.prev.state) &&
      t.guards.every((g) => GUARDS[g](ctx)),
  );
}

/** The state_detail this row produces in this context. */
export function resolveDetail(t: Transition, ctx: TransitionContext): string | null {
  return DETAIL_RULES[t.detail](ctx);
}

/** Events whose payload fields are unverified. Behavior is provisional until S0b adds fixtures. */
export interface ProvisionalBehavior {
  readonly event: HookEventName;
  readonly current: string;
  readonly intended: string;
}

export const PROVISIONAL_BEHAVIOR: readonly ProvisionalBehavior[] = Object.freeze(
  (
    [
      {
        event: "PostToolUse",
        current: "state working, tool_response not read",
        intended: "read tool_response to detect an interrupted or failed result",
      },
      {
        event: "PostToolUseFailure",
        current: "state unchanged",
        intended: "payload marks an API error: error; a plain tool failure: working",
      },
      {
        event: "TaskCreated",
        current: "state unchanged",
        intended: "tasks.total + 1 and tasks.last_subject from the payload subject",
      },
      {
        event: "TaskCompleted",
        current: "state unchanged",
        intended: "tasks.completed + 1 and tasks.last_subject from the payload subject",
      },
      {
        event: "PreCompact",
        current: "state unchanged",
        intended: "read the compaction trigger (manual or auto) into state_detail",
      },
    ] satisfies ProvisionalBehavior[]
  ).map((p) => Object.freeze(p)),
);
